package name.modid.vision;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import org.slf4j.Logger;

/**
 * v2.55（多世界记忆隔离，见 docs/多世界记忆隔离设计方案.md §3）：{@code stevex/vision/} 根目录下的
 * 指针文件与每个世界目录的元数据。
 *
 * <pre>{@code
 * stevex/vision/
 *   current.json     { worldKey, dir, kind, label, inWorld, since }   ← 三端都靠它找当前世界
 *   worlds/<worldKey>/
 *     world.json     { worldKey, kind, label, firstSeen, lastSeen }   ← 只给人和工具辨认，读写不依赖
 *     terrain.nbt ...（各 store 原样）
 *   worlds/_legacy/  v2.55 之前散在根目录的旧数据（D7：不自动使用）
 * }</pre>
 *
 * <p>{@code current.json} 一律先写 {@code .tmp} 再改名（读端是另外两个进程，按 mtime 轮询）。
 */
final class CurrentWorldFile {

    private static final Logger LOGGER = LogUtils.getLogger();
    static final String CURRENT_FILE = "current.json";
    static final String WORLDS_DIR = "worlds";
    static final String WORLD_META_FILE = "world.json";
    static final String LEGACY_DIR = "_legacy";

    /** v2.55 之前直接放在 {@code stevex/vision/} 下的条目（含更早的单文件形态与写到一半的 .tmp）。 */
    private static final List<String> LEGACY_ENTRIES = List.of(
            "terrain.nbt", "entities.nbt", "entities_union.nbt",
            "terrain_union", "block_entities", "containers", "biomes",
            "terrain_union.nbt", "block_entities.nbt", "containers.nbt", "biomes.nbt",
            "memory_cells.bin", "memory_sprites.bin");

    private CurrentWorldFile() {
    }

    static Path worldDir(final Path root, final String worldKey) {
        return root.resolve(WORLDS_DIR).resolve(worldKey);
    }

    /** 写指针（进入世界 = inWorld:true；退出 = 同一 worldKey 的 inWorld:false，D5）。 */
    static void writeCurrent(final Path root, final WorldKey.Identity id, final boolean inWorld) {
        final JsonObject obj = new JsonObject();
        obj.addProperty("worldKey", id.key());
        obj.addProperty("dir", WORLDS_DIR + "/" + id.key());
        obj.addProperty("kind", id.kind());
        obj.addProperty("label", id.label());
        obj.addProperty("inWorld", inWorld);
        obj.addProperty("since", System.currentTimeMillis());
        try {
            Files.createDirectories(root);
            writeAtomic(root.resolve(CURRENT_FILE), obj);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to write {}: {}", root.resolve(CURRENT_FILE), e.getMessage());
        }
    }

    /** 更新世界目录的 world.json（保留首次见到的时间）。 */
    static void touchWorldMeta(final Path worldDir, final WorldKey.Identity id) {
        final Path file = worldDir.resolve(WORLD_META_FILE);
        final long now = System.currentTimeMillis();
        long firstSeen = now;
        try {
            if (Files.isRegularFile(file)) {
                final JsonElement root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8));
                if (root != null && root.isJsonObject() && root.getAsJsonObject().has("firstSeen")) {
                    firstSeen = root.getAsJsonObject().get("firstSeen").getAsLong();
                }
            }
        } catch (IOException | RuntimeException e) {
            // 元数据坏了不影响任何读写：重写一份即可
        }
        final JsonObject obj = new JsonObject();
        obj.addProperty("worldKey", id.key());
        obj.addProperty("kind", id.kind());
        obj.addProperty("label", id.label());
        obj.addProperty("firstSeen", firstSeen);
        obj.addProperty("lastSeen", now);
        try {
            Files.createDirectories(worldDir);
            writeAtomic(file, obj);
        } catch (IOException e) {
            LOGGER.warn("[Vision] Failed to write {}: {}", file, e.getMessage());
        }
    }

    /**
     * D7：首次升级时把根目录下的旧数据整体移进 {@code worlds/_legacy/}（不自动使用；想继续用就手动把它
     * 改名成对应的 worldKey）。只在 {@code current.json} 还不存在时做——之后根目录若再出现零散文件
     * （例如旧版记忆端写的 cells），不再搬动。
     */
    static void migrateLegacyIfNeeded(final Path root) {
        if (Files.exists(root.resolve(CURRENT_FILE))) return;
        boolean any = false;
        for (String name : LEGACY_ENTRIES) {
            if (Files.exists(root.resolve(name))) {
                any = true;
                break;
            }
        }
        if (!any) return;
        Path target = root.resolve(WORLDS_DIR).resolve(LEGACY_DIR);
        if (Files.exists(target)) {
            target = root.resolve(WORLDS_DIR).resolve(LEGACY_DIR + "-" + System.currentTimeMillis());
        }
        try {
            Files.createDirectories(target);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to create {}: {}", target, e.getMessage());
            return;
        }
        int moved = 0;
        for (String name : LEGACY_ENTRIES) {
            final Path src = root.resolve(name);
            if (!Files.exists(src)) continue;
            try {
                Files.move(src, target.resolve(name));
                moved++;
            } catch (IOException e) {
                LOGGER.warn("[Vision] Failed to move legacy {} → {}: {}", src, target, e.getMessage());
            }
        }
        LOGGER.info("[Vision] Moved {} pre-v2.55 memory entr{} into {} (not used automatically)",
                moved, moved == 1 ? "y" : "ies", target);
    }

    private static void writeAtomic(final Path target, final JsonObject obj) throws IOException {
        final Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
        Files.writeString(tmp, new GsonBuilder().setPrettyPrinting().create().toJson(obj), StandardCharsets.UTF_8);
        try {
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException atomicFailure) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
