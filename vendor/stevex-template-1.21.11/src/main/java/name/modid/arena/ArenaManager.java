package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

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
 */
public final class ArenaManager {

    public static final BlockPos DEFAULT_ORIGIN = new BlockPos(10000, 120, 10000);

    /** 已知场地：名字 → origin。arena/build 会登记或更新；/arena 命令按这里传送。 */
    private static final Map<String, BlockPos> KNOWN = new ConcurrentHashMap<>(Map.of("craft2x2", DEFAULT_ORIGIN));

    private static final int MONSTER_SWEEP_TICKS = 20;

    private record Watch(Item item, String id, int baseline) {}

    /** 进行中的一轮；null = 没有进行中的训练。 */
    private static final class Run {
        final String arena;
        final BlockPos origin;
        final UUID player;
        final List<Watch> watch;
        final long startedAtMs;
        Long craftedAtMs;
        String craftedItem;

        Run(String arena, BlockPos origin, UUID player, List<Watch> watch, long startedAtMs) {
            this.arena = arena;
            this.origin = origin;
            this.player = player;
            this.watch = watch;
            this.startedAtMs = startedAtMs;
        }
    }

    private static Run active;
    private static int tickCounter;

    private ArenaManager() {}

    public static boolean isActive() {
        return active != null;
    }

    public static Map<String, BlockPos> known() {
        return KNOWN;
    }

    /** 世界关闭时丢掉进行中的状态，避免带进下一个世界。 */
    public static void reset() {
        active = null;
    }

    // ── 搭建 ─────────────────────────────────────────────────────────────

    /** 幂等搭建场地，返回实际改动的方块数。 */
    public static int build(MinecraftServer server, String arena, BlockPos o) {
        KNOWN.put(arena, o.immutable());
        ServerLevel level = server.overworld();
        int ox = o.getX(), oy = o.getY(), oz = o.getZ();
        int placed = 0;
        // 场内：地板 11×11，外圈屏障墙 3 格高；场内上方清空
        for (int dx = -5; dx <= 5; dx++) {
            for (int dz = -5; dz <= 5; dz++) {
                placed += set(level, new BlockPos(ox + dx, oy, oz + dz), Blocks.STONE.defaultBlockState());
                boolean wall = Math.abs(dx) == 5 || Math.abs(dz) == 5;
                for (int dy = 1; dy <= 3; dy++) {
                    BlockState state = wall ? Blocks.BARRIER.defaultBlockState() : Blocks.AIR.defaultBlockState();
                    placed += set(level, new BlockPos(ox + dx, oy + dy, oz + dz), state);
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

    private static void teleportInside(MinecraftServer server, ServerPlayer player, BlockPos o) {
        player.teleportTo(server.overworld(), o.getX() + 0.5, o.getY() + 1, o.getZ() + 0.5, Set.of(), 0f, 0f, true);
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

    /** 一个要发放的物品：slot ∈ [0, 35]（主物品栏），count ∈ [1, 堆叠上限]。 */
    public record Give(int slot, String id, int count) {}

    /**
     * 每轮重置（方案 T8）并发放材料，开始监测 watch 里各物品的 crafted 统计。
     * 已有进行中的一轮时拒绝：先 finish 再开新一轮。
     */
    public static Map<String, Object> prepare(MinecraftServer server, ServerPlayer player, String arena, BlockPos o,
                                              List<Give> items, List<String> watchIds, long dayTime) {
        if (active != null) throw new IllegalStateException("a run is already active in arena " + active.arena + " (call arena/finish first)");
        List<ItemStack> stacks = new ArrayList<>();
        boolean[] used = new boolean[36];
        for (Give g : items) {
            if (g.slot() < 0 || g.slot() > 35) throw new IllegalArgumentException("slot out of range [0, 35]: " + g.slot());
            if (used[g.slot()]) throw new IllegalArgumentException("duplicate slot: " + g.slot());
            used[g.slot()] = true;
            Item item = item(g.id());
            if (g.count() < 1 || g.count() > item.getDefaultMaxStackSize()) throw new IllegalArgumentException("bad count for " + g.id() + ": " + g.count());
            stacks.add(new ItemStack(item, g.count()));
        }
        List<Item> watchItems = new ArrayList<>();
        for (String id : watchIds) watchItems.add(item(id));

        build(server, arena, o);
        ServerLevel level = server.overworld();
        // 1. 先关界面：2×2 合成格里的物品退回物品栏、客户端界面一并关掉；光标物品清掉
        player.containerMenu.setCarried(ItemStack.EMPTY);
        player.closeContainer();
        player.containerMenu.setCarried(ItemStack.EMPTY);
        // 2. 清空物品栏（含盔甲、副手）
        player.getInventory().clearContent();
        player.inventoryMenu.getCraftSlots().clearContent();
        teleportInside(server, player, o);
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
        active = new Run(arena, o.immutable(), player.getUUID(), watch, System.currentTimeMillis());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("arena", arena);
        out.put("startedAtMs", active.startedAtMs);
        out.put("baseline", baseline);
        out.put("inventory", inventory(player, null));
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

    /** 服务器 tick：记第一次合成时刻；定期清掉场内敌对生物。 */
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
