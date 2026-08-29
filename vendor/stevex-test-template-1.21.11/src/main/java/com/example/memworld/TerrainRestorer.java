package com.example.memworld;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.LongArrayTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 记忆世界地形复原引擎 —— 与 {@link MemoryRestorer}（方块实体）并行的第二通道。
 *
 * <p>读取地形源 NBT 文件（{@code terrain.nbt}，由 stevex 视觉采集器写入），
 * <b>仅在文件内容发生变化时</b>对世界做增量更新。与方块实体通道的关键区别：
 *
 * <ul>
 *   <li><b>放置</b>：只 setBlock 方块状态，不挂方块实体（块实体由 {@link MemoryRestorer} 负责）</li>
 *   <li><b>纯累积语义（v2，§7）</b>：只放置 / 更新文件里出现的方块，<b>绝不移除</b>。
 *       已删除 v1 的 scannedSections 移除权威——被遮挡 / 移出视野的对象本来就该保留在记忆世界，
 *       无需区分"被挖掉"与"没扫到"</li>
 *   <li><b>方块实体生命周期失步防护（v2.10）</b>：当某位置方块类型改变、且新方块无方块实体时，
 *       主动清除该位置的旧方块实体记录（{@code block_entities.nbt} 增量合并永不删除 → 否则新方块
 *       位置残留旧 BE 的 ghosting，见 {@link MemoryRestorer#clearStale}）</li>
 * </ul>
 *
 * <p>{@code applied} 是纯累积的：已放置的方块在后续扫描中一直保留在表内，永不因"本次没看到"而移除。
 */
public class TerrainRestorer {

    private static final Logger LOGGER = LoggerFactory.getLogger("stevex-test/memory");

    private static final String KEY_BLOCKS = "blocks";
    private static final String KEY_BLOCK = "block";
    private static final String KEY_STATE = "state";
    /** v2.23（§7.11）删除证据：采集侧 {@code DeletionJudge} 逐块证明消失的 BlockPos 列表（LongArrayTag）。 */
    private static final String KEY_DELETIONS = "deletions";
    /** v2.22（§7.11）采集时相机（眼睛）位置 —— 相机格快路径 + 距离球参考（DeletionApplier 用）。 */
    private static final String KEY_AGENT_POS = "agentPos";

    /** 已应用的世界状态：方块坐标 -> 内容指纹（block+state）。累积，永不因"本次没看到"而移除。 */
    private final Map<BlockPos, String> applied = new LinkedHashMap<>();

    /** 方块实体通道：v2.10 失效 BE 的清除由本类驱动。 */
    private final MemoryRestorer beRestorer;

    /** 已应用版本的源文件内容指纹；为 null 表示需要重新读取。 */
    private String appliedFingerprint = null;

    /** v2.13 mtime 门控（§7.4）：最近一次成功读取的源文件 mtime；未变 → 不读不解压。 */
    private FileTime lastMtime;

    /** v2.23：世界变化版本（每次源内容变化 → sync 前递增）。{@link MemoryCellReporter} 据此触发重算 cells。 */
    private int mutationVersion;

    private int ticks;
    private int missingSourceCounter;

    public TerrainRestorer(final MemoryRestorer beRestorer) {
        this.beRestorer = beRestorer;
    }

    /** v2.23：世界变化版本。MemoryCellReporter 用它判断是否需要重算 / 重写 cells（§7.11 触发）。 */
    public int mutationVersion() {
        return mutationVersion;
    }

    /**
     * v2.23：已应用方块坐标集快照副本。MemoryCellReporter 据此做距离球过滤 + 世界状态判定
     * （§7.11 ① 实心不透明块）。纯累积：已删块仍在此表内，但上报前用世界状态过滤掉。
     */
    public Set<BlockPos> appliedBlocks() {
        return new HashSet<>(applied.keySet());
    }

    /** 服务器（世界）启动 / 切换时调用，清空已应用状态。 */
    public void onServerStart() {
        applied.clear();
        appliedFingerprint = null;
        lastMtime = null;
        mutationVersion = 0;
        ticks = 0;
        LOGGER.info("[MemoryWorld] Terrain restorer ready");
    }

    /** 命令触发：强制重新读取源文件。须同时清 mtime 门控，否则 mtime 相同会被提前拦下。 */
    public void forceRefresh() {
        appliedFingerprint = null;
        lastMtime = null;
    }

    /**
     * 驱动一次轮询：源文件 mtime 变化时读取并按需同步地形。
     *
     * <p>v2.23（§7.11）：返回值供 {@link DeletionApplier} 减量——即使方块内容未变化，只要
     * deletions 变化也返回本次读取的数据（内容未变化时返回 null 不成立：mtime 变化即读取）。
     * 返回 null 表示本轮无新数据（文件缺失 / mtime 未变 / 读取失败）。
     */
    public TerrainData tick(final ServerLevel level) {
        MemoryConfig config = MemoryConfig.get();
        if (ticks++ % Math.max(1, config.pollIntervalTicks) != 0) return null;

        Path source = config.resolveTerrainFile();
        if (source == null || !Files.exists(source)) {
            if (missingSourceCounter++ % 30 == 0) {
                LOGGER.warn("[MemoryWorld] Terrain source file missing, terrain updates paused (gameDir={}).",
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
            LOGGER.warn("[MemoryWorld] Failed to stat terrain file {}: {}", source, e.getMessage());
            return null;
        }
        if (mtime.equals(lastMtime)) return null;

        TerrainData current = readFile(source);
        if (current == null) return null; // 写入半截等 → 保留旧 mtime，下轮重试

        lastMtime = mtime; // 只在成功读取后才推进
        String fp = current.fingerprint();
        if (!fp.equals(appliedFingerprint)) {
            appliedFingerprint = fp;
            mutationVersion++; // v2.23：源内容变化（含 deletions 变化）→ 通知 MemoryCellReporter
            sync(level, current);
        }
        return current;
    }

    // ==================== 差异计算与应用 ====================

    private void sync(final ServerLevel level, final TerrainData current) {
        if (current.blocks.isEmpty()) return;

        // 累积已应用表：本次文件里的方块直接登记（无论是否变化）
        Map<BlockPos, String> nextApplied = new LinkedHashMap<>(applied);

        // 放置：文件里有、但应用表里没有或内容不同
        List<BlockPos> toPlace = new ArrayList<>();
        for (Map.Entry<BlockPos, TerrainBlock> e : current.blocks.entrySet()) {
            BlockPos pos = e.getKey();
            String fp = e.getValue().fingerprint();
            nextApplied.put(pos, fp);
            if (!fp.equals(applied.get(pos))) toPlace.add(pos);
        }

        if (toPlace.isEmpty()) return;

        int placed = 0;
        for (BlockPos pos : toPlace) {
            TerrainBlock tb = current.blocks.get(pos);
            if (tb == null) continue;
            if (place(level, pos, tb)) placed++;
            // v2.10 方块实体生命周期失步修正：新方块无方块实体 → 主动清除该位置的旧 BE 记录。
            // setBlock 已移除世界内旧 BE；这里再让 MemoryRestorer 忘掉它，防止后续按增量文件重放。
            // clearStale 对不存在的记录是廉价 no-op，因此即使方块类型未实际变化也不造成问题。
            if (!BlockStateUtil.fromSaved(tb.blockId(), tb.state()).hasBlockEntity()) {
                beRestorer.clearStale(pos);
            }
        }

        applied.clear();
        applied.putAll(nextApplied);

        LOGGER.info("[MemoryWorld] Terrain sync: +{} placed, total {} blocks", placed, applied.size());
    }

    private boolean place(final ServerLevel level, final BlockPos pos, final TerrainBlock tb) {
        try {
            BlockState state = BlockStateUtil.fromSaved(tb.blockId(), tb.state());
            // v2.21 静默放置（§7.9 陷阱 ①）：UPDATE_CLIENTS | UPDATE_SKIP_ALL_SIDEEFFECTS = 2 | 816 = 818。
            // 不含 UPDATE_NEIGHBORS(bit1) → 不触发邻居 updateShape / neighborChanged（挂墙方块不因支撑
            // 方块未放置被破坏、红石线保留采集时连接）；含 SKIP_ON_PLACE → 不触发 onPlace 副作用；
            // 含 SUPPRESS_DROPS → 被替换方块不掉落物。旧方块实体移除不受 flags 门控（LevelChunk.setBlockState
            // 方块类型变化即移除），故"setBlock 已移除世界内旧 BE"语义不变。
            level.setBlock(pos, state, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
            return true;
        } catch (Exception e) {
            LOGGER.warn("[MemoryWorld] Failed to place terrain {} at {}: {}", tb.blockId(), pos, e.getMessage());
            return false;
        }
    }

    // ==================== 读取源文件 ====================

    private TerrainData readFile(final Path source) {
        try {
            CompoundTag root = NbtIo.readCompressed(source, NbtAccounter.unlimitedHeap());
            if (root == null) return new TerrainData(Map.of(), List.of(), null);

            Map<BlockPos, TerrainBlock> blocks = new LinkedHashMap<>();
            CompoundTag blocksTag = root.getCompoundOrEmpty(KEY_BLOCKS);
            for (String key : blocksTag.keySet()) {
                BlockPos pos = parsePos(key);
                if (pos == null) continue;
                CompoundTag entry = blocksTag.getCompoundOrEmpty(key);
                String blockId = entry.getStringOr(KEY_BLOCK, "");
                Map<String, String> state = readState(entry.getCompoundOrEmpty(KEY_STATE));
                blocks.put(pos, new TerrainBlock(blockId, state));
            }
            // v2.23：采集侧 DeletionJudge 逐块证明消失的格（LongArrayTag）。旧文件无该键 → 空列表，兼容
            List<BlockPos> deletions = new ArrayList<>();
            if (root.get(KEY_DELETIONS) instanceof LongArrayTag deletionsTag) {
                for (long packed : deletionsTag.getAsLongArray()) {
                    deletions.add(BlockPos.of(packed));
                }
            }
            // 相机位置（DeletionApplier 相机格快路径用）。旧文件无该键 → null，兼容
            Vec3 cameraPos = parseVec3(root.getStringOr(KEY_AGENT_POS, ""));
            return new TerrainData(blocks, deletions, cameraPos);
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to read terrain file {}: {}", source, e.getMessage());
            return null;
        }
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

    // ==================== 解析助手 ====================

    /** 观察者眼睛坐标字符串（"x,y,z"，双精度）→ Vec3；缺失 / 解析失败 → null。 */
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

    // ==================== 数据结构 ====================

    record TerrainBlock(String blockId, Map<String, String> state) {
        String fingerprint() {
            return blockId + "|" + state;
        }
    }

    /**
     * 一帧地形数据：方块表（v2 起无 scannedSections，纯累积语义）+ 删除证据。
     *
     * <p>v2.23（§7.11）：{@code surfaces} / {@code skyRays} 已移除——减量判定完全移到采集侧
     * {@code DeletionJudge}（记忆侧反向通道只上报 cells）；本记录只剩 {@code deletions}
     * （采集侧逐块证明消失的格）与 {@code cameraPos}（相机格快路径）。{@link DeletionApplier}
     * 消费二者。
     */
    record TerrainData(
            Map<BlockPos, TerrainBlock> blocks,
            List<BlockPos> deletions,
            Vec3 cameraPos
    ) {
        /** 内容指纹 = 方块表 + 删除清单（deletions 变化同样触发重新读取 / 应用，§7.11）。 */
        String fingerprint() {
            return blocks.toString() + "|" + deletions.toString();
        }
    }
}
