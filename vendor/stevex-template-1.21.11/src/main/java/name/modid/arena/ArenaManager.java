package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.Stats;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * 训练场（docs/训练场设计方案.md）：搭场地、每轮重置、监测合成统计、传送进出。
 *
 * <p>全部方法只在集成服务器线程上调用（{@link name.modid.api.ArenaApi} 经 {@code server.submit} 进来，
 * 命令和 tick 本来就在服务器线程），因此本类的可变状态不加锁。
 *
 * <p>以服务器身份操作，玩家不需要作弊权限：世界关闭作弊时 agent 的 {@code /give} 会失败（方案 T3、T4）。
 *
 * <p>几何（以 origin 为场内地板中心方块）：场内 9×9 可站立，地板延伸到 11×11，外圈 3 格高屏障墙；
 * 场外平台在 -x 方向（x ∈ [ox-11, ox-6]，z ∈ [oz-2, oz+2]），立柱上挂告示牌。
 *
 * <p>带工作站的场地（docs/工作台训练场设计方案.md W2）：工作站放在 (ox, oy+1, oz+2)，玩家站在中心朝 +z，
 * 俯角按"眼睛 → 工作站中心"算出，准星正对工作站朝向玩家的那一面。
 */
public final class ArenaManager {

    public static final BlockPos DEFAULT_ORIGIN = new BlockPos(10000, 120, 10000);

    /** 一块场地：origin + 工作站名（null = 没有工作站）。 */
    public record Site(BlockPos origin, String station) {}

    /** 工作站名 → 方块。目前只有工作台（W2）。 */
    private static final Map<String, Block> STATIONS = Map.of("crafting_table", Blocks.CRAFTING_TABLE);

    /** 已知场地：名字 → Site。arena/build 会登记或更新；/arena 命令按这里传送。 */
    private static final Map<String, Site> KNOWN = new ConcurrentHashMap<>(Map.of(
            "craft2x2", new Site(DEFAULT_ORIGIN, null),
            "craft3x3", new Site(new BlockPos(10000, 120, 10030), "crafting_table")));

    private static final int MONSTER_SWEEP_TICKS = 20;

    private record Watch(Item item, String id, int baseline) {}

    /** 进行中的一轮；null = 没有进行中的训练。 */
    private static final class Run {
        final String arena;
        final BlockPos origin;
        final UUID player;
        final List<Watch> watch;
        final long startedAtMs;
        final BlockPos stationPos; // 没有工作站时为 null
        final Block station;
        Long craftedAtMs;
        String craftedItem;
        Long openedAtMs;

        Run(String arena, BlockPos origin, UUID player, List<Watch> watch, long startedAtMs, BlockPos stationPos, Block station) {
            this.arena = arena;
            this.origin = origin;
            this.player = player;
            this.watch = watch;
            this.startedAtMs = startedAtMs;
            this.stationPos = stationPos;
            this.station = station;
        }
    }

    private static Run active;
    private static int tickCounter;

    private ArenaManager() {}

    public static boolean isActive() {
        return active != null;
    }

    public static Map<String, Site> known() {
        return KNOWN;
    }

    /** 工作站名 → 方块；null → null；未知名字报错。 */
    public static Block station(String name) {
        if (name == null) return null;
        Block block = STATIONS.get(name);
        if (block == null) throw new IllegalArgumentException("unknown station: " + name + " (known: " + String.join(", ", STATIONS.keySet()) + ")");
        return block;
    }

    private static BlockPos stationPos(BlockPos o) {
        return new BlockPos(o.getX(), o.getY() + 1, o.getZ() + 2);
    }

    /** 世界关闭时丢掉进行中的状态，避免带进下一个世界。 */
    public static void reset() {
        active = null;
    }

    // ── 搭建 ─────────────────────────────────────────────────────────────

    /** 幂等搭建场地，返回实际改动的方块数。station 不为 null 时在场内放工作站，被挖掉的会补回（W8）。 */
    public static int build(MinecraftServer server, String arena, BlockPos o, String station) {
        Block stationBlock = station(station);
        KNOWN.put(arena, new Site(o.immutable(), station));
        ServerLevel level = server.overworld();
        int ox = o.getX(), oy = o.getY(), oz = o.getZ();
        BlockPos stationAt = stationPos(o);
        int placed = 0;
        // 场内：地板 11×11，外圈屏障墙 3 格高；场内上方清空
        for (int dx = -5; dx <= 5; dx++) {
            for (int dz = -5; dz <= 5; dz++) {
                placed += set(level, new BlockPos(ox + dx, oy, oz + dz), Blocks.STONE.defaultBlockState());
                boolean wall = Math.abs(dx) == 5 || Math.abs(dz) == 5;
                for (int dy = 1; dy <= 3; dy++) {
                    BlockPos pos = new BlockPos(ox + dx, oy + dy, oz + dz);
                    BlockState state = wall ? Blocks.BARRIER.defaultBlockState()
                            : stationBlock != null && pos.equals(stationAt) ? stationBlock.defaultBlockState()
                            : Blocks.AIR.defaultBlockState();
                    placed += set(level, pos, state);
                }
            }
        }
        // 场外平台：地板 + 屏障护栏 2 格高（靠场地一侧不设护栏，由场地墙挡住）
        for (int x = ox - 11; x <= ox - 6; x++) {
            for (int z = oz - 2; z <= oz + 2; z++) {
                placed += set(level, new BlockPos(x, oy, z), Blocks.STONE.defaultBlockState());
                boolean rail = x == ox - 11 || Math.abs(z - oz) == 2;
                for (int dy = 1; dy <= 2; dy++) {
                    BlockPos pos = new BlockPos(x, oy + dy, z);
                    if (x == ox - 6 && z == oz) continue;
                    if (x == ox - 7 && z == oz) continue;
                    placed += set(level, pos, rail ? Blocks.BARRIER.defaultBlockState() : Blocks.AIR.defaultBlockState());
                }
            }
        }
        // 立柱 + 告示牌；告示牌下方清成空气（旧场地在那里放过按钮）
        placed += set(level, new BlockPos(ox - 6, oy + 1, oz), Blocks.STONE.defaultBlockState());
        placed += set(level, new BlockPos(ox - 6, oy + 2, oz), Blocks.STONE.defaultBlockState());
        placed += set(level, new BlockPos(ox - 7, oy + 1, oz), Blocks.AIR.defaultBlockState());
        BlockPos signPos = new BlockPos(ox - 7, oy + 2, oz);
        placed += set(level, signPos, Blocks.OAK_WALL_SIGN.defaultBlockState().setValue(WallSignBlock.FACING, Direction.WEST));
        if (level.getBlockEntity(signPos) instanceof SignBlockEntity sign) {
            SignText text = new SignText()
                    .setMessage(0, Component.literal("训练场 " + arena))
                    .setMessage(2, Component.literal("在 DSH 输入"))
                    .setMessage(3, Component.literal("/bt train " + arena));
            sign.setText(text, true);
        }
        return placed;
    }

    private static int set(ServerLevel level, BlockPos pos, BlockState state) {
        if (level.getBlockState(pos).equals(state)) return 0;
        level.setBlockAndUpdate(pos, state);
        return 1;
    }

    // ── 传送 ─────────────────────────────────────────────────────────────

    public static void teleportOutside(MinecraftServer server, ServerPlayer player, BlockPos o) {
        player.teleportTo(server.overworld(), o.getX() - 9 + 0.5, o.getY() + 1, o.getZ() + 0.5, Set.of(), -90f, 0f, true);
    }

    private static void teleportInside(MinecraftServer server, ServerPlayer player, BlockPos o, float pitch) {
        player.teleportTo(server.overworld(), o.getX() + 0.5, o.getY() + 1, o.getZ() + 0.5, Set.of(), 0f, pitch, true);
    }

    /** 站在场内中心朝 +z 时，眼睛 → 工作站中心的俯角（度，向下为正）。 */
    private static float stationPitch(ServerPlayer player, BlockPos o) {
        BlockPos s = stationPos(o);
        double dy = (o.getY() + 1 + player.getEyeHeight()) - (s.getY() + 0.5);
        double dz = (s.getZ() + 0.5) - (o.getZ() + 0.5);
        return (float) Math.toDegrees(Math.atan2(dy, dz));
    }

    /** 服务器侧按玩家当前位置与朝向做一次方块射线检测：准星是否命中工作站（W2 自检）。 */
    private static boolean aimsAt(ServerPlayer player, BlockPos target, Block block) {
        Vec3 eye = player.getEyePosition();
        Vec3 end = eye.add(Vec3.directionFromRotation(player.getXRot(), player.getYRot()).scale(player.blockInteractionRange()));
        BlockHitResult hit = player.level().clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && player.level().getBlockState(target).is(block);
    }

    private static boolean inside(MinecraftServer server, ServerPlayer player, BlockPos o) {
        if (player.level() != server.overworld()) return false;
        int bx = player.getBlockX(), by = player.getBlockY(), bz = player.getBlockZ();
        return Math.abs(bx - o.getX()) <= 4 && Math.abs(bz - o.getZ()) <= 4 && by >= o.getY() && by <= o.getY() + 4;
    }

    private static AABB box(BlockPos o) {
        return new AABB(o.getX() - 5, o.getY() - 2, o.getZ() - 5, o.getX() + 6, o.getY() + 6, o.getZ() + 6);
    }

    // ── 一轮 ─────────────────────────────────────────────────────────────

    /** 一个要发放的物品：slot ∈ [0, 35]（主物品栏），count ≥ 1（超过堆叠上限的由 {@link #split} 拆开）。 */
    public record Give(int slot, String id, int count) {}

    /**
     * 兜底拆堆（工作台方案 W5）：超过堆叠上限的一堆，原槽位放满上限，余下的按上限分堆，
     * 依次放进按 seed 打乱的空槽；没超限的堆原样保留。@return 实际发放的槽位
     */
    static List<Give> split(List<Give> items, long seed) {
        boolean[] used = new boolean[36];
        for (Give g : items) {
            if (g.slot() < 0 || g.slot() > 35) throw new IllegalArgumentException("slot out of range [0, 35]: " + g.slot());
            if (used[g.slot()]) throw new IllegalArgumentException("duplicate slot: " + g.slot());
            used[g.slot()] = true;
            if (g.count() < 1) throw new IllegalArgumentException("bad count for " + g.id() + ": " + g.count());
        }
        List<Integer> free = new ArrayList<>();
        for (int i = 0; i < 36; i++) if (!used[i]) free.add(i);
        Collections.shuffle(free, new Random(seed));
        List<Give> out = new ArrayList<>();
        int next = 0;
        for (Give g : items) {
            int max = item(g.id()).getDefaultMaxStackSize();
            out.add(new Give(g.slot(), g.id(), Math.min(g.count(), max)));
            for (int left = g.count() - max; left > 0; left -= max) {
                if (next >= free.size()) throw new IllegalArgumentException("not enough free slots to split " + g.id() + " x" + g.count());
                out.add(new Give(free.get(next++), g.id(), Math.min(left, max)));
            }
        }
        return out;
    }

    /**
     * 每轮重置（方案 T8）并发放材料，开始监测 watch 里各物品的 crafted 统计。
     * 已有进行中的一轮时拒绝：先 finish 再开新一轮。
     */
    public static Map<String, Object> prepare(MinecraftServer server, ServerPlayer player, String arena, BlockPos o, String station,
                                              List<Give> requested, long seed, List<String> watchIds, long dayTime) {
        if (active != null) throw new IllegalStateException("a run is already active in arena " + active.arena + " (call arena/finish first)");
        Block stationBlock = station(station);
        List<Give> items = split(requested, seed);
        List<ItemStack> stacks = new ArrayList<>();
        for (Give g : items) stacks.add(new ItemStack(item(g.id()), g.count()));
        List<Item> watchItems = new ArrayList<>();
        for (String id : watchIds) watchItems.add(item(id));

        build(server, arena, o, station);
        ServerLevel level = server.overworld();
        // 1. 先关界面：2×2 / 工作台合成格里的物品退回物品栏、客户端界面一并关掉；光标物品清掉
        player.containerMenu.setCarried(ItemStack.EMPTY);
        player.closeContainer();
        player.containerMenu.setCarried(ItemStack.EMPTY);
        // 2. 清空物品栏（含盔甲、副手）
        player.getInventory().clearContent();
        player.inventoryMenu.getCraftSlots().clearContent();
        teleportInside(server, player, o, stationBlock != null ? stationPitch(player, o) : 0f);
        // 3. 场内掉落物、经验球、敌对生物
        for (Entity e : level.getEntitiesOfClass(Entity.class, box(o),
                e -> e instanceof ItemEntity || e instanceof ExperienceOrb || e instanceof Enemy)) {
            e.discard();
        }
        // 4. 状态
        player.setGameMode(GameType.SURVIVAL);
        player.removeAllEffects();
        player.setHealth(player.getMaxHealth());
        player.getFoodData().setFoodLevel(20);
        player.getFoodData().setSaturation(5.0f);
        player.setRemainingFireTicks(0);
        player.resetFallDistance();
        // 5. 白天、晴天
        level.setDayTime(dayTime);
        level.setWeatherParameters(12000, 0, false, false);
        // 6. 配方书
        player.resetRecipes(server.getRecipeManager().getRecipes());
        // 7. 发材料，记统计基线
        for (int i = 0; i < items.size(); i++) player.getInventory().setItem(items.get(i).slot(), stacks.get(i));
        player.inventoryMenu.broadcastChanges();
        List<Watch> watch = new ArrayList<>();
        Map<String, Object> baseline = new LinkedHashMap<>();
        for (int i = 0; i < watchIds.size(); i++) {
            int value = crafted(player, watchItems.get(i));
            watch.add(new Watch(watchItems.get(i), watchIds.get(i), value));
            baseline.put(watchIds.get(i), value);
        }
        BlockPos stationAt = stationBlock != null ? stationPos(o) : null;
        active = new Run(arena, o.immutable(), player.getUUID(), watch, System.currentTimeMillis(), stationAt, stationBlock);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("arena", arena);
        out.put("startedAtMs", active.startedAtMs);
        out.put("baseline", baseline);
        List<Map<String, Object>> given = new ArrayList<>();
        for (Give g : items) given.add(Map.of("slot", g.slot(), "id", g.id(), "count", g.count()));
        out.put("given", given);
        out.put("inventory", inventory(player, null));
        if (stationBlock != null) {
            out.put("station", station);
            out.put("pitch", player.getXRot());
            out.put("aimOk", aimsAt(player, stationAt, stationBlock));
        }
        return out;
    }

    /** 当前一轮的状态（没有进行中的一轮时 active=false）。 */
    public static Map<String, Object> status(MinecraftServer server) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("active", active != null);
        if (active == null) return out;
        out.put("arena", active.arena);
        out.put("startedAtMs", active.startedAtMs);
        out.put("craftedAtMs", active.craftedAtMs);
        out.put("craftedItem", active.craftedItem);
        if (active.station != null) {
            out.put("openedAtMs", active.openedAtMs);
            out.put("stationIntact", server.overworld().getBlockState(active.stationPos).is(active.station));
        }
        ServerPlayer player = server.getPlayerList().getPlayer(active.player);
        out.put("playerOnline", player != null);
        if (player == null) return out;
        Map<String, Object> delta = new LinkedHashMap<>();
        for (Watch w : active.watch) delta.put(w.id(), crafted(player, w.item()) - w.baseline());
        out.put("craftedDelta", delta);
        out.put("inventory", inventory(player, active.watch));
        out.put("insideArena", inside(server, player, active.origin));
        return out;
    }

    /** 结束本轮：读最终状态后传送到场外。没有进行中的一轮时只传送。 */
    public static Map<String, Object> finish(MinecraftServer server, ServerPlayer player, BlockPos fallbackOrigin) {
        Map<String, Object> out = status(server);
        BlockPos o = active != null ? active.origin : fallbackOrigin;
        active = null;
        player.containerMenu.setCarried(ItemStack.EMPTY);
        player.closeContainer();
        teleportOutside(server, player, o);
        return out;
    }

    /** 服务器 tick：记第一次合成时刻、第一次打开工作台的时刻；定期清掉场内敌对生物。 */
    public static void onServerTick(MinecraftServer server) {
        Run run = active;
        if (run == null) return;
        ServerPlayer player = server.getPlayerList().getPlayer(run.player);
        if (player == null) return;
        if (run.craftedAtMs == null) {
            for (Watch w : run.watch) {
                if (crafted(player, w.item()) > w.baseline()) {
                    run.craftedAtMs = System.currentTimeMillis();
                    run.craftedItem = w.id();
                    break;
                }
            }
        }
        if (run.station != null && run.openedAtMs == null && player.containerMenu instanceof CraftingMenu) {
            run.openedAtMs = System.currentTimeMillis();
        }
        if (++tickCounter % MONSTER_SWEEP_TICKS == 0) {
            for (Entity e : server.overworld().getEntitiesOfClass(Entity.class, box(run.origin), e -> e instanceof Enemy)) e.discard();
        }
    }

    // ── 工具 ─────────────────────────────────────────────────────────────

    private static Item item(String id) {
        Identifier key = Identifier.tryParse(id);
        if (key == null || !BuiltInRegistries.ITEM.containsKey(key)) throw new IllegalArgumentException("unknown item: " + id);
        return BuiltInRegistries.ITEM.getValue(key);
    }

    private static int crafted(ServerPlayer player, Item item) {
        return player.getStats().getValue(Stats.ITEM_CRAFTED.get(item));
    }

    /** 物品栏按物品 id 汇总数量；watch 不为 null 时只汇总这些物品（全部列出，没有的记 0）。 */
    private static Map<String, Integer> inventory(ServerPlayer player, List<Watch> watch) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        if (watch != null) for (Watch w : watch) counts.put(w.id(), 0);
        var inv = player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack stack = inv.getItem(i);
            if (stack.isEmpty()) continue;
            String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
            if (watch != null && !counts.containsKey(id)) continue;
            counts.merge(id, stack.getCount(), Integer::sum);
        }
        // 光标上拿着的（刚从合成结果槽取出、还没放下）也算
        ItemStack carried = player.containerMenu.getCarried();
        if (!carried.isEmpty()) {
            String id = BuiltInRegistries.ITEM.getKey(carried.getItem()).toString();
            if (watch == null || counts.containsKey(id)) counts.merge(id, carried.getCount(), Integer::sum);
        }
        return counts;
    }
}
