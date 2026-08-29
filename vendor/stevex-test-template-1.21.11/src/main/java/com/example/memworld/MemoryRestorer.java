package com.example.memworld;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 记忆世界复原引擎。
 *
 * <p>由 {@link MemoryWorldManager} 在每个服务器 tick 驱动。定期读取源 NBT 文件，
 * <b>仅在文件内容发生变化时</b>对世界做增量更新：新增的放置、变化的覆盖。
 *
 * <p><b>纯累积语义（v2，§7）</b>：只增不删——条目永不移除；失效条目的清除职责移交
 * {@link TerrainRestorer}（方块类型改变且新方块无方块实体时经 {@link #clearStale} 主动清除），
 * 另在 {@link #place} 加世界权威校验兜底（防止重启 / 文件残留导致"石头里的箱子实体"类 ghosting）。
 *
 * <p>坐标处理：不做任何平移，NBT 里的方块坐标严格对应世界坐标。
 */
public class MemoryRestorer {

    private static final Logger LOGGER = LoggerFactory.getLogger("stevex-test/memory");

    private static final String KEY_BLOCK_ENTITIES = "blockEntities";
    private static final String KEY_BLOCK = "block";
    private static final String KEY_STATE = "state";
    private static final String KEY_NBT = "nbt";
    private static final String KEY_AGENT_POS = "agentPos";
    private static final String KEY_AGENT_YAW = "agentYaw";
    private static final String KEY_AGENT_PITCH = "agentPitch";
    private static final String KEY_AGENT_FOV = "agentFov";
    /** v2.21：采集时刻世界时间（dayTime），记忆世界据此对齐昼夜（§7.10）。 */
    private static final String KEY_WORLD_TIME = "dayTime";

    /** v2.19：基础视场角"缺失"哨兵值（旧文件无 agentFov）；FOV 合法范围为 [70,110]，-1 恒安全。 */
    private static final int FOV_MISSING = -1;

    /** v2.18：agent 位置比较容差（1 mm），过滤双精度坐标下的浮点抖动。 */
    private static final double POS_EPSILON = 1e-3;

    /** 已应用的世界状态：方块坐标 -> 内容指纹（block+state+nbt）。 */
    private final Map<BlockPos, String> applied = new LinkedHashMap<>();

    /** 已应用版本的源文件内容指纹；为 null 表示需要重新读取。 */
    private String appliedFingerprint = null;

    /** v2.13 mtime 门控（§7.4）：最近一次成功读取的源文件 mtime；未变 → 不读不解压。 */
    private FileTime lastMtime;

    /** v2.15：最近一次触发传送的 agent 视角（位置 + 朝向）；未变 → 不重复传送。 */
    private AgentPose lastPose;

    /** v2.21：最近一次应用的世界时间（dayTime）；旧文件无该字段时 -1（哨兵）。 */
    private long lastDayTime = -1L;

    private int ticks;
    private int missingSourceCounter;

    /** 服务器（世界）启动 / 切换时调用，清空已应用状态。 */
    public void onServerStart() {
        applied.clear();
        appliedFingerprint = null;
        lastMtime = null;
        lastPose = null;
        lastDayTime = -1L;
        ticks = 0;
        LOGGER.info("[MemoryWorld] Restorer ready");
    }

    /** 命令触发：强制重新读取源文件。须同时清 mtime 门控，否则 mtime 相同会被提前拦下。 */
    public void forceRefresh() {
        appliedFingerprint = null;
        lastMtime = null;
        lastPose = null;
    }

    /**
     * v2.10：清除指定位置的旧方块实体记录（由 {@link TerrainRestorer} 在方块类型改变、且新方块
     * 无方块实体时调用）。
     *
     * <p>{@code block_entities.nbt} 增量合并永不删除旧条目 → 若不清除，重启后该位置的旧 BE 会被
     * 重新放回世界（"石头里的箱子实体"类 ghosting）。世界内旧 BE 已由 TerrainRestorer 的 setBlock
     * 一并移除，这里只需从已应用表忘记它；若文件里仍有该条目，后续读取由 {@link #place} 的世界
     * 权威校验兜底跳过（自愈）。
     *
     * <p>该位置没有已应用记录时是廉价 no-op。
     */
    public void clearStale(final BlockPos pos) {
        applied.remove(pos);
    }

    /**
     * 驱动一次轮询：源文件 mtime 变化时读取并（按需）同步方块实体。
     *
     * <p>v2.15：返回值用于「跟随观察者视角」——当文件里的 agent 位置/朝向较上次变化时，
     * 返回新的 {@link AgentPose} 供 {@code MemoryWorldManager} 传送玩家；未变化 / 未更新时
     * 返回 null。
     */
    public AgentPose tick(final ServerLevel level) {
        MemoryConfig config = MemoryConfig.get();
        if (ticks++ % Math.max(1, config.pollIntervalTicks) != 0) return null;

        Path source = config.resolveSourceFile();
        if (source == null || !Files.exists(source)) {
            // 每 30 次轮询（约 30 秒）告警一次，避免刷屏
            if (missingSourceCounter++ % 30 == 0) {
                LOGGER.warn("[MemoryWorld] Source file missing, updates paused (gameDir={}). "
                        + "Set 'sourceFile' in config/stevex-test/memory.json.",
                        config.gameDirectory());
            }
            appliedFingerprint = null;
            lastMtime = null; // 文件重新出现后自然触发首次读取
            return null;
        }
        missingSourceCounter = 0;

        // v2.13 mtime 门控（§7.4）：文件只在采集器侧 vision/snapshot 落盘时变化 → 以 mtime 作为
        // 快照到达信号。mtime 未变 → 不读不解压（空闲成本≈0）。
        final FileTime mtime;
        try {
            mtime = Files.getLastModifiedTime(source);
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to stat source file {}: {}", source, e.getMessage());
            return null;
        }
        if (mtime.equals(lastMtime)) return null;

        FileData current = readFile(source);
        if (current == null) return null; // 写入半截等 → 保留旧 mtime，下轮重试

        lastMtime = mtime; // 只在成功读取后才推进

        // v2.21：世界时间对齐（§7.10）——dayTime >= 0（旧文件无该字段 → -1 哨兵）且较上次变化时
        // setDayTime。与内容指纹 / 视角跟随解耦：agent 站桩不动时，方块与视角不变，但昼夜仍随每次
        // 采集对齐。与 advance_time=false 不冲突——setDayTime 直接设值，不依赖 tickTime 自增。
        if (current.dayTime() >= 0 && current.dayTime() != lastDayTime) {
            level.setDayTime(current.dayTime());
            lastDayTime = current.dayTime();
            LOGGER.info("[MemoryWorld] Day time synced to {} ({})", current.dayTime(),
                    current.dayTime() % 24000L);
        }

        // 内容指纹变化 → 同步方块实体；与下面的视角跟随解耦（视角变化不要求方块实体变化）
        String fp = fingerprint(current.blocks());
        if (!fp.equals(appliedFingerprint)) {
            appliedFingerprint = fp;
            sync(level, current.blocks());
        }

        // v2.15：agent 视角变化 → 返回新 pose 触发传送（与内容指纹解耦）
        AgentPose pose = current.pose();
        if (pose != null && !samePose(lastPose, pose)) {
            lastPose = pose;
            return pose;
        }
        return null;
    }

    // ==================== 差异计算与应用 ====================

    private void sync(final ServerLevel level, final Map<BlockPos, StoredBlock> current) {
        if (current.isEmpty()) return; // 空记忆，无需放置

        Map<BlockPos, String> next = new LinkedHashMap<>();
        List<BlockPos> toPlace = new ArrayList<>();

        for (Map.Entry<BlockPos, StoredBlock> e : current.entrySet()) {
            BlockPos pos = e.getKey();
            String key = e.getValue().fingerprint();
            next.put(pos, key);
            if (!key.equals(applied.get(pos))) toPlace.add(pos);
        }

        if (toPlace.isEmpty()) return;

        int placed = 0;
        for (BlockPos pos : toPlace) {
            StoredBlock sb = current.get(pos);
            if (sb != null && place(level, pos, sb)) placed++;
        }

        applied.clear();
        applied.putAll(next);

        LOGGER.info("[MemoryWorld] Sync: +{} placed, total {} entries", placed, applied.size());
    }

    private boolean place(final ServerLevel level, final BlockPos pos, final StoredBlock sb) {
        try {
            BlockState state = BlockStateUtil.fromSaved(sb.blockId(), sb.state());
            // v2.10 世界权威校验：当前世界方块与 BE 记录的方块不一致（terrain 已把该位置换成别的方块
            // → 该 BE 条目失效），跳过放置，防止"石头里的箱子实体"类 ghosting。TerrainRestorer 在本类
            // 之前执行（见 MemoryWorldManager），此处读到的世界方块即最新地形。世界为空气时允许放置
            // （BE 数据是自身方块的权威来源）。
            BlockState worldState = level.getBlockState(pos);
            if (!worldState.isAir() && worldState.getBlock() != state.getBlock()) {
                return false;
            }
            // v2.21 静默放置（§7.9 陷阱 ①）：UPDATE_CLIENTS | UPDATE_SKIP_ALL_SIDEEFFECTS = 2 | 816 = 818。
            // 不含 UPDATE_NEIGHBORS(bit1) → 不触发邻居 updateShape / neighborChanged；
            // 不含 UPDATE_KNOWN_SHAPE(bit16) → 不传播形状更新；不含 UPDATE_SKIP_ON_PLACE 之外的效果（816 含
            // 512 SKIP_ON_PLACE / 256 SKIP_BE_SIDEEFFECTS / 32 SUPPRESS_DROPS / 16 KNOWN_SHAPE）→ 挂墙方块
            // 不因支撑方块未放置被破坏、红石线保留采集时连接、被替换方块不掉落物；保留 bit2 客户端同步。
            level.setBlock(pos, state, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);

            if (sb.nbt() != null && !sb.nbt().isEmpty()) {
                CompoundTag nbt = sb.nbt().copy();
                // 用目标坐标覆盖 nbt 里的位置字段，防止残留源世界坐标
                nbt.putInt("x", pos.getX());
                nbt.putInt("y", pos.getY());
                nbt.putInt("z", pos.getZ());

                BlockEntity be = BlockEntity.loadStatic(pos, state, nbt, level.registryAccess());
                if (be != null) {
                    be.setLevel(level);
                    level.setBlockEntity(be);
                }
            }
            return true;
        } catch (Exception e) {
            LOGGER.warn("[MemoryWorld] Failed to place {} at {}: {}", sb.blockId(), pos, e.getMessage());
            return false;
        }
    }

    // ==================== 读取源文件 ====================

    private FileData readFile(final Path source) {
        try {
            CompoundTag root = NbtIo.readCompressed(source, NbtAccounter.unlimitedHeap());
            if (root == null) return new FileData(Map.of(), null, -1L);

            CompoundTag beTag = root.getCompoundOrEmpty(KEY_BLOCK_ENTITIES);
            Map<BlockPos, StoredBlock> out = new LinkedHashMap<>();
            for (String key : beTag.keySet()) {
                BlockPos pos = parsePos(key);
                if (pos == null) continue;

                CompoundTag entry = beTag.getCompoundOrEmpty(key);
                String blockId = entry.getStringOr(KEY_BLOCK, "");
                Map<String, String> state = readState(entry.getCompoundOrEmpty(KEY_STATE));
                CompoundTag nbt = entry.getCompoundOrEmpty(KEY_NBT);
                out.put(pos, new StoredBlock(blockId, state, nbt));
            }
            return new FileData(out, readPose(root), root.getLongOr(KEY_WORLD_TIME, -1L));
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to read source file {}: {}", source, e.getMessage());
            return null;
        }
    }

    /**
     * 从文件顶层读取 agent 视角（眼睛位置 + yaw/pitch + 基础视场角）。
     *
     * <p>v2.18：位置改为双精度眼睛坐标；旧整数格式（如 {@code "100,64,96"}）仍可解析
     * （{@link #parseVec3} 用 {@code Double.parseDouble} 兼容）。旧文件无
     * {@code agentYaw}/{@code agentPitch} → 朝向填 NaN，传送时沿用玩家当前朝向；
     * v2.19：旧文件无 {@code agentFov} → FOV 填 {@link #FOV_MISSING}，沿用玩家当前视场角。
     * 位置缺失 / 解析失败 → 返回 null。
     */
    private static AgentPose readPose(final CompoundTag root) {
        Vec3 pos = parseVec3(root.getStringOr(KEY_AGENT_POS, ""));
        if (pos == null) return null;
        float yaw = root.contains(KEY_AGENT_YAW) ? root.getFloatOr(KEY_AGENT_YAW, 0.0f) : Float.NaN;
        float pitch = root.contains(KEY_AGENT_PITCH) ? root.getFloatOr(KEY_AGENT_PITCH, 0.0f) : Float.NaN;
        int fov = root.contains(KEY_AGENT_FOV) ? root.getIntOr(KEY_AGENT_FOV, FOV_MISSING) : FOV_MISSING;
        return new AgentPose(pos, yaw, pitch, fov);
    }

    /** 两个 agent 视角是否「等价」：位置差 < {@link #POS_EPSILON}，且 yaw/pitch 差在 0.5° 内（过滤抖动）。 */
    private static boolean samePose(final AgentPose a, final AgentPose b) {
        if (a == b) return true;
        if (a == null || b == null) return false;
        return posEquals(a.pos(), b.pos())
                && rotEquals(a.yaw(), b.yaw())
                && rotEquals(a.pitch(), b.pitch())
                && fovEquals(a.fov(), b.fov());
    }

    /** v2.18：位置比较（双精度，1 mm 容差）。 */
    private static boolean posEquals(final Vec3 a, final Vec3 b) {
        return Math.abs(a.x - b.x) < POS_EPSILON
                && Math.abs(a.y - b.y) < POS_EPSILON
                && Math.abs(a.z - b.z) < POS_EPSILON;
    }

    /** 朝向相等判定：任一为 NaN（旧文件未记录）视为相等；否则差在 0.5° 内。 */
    private static boolean rotEquals(final float x, final float y) {
        if (Float.isNaN(x) || Float.isNaN(y)) return true;
        return Math.abs(x - y) < 0.5f;
    }

    /** FOV 相等判定：任一为 {@link #FOV_MISSING}（旧文件未记录）视为相等；否则严格相等。 */
    private static boolean fovEquals(final int x, final int y) {
        return x == FOV_MISSING || y == FOV_MISSING || x == y;
    }

    private static Map<String, String> readState(final CompoundTag stateTag) {
        Map<String, String> state = new LinkedHashMap<>();
        for (String k : stateTag.keySet()) {
            state.put(k, stateTag.getStringOr(k, ""));
        }
        return state;
    }

    private static BlockPos parsePos(final String key) {
        String[] parts = key.split(",");
        if (parts.length != 3) return null;
        try {
            return new BlockPos(
                    Integer.parseInt(parts[0].trim()),
                    Integer.parseInt(parts[1].trim()),
                    Integer.parseInt(parts[2].trim())
            );
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 观察者眼睛坐标字符串 → Vec3（双精度）；旧整数格式（如 {@code "100,64,96"}）同样可解析。 */
    private static Vec3 parseVec3(final String key) {
        if (key == null || key.isBlank()) return null;
        String[] parts = key.split(",");
        if (parts.length != 3) return null;
        try {
            return new Vec3(
                    Double.parseDouble(parts[0].trim()),
                    Double.parseDouble(parts[1].trim()),
                    Double.parseDouble(parts[2].trim())
            );
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 内容指纹：整张表的字符串表示（同一文件内容读取结果稳定）。 */
    private static String fingerprint(final Map<BlockPos, StoredBlock> entries) {
        return entries.toString();
    }

    // ==================== 数据结构 ====================

    private record StoredBlock(String blockId, Map<String, String> state, CompoundTag nbt) {
        String fingerprint() {
            return blockId + "|" + state + "|" + nbt;
        }
    }

    /** agent 视角：眼睛位置（双精度，v2.18）+ 朝向（v2.15）+ 基础视场角（v2.19）。
     *  yaw/pitch 为 NaN、fov 为 {@link #FOV_MISSING} 表示旧文件未记录对应字段。 */
    public record AgentPose(Vec3 pos, float yaw, float pitch, int fov) {}

    /**
     * 一次文件读取结果：方块实体表 + agent 视角 + 世界时间（dayTime，v2.21）。
     * dayTime 为 {@code -1} 表示旧文件无该字段（不应用时间对齐）。
     */
    private record FileData(Map<BlockPos, StoredBlock> blocks, AgentPose pose, long dayTime) {}
}
