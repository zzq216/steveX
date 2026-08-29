package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.FloatTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;

/**
 * 实体 NBT 持久化存储 —— 每次采集整体覆盖写（快照式，仿 {@link VisionTerrainStore}）。
 *
 * <p><b>只存轻量物理状态，不存每实体全量 NBT</b>——全量 NBT 走
 * {@link VisionCollector#collectEntityNbt} 按需查询，避免 GC 风暴。
 * 记忆世界侧用这份文件 + {@code scannedSections} 权威集做新增 / 移动 / 移除。
 *
 * <p>文件格式（NBT）：
 * <pre>{@code
 * {
 *   "agentPos": "100.5,65.62,96.0",
 *   "agentYaw": -45.0,
 *   "agentPitch": 10.0,
 *   "agentFov": 70,
 *   "dayTime": 6000,
 *   "timestamp": 1720000000,
 *   "entities": {
 *     "<uuid>": {
 *       "id": 42,
 *       "type": "minecraft:zombie",
 *       "pos": [x, y, z],
 *       "motion": [vx, vy, vz],
 *       "rotation": [yaw, pitch],
 *       "onGround": 1b,
 *       "health": 20.0f
 *     },
 *     ...
 *   }
 * }
 * }</pre>
 *
 * <p>v2（GPU 深度缓冲驱动）：不再写 {@code scannedSections}——记忆世界侧读到空集合 →
 * 移除权威永不触发 → 自动变成<b>纯累积语义</b>（只增不删，见设计 §6.1/§7.1）。
 */
public class VisionEntityStore {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String DIR_NAME = "stevex/vision";
    private static final String FILE_NAME = "entities.nbt";
    private static final String KEY_AGENT_POS = "agentPos";
    private static final String KEY_AGENT_YAW = "agentYaw";
    private static final String KEY_AGENT_PITCH = "agentPitch";
    private static final String KEY_AGENT_FOV = "agentFov";
    private static final String KEY_TIMESTAMP = "timestamp";
    /** v2.21：采集时刻世界时间（dayTime），记忆世界据此对齐昼夜（§7.10）。 */
    private static final String KEY_WORLD_TIME = "dayTime";
    private static final String KEY_ENTITIES = "entities";
    private static final String KEY_ID = "id";
    private static final String KEY_TYPE = "type";
    private static final String KEY_POS = "pos";
    private static final String KEY_MOTION = "motion";
    private static final String KEY_ROTATION = "rotation";
    private static final String KEY_ON_GROUND = "onGround";
    private static final String KEY_HEALTH = "health";

    private final Path filePath;

    public VisionEntityStore() {
        Path dir = Minecraft.getInstance().gameDirectory.toPath().resolve(DIR_NAME);
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to create directory {}: {}", dir, e.getMessage());
        }
        this.filePath = dir.resolve(FILE_NAME);
    }

    /**
     * 用本次采集结果整体覆盖写实体存储（v2：内容 = 本次<b>可见</b>实体）。
     *
     * @param entities 本次可见实体轻量快照
     * @param agentPos 采集时观察者的相机（眼睛）双精度坐标（游戏精度），可为 null
     * @param agentYaw 采集时观察者水平朝向（度）
     * @param agentPitch 采集时观察者俯仰朝向（度）
     * @param agentFov 采集时观察者基础视场角（整数度，游戏精度）
     * @param worldTime 采集时世界时间（dayTime，游戏时间单位；无世界时 -1，v2.21）
     * @return 统计信息 { "entities": n }
     */
    public Map<String, Object> sync(
            final List<VisionCollector.EntityLightSnapshot> entities,
            final Vec3 agentPos,
            final float agentYaw,
            final float agentPitch,
            final int agentFov,
            final long worldTime
    ) {
        CompoundTag root = new CompoundTag();
        root.putString(KEY_AGENT_POS, agentPosKey(agentPos));
        root.putFloat(KEY_AGENT_YAW, agentYaw);
        root.putFloat(KEY_AGENT_PITCH, agentPitch);
        root.putInt(KEY_AGENT_FOV, agentFov);
        root.putLong(KEY_WORLD_TIME, worldTime);
        root.putLong(KEY_TIMESTAMP, System.currentTimeMillis());

        CompoundTag entitiesTag = new CompoundTag();
        for (VisionCollector.EntityLightSnapshot e : entities) {
            CompoundTag entry = new CompoundTag();
            entry.putInt(KEY_ID, e.id());
            entry.putString(KEY_TYPE, e.typeId());
            entry.put(KEY_POS, doubleList(e.x(), e.y(), e.z()));
            entry.put(KEY_MOTION, doubleList(e.vx(), e.vy(), e.vz()));
            entry.put(KEY_ROTATION, floatList(e.yaw(), e.pitch()));
            entry.putBoolean(KEY_ON_GROUND, e.onGround());
            entry.putFloat(KEY_HEALTH, e.health());
            entitiesTag.put(e.uuid().toString(), entry);
        }
        root.put(KEY_ENTITIES, entitiesTag);

        try {
            NbtIo.writeCompressed(root, filePath);
            LOGGER.debug("[Vision] Saved entities: {} entities to {}", entities.size(), filePath);
        } catch (IOException ex) {
            LOGGER.error("[Vision] Failed to save entity store: {}", ex.getMessage());
        }

        return Map.of("entities", entities.size());
    }

    // ==================== 内部 ====================

    private static String agentPosKey(final Vec3 v) {
        return v == null ? "" : Double.toString(v.x) + "," + Double.toString(v.y) + "," + Double.toString(v.z);
    }

    private static ListTag doubleList(final double... values) {
        ListTag list = new ListTag();
        for (double v : values) {
            list.add(DoubleTag.valueOf(v));
        }
        return list;
    }

    private static ListTag floatList(final float... values) {
        ListTag list = new ListTag();
        for (float v : values) {
            list.add(FloatTag.valueOf(v));
        }
        return list;
    }
}
