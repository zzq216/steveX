package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;

/**
 * 方块实体 NBT 持久化存储 —— 基于文件的增量保存。
 *
 * <p>行为：
 * <ul>
 *   <li>新方块实体 → 写入存储</li>
 *   <li>NBT 未变化  → 跳过</li>
 *   <li>NBT 已变化  → 更新存储</li>
 * </ul>
 *
 * <p>文件格式（NBT）：
 * <pre>{@code
 * {
 *   "agentPos": "100.5,65.62,96.0",
 *   "agentYaw": -45.0,
 *   "agentPitch": 10.0,
 *   "agentFov": 70,
 *   "dayTime": 6000,
 *   "blockEntities": {
 *     "128,64,-32": { "typeId": "minecraft:chest", "block": "minecraft:chest",
 *                     "state": {"facing":"east","waterlogged":"false"},
 *                     "nbt": {...}, "timestamp": 1720000000 },
 *     ...
 *   }
 * }
 * }</pre>
 *
 * <p>{@code agentPos} 是最后一次采集时观察者的相机（眼睛）双精度坐标
 * （"x,y,z"，游戏精度），只维护一份顶层记录，随每次保存刷新。
 */
public class VisionBlockEntityStore {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String DIR_NAME = "stevex/vision";
    private static final String FILE_NAME = "block_entities.nbt";
    private static final String KEY_BLOCK_ENTITIES = "blockEntities";
    private static final String KEY_TYPE_ID = "typeId";
    private static final String KEY_BLOCK = "block";
    private static final String KEY_STATE = "state";
    private static final String KEY_NBT = "nbt";
    private static final String KEY_AGENT_POS = "agentPos";
    private static final String KEY_AGENT_YAW = "agentYaw";
    private static final String KEY_AGENT_PITCH = "agentPitch";
    private static final String KEY_AGENT_FOV = "agentFov";
    /** v2.21：采集时刻世界时间（dayTime），记忆世界据此对齐昼夜（§7.10）。 */
    private static final String KEY_WORLD_TIME = "dayTime";
    private static final String KEY_TIMESTAMP = "timestamp";

    /** 内存中缓存的全部已存储方块实体。key = "x,y,z" */
    private final Map<String, StoredEntry> entries = new LinkedHashMap<>();

    /** 最后一次采集时 agent 的相机（眼睛）双精度坐标（"x,y,z"），空串表示未知。 */
    private String agentPos = "";

    /** 最后一次采集时 agent 的朝向（度）；随文件持久化（v2.15）。 */
    private float agentYaw = 0.0f;
    private float agentPitch = 0.0f;

    /** 最后一次采集时 agent 的基础视场角（整数度）；随文件持久化（v2.19）。 */
    private int agentFov = 0;

    /** 最后一次采集时世界时间（dayTime，游戏时间单位；未知时 -1）；随文件持久化（v2.21，§7.10）。 */
    private long dayTime = -1L;

    private final Path filePath;
    private boolean dirty;

    public VisionBlockEntityStore() {
        this.filePath = resolveFilePath();
        load();
    }

    // ==================== 公开接口 ====================

    /**
     * 将一批快照与已有存储对比，仅写入新增或变化的条目；同时把本次采集时
     * agent 所在的坐标记录为文件顶层的最新 {@code agentPos}。
     *
     * @param snapshots 当前帧收集到的方块实体快照
     * @param agentPos 采集时观察者的相机（眼睛）双精度坐标（游戏精度），可为 null
     * @param agentYaw 采集时观察者水平朝向（度）
     * @param agentPitch 采集时观察者俯仰朝向（度）
     * @param agentFov 采集时观察者基础视场角（整数度，游戏精度）
     * @param worldTime 采集时世界时间（dayTime，游戏时间单位；无世界时 -1，v2.21）
     * @return 统计信息 { "new": n, "updated": n, "skipped": n }
     */
    public Map<String, Integer> sync(final Map<BlockPos, VisionCollector.BlockEntitySnapshot> snapshots,
                                     final Vec3 agentPos,
                                     final float agentYaw,
                                     final float agentPitch,
                                     final int agentFov,
                                     final long worldTime) {
        int added = 0, updated = 0, skipped = 0;

        // 顶层 agent 坐标：只在发生变化时标记 dirty，从而刷新文件
        String newAgentPos = agentPosKey(agentPos);
        if (!newAgentPos.equals(this.agentPos)) {
            this.agentPos = newAgentPos;
            dirty = true;
        }
        // v2.15：顶层 agent 朝向，变化时同样标记 dirty（记忆世界据此跟随观察者视角）
        if (Math.abs(agentYaw - this.agentYaw) > 0.001f || Math.abs(agentPitch - this.agentPitch) > 0.001f) {
            this.agentYaw = agentYaw;
            this.agentPitch = agentPitch;
            dirty = true;
        }
        // v2.19：顶层 agent 基础视场角，变化时标记 dirty（记忆世界据此同步视场角）
        if (agentFov != this.agentFov) {
            this.agentFov = agentFov;
            dirty = true;
        }
        // v2.21：顶层世界时间，变化时标记 dirty（§7.10；世界静止时恒等，不触发无谓落盘）
        if (worldTime != this.dayTime) {
            this.dayTime = worldTime;
            dirty = true;
        }

        for (var entry : snapshots.entrySet()) {
            BlockPos pos = entry.getKey();
            VisionCollector.BlockEntitySnapshot snapshot = entry.getValue();
            String key = posToKey(pos);

            StoredEntry existing = entries.get(key);
            if (existing != null) {
                // 已存在 → 比较类型 / 方块 / 状态 / NBT
                if (entryEquals(existing, snapshot)) {
                    skipped++;
                    continue;
                }
                // 数据变了 → 更新
                existing.typeId = snapshot.typeId();
                existing.blockId = snapshot.blockId();
                existing.stateProps = Map.copyOf(snapshot.stateProps());
                existing.nbt = snapshot.nbt() != null ? snapshot.nbt().copy() : new CompoundTag();
                existing.timestamp = snapshot.timestamp();
                updated++;
                dirty = true;
            } else {
                // 新的 → 写入
                CompoundTag nbtCopy = snapshot.nbt() != null ? snapshot.nbt().copy() : new CompoundTag();
                entries.put(key, new StoredEntry(
                        nbtCopy,
                        snapshot.typeId(),
                        snapshot.blockId(),
                        Map.copyOf(snapshot.stateProps()),
                        snapshot.timestamp()
                ));
                added++;
                dirty = true;
            }
        }

        if (dirty) {
            save();
            dirty = false;
        }

        return Map.of("new", added, "updated", updated, "skipped", skipped);
    }

    /** 存储中已有的方块实体总数。 */
    public int size() {
        return entries.size();
    }

    /** 清除全部存储（内存 + 文件）。 */
    public void clear() {
        entries.clear();
        agentPos = "";
        agentYaw = 0.0f;
        agentPitch = 0.0f;
        agentFov = 0;
        dayTime = -1L;
        try {
            Files.deleteIfExists(filePath);
        } catch (IOException e) {
            LOGGER.warn("[Vision] Failed to delete store file: {}", e.getMessage());
        }
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
            LOGGER.info("[Vision] No existing store file, starting fresh.");
            return;
        }

        try {
            CompoundTag root = NbtIo.readCompressed(filePath, NbtAccounter.unlimitedHeap());
            if (root == null) return;

            agentPos = root.getStringOr(KEY_AGENT_POS, "");
            agentYaw = root.getFloatOr(KEY_AGENT_YAW, 0.0f);
            agentPitch = root.getFloatOr(KEY_AGENT_PITCH, 0.0f);
            agentFov = root.getIntOr(KEY_AGENT_FOV, 0);
            dayTime = root.getLongOr(KEY_WORLD_TIME, -1L);
            CompoundTag beTag = root.getCompoundOrEmpty(KEY_BLOCK_ENTITIES);
            for (String key : beTag.keySet()) {
                CompoundTag entry = beTag.getCompoundOrEmpty(key);
                entries.put(key, new StoredEntry(
                        entry.getCompoundOrEmpty(KEY_NBT),
                        entry.getStringOr(KEY_TYPE_ID, ""),
                        entry.getStringOr(KEY_BLOCK, ""),
                        propsFromNbt(entry.getCompoundOrEmpty(KEY_STATE)),
                        entry.getLongOr(KEY_TIMESTAMP, 0L)
                ));
            }
            LOGGER.info("[Vision] Loaded {} stored block entities from {}", entries.size(), filePath);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to load store file: {}", e.getMessage());
        }
    }

    private void save() {
        CompoundTag root = new CompoundTag();
        CompoundTag beTag = new CompoundTag();

        for (var e : entries.entrySet()) {
            CompoundTag entry = new CompoundTag();
            entry.putString(KEY_TYPE_ID, e.getValue().typeId);
            entry.putString(KEY_BLOCK, e.getValue().blockId);
            entry.put(KEY_STATE, propsToNbt(e.getValue().stateProps));
            entry.put(KEY_NBT, e.getValue().nbt);
            entry.putLong(KEY_TIMESTAMP, e.getValue().timestamp);
            beTag.put(e.getKey(), entry);
        }
        root.putString(KEY_AGENT_POS, agentPos);
        root.putFloat(KEY_AGENT_YAW, agentYaw);
        root.putFloat(KEY_AGENT_PITCH, agentPitch);
        root.putInt(KEY_AGENT_FOV, agentFov);
        root.putLong(KEY_WORLD_TIME, dayTime);
        root.put(KEY_BLOCK_ENTITIES, beTag);

        try {
            NbtIo.writeCompressed(root, filePath);
            LOGGER.debug("[Vision] Saved {} block entities to {}", entries.size(), filePath);
        } catch (IOException ex) {
            LOGGER.error("[Vision] Failed to save store file: {}", ex.getMessage());
        }
    }

    private static String posToKey(final BlockPos pos) {
        return pos.getX() + "," + pos.getY() + "," + pos.getZ();
    }

    /** 观察者眼睛坐标 → 存储字符串（双精度，游戏精度）；未知（null）时存空串。 */
    private static String agentPosKey(final Vec3 v) {
        return v == null ? "" : Double.toString(v.x) + "," + Double.toString(v.y) + "," + Double.toString(v.z);
    }

    private static boolean nbtEquals(final CompoundTag a, final CompoundTag b) {
        if (a == b) return true;
        if (a == null || b == null) return false;
        return a.equals(b);
    }

    /** 方块状态属性表 → NBT。 */
    private static CompoundTag propsToNbt(final Map<String, String> props) {
        CompoundTag tag = new CompoundTag();
        props.forEach(tag::putString);
        return tag;
    }

    /** NBT → 方块状态属性表（旧文件无该字段时返回空表）。 */
    private static Map<String, String> propsFromNbt(final CompoundTag tag) {
        Map<String, String> props = new LinkedHashMap<>();
        for (String key : tag.keySet()) {
            props.put(key, tag.getStringOr(key, ""));
        }
        return props;
    }

    /** 比较条目的全部字段（类型 / 方块 / 状态 / NBT），决定是否跳过或更新。 */
    private static boolean entryEquals(
            final StoredEntry existing,
            final VisionCollector.BlockEntitySnapshot snapshot
    ) {
        return existing.typeId.equals(snapshot.typeId())
                && existing.blockId.equals(snapshot.blockId())
                && existing.stateProps.equals(snapshot.stateProps())
                && nbtEquals(existing.nbt, snapshot.nbt());
    }

    // ==================== 内部数据结构 ====================

    private static class StoredEntry {
        CompoundTag nbt;
        String typeId;
        String blockId;
        Map<String, String> stateProps;
        long timestamp;

        StoredEntry(final CompoundTag nbt, final String typeId,
                    final String blockId, final Map<String, String> stateProps,
                    final long timestamp) {
            this.nbt = nbt;
            this.typeId = typeId;
            this.blockId = blockId;
            this.stateProps = stateProps;
            this.timestamp = timestamp;
        }
    }
}
