package name.modid.vision;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.phys.Vec3;

/**
 * 陆地寻路训练场的记忆清除与预填（docs/陆地寻路训练场设计方案.md Q11）。
 *
 * <p>agent 读的"记忆"是采集端的几个累积文件（F7）。场地每轮按题目重建，agent 并没有看见，
 * 所以开局时把整块场地从五个文件里删掉（两种记忆模式都删）；{@code memory=prefill} 时再把本轮场地
 * "整块看一遍"：只写露在外面的方块（至少一面挨着不遮挡的方块，视觉有可能看到的那些），
 * 条目用视觉自己的构造（{@link VisionCollector#blockId} / {@link VisionCollector#stateProps} /
 * {@link BlockEntityFieldPolicy#filter}），格式和视觉写进去的完全一样。
 *
 * <p>只动采集端给 agent 读的文件：瞬时的 terrain.nbt、记忆端的镜像世界都不动（Q11）。
 * 容器内容（只有打开过才会有）、实体不预填。
 *
 * <p>必须在渲染线程调用（各 store 只在渲染线程变更；预填读的是客户端世界）。
 */
public final class ArenaMemory {

    private ArenaMemory() {}

    /**
     * @param clear 要清掉的范围（整块场地）
     * @param fill  要预填的范围（本轮场地）；null = 不预填
     * @return { cleared: { terrain, blockEntities, biomes, containers, entities }, prefilled: { terrain, blockEntities, biomes } | null, dimension }
     */
    public static Map<String, Object> apply(final BoundingBox clear, final BoundingBox fill) {
        final VisionWorldContext ctx = VisionWorldContext.require();
        final Minecraft mc = Minecraft.getInstance();
        final ClientLevel level = mc.level;
        if (level == null) throw new IllegalStateException("no client level");
        final String dim = level.dimension().identifier().toString();

        final Map<String, Object> cleared = new LinkedHashMap<>();
        cleared.put("terrain", ctx.terrainUnion().clearBox(dim, clear));
        cleared.put("blockEntities", ctx.blockEntities().clearBox(dim, clear));
        cleared.put("biomes", ctx.biomes().clearBox(dim, clear));
        cleared.put("containers", ctx.containers().clearBox(dim, clear));
        cleared.put("entities", ctx.entityUnion().clearBox(dim, clear));

        Map<String, Object> prefilled = null;
        if (fill != null) {
            final long ts = System.currentTimeMillis();
            final Map<BlockPos, VisionCollector.TerrainBlockSnapshot> terrain = new LinkedHashMap<>();
            final Map<BlockPos, VisionCollector.BlockEntitySnapshot> blockEntities = new LinkedHashMap<>();
            for (BlockPos p : BlockPos.betweenClosed(fill.minX(), fill.minY(), fill.minZ(), fill.maxX(), fill.maxY(), fill.maxZ())) {
                final BlockState state = level.getBlockState(p);
                if (state.isAir() || !exposed(level, p)) continue;
                final BlockPos pos = p.immutable();
                terrain.put(pos, new VisionCollector.TerrainBlockSnapshot(pos, VisionCollector.blockId(state), VisionCollector.stateProps(state), ts));
                if (!state.hasBlockEntity()) continue;
                final BlockEntity be = level.getBlockEntity(pos);
                if (be == null) continue;
                final String typeId = BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType()).toString();
                final CompoundTag nbt = BlockEntityFieldPolicy.filter(typeId, be.saveWithFullMetadata(level.registryAccess()));
                blockEntities.put(pos, new VisionCollector.BlockEntitySnapshot(pos, typeId, VisionCollector.blockId(state), VisionCollector.stateProps(state), nbt, ts));
            }
            final Map<String, Object> terrainStats = ctx.terrainUnion().sync(terrain, List.of(), List.of(), dim);
            final Vec3 cam = mc.gameRenderer.getMainCamera().position();
            final float yaw = mc.player != null ? mc.player.getYRot() : 0f;
            final float pitch = mc.player != null ? mc.player.getXRot() : 0f;
            final int fov = mc.options.fov().get();
            final Map<String, Integer> beStats = ctx.blockEntities().sync(blockEntities, cam, yaw, pitch, fov, level.getDayTime(), dim);
            final VisionBiomeStore.Stats biomeStats = ctx.biomes().sync(level, new ArrayList<>(terrain.keySet()), dim);
            prefilled = new LinkedHashMap<>();
            prefilled.put("terrain", terrainStats.get("added"));
            prefilled.put("blockEntities", beStats.get("new"));
            prefilled.put("biomes", biomeStats.added());
        }
        // 不等限频：发任务时 nbt_query 读到的一定是本轮的状态
        ctx.terrainUnion().flushNow();
        ctx.entityUnion().flushNow();

        final Map<String, Object> out = new LinkedHashMap<>();
        out.put("dimension", dim);
        out.put("cleared", cleared);
        out.put("prefilled", prefilled);
        return out;
    }

    /** 露在外面：六个邻格里至少有一个不遮挡（空气、不满一格、透明的方块）。 */
    private static boolean exposed(final ClientLevel level, final BlockPos pos) {
        final BlockPos.MutableBlockPos n = new BlockPos.MutableBlockPos();
        for (Direction d : Direction.values()) {
            n.setWithOffset(pos, d);
            if (!level.getBlockState(n).canOcclude()) return true;
        }
        return false;
    }
}
