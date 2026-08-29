package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.LongArrayTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;

/**
 * 地形方块 NBT 持久化存储 —— 每次采集整体覆盖写。
 *
 * <p>与 {@link VisionBlockEntityStore}（增量合并）不同，地形是"当前世界状态"的快照，
 * 每次 API 触发时用本次扫描的结果<b>整体替换</b>旧内容。
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
 *   "blocks": {
 *     "128,64,-32": { "block": "minecraft:stone", "state": {} },
 *     ...
 *   },
 *   "deletions": [ 819874916943... , ... ]
 * }
 * }</pre>
 *
 * <p>v2（GPU 深度缓冲驱动）：不再写 {@code scannedSections}——记忆世界侧读到空集合 →
 * 移除权威永不触发 → 自动变成<b>纯累积语义</b>（只增不删，见设计 §6.1/§7.1）。
 *
 * <p>v2.23（§7.11）：顶层新增 {@code deletions}（BlockPos long 列表）——采集侧 {@link DeletionJudge}
 * 用记忆侧反向通道 cells 文件逐块深度判定出的「被证明已消失」的记忆格。记忆世界侧
 * {@code DeletionApplier} 据此减量删除。v2.22 的 {@code surface}/@{@code skyRays} 字段已移除。
 */
public class VisionTerrainStore {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String DIR_NAME = "stevex/vision";
    private static final String FILE_NAME = "terrain.nbt";
    private static final String KEY_AGENT_POS = "agentPos";
    private static final String KEY_AGENT_YAW = "agentYaw";
    private static final String KEY_AGENT_PITCH = "agentPitch";
    private static final String KEY_AGENT_FOV = "agentFov";
    private static final String KEY_TIMESTAMP = "timestamp";
    /** v2.21：采集时刻世界时间（dayTime），记忆世界据此对齐昼夜（§7.10）。 */
    private static final String KEY_WORLD_TIME = "dayTime";
    private static final String KEY_BLOCKS = "blocks";
    private static final String KEY_BLOCK = "block";
    private static final String KEY_STATE = "state";
    /** v2.23（§7.11）：被证明消失的记忆格（BlockPos long 数组，采集侧 DeletionJudge 产出）。 */
    private static final String KEY_DELETIONS = "deletions";

    private final Path filePath;

    public VisionTerrainStore() {
        Path dir = Minecraft.getInstance().gameDirectory.toPath().resolve(DIR_NAME);
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            LOGGER.error("[Vision] Failed to create directory {}: {}", dir, e.getMessage());
        }
        this.filePath = dir.resolve(FILE_NAME);
    }

    /**
     * 用本次采集结果整体覆盖写地形存储（v2：内容 = 本次<b>可见</b>方块，含半透明方块）。
     *
     * @param blocks 本次可见方块（key = 方块坐标）
     * @param deletions v2.23：被证明消失的记忆格（采集侧 DeletionJudge 产出，可空）
     * @param agentPos 采集时观察者的相机（眼睛）双精度坐标（游戏精度），可为 null
     * @param agentYaw 采集时观察者水平朝向（度）
     * @param agentPitch 采集时观察者俯仰朝向（度）
     * @param agentFov 采集时观察者基础视场角（整数度，游戏精度）
     * @param worldTime 采集时世界时间（dayTime，游戏时间单位；无世界时 -1，v2.21）
     * @return 统计信息 { "blocks": n, "deletions": n }
     */
    public Map<String, Object> sync(
            final Map<BlockPos, VisionCollector.TerrainBlockSnapshot> blocks,
            final List<BlockPos> deletions,
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

        CompoundTag blocksTag = new CompoundTag();
        for (var e : blocks.entrySet()) {
            CompoundTag entry = new CompoundTag();
            entry.putString(KEY_BLOCK, e.getValue().blockId());
            entry.put(KEY_STATE, propsToNbt(e.getValue().stateProps()));
            blocksTag.put(posKey(e.getKey()), entry);
        }
        root.put(KEY_BLOCKS, blocksTag);

        // v2.23：deletions 恒写（空 = 本帧无删除证据）。旧文件无该键 → 记忆世界侧读为空列表，兼容。
        final long[] arr = new long[deletions.size()];
        for (int i = 0; i < deletions.size(); i++) {
            arr[i] = deletions.get(i).asLong();
        }
        root.put(KEY_DELETIONS, new LongArrayTag(arr));

        try {
            NbtIo.writeCompressed(root, filePath);
            LOGGER.debug("[Vision] Saved terrain: {} blocks, {} deletions to {}",
                    blocks.size(), deletions.size(), filePath);
        } catch (IOException ex) {
            LOGGER.error("[Vision] Failed to save terrain store: {}", ex.getMessage());
        }

        return Map.of("blocks", blocks.size(), "deletions", deletions.size());
    }

    // ==================== 内部 ====================

    private static String posKey(final BlockPos pos) {
        return pos.getX() + "," + pos.getY() + "," + pos.getZ();
    }

    /** 观察者眼睛坐标 → 存储字符串（双精度，游戏精度）；未知（null）时存空串。 */
    private static String agentPosKey(final Vec3 v) {
        return v == null ? "" : Double.toString(v.x) + "," + Double.toString(v.y) + "," + Double.toString(v.z);
    }

    /** 方块状态属性表 → NBT。 */
    private static CompoundTag propsToNbt(final Map<String, String> props) {
        CompoundTag tag = new CompoundTag();
        props.forEach(tag::putString);
        return tag;
    }
}
