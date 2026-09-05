package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import org.slf4j.Logger;

/**
 * 容器 / 末影箱内容记忆持久化（设计 §5.2.2，v2.28 → v2.30）。
 *
 * <p>与视觉 L1 store（{@link VisionBlockEntityStore} 每帧整文件覆盖写）不同：本 store 是
 * <b>交互提交路径的唯一写者、低频事件驱动</b>——只在一次容器会话提交（close/commit）时
 * 整文件 read-modify-write，无竞态（§5.2.2 定案 A 的"独立文件单写者"理由）。
 *
 * <p>文件格式（NBT，契约见 §5.2.2「文件契约」）：
 * <pre>{@code
 * { version: 1,
 *   containers: {
 *     "x,y,z": { "typeId": "minecraft:chest", "block": "minecraft:chest",
 *                "state": {"facing":"east","type":"single",...},
 *                "items": [ {"slot": 0, "item": <ItemStack.CODEC 编码 tag>}, ... ] }, ...
 *   },
 *   enderInventory: { "items": [ {"slot": 0, "item": ...}, ... ] }   // v2.29 玩家态（可选段）
 * } }</pre>
 */
public class ContainerMemoryStore {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String DIR_NAME = "stevex/vision";
    private static final String FILE_NAME = "containers.nbt";
    private static final String KEY_VERSION = "version";
    private static final String KEY_CONTAINERS = "containers";
    private static final String KEY_ENDER_INVENTORY = "enderInventory";
    private static final String KEY_TYPE_ID = "typeId";
    private static final String KEY_BLOCK = "block";
    private static final String KEY_STATE = "state";
    private static final String KEY_ITEMS = "items";
    private static final String KEY_ITEM = "item";
    private static final String KEY_SLOT = "slot";

    private static final ContainerMemoryStore INSTANCE = new ContainerMemoryStore();

    /** 内存镜像：posKey("x,y,z") → 容器记录；启动时 load、提交时 upsert/remove。 */
    private final Map<String, StoredContainer> containers = new LinkedHashMap<>();

    /** v2.29：末影箱玩家态是否存在（有记录段才写/覆写；无 → 记忆侧不动本地末影箱）。 */
    private boolean enderPresent;
    private final List<SlotTag> enderItems = new ArrayList<>();

    private final Path filePath;
    private boolean dirty;

    private ContainerMemoryStore() {
        this.filePath = resolveFilePath();
        load();
    }

    public static ContainerMemoryStore get() {
        return INSTANCE;
    }

    // ==================== 公开接口（提交路径调用，随后 save()） ====================

    /** upsert 一条 per-pos 容器记录（double 每半一条；覆盖该键旧内容 = latest-wins，定案 C）。 */
    public void upsert(final String posKey, final String typeId, final String blockId,
                       final Map<String, String> state, final List<SlotTag> items) {
        containers.put(posKey, new StoredContainer(typeId, blockId, state, List.copyOf(items)));
        dirty = true;
    }

    /** 删除一条 per-pos 记录（double↔single 迁移：删伙伴旧键）。 */
    public void remove(final String posKey) {
        if (containers.remove(posKey) != null) {
            dirty = true;
        }
    }

    /** 覆写顶层末影箱玩家态（27 格 latest-wins；末影会话提交时调用）。 */
    public void setEnder(final List<SlotTag> items) {
        enderPresent = true;
        enderItems.clear();
        enderItems.addAll(items);
        dirty = true;
    }

    /** 一次提交完成后的整文件落盘（低频事件驱动；mtime 变化 = 记忆侧重读信号）。 */
    public void save() {
        if (!dirty) return;
        CompoundTag root = new CompoundTag();
        CompoundTag containersTag = new CompoundTag();
        for (var e : containers.entrySet()) {
            containersTag.put(e.getKey(), e.getValue().toNbt());
        }
        root.putInt(KEY_VERSION, 1);
        root.put(KEY_CONTAINERS, containersTag);
        if (enderPresent) {
            CompoundTag ender = new CompoundTag();
            ender.put(KEY_ITEMS, itemsListTag(enderItems));
            root.put(KEY_ENDER_INVENTORY, ender);
        }
        try {
            NbtIo.writeCompressed(root, filePath);
            LOGGER.info("[Vision] Container memory saved: {} containers, enderPresent={} → {}",
                    containers.size(), enderPresent, filePath);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to save container memory {}: {}", filePath, e.getMessage());
        }
        dirty = false;
    }

    public int size() {
        return containers.size();
    }

    // ==================== 内部 ====================

    private static Path resolveFilePath() {
        Path dir = Minecraft.getInstance().gameDirectory.toPath().resolve(DIR_NAME);
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to create directory {}: {}", dir, e.getMessage());
        }
        return dir.resolve(FILE_NAME);
    }

    private void load() {
        if (!Files.exists(filePath)) {
            LOGGER.info("[Vision] No existing container memory file, starting fresh.");
            return;
        }
        try {
            CompoundTag root = NbtIo.readCompressed(filePath, NbtAccounter.unlimitedHeap());
            if (root == null) return;
            CompoundTag containersTag = root.getCompoundOrEmpty(KEY_CONTAINERS);
            for (String key : containersTag.keySet()) {
                containers.put(key, StoredContainer.fromNbt(containersTag.getCompoundOrEmpty(key)));
            }
            CompoundTag ender = root.getCompoundOrEmpty(KEY_ENDER_INVENTORY);
            if (!ender.isEmpty()) {
                enderPresent = true;
                readItemsInto(ender.getListOrEmpty(KEY_ITEMS), enderItems);
            }
            LOGGER.info("[Vision] Loaded {} container records from {}", containers.size(), filePath);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to load container memory {}: {}", filePath, e.getMessage());
        }
    }

    private static ListTag itemsListTag(final List<SlotTag> items) {
        ListTag list = new ListTag();
        for (SlotTag it : items) {
            CompoundTag e = new CompoundTag();
            e.putInt(KEY_SLOT, it.slot());
            if (it.item() != null) e.put(KEY_ITEM, it.item());
            list.add(e);
        }
        return list;
    }

    private static void readItemsInto(final ListTag list, final List<SlotTag> out) {
        for (int i = 0; i < list.size(); i++) {
            CompoundTag e = list.getCompound(i).orElse(null);
            if (e == null) continue;
            int slot = e.getIntOr(KEY_SLOT, -1);
            CompoundTag item = e.getCompoundOrEmpty(KEY_ITEM);
            if (slot < 0 || item.isEmpty()) continue;
            out.add(new SlotTag(slot, item));
        }
    }

    // ==================== 数据结构 ====================

    /** 一格：菜单容器槽号 + 已编码 item tag（ItemStack.CODEC；仅非空格）。 */
    public record SlotTag(int slot, CompoundTag item) {}

    private static final class StoredContainer {
        final String typeId;
        final String blockId;
        final Map<String, String> state;
        final List<SlotTag> items;

        StoredContainer(final String typeId, final String blockId,
                        final Map<String, String> state, final List<SlotTag> items) {
            this.typeId = typeId;
            this.blockId = blockId;
            this.state = state;
            this.items = items;
        }

        CompoundTag toNbt() {
            CompoundTag entry = new CompoundTag();
            entry.putString(KEY_TYPE_ID, typeId);
            entry.putString(KEY_BLOCK, blockId);
            CompoundTag st = new CompoundTag();
            state.forEach(st::putString);
            entry.put(KEY_STATE, st);
            entry.put(KEY_ITEMS, itemsListTag(items));   // 记忆侧按 entry.getListOrEmpty(KEY_ITEMS) 读
            return entry;
        }

        static StoredContainer fromNbt(final CompoundTag entry) {
            Map<String, String> state = new LinkedHashMap<>();
            CompoundTag st = entry.getCompoundOrEmpty(KEY_STATE);
            for (String k : st.keySet()) {
                state.put(k, st.getStringOr(k, ""));
            }
            List<SlotTag> items = new ArrayList<>();
            readItemsInto(entry.getListOrEmpty(KEY_ITEMS), items);
            return new StoredContainer(
                    entry.getStringOr(KEY_TYPE_ID, ""),
                    entry.getStringOr(KEY_BLOCK, ""),
                    state,
                    items
            );
        }
    }
}
