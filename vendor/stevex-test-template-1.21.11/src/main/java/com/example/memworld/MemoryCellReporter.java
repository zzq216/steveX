package com.example.memworld;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * v2.23（§7.11）反向通道上报器 —— 把记忆世界"当前存在"的<b>实心不透明块 + 冻结实体占用格</b>
 * 按距离球过滤后写成 {@code memory_cells.bin}，供采集侧 {@code DeletionJudge} 逐块深度判定。
 *
 * <p>设计 §7.11 反向通道：
 * <ul>
 *   <li><b>集合来源</b>：实心不透明块取 {@link TerrainRestorer} 的已应用表（纯累积的全部已放置块，
 *       再按当前世界状态判定实心+不透明）；冻结实体占用格取 {@link EntityRestorer} 已放置实体的
 *       AABB 覆盖格；</li>
 *   <li><b>距离球过滤</b>：只上报 {@code |cell − agentPos| ≤ removalMaxRayDist}（默认 96）的格。
 *       <b>Over-inclusive</b>：只缩距离、不做精确视锥——采集侧用真实投影矩阵判定，越界格无像素命中、
 *       自然跳过，过滤只为了缩小清单；</li>
 *   <li><b>触发</b>：世界变化（restorer mutationVersion 变化）|| 姿态变化 &gt; ε（球随 agent 移动 →
 *       球内格集变化）|| 每 {@code memoryCellsWriteIntervalTicks}（默认 10）兜底；</li>
 *   <li><b>内容指纹门控</b>：内容未变不重写；</li>
 *   <li><b>原子写</b>：临时文件 + rename（半截写防护，同 §7.4），mtime 只在成功后推进。</li>
 * </ul>
 *
 * <p>v2.32（世界类型区分，见 docs/世界类型区分与镜像复原设计方案.md §4.6/§5.4）：cells 按<b>活动维</b>
 * 求取并带<b>维标签</b>上报——只算 {@code level.dimension()} 对应维的方块/实体（调用方 manager 只传
 * 活动维的 ServerLevel），采集侧只对 {@code dimension == 本快照维} 的 cells 做删除判定；镜像落后时
 * cells 仍标上一维 → 采集侧宁缺勿滥、绝不跨维误删。
 *
 * <p>文件格式（小端，与采集侧 {@code MemoryCellsReader} 对应；version = 2 起带 UTF-8 维 id）：
 * <pre>{@code
 *   [0..3]   magic "SCEL"
 *   [4]      version = 2
 *   [5..8]   int 维 id 字节长度 L（UTF-8）
 *   [9..9+L) UTF-8 dimensionId（活动维）
 *   [..]     int removalPixelThreshold   （采集侧删除判定阈值，随通道下发，单一来源）
 *   [..]     double removalMaxRayDist    （信息性：距离球过滤半径）
 *   [..]     int count
 *   [..]     count × long（BlockPos.asLong）
 * }</pre>
 *
 * <p>文件路径 = 源 terrain.nbt 所在目录的 {@code memory_cells.bin}（采集侧读同一路径）。
 * 记忆侧离线不写 → 采集侧无删除证据 → 只增不删（优雅降级）。
 */
public final class MemoryCellReporter {

    private static final Logger LOGGER = LoggerFactory.getLogger("stevex-test/memory");
    private static final byte[] MAGIC = {'S', 'C', 'E', 'L'};
    /** v2.32：格式版本升到 2（头部在 version 之后追加 UTF-8 维 id 段；version=1 旧文件无维标签）。 */
    private static final int VERSION = 2;

    private final TerrainRestorer terrain;
    private final EntityRestorer entities;

    private final MemoryConfig config = MemoryConfig.get();
    private int ticks;
    private int lastMutationVersion = -1;
    private Set<Long> lastCells = Set.of();

    public MemoryCellReporter(final TerrainRestorer terrain, final EntityRestorer entities) {
        this.terrain = terrain;
        this.entities = entities;
    }

    /** 服务器（世界）启动 / 切换时调用，清空指纹与版本。 */
    public void onServerStart() {
        ticks = 0;
        lastMutationVersion = -1;
        lastCells = Set.of();
        LOGGER.info("[MemoryWorld] Cell reporter ready");
    }

    /** 每服务器 tick 调用：按需重算 + 原子写 cells 文件（只对传入的活动维 level）。 */
    public void tick(final ServerLevel level) {
        if (!config.removalEnabled) return; // 减量关闭 → 不写 cells → 纯累积
        if (level.players().isEmpty()) return; // v2.32：活动维尚无玩家（跨维传送过渡 tick）→ 无法定位
        // agent（球心），本轮跳过且不推进指纹——绝不把“无 cells”误上报成“记忆为空”（采集侧会宁缺勿滥）。

        final String dimension = level.dimension().identifier().toString();
        final int version = terrain.mutationVersion() + entities.mutationVersion();
        ticks++;
        // 触发：世界变化（mutationVersion 变化）|| 姿态变化（球内格集变化，随每次重算内容指纹体现）
        //        || 每 memoryCellsWriteIntervalTicks 兜底
        if (ticks % Math.max(1, config.memoryCellsWriteIntervalTicks) != 0 && version == lastMutationVersion) {
            return;
        }
        lastMutationVersion = version;

        final Set<Long> cells = computeCells(level, dimension);
        if (cells.equals(lastCells)) return; // 内容指纹门控：内容未变不重写

        final Path file = config.resolveMemoryCellsFile();
        if (file == null) return;
        if (writeAtomic(file, dimension, cells, config.removalPixelThreshold, config.removalMaxRayDist)) {
            lastCells = cells;
            LOGGER.info("[MemoryWorld] Wrote {} memory cells [{}] to {} (threshold={}, maxDist={})",
                    cells.size(), dimension, file, config.removalPixelThreshold, config.removalMaxRayDist);
        }
    }

    // ==================== 集合重算 ====================

    /** 当前记忆世界的 agent 位置（眼睛坐标）；玩家未就绪返回 null（无法过滤 → 跳过本轮上报）。 */
    private static Vec3 agentPos(final ServerLevel level) {
        final List<ServerPlayer> players = level.players();
        if (players.isEmpty()) return null;
        final ServerPlayer p = players.get(0);
        return new Vec3(p.getX(), p.getEyeY(), p.getZ());
    }

    /**
     * 重算待上报格集（§7.11 / v2.32）：指定维的实心不透明块（距离过滤 + 世界状态判定）+ 冻结实体
     * 占用格（距离过滤）。Over-inclusive：只缩距离，不做视锥。
     */
    private Set<Long> computeCells(final ServerLevel level, final String dimension) {
        final Vec3 agent = agentPos(level);
        if (agent == null) return Set.of();
        final double r2 = config.removalMaxRayDist * config.removalMaxRayDist;
        final Set<Long> cells = new HashSet<>();

        // ① 实心不透明块：先距离过滤（便宜），再读世界判定（只对球内格读）。只取该维已应用方块。
        for (BlockPos pos : terrain.appliedBlocks(dimension)) {
            final double dx = pos.getX() + 0.5 - agent.x;
            final double dy = pos.getY() + 0.5 - agent.y;
            final double dz = pos.getZ() + 0.5 - agent.z;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            if (BlockStateUtil.isSolidOpaque(level, pos, level.getBlockState(pos))) {
                cells.add(pos.asLong());
            }
        }

        // ② 冻结实体占用格（AABB 覆盖的所有格，距离过滤）。只取该维已放置实体。
        for (Entity e : entities.entities(dimension)) {
            if (e.isRemoved()) continue;
            final AABB box = e.getBoundingBox();
            final int minX = Mth.floor(box.minX), maxX = Mth.floor(box.maxX);
            final int minY = Mth.floor(box.minY), maxY = Mth.floor(box.maxY);
            final int minZ = Mth.floor(box.minZ), maxZ = Mth.floor(box.maxZ);
            for (int x = minX; x <= maxX; x++) {
                for (int y = minY; y <= maxY; y++) {
                    for (int z = minZ; z <= maxZ; z++) {
                        final double dx = x + 0.5 - agent.x;
                        final double dy = y + 0.5 - agent.y;
                        final double dz = z + 0.5 - agent.z;
                        if (dx * dx + dy * dy + dz * dz > r2) continue;
                        cells.add(BlockPos.asLong(x, y, z));
                    }
                }
            }
        }
        return cells;
    }

    // ==================== 原子写 ====================

    /** 原子写（临时文件 + rename，半截写防护同 §7.4）。失败返回 false（调用方不推进指纹）。
     *  字节序与采集侧 {@code MemoryCellsReader} 一致：{@link ByteOrder#LITTLE_ENDIAN}。 */
    private static boolean writeAtomic(final Path target, final String dimension, final Set<Long> cells,
                                       final int threshold, final double maxRayDist) {
        try {
            Files.createDirectories(target.getParent());
            final Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            final byte[] dimBytes = dimension == null ? new byte[0] : dimension.getBytes(StandardCharsets.UTF_8);
            // 布局：[0..3] magic + [4] ver + [5..8] L + [9..9+L) dim + 16（threshold/maxRayDist/count）+ count×8
            final ByteBuffer buf = ByteBuffer.allocate(25 + dimBytes.length + cells.size() * 8)
                    .order(ByteOrder.LITTLE_ENDIAN);
            buf.put(MAGIC);                    // [0..3]
            buf.put((byte) VERSION);           // [4]
            buf.putInt(dimBytes.length);       // [5..8]
            buf.put(dimBytes);                 // [9..9+L)
            buf.putInt(threshold);             // threshold
            buf.putDouble(maxRayDist);         // maxRayDist
            buf.putInt(cells.size());          // count
            for (long c : cells) {             // count × long
                buf.putLong(c);
            }
            Files.write(tmp, buf.array());
            // ATOMIC_MOVE 尽力而为；失败时回退 REPLACE_EXISTING（同目录 rename 通常原子）
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException atomicFailure) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            return true;
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to write cells file {}: {}", target, e.getMessage());
            return false;
        }
    }
}
