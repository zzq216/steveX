package name.modid.arena;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.core.QuartPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.Container;
import net.minecraft.world.RandomizableContainer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.TagValueInput;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.VoxelShape;

/**
 * 陆地寻路训练场（docs/陆地寻路训练场设计方案.md）：场地 {@code land} 的搭建、每轮的记录和判定。
 *
 * <p>几何（以 origin 为准，缺省 (10496, 100, 9984)，按区块对齐，Q1）：整块场地占 4 × 4 个区块，
 * x ∈ [ox, ox+64)、z ∈ [oz, oz+64)、y ∈ [oy−10, oy+50]；本轮场地从西北角起取 size × size 个区块，其余清成空气。
 * 平地的地板顶面在 oy（人站在 oy+1）；模拟起伏、真实世界的最低地表对齐到 oy（Q2、Q2b、Q3）。场地外面是空的，四周不加墙。
 *
 * <p>一轮分两步：{@link #build}（arena/land-build，插件出题之前）按地形种类放好地面、交回格子信息；
 * {@link #begin}（arena/prepare）登记起点、中间点、终点，开始逐 tick 记录（Q8、Q13）。
 * 掉出场地不等摔死就结束（Q10）：脚的高度低于场地最低的方块 − 2 时记下、立刻传送到场外平台。
 * 受伤按事件逐次记录（Q9，F6）；死亡由 {@link #allowDeath} 拦下（生命值留 1），记 died，下一 tick 传送出场——
 * 不让它真死，免得复活、牵动 P2 的 died 请求。
 *
 * <p>全部方法只在集成服务器线程上调用（{@link #markers} 除外：客户端每帧读一份不可变的快照）。
 */
public final class LandArena {

    /** 整块场地的边长（格）：5 × 5 个区块。本轮场地最大 4 × 4 个区块，在里面随机偏移 0–16 格（第四稿 Q19） */
    public static final int SITE = 80;
    /** 整块场地的竖直范围（相对 oy） */
    public static final int SITE_Y0 = -10, SITE_Y1 = 50;
    public static final int MIN_SIZE = 2, MAX_SIZE = 4;
    /** 复制的竖直范围：最低地表 − 4 到最高地表 + 16（Q3） */
    private static final int COPY_BELOW = 4, COPY_ABOVE = 16;
    /** 岩浆点火的检查范围（F16）：水平 4 格、往上 4 格 */
    private static final int LAVA_REACH = 4;
    /** 放方块不触发相邻更新、不掉落、不触发方块实体的副作用、不调 onPlace（沙子不落、流体不流，Q3） */
    private static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS;
    /** 能站：头顶留多少（玩家高 1.8） */
    private static final double HEADROOM = 1.8;
    /** 头顶净空最多记到多少格：走下 3 格的坎要落点那一列从落点往上留 3 + 1.8 格，所以至少要记到 4.8 */
    private static final double CLEARANCE_CAP = 6.0;
    /** 开始移动：离开起点的阈值（Q8） */
    private static final double MOVE_EPS = 0.05;
    /** 轨迹在内存里最多留多少 tick（30 分钟） */
    private static final int MAX_TRACE = 36000;
    /** finish 返回的轨迹：每 4 tick 一个点，最多 3000 个（Q13） */
    private static final int TRACE_STEP = 4, TRACE_MAX = 3000;

    /** 只能待在水里的方块：和它所在位置的水一样处理（Q3） */
    private static final Set<Block> WATER_ONLY = Set.of(Blocks.KELP, Blocks.KELP_PLANT, Blocks.SEAGRASS, Blocks.TALL_SEAGRASS, Blocks.BUBBLE_COLUMN);
    /** 站在上面会掉血 */
    private static final Set<Block> HAZARD_STAND = Set.of(Blocks.MAGMA_BLOCK, Blocks.CAMPFIRE, Blocks.SOUL_CAMPFIRE, Blocks.POINTED_DRIPSTONE, Blocks.CACTUS);
    /** 身体待在里面会掉血 */
    private static final Set<Block> HAZARD_INSIDE = Set.of(Blocks.LAVA, Blocks.FIRE, Blocks.SOUL_FIRE, Blocks.SWEET_BERRY_BUSH, Blocks.WITHER_ROSE,
            Blocks.POWDER_SNOW, Blocks.CACTUS, Blocks.CAMPFIRE, Blocks.SOUL_CAMPFIRE, Blocks.MAGMA_BLOCK);

    // ── 搭建 ─────────────────────────────────────────────────────────────

    /**
     * arena/land-build 的参数。ground：flat / synthetic / terrain；size：本轮场地的边长（区块，2–4）；
     * heights：synthetic 的高度图（(16·size)² 个非负整数，下标 dz·W + dx，最低处应为 0）；
     * windowCx / windowCz：terrain 源窗口西北角的区块坐标；maxWater、reliefMin、reliefMax：terrain 的筛选条件（Q3）；
     * offsetX / offsetZ：本轮场地的西北角相对整块场地西北角的偏移（格，0 … SITE − 16·size，第四稿 Q19）。
     */
    public record Build(String ground, int size, int[] heights, Integer windowCx, Integer windowCz, double maxWater, int reliefMin, int reliefMax,
                        int offsetX, int offsetZ) {}

    /** 真实世界窗口的扫描结果（Q3） */
    private record Scan(int sx0, int sz0, int n, int minSurface, int maxSurface, double waterRatio, int lavaCount, boolean lavaNearFlammable, String reject) {}

    /**
     * 按地形种类放好本轮场地，交回格子信息（§3 第 1 步）。真实世界的窗口不合格时什么都不改，返回 accepted:false 和原因。
     * 有进行中的一轮时拒绝。
     */
    public static Map<String, Object> build(MinecraftServer server, BlockPos o, Build b) {
        if (ArenaManager.isActive()) throw new IllegalStateException("a run is active (call arena/finish first)");
        if (b.size() < MIN_SIZE || b.size() > MAX_SIZE) throw new IllegalArgumentException("size must be within " + MIN_SIZE + "-" + MAX_SIZE + ": " + b.size());
        final int w = 16 * b.size();
        if (b.offsetX() < 0 || b.offsetZ() < 0 || b.offsetX() > SITE - w || b.offsetZ() > SITE - w) {
            throw new IllegalArgumentException("offset must be within 0-" + (SITE - w) + " for size " + b.size() + ": [" + b.offsetX() + ", " + b.offsetZ() + "]");
        }
        // 本轮场地的西北角（Q19）：o 是整块场地，f 是本轮场地
        final BlockPos f = o.offset(b.offsetX(), 0, b.offsetZ());
        ServerLevel level = server.overworld();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ground", b.ground());
        out.put("size", b.size());
        out.put("offset", List.of(b.offsetX(), b.offsetZ()));
        BlockState[][] columns = new BlockState[w * w][];
        List<BlockPos[]> blockEntities = new ArrayList<>();
        Scan scan = null;
        int bottom; // 本轮场地最低的方块（相对世界）
        switch (b.ground()) {
            case "flat" -> {
                for (int i = 0; i < w * w; i++) columns[i] = new BlockState[]{Blocks.GRASS_BLOCK.defaultBlockState()};
                bottom = o.getY();
            }
            case "synthetic" -> {
                int[] h = b.heights();
                if (h == null || h.length != w * w) throw new IllegalArgumentException("heights must have " + (w * w) + " entries for size " + b.size());
                for (int i = 0; i < w * w; i++) {
                    if (h[i] < 0 || h[i] > SITE_Y1 - 4) throw new IllegalArgumentException("heights[" + i + "] out of range [0, " + (SITE_Y1 - 4) + "]: " + h[i]);
                    // 从 oy−4 往上：石头……泥土 3 格、顶上草方块（Q2b 第 4 步）
                    BlockState[] col = new BlockState[h[i] + COPY_BELOW + 1];
                    for (int k = 0; k < col.length; k++) {
                        int fromTop = col.length - 1 - k;
                        col[k] = fromTop == 0 ? Blocks.GRASS_BLOCK.defaultBlockState() : fromTop <= 3 ? Blocks.DIRT.defaultBlockState() : Blocks.STONE.defaultBlockState();
                    }
                    columns[i] = col;
                }
                bottom = o.getY() - COPY_BELOW;
            }
            case "terrain" -> {
                if (b.windowCx() == null || b.windowCz() == null) throw new IllegalArgumentException("terrain needs window: { cx, cz }");
                scan = scan(level, b.windowCx(), b.windowCz(), b);
                out.put("scan", describe(scan));
                if (scan.reject() != null) {
                    out.put("accepted", false);
                    out.put("reason", scan.reject());
                    return out;
                }
                transform(level, scan, columns, blockEntities, f);
                bottom = o.getY() - COPY_BELOW;
            }
            default -> throw new IllegalArgumentException("ground must be flat, synthetic or terrain: " + b.ground());
        }
        out.put("accepted", true);
        int base = "flat".equals(b.ground()) ? o.getY() : o.getY() - COPY_BELOW;
        int placed = place(level, o, f, w, columns, base);
        // 方块实体（真实世界）：连数据一起复制，容器清空、去掉战利品表，刷怪笼清掉要刷的生物（Q3，F17）
        int copiedBe = 0;
        for (BlockPos[] pair : blockEntities) copiedBe += copyBlockEntity(level, pair[0], pair[1]) ? 1 : 0;
        fillBiomes(level, o, f, w, scan);
        // 场地里的掉落物、经验球、生物（玩家除外）
        for (Entity e : level.getEntitiesOfClass(Entity.class, siteAabb(o), e -> !(e instanceof Player))) e.discard();
        out.put("placed", placed);
        out.put("blockEntities", copiedBe);
        out.put("field", fieldInfo(f, w, bottom));
        out.put("grid", grid(level, f, w));
        lastBuild = new Built(o.immutable(), f.immutable(), w, bottom, b.ground());
        return out;
    }

    /** 最近一次 build 的场地（prepare 据此核对起点、终点在场地里）：site = 整块场地的西北角，origin = 本轮场地的西北角（Q19） */
    private record Built(BlockPos site, BlockPos origin, int w, int bottom, String ground) {}

    private static Built lastBuild;

    /** 扫描真实世界的窗口（Q3）：先让服务器生成这几个区块，再看地表、水面占比、高差、岩浆周围的可燃方块。 */
    private static Scan scan(ServerLevel level, int cx, int cz, Build b) {
        final int n = 16 * b.size();
        for (int i = 0; i < b.size(); i++) for (int j = 0; j < b.size(); j++) level.getChunk(cx + i, cz + j);
        int sx0 = cx * 16, sz0 = cz * 16;
        int minS = Integer.MAX_VALUE, maxS = Integer.MIN_VALUE, water = 0;
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int dz = 0; dz < n; dz++) {
            for (int dx = 0; dx < n; dx++) {
                int top = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, sx0 + dx, sz0 + dz) - 1;
                minS = Math.min(minS, top);
                maxS = Math.max(maxS, top);
                // 地表是水：含液体的高度图看最上面那格（Q3 第 1 条）
                if (level.getFluidState(p.set(sx0 + dx, top, sz0 + dz)).is(FluidTags.WATER)) water++;
            }
        }
        double waterRatio = water / (double) (n * n);
        int relief = maxS - minS;
        int lava = 0;
        boolean near = false;
        int y0 = minS - COPY_BELOW, y1 = maxS + COPY_ABOVE;
        for (int y = y0; y <= y1 && !near; y++) {
            for (int dz = 0; dz < n && !near; dz++) {
                for (int dx = 0; dx < n && !near; dx++) {
                    if (!level.getFluidState(p.set(sx0 + dx, y, sz0 + dz)).is(FluidTags.LAVA)) continue;
                    lava++;
                    near = flammableNear(level, sx0, sz0, n, dx, y, dz, y1);
                }
            }
        }
        String reject = null;
        if (waterRatio > b.maxWater()) reject = "water";
        else if (relief < b.reliefMin() || relief > b.reliefMax()) reject = "relief";
        else if (relief + COPY_BELOW + COPY_ABOVE > SITE_Y1 + COPY_BELOW) reject = "relief";
        else if (near) reject = "lava";
        return new Scan(sx0, sz0, n, minS, maxS, waterRatio, lava, near, reject);
    }

    /** 岩浆周围水平 4 格、往上 4 格以内有没有可燃方块（只看窗口里的，F16） */
    private static boolean flammableNear(ServerLevel level, int sx0, int sz0, int n, int dx, int y, int dz, int yTop) {
        BlockPos.MutableBlockPos q = new BlockPos.MutableBlockPos();
        for (int ex = Math.max(0, dx - LAVA_REACH); ex <= Math.min(n - 1, dx + LAVA_REACH); ex++) {
            for (int ez = Math.max(0, dz - LAVA_REACH); ez <= Math.min(n - 1, dz + LAVA_REACH); ez++) {
                for (int ey = y; ey <= Math.min(yTop, y + LAVA_REACH); ey++) {
                    if (level.getBlockState(q.set(sx0 + ex, ey, sz0 + ez)).ignitedByLava()) return true;
                }
            }
        }
        return false;
    }

    private static Map<String, Object> describe(Scan s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("window", List.of(s.sx0() >> 4, s.sz0() >> 4));
        m.put("minSurface", s.minSurface());
        m.put("maxSurface", s.maxSurface());
        m.put("relief", s.maxSurface() - s.minSurface());
        m.put("waterRatio", Math.round(s.waterRatio() * 1000) / 1000.0);
        m.put("lava", s.lavaCount());
        m.put("lavaNearFlammable", s.lavaNearFlammable());
        return m;
    }

    /**
     * 把窗口变成每一列要放的方块（Q3 的"复制"）：水换掉（水面草方块、水下泥土、流水空气、水生植物同水），含水去掉，
     * 树叶 persistent。顺带记下要复制数据的方块实体（源位置、目标位置）。
     */
    private static void transform(ServerLevel level, Scan s, BlockState[][] columns, List<BlockPos[]> blockEntities, BlockPos o) {
        int y0 = s.minSurface() - COPY_BELOW, y1 = s.maxSurface() + COPY_ABOVE;
        int h = y1 - y0 + 1;
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int dz = 0; dz < s.n(); dz++) {
            for (int dx = 0; dx < s.n(); dx++) {
                BlockState[] col = new BlockState[h];
                boolean airAbove = true; // 复制范围顶上一格当作空气
                for (int k = h - 1; k >= 0; k--) {
                    BlockState src = level.getBlockState(p.set(s.sx0() + dx, y0 + k, s.sz0() + dz));
                    BlockState dst;
                    boolean waterish = isWaterSource(src);
                    if (src.is(Blocks.WATER) && !src.getFluidState().isSource()) dst = Blocks.AIR.defaultBlockState();
                    else if (waterish) dst = airAbove ? Blocks.GRASS_BLOCK.defaultBlockState() : Blocks.DIRT.defaultBlockState();
                    else if (src.is(Blocks.LILY_PAD)) dst = Blocks.AIR.defaultBlockState();
                    else {
                        dst = src;
                        if (dst.hasProperty(BlockStateProperties.WATERLOGGED) && dst.getValue(BlockStateProperties.WATERLOGGED)) dst = dst.setValue(BlockStateProperties.WATERLOGGED, false);
                        if (dst.getBlock() instanceof LeavesBlock && dst.hasProperty(LeavesBlock.PERSISTENT)) dst = dst.setValue(LeavesBlock.PERSISTENT, true);
                    }
                    col[k] = dst;
                    // "上面是空气"：空气、睡莲、流水（换成空气的那些）都算
                    airAbove = src.isAir() || src.is(Blocks.LILY_PAD) || (src.is(Blocks.WATER) && !src.getFluidState().isSource());
                    if (dst == src && src.hasBlockEntity()) {
                        BlockPos from = p.immutable();
                        BlockPos to = new BlockPos(o.getX() + dx, o.getY() - COPY_BELOW + k, o.getZ() + dz);
                        blockEntities.add(new BlockPos[]{from, to});
                    }
                }
                columns[dz * s.n() + dx] = col;
            }
        }
        sourceLevel = level;
        sourceScan = s;
    }

    /** transform 之后、copyBlockEntity 用的源（同一次 build 内有效） */
    private static ServerLevel sourceLevel;
    private static Scan sourceScan;

    /** 水源、水生植物、气泡柱、含水的海泡菜：按水处理（Q3 的替换表） */
    private static boolean isWaterSource(BlockState s) {
        if (s.is(Blocks.WATER)) return s.getFluidState().isSource();
        if (WATER_ONLY.contains(s.getBlock())) return true;
        return s.is(Blocks.SEA_PICKLE) && s.getValue(BlockStateProperties.WATERLOGGED);
    }

    /**
     * 整块场地：本轮场地（西北角 f）按 columns 放（每列从 base 往上），其余清成空气。只改和目标不同的格。@return 改了多少格
     */
    private static int place(ServerLevel level, BlockPos o, BlockPos f, int w, BlockState[][] columns, int base) {
        int placed = 0;
        BlockState air = Blocks.AIR.defaultBlockState();
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        int ox = f.getX() - o.getX(), oz = f.getZ() - o.getZ();
        for (int dz = 0; dz < SITE; dz++) {
            for (int dx = 0; dx < SITE; dx++) {
                int fx = dx - ox, fz = dz - oz;
                BlockState[] col = fx >= 0 && fz >= 0 && fx < w && fz < w ? columns[fz * w + fx] : null;
                for (int y = o.getY() + SITE_Y0; y <= o.getY() + SITE_Y1; y++) {
                    int k = y - base;
                    BlockState want = col != null && k >= 0 && k < col.length ? col[k] : air;
                    p.set(o.getX() + dx, y, o.getZ() + dz);
                    if (level.getBlockState(p).equals(want)) continue;
                    level.setBlock(p, want, FLAGS);
                    placed++;
                }
            }
        }
        return placed;
    }

    private static boolean copyBlockEntity(ServerLevel level, BlockPos from, BlockPos to) {
        BlockEntity src = sourceLevel != null ? sourceLevel.getBlockEntity(from) : null;
        BlockEntity dst = level.getBlockEntity(to);
        if (src == null || dst == null || src.getType() != dst.getType()) return false;
        CompoundTag tag = src.saveWithoutMetadata(level.registryAccess());
        // 刷怪笼：不带要刷的生物 → 空刷怪笼，什么也不刷（F17）
        tag.remove("SpawnData");
        tag.remove("SpawnPotentials");
        dst.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), tag));
        // 容器：清空、去掉战利品表（冒险模式也能开箱子，Q3）
        if (dst instanceof RandomizableContainer r) r.setLootTable(null);
        if (dst instanceof Container c) c.clearContent();
        dst.setChanged();
        level.getChunkSource().blockChanged(to);
        return true;
    }

    /**
     * 生物群系：平地、模拟起伏整块设成平原；真实世界按窗口复制（Q2、Q2b、Q3）。整块场地（西北角 o）的区块都重发给客户端。
     * 群系按 4 × 4 格的单元放：本轮场地（西北角 f）的偏移不是 4 的倍数时，群系和方块最多错开 3 格（Q19）。
     */
    private static void fillBiomes(ServerLevel level, BlockPos o, BlockPos f, int w, Scan scan) {
        Holder<Biome> plains = level.registryAccess().lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.PLAINS);
        List<ChunkAccess> chunks = new ArrayList<>();
        int qx0 = QuartPos.fromBlock(f.getX()), qz0 = QuartPos.fromBlock(f.getZ()), qw = QuartPos.fromBlock(w);
        for (int cz = 0; cz < SITE / 16; cz++) {
            for (int cx = 0; cx < SITE / 16; cx++) {
                ChunkAccess chunk = level.getChunk((o.getX() >> 4) + cx, (o.getZ() >> 4) + cz);
                chunk.fillBiomesFromNoise((qx, qy, qz, sampler) -> {
                    int rx = qx - qx0, rz = qz - qz0;
                    if (scan == null || rx < 0 || rz < 0 || rx >= qw || rz >= qw) return plains;
                    int srcY = QuartPos.toBlock(qy) - f.getY() + scan.minSurface();
                    return sourceLevel.getNoiseBiome(QuartPos.fromBlock(scan.sx0()) + rx, QuartPos.fromBlock(srcY), QuartPos.fromBlock(scan.sz0()) + rz);
                }, level.getChunkSource().randomState().sampler());
                chunk.markUnsaved();
                chunks.add(chunk);
            }
        }
        level.getChunkSource().chunkMap.resendBiomesForChunks(chunks);
    }

    private static Map<String, Object> fieldInfo(BlockPos o, int w, int bottom) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("x0", o.getX());
        m.put("z0", o.getZ());
        m.put("x1", o.getX() + w - 1);
        m.put("z1", o.getZ() + w - 1);
        m.put("width", w);
        m.put("bottom", bottom);
        m.put("fellY", bottom - 2);
        return m;
    }

    /**
     * 格子信息（§3 第 1 步，Q3）：每一列（下标 dz·W + dx）给一个数组
     * {@code [地表那一面的序号（-1 = 地表不能出题）, 能站的面数 n, 第 1 面的脚高, 头顶净空, 危险(0/1), 第 2 面…]}，
     * 面按从高到低排。能站 = 有碰撞顶面、往上留 1.8 格；净空最多记 6 格。
     * 地表 = 不算树叶的高度图那一格（F18）；它是原木、危险或者站不了时记 -1。
     */
    static Map<String, Object> grid(ServerLevel level, BlockPos o, int w) {
        List<List<Number>> cols = new ArrayList<>(w * w);
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        int yTop = o.getY() + SITE_Y1, yBottom = o.getY() + SITE_Y0;
        for (int dz = 0; dz < w; dz++) {
            for (int dx = 0; dx < w; dx++) {
                int x = o.getX() + dx, z = o.getZ() + dz;
                int surfaceY = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                List<Number> col = new ArrayList<>();
                col.add(-1);
                col.add(0);
                int count = 0;
                for (int y = yTop; y >= yBottom; y--) {
                    BlockState state = level.getBlockState(p.set(x, y, z));
                    VoxelShape shape = collision(level, state, p);
                    if (shape.isEmpty()) continue;
                    double feet = y + shape.max(Direction.Axis.Y);
                    double clear = clearance(level, x, y, z, feet, yTop);
                    if (clear < HEADROOM) continue;
                    boolean hazard = hazard(level, state, x, feet, z);
                    if (y == surfaceY && !state.is(BlockTags.LOGS) && !hazard) col.set(0, count);
                    col.add(round2(feet));
                    col.add(round2(clear));
                    col.add(hazard ? 1 : 0);
                    count++;
                }
                col.set(1, count);
                cols.add(col);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("width", w);
        out.put("columns", cols);
        return out;
    }

    /** 细雪对玩家没有碰撞（没穿皮靴会陷进去），按空的算 */
    private static VoxelShape collision(ServerLevel level, BlockState state, BlockPos pos) {
        if (state.is(Blocks.POWDER_SNOW)) return net.minecraft.world.phys.shapes.Shapes.empty();
        return state.getCollisionShape(level, pos);
    }

    /** 从脚高往上，到上方第一个碰撞底面的距离；最多 6 格 */
    private static double clearance(ServerLevel level, int x, int y, int z, double feet, int yTop) {
        BlockPos.MutableBlockPos q = new BlockPos.MutableBlockPos();
        double best = CLEARANCE_CAP;
        for (int c = y + 1; c <= Math.min(yTop, y + 1 + (int) CLEARANCE_CAP); c++) {
            BlockState s = level.getBlockState(q.set(x, c, z));
            VoxelShape shape = collision(level, s, q);
            if (shape.isEmpty()) continue;
            double bottom = c + shape.min(Direction.Axis.Y);
            best = Math.min(best, Math.max(0, bottom - feet));
            break;
        }
        return best;
    }

    /** 站在这一面上会不会掉血：脚下的方块、身体占的两格、身体两格四周的仙人掌 */
    private static boolean hazard(ServerLevel level, BlockState under, int x, double feet, int z) {
        if (HAZARD_STAND.contains(under.getBlock())) return true;
        BlockPos.MutableBlockPos q = new BlockPos.MutableBlockPos();
        int f = (int) Math.floor(feet + 1e-6);
        for (int c = f; c <= f + 1; c++) {
            BlockState s = level.getBlockState(q.set(x, c, z));
            if (HAZARD_INSIDE.contains(s.getBlock()) || s.getFluidState().is(FluidTags.LAVA)) return true;
            for (Direction d : Direction.Plane.HORIZONTAL) {
                if (level.getBlockState(q.set(x + d.getStepX(), c, z + d.getStepZ())).is(Blocks.CACTUS)) return true;
            }
        }
        return false;
    }

    private static double round2(double d) {
        return Math.round(d * 100.0) / 100.0;
    }

    /** 整块场地的范围（清记忆、清实体用） */
    public static AABB siteAabb(BlockPos o) {
        return new AABB(o.getX(), o.getY() + SITE_Y0, o.getZ(), o.getX() + SITE, o.getY() + SITE_Y1 + 1, o.getZ() + SITE);
    }

    public static BoundingBox siteBox(BlockPos o) {
        return new BoundingBox(o.getX(), o.getY() + SITE_Y0, o.getZ(), o.getX() + SITE - 1, o.getY() + SITE_Y1, o.getZ() + SITE - 1);
    }

    /** 本轮场地的范围（预填用）；还没 build 过 → null */
    public static BoundingBox fieldBox() {
        Built b = lastBuild;
        if (b == null) return null;
        BlockPos o = b.origin();
        return new BoundingBox(o.getX(), o.getY() + SITE_Y0, o.getZ(), o.getX() + b.w() - 1, o.getY() + SITE_Y1, o.getZ() + b.w() - 1);
    }

    // ── 一轮 ─────────────────────────────────────────────────────────────

    /**
     * prepare 的 land 参数：kind = route / goal；start、goal 是脚的位置 [x, y, z]（格子中心）；points 是路线题的中间点（寻路题为空）；
     * yaw 是开局的偏航角；markers = 画不画观察标记（Q4b）；memory = prefill / none（Q11，记忆由 ArenaApi 在客户端一侧处理）。
     */
    public record Setup(String kind, double[] start, float yaw, List<double[]> points, double[] goal, boolean markers, String memory) {}

    /** 一次受伤（Q9） */
    private record Hurt(int tick, long atMs, String source, float amount, float health, Vec3 pos, double fall) {}

    private static final class Round {
        final Setup setup;
        final UUID player;
        /** 整块场地的西北角（场外平台按它算） */
        final BlockPos site;
        /** 本轮场地的西北角（Q19） */
        final BlockPos origin;
        final int w;
        final int bottom;
        final String ground;
        final int startTick;
        final long startMs;
        Integer moveTick;
        Long moveAtMs;
        int next; // 下一个要经过的中间点
        final Integer[] passed;
        final List<int[]> early = new ArrayList<>(); // [点序号, tick]：顺序不对时到过
        final boolean[] inEarly;
        Integer reachedTick;
        Long reachedAtMs;
        final List<Hurt> hurts = new ArrayList<>();
        float damageTotal;
        Map<String, Object> dead;
        boolean deadHandled;
        Map<String, Object> fell;
        Long fellAtMs;
        Vec3 lastInField;
        int lastInFieldTick;
        float[] trace = new float[4096 * 5];
        int traceLen; // tick 数
        final List<int[]> events = new ArrayList<>(); // [tick, 0=起跳 1=落地 2=经过点 3=受伤]
        boolean lastGround = true;

        Round(Setup setup, UUID player, Built built, int startTick) {
            this.setup = setup;
            this.player = player;
            this.site = built.site();
            this.origin = built.origin();
            this.w = built.w();
            this.bottom = built.bottom();
            this.ground = built.ground();
            this.startTick = startTick;
            this.startMs = System.currentTimeMillis();
            this.passed = new Integer[setup.points().size()];
            this.inEarly = new boolean[setup.points().size()];
        }
    }

    private static Round round;
    /** 客户端每帧读的观察标记快照（Q4b）；没有进行中的一轮或关掉了标记 → null */
    private static volatile List<Marker> markers;

    /** 一个观察标记：label = "起" / 序号 / "终"；kind 0 起点 1 中间点 2 终点；passed = 已经经过 */
    public record Marker(double x, double y, double z, String label, int kind, boolean passed) {}

    public static List<Marker> markers() {
        return markers;
    }

    /** prepare 之前核对：场地已经 build 过、整块场地的 origin 一致，起点、中间点、终点都在本轮场地里 */
    static void check(BlockPos site, Setup s) {
        Built b = lastBuild;
        if (b == null || !b.site().equals(site)) throw new IllegalStateException("the land field is not built (call arena/land-build first)");
        BlockPos o = b.origin();
        if (!"route".equals(s.kind()) && !"goal".equals(s.kind())) throw new IllegalArgumentException("land.kind must be route or goal: " + s.kind());
        if ("goal".equals(s.kind()) && !s.points().isEmpty()) throw new IllegalArgumentException("land.points must be empty for goal");
        List<double[]> all = new ArrayList<>(s.points());
        all.add(s.start());
        all.add(s.goal());
        for (double[] p : all) {
            if (p.length != 3) throw new IllegalArgumentException("land positions must be [x, y, z]");
            if (p[0] < o.getX() || p[0] >= o.getX() + b.w() || p[2] < o.getZ() || p[2] >= o.getZ() + b.w()) {
                throw new IllegalArgumentException("land position " + Arrays.toString(p) + " is outside the field");
            }
        }
    }

    /** prepare：登记本轮，从玩家当前位置（已传送到起点）开始记录 */
    static void begin(MinecraftServer server, ServerPlayer player, Setup setup) {
        round = new Round(setup, player.getUUID(), lastBuild, server.getTickCount());
        round.lastInField = player.position();
        round.lastGround = player.onGround();
        publishMarkers(round);
    }

    static void end() {
        round = null;
        markers = null;
    }

    static void reset() {
        round = null;
        markers = null;
        lastBuild = null;
        sourceLevel = null;
        sourceScan = null;
    }

    static boolean reached() {
        return round != null && round.reachedTick != null;
    }

    static Long reachedAtMs() {
        return round != null ? round.reachedAtMs : null;
    }

    /** 脚还在本轮场地的水平范围里、没掉下去 */
    static boolean insideField(ServerPlayer player) {
        Round r = round;
        if (r == null) return false;
        Vec3 p = player.position();
        return inField(r, p) && p.y >= r.bottom - 2;
    }

    private static boolean inField(Round r, Vec3 p) {
        return p.x >= r.origin.getX() && p.x < r.origin.getX() + r.w && p.z >= r.origin.getZ() && p.z < r.origin.getZ() + r.w;
    }

    /** 脚在这个点所在的格子里（水平），高度差不超过 tol */
    private static boolean at(Vec3 p, double[] pt, double tol) {
        return Math.floor(p.x) == Math.floor(pt[0]) && Math.floor(p.z) == Math.floor(pt[2]) && Math.abs(p.y - pt[1]) <= tol;
    }

    /** 服务器 tick：轨迹、开始移动、中间点、到达、掉出场地、死亡后的收尾（Q8、Q10、Q13） */
    static void tick(MinecraftServer server, ServerPlayer player) {
        Round r = round;
        if (r == null || !player.getUUID().equals(r.player)) return;
        int t = server.getTickCount() - r.startTick;
        Vec3 p = player.position();
        // 死亡被拦下后（allowDeath）：传送出场、回满血
        if (r.dead != null && !r.deadHandled) {
            r.deadHandled = true;
            player.resetFallDistance();
            player.clearFire();
            player.setHealth(player.getMaxHealth());
            ArenaManager.teleportOutside(server, player, r.site);
            return;
        }
        if (r.dead != null || r.fell != null) return;
        record(r, t, p, player.onGround(), player.isSprinting());
        if (player.onGround() != r.lastGround) {
            r.events.add(new int[]{t, player.onGround() ? 1 : 0});
            r.lastGround = player.onGround();
        }
        if (r.moveTick == null) {
            double[] s = r.setup.start();
            double dh = Math.hypot(p.x - s[0], p.z - s[2]);
            if (dh > MOVE_EPS || Math.abs(p.y - s[1]) > MOVE_EPS) {
                r.moveTick = t;
                r.moveAtMs = System.currentTimeMillis();
            }
        }
        if (inField(r, p)) {
            r.lastInField = p;
            r.lastInFieldTick = t;
        }
        // 掉出场地（Q10）：不等摔死，记下、传送到场外平台
        if (p.y < r.bottom - 2) {
            Map<String, Object> fell = new LinkedHashMap<>();
            fell.put("tick", t);
            fell.put("pos", vec(p));
            fell.put("edge", vec(r.lastInField));
            fell.put("edgeTick", r.lastInFieldTick);
            r.fell = fell;
            r.fellAtMs = System.currentTimeMillis();
            player.resetFallDistance();
            ArenaManager.teleportOutside(server, player, r.site);
            return;
        }
        if (r.reachedTick != null) return;
        List<double[]> pts = r.setup.points();
        boolean changed = false;
        // 按顺序经过（Q4）：第 k 个点只有在第 k−1 个经过以后才算；先到了后面的点记"顺序不对时到过"
        if (r.next < pts.size() && at(p, pts.get(r.next), 1.0)) {
            r.passed[r.next] = t;
            r.events.add(new int[]{t, 2});
            r.next++;
            changed = true;
        }
        for (int j = r.next; j < pts.size(); j++) {
            boolean here = at(p, pts.get(j), 1.0);
            if (here && !r.inEarly[j]) r.early.add(new int[]{j, t});
            r.inEarly[j] = here;
        }
        if (r.next == pts.size() && at(p, r.setup.goal(), 0.5)) {
            r.reachedTick = t;
            r.reachedAtMs = System.currentTimeMillis();
            changed = true;
        }
        if (changed) publishMarkers(r);
    }

    /** 一个轨迹点：x、y、z、标志（1 在地上、2 疾跑）、tick（本轮从 prepare 起算） */
    private static void record(Round r, int tick, Vec3 p, boolean ground, boolean sprint) {
        if (r.traceLen >= MAX_TRACE) return;
        if ((r.traceLen + 1) * 5 > r.trace.length) r.trace = Arrays.copyOf(r.trace, r.trace.length * 2);
        int i = r.traceLen * 5;
        r.trace[i] = (float) p.x;
        r.trace[i + 1] = (float) p.y;
        r.trace[i + 2] = (float) p.z;
        r.trace[i + 3] = (ground ? 1 : 0) | (sprint ? 2 : 0);
        r.trace[i + 4] = tick;
        r.traceLen++;
    }

    /** Fabric AFTER_DAMAGE：本轮玩家的每一次受伤（Q9） */
    public static void onDamage(LivingEntity entity, DamageSource source, float base, float taken, boolean blocked) {
        Round r = round;
        if (r == null || !(entity instanceof ServerPlayer player) || !player.getUUID().equals(r.player) || taken <= 0) return;
        MinecraftServer server = player.level().getServer();
        int t = server != null ? server.getTickCount() - r.startTick : 0;
        r.hurts.add(new Hurt(t, System.currentTimeMillis(), sourceId(source), taken, player.getHealth(), player.position(), player.fallDistance));
        r.damageTotal += taken;
        r.events.add(new int[]{t, 3});
    }

    /** Fabric ALLOW_DEATH：本轮玩家不真死，生命值留 1、记 died，下一 tick 传送出场（Q9） */
    public static boolean allowDeath(LivingEntity entity, DamageSource source, float amount) {
        Round r = round;
        if (r == null || !(entity instanceof ServerPlayer player) || !player.getUUID().equals(r.player)) return true;
        player.setHealth(1.0f);
        if (r.dead == null) {
            MinecraftServer server = player.level().getServer();
            Map<String, Object> dead = new LinkedHashMap<>();
            dead.put("tick", server != null ? server.getTickCount() - r.startTick : 0);
            dead.put("atMs", System.currentTimeMillis());
            dead.put("source", sourceId(source));
            dead.put("pos", vec(player.position()));
            r.dead = dead;
        }
        return false;
    }

    private static String sourceId(DamageSource source) {
        return source.typeHolder().unwrapKey().map(k -> k.identifier().toString()).orElse("unknown");
    }

    private static void publishMarkers(Round r) {
        if (!r.setup.markers()) {
            markers = null;
            return;
        }
        List<Marker> list = new ArrayList<>();
        double[] s = r.setup.start();
        list.add(new Marker(s[0], s[1], s[2], "起", 0, true));
        for (int i = 0; i < r.setup.points().size(); i++) {
            double[] p = r.setup.points().get(i);
            list.add(new Marker(p[0], p[1], p[2], String.valueOf(i + 1), 1, r.passed[i] != null));
        }
        double[] g = r.setup.goal();
        list.add(new Marker(g[0], g[1], g[2], "终", 2, r.reachedTick != null));
        markers = List.copyOf(list);
    }

    // ── 状态 ─────────────────────────────────────────────────────────────

    /** prepare 的返回：本轮的场地和题目（插件核对用） */
    static Map<String, Object> describeSetup() {
        Round r = round;
        if (r == null) return null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", r.setup.kind());
        m.put("ground", r.ground);
        m.put("field", fieldInfo(r.origin, r.w, r.bottom));
        m.put("start", List.of(r.setup.start()[0], r.setup.start()[1], r.setup.start()[2]));
        List<List<Double>> pts = new ArrayList<>();
        for (double[] p : r.setup.points()) pts.add(List.of(p[0], p[1], p[2]));
        m.put("points", pts);
        m.put("goal", List.of(r.setup.goal()[0], r.setup.goal()[1], r.setup.goal()[2]));
        m.put("memory", r.setup.memory());
        return m;
    }

    /** status 的 land 段（Q13）：摘要，不含轨迹 */
    static Map<String, Object> describe(ServerPlayer player) {
        Round r = round;
        if (r == null) return null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", r.setup.kind());
        m.put("field", Map.of("size", r.w / 16, "ground", r.ground));
        m.put("started", r.moveTick);
        m.put("startedAtMs", r.moveAtMs);
        m.put("reachedTick", r.reachedTick);
        m.put("reachedAtMs", r.reachedAtMs);
        Map<String, Object> route = new LinkedHashMap<>();
        route.put("passed", Arrays.asList(r.passed));
        route.put("next", r.next);
        List<Map<String, Object>> early = new ArrayList<>();
        for (int[] e : r.early) early.add(Map.of("point", e[0], "tick", e[1]));
        route.put("early", early);
        m.put("route", route);
        m.put("hurt", Map.of("count", r.hurts.size(), "total", round2(r.damageTotal)));
        m.put("dead", r.dead);
        m.put("fell", r.fell);
        m.put("fellAtMs", r.fellAtMs);
        m.put("pos", player != null ? vec(player.position()) : null);
        m.put("tick", player != null && player.level().getServer() != null ? player.level().getServer().getTickCount() - r.startTick : null);
        return m;
    }

    /** finish 的 land 段：摘要加每次受伤、起跳落地等事件和抽稀的轨迹（Q13） */
    static Map<String, Object> finalState(ServerPlayer player) {
        Round r = round;
        if (r == null) return null;
        Map<String, Object> m = describe(player);
        List<Map<String, Object>> hurts = new ArrayList<>();
        for (Hurt h : r.hurts) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("tick", h.tick());
            e.put("atMs", h.atMs());
            e.put("source", h.source());
            e.put("amount", round2(h.amount()));
            e.put("health", round2(h.health()));
            e.put("pos", vec(h.pos()));
            if ("minecraft:fall".equals(h.source())) e.put("fallDistance", round2(h.fall()));
            hurts.add(e);
        }
        m.put("damage", hurts);
        List<List<Integer>> events = new ArrayList<>();
        for (int[] e : r.events) events.add(List.of(e[0], e[1]));
        m.put("events", events);
        m.put("trace", trace(r));
        return m;
    }

    /**
     * 抽稀的轨迹：从开始移动的前一 tick 起每 4 个点留一个，另外保留事件（起跳、落地、经过中间点、受伤）的那一 tick 和最后一个点；
     * 超过 3000 个就再抽一半。每个点带它真实的 tick，和事件、中间点的 tick 是同一套计数。
     */
    private static List<List<Number>> trace(Round r) {
        java.util.Set<Integer> eventTicks = new java.util.HashSet<>();
        for (int[] e : r.events) eventTicks.add(e[0]);
        int from = r.traceLen - 1;
        if (r.moveTick != null) {
            for (int i = 0; i < r.traceLen; i++) {
                if ((int) r.trace[i * 5 + 4] >= r.moveTick - 1) {
                    from = i;
                    break;
                }
            }
        }
        List<Integer> keep = new ArrayList<>();
        for (int i = Math.max(0, from); i < r.traceLen; i++) {
            if ((i - from) % TRACE_STEP == 0 || i == r.traceLen - 1 || eventTicks.contains((int) r.trace[i * 5 + 4])) keep.add(i);
        }
        while (keep.size() > TRACE_MAX) {
            List<Integer> half = new ArrayList<>();
            for (int i = 0; i < keep.size(); i += 2) half.add(keep.get(i));
            keep = half;
        }
        List<List<Number>> out = new ArrayList<>(keep.size());
        for (int idx : keep) {
            int i = idx * 5;
            out.add(List.of((int) r.trace[i + 4], round2(r.trace[i]), round2(r.trace[i + 1]), round2(r.trace[i + 2]), (int) r.trace[i + 3]));
        }
        return out;
    }

    private static List<Double> vec(Vec3 v) {
        return v == null ? null : List.of(round2(v.x), round2(v.y), round2(v.z));
    }
}
