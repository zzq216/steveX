package com.example.memworld;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * v2.23（§7.11）记忆世界<b>减量</b>执行器 —— 消费采集侧 {@code DeletionJudge} 的删除判定。
 *
 * <p>v2.23 起删除判定<b>完全移到采集侧</b>（§7.11 反向通道）：记忆侧只上报"当前存在"的实心不透明
 * 块 + 冻结实体占用格（{@link MemoryCellReporter} → {@code memory_cells.bin}），采集侧对每个 cell
 * 做 §5.4 式逐块投影 + 深度判定，证明被射线整格越过（{@code Z_opaque ≥ t_far − δ}，越过计数
 * ≥ {@code removalPixelThreshold}）→ 判消失 → 写入 terrain.nbt 顶层 {@code deletions}。本类只负责
 * <b>执行</b>：
 *
 * <ol>
 *   <li><b>方块删除</b>：对每个 deletion 格，若当前实心+不透明且不在本次可见集 → 静默置空
 *       （flags 818）并清除该位置旧方块实体记录（{@link MemoryRestorer#clearStale}）；</li>
 *   <li><b>相机格快路径</b>：相机所在格无条件尝试删除（受当前可见集防护）——DeletionJudge 跳过
 *       "相机在格内"的 cell，故相机格不在 deletions 里，须单独处理（保留 v2.22 语义）；</li>
 *   <li><b>冻结实体清理</b>：不在当前帧实体快照内、且<b>全部 AABB 占用格</b> ∈ deletions ∪
 *       {相机格}（= 采集侧已逐块证明消失）→ {@link EntityRestorer#discard}。</li>
 * </ol>
 *
 * <p>关键正确性约束（§7.11）：
 * <ul>
 *   <li><b>执行顺序</b>：先增量后减量——增量把本次可见集构建进 applied 表后，减量才拿
 *       「当前可见集」作假阳性防护；反序会把删掉的方块经指纹同步立即重新放回。</li>
 *   <li><b>假阳性防护</b>：当前地形集（{@code terrain.blocks}，本次可见方块）绝不可删。</li>
 *   <li><b>只删实心+不透明</b>：{@code isShapeFullBlock && canOcclude}（欠删无害，接受）。</li>
 *   <li><b>无跨帧累积</b>：删除阈值（≥2 像素）由采集侧 {@code DeletionJudge} 每帧独立判定，
 *       记忆侧不投票、不累计。</li>
 * </ul>
 */
public final class DeletionApplier {

    private static final Logger LOGGER = LoggerFactory.getLogger("stevex-test/memory");

    /** 方块实体通道：删除方块后清除该位置旧 BE 记录，防 block_entities.nbt 增量重放（v2.10 语义）。 */
    private final MemoryRestorer beRestorer;

    /** 实体通道：删除冻结实体。 */
    private final EntityRestorer entities;

    public DeletionApplier(final MemoryRestorer beRestorer, final EntityRestorer entities) {
        this.beRestorer = beRestorer;
        this.entities = entities;
    }

    /** 服务器（世界）启动 / 切换时调用，清空状态。 */
    public void onServerStart() {
        LOGGER.info("[MemoryWorld] Deletion applier ready");
    }

    /**
     * 对一帧 TerrainData 的 deletions 执行删除。terrain 为 null（本轮无新数据）或减量关闭 → 直接返回
     * （空闲成本≈0）。
     *
     * @param terrain 本次读取的 TerrainData（含 deletions / blocks / cameraPos）；null → 跳过
     * @param currentEntityUuids 当前帧实体快照 uuid 集（当前可见实体，删除跳过集）
     */
    public void apply(final ServerLevel level, final TerrainRestorer.TerrainData terrain,
                      final Set<UUID> currentEntityUuids) {
        final MemoryConfig config = MemoryConfig.get();
        if (!config.removalEnabled || terrain == null) return;

        final List<BlockPos> deletions = terrain.deletions();
        final Set<BlockPos> currentTerrain = terrain.blocks().keySet();
        final Vec3 cam = terrain.cameraPos();
        final BlockPos cameraCell = cam != null ? BlockPos.containing(cam.x, cam.y, cam.z) : null;

        // 采集侧已逐块证明消失的格 = 删除证据全集（实体清理用它判"占用格全空"）
        final Set<BlockPos> provenEmpty = new HashSet<>(deletions);
        if (cameraCell != null) {
            // 相机就在格内，最强证据（保留 v2.22 语义）；DeletionJudge 跳过格内 cell，故须单独处理。
            provenEmpty.add(cameraCell);
        }

        int deleted = 0;

        // ① 相机格快路径：无条件尝试删除，当前可见集防护防抖振（贴墙时格内方块在当前可见集，删除会被增量重建）
        if (cameraCell != null && !currentTerrain.contains(cameraCell)) {
            if (deleteBlock(level, cameraCell)) deleted++;
        }

        // ② 对每个 deletion 格：假阳性防护 + 实心不透明 → 静默置空 + 清 BE
        for (BlockPos pos : deletions) {
            if (currentTerrain.contains(pos)) continue;
            if (deleteBlock(level, pos)) deleted++;
        }

        // ③ 冻结实体清理：不在当前可见集、且全部占用格已证空 → 移除
        int discarded = 0;
        for (UUID uuid : entities.uuids()) {
            if (currentEntityUuids.contains(uuid)) continue;
            if (entities.allCellsEmpty(uuid, provenEmpty)) {
                entities.discard(uuid);
                discarded++;
            }
        }

        if (deleted > 0 || discarded > 0) {
            LOGGER.info("[MemoryWorld] Deletion apply: deleted {} blocks, discarded {} entities ({} deletions from judge)",
                    deleted, discarded, deletions.size());
        }
    }

    /**
     * 静默删除一个方块（v2.21 静默放置语义，flags = 818），并清除该位置旧方块实体记录
     * （防 block_entities.nbt 增量重放 ghosting，见 {@link MemoryRestorer#clearStale}）。
     * 只删实心+不透明方块；已是空气 / 非满形状 / 半透明 → false（欠删无害）。
     */
    private boolean deleteBlock(final ServerLevel level, final BlockPos pos) {
        try {
            if (!BlockStateUtil.isSolidOpaque(level, pos, level.getBlockState(pos))) return false;
            level.setBlock(pos, Blocks.AIR.defaultBlockState(), Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
            beRestorer.clearStale(pos);
            return true;
        } catch (Exception e) {
            LOGGER.warn("[MemoryWorld] Deletion failed to delete {}: {}", pos, e.getMessage());
            return false;
        }
    }
}
