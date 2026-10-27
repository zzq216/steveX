package name.modid.vision;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.world.level.storage.LevelResource;
import org.slf4j.Logger;

/**
 * v2.55（多世界记忆隔离，见 docs/多世界记忆隔离设计方案.md §4）：当前连接的世界 → 记忆目录键。
 *
 * <ul>
 *   <li><b>单人</b>（D2）：存档内标记文件 {@code <save>/stevex/world_id.json} = {@code {id, folder}}。
 *       没有标记 → 新 uuid；标记里的 {@code folder} 与当前文件夹名不符 → 视为复制出来的存档、换新
 *       uuid（复制品不继承原存档的记忆）。键 = {@code sp-<文件夹名净化>-<uuid 前 8 位>}。</li>
 *   <li><b>多人</b>（D3）：规范化地址 {@code host_port}（host 小写、缺省端口补 25565），前缀按类型
 *       {@code mp-} / {@code lan-} / {@code realm-}。同地址重置地图、多子服共用一个地址、LAN 端口随机
 *       是已知限制（服务器目录不可写，客户端也拿不到种子）。</li>
 * </ul>
 *
 * <p>必须在客户端主线程调用（读 {@code getSingleplayerServer()} / {@code getCurrentServer()}）。
 */
public final class WorldKey {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String MARKER_DIR = "stevex";
    private static final String MARKER_FILE = "world_id.json";
    private static final int DEFAULT_PORT = 25565;
    /** 存档文件夹名在键里的最大长度（键还要拼前缀与 uuid，整体控制在 Windows 路径预算内）。 */
    static final int MAX_FOLDER_CHARS = 32;
    /** 多人地址在键里的最大长度。 */
    static final int MAX_ADDRESS_CHARS = 64;

    private WorldKey() {
    }

    /**
     * @param key   目录名（只含 {@code [A-Za-z0-9._-]}）
     * @param kind  {@code singleplayer} / {@code multiplayer} / {@code lan} / {@code realm}
     * @param label 人看的名字（存档显示名 / 服务器列表名），不参与定位
     */
    public record Identity(String key, String kind, String label) {
    }

    /** 当前连接对应的世界身份；既非单人也拿不到服务器信息 → null（调用方不切换）。 */
    public static Identity compute(final Minecraft mc) {
        final IntegratedServer server = mc.getSingleplayerServer();
        if (server != null) {
            return singleplayer(server);
        }
        final ServerData data = mc.getCurrentServer();
        if (data != null && data.ip != null && !data.ip.isBlank()) {
            return multiplayer(data);
        }
        return null;
    }

    private static Identity singleplayer(final IntegratedServer server) {
        // LevelResource.ROOT 的 id 是 "."，不 normalize 的话 getFileName() 会拿到 "."
        final Path save = server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
        final String folder = save.getFileName() == null ? "world" : save.getFileName().toString();
        final String id = markerId(save.resolve(MARKER_DIR).resolve(MARKER_FILE), folder);
        final String label = server.getWorldData().getLevelName();
        return new Identity("sp-" + sanitize(folder, MAX_FOLDER_CHARS) + "-" + id.substring(0, 8),
                "singleplayer", label == null || label.isBlank() ? folder : label);
    }

    private static Identity multiplayer(final ServerData data) {
        final ServerAddress address = ServerAddress.parseString(data.ip.trim());
        final String host = address.getHost().toLowerCase(Locale.ROOT);
        final int port = address.getPort() > 0 ? address.getPort() : DEFAULT_PORT;
        final String kind = data.isRealm() ? "realm" : data.isLan() ? "lan" : "multiplayer";
        final String prefix = data.isRealm() ? "realm-" : data.isLan() ? "lan-" : "mp-";
        final String label = data.name == null || data.name.isBlank() ? data.ip : data.name;
        return new Identity(prefix + sanitize(host + "_" + port, MAX_ADDRESS_CHARS), kind, label);
    }

    /** 读（必要时写）存档标记，返回不带横线的 32 位 uuid。写失败 → 仍返回本次生成的 id（只是下次会换）。 */
    private static String markerId(final Path marker, final String folder) {
        try {
            if (Files.isRegularFile(marker)) {
                final JsonElement root = JsonParser.parseString(Files.readString(marker, StandardCharsets.UTF_8));
                if (root != null && root.isJsonObject()) {
                    final JsonObject obj = root.getAsJsonObject();
                    final String id = obj.has("id") ? obj.get("id").getAsString() : null;
                    final String recorded = obj.has("folder") ? obj.get("folder").getAsString() : null;
                    if (id != null && id.matches("[0-9a-f]{32}") && folder.equals(recorded)) {
                        return id;
                    }
                    if (id != null && recorded != null && !folder.equals(recorded)) {
                        LOGGER.info("[Vision] Save folder '{}' carries a marker from '{}' (copied save?) → new world id",
                                folder, recorded);
                    }
                }
            }
        } catch (IOException | RuntimeException e) {
            LOGGER.warn("[Vision] Unreadable world marker {} ({}); assigning a new world id", marker, e.getMessage());
        }
        final String id = UUID.randomUUID().toString().replace("-", "");
        final JsonObject obj = new JsonObject();
        obj.addProperty("id", id);
        obj.addProperty("folder", folder);
        try {
            Files.createDirectories(marker.getParent());
            Files.writeString(marker, obj.toString(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOGGER.warn("[Vision] Failed to write world marker {}: {}", marker, e.getMessage());
        }
        return id;
    }

    /** 只留 {@code [A-Za-z0-9._-]}，其余换 {@code _}；去掉首尾的点（Windows 不接受以点结尾的目录名）。 */
    static String sanitize(final String raw, final int maxChars) {
        String s = raw.replaceAll("[^A-Za-z0-9._-]", "_");
        if (s.length() > maxChars) s = s.substring(0, maxChars);
        s = s.replaceAll("^\\.+|\\.+$", "");
        return s.isEmpty() ? "_" : s;
    }
}
