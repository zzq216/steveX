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
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ChestMenu;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.DispenserMenu;
import net.minecraft.world.inventory.HopperMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.HopperBlock;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.ChestType;
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
 *
 * <p>箱子场地（docs/箱子训练场设计方案.md）：工作站是小箱子（{@code chest}）或大箱子（{@code large_chest}，
 * 多占 (ox+1, oy+1, oz+2) 一格），每轮按本轮的大小重搭；prepare 清空并布置箱子、登记本轮的目标计数
 * （{@link Expect}），tick 里记第一次恰好达到目标的时刻（C9）；status 另报箱子、物品栏、光标、地上掉落物的计数（C8）。
 * 同一场地也可以换成漏斗（{@code hopper}，正下方地板换成红石块把它锁住，方案 C15）或发射器（{@code dispenser}），
 * 下文"容器工作站"指这四种。
 */
public final class ArenaManager {

    public static final BlockPos DEFAULT_ORIGIN = new BlockPos(10000, 120, 10000);

    /** 一块场地：origin + 工作站名（null = 没有工作站）。 */
    public record Site(BlockPos origin, String station) {}

    /** 工作站名 → 方块：工作台（W2）；小箱子、大箱子（箱子方案 C2，大箱子是两块 CHEST）；漏斗、发射器（方案 §8）。 */
    private static final Map<String, Block> STATIONS = Map.of(
            "crafting_table", Blocks.CRAFTING_TABLE,
            "chest", Blocks.CHEST,
            "large_chest", Blocks.CHEST,
            "hopper", Blocks.HOPPER,
            "dispenser", Blocks.DISPENSER);

    /** 已知场地：名字 → Site。arena/build 会登记或更新；/arena 命令按这里传送。 */
    private static final Map<String, Site> KNOWN = new ConcurrentHashMap<>(Map.of(
            "craft2x2", new Site(DEFAULT_ORIGIN, null),
            "craft3x3", new Site(new BlockPos(10000, 120, 10030), "crafting_table"),
            "chest", new Site(new BlockPos(10000, 120, 10060), "chest")));

    private static final int MONSTER_SWEEP_TICKS = 20;

    private record Watch(Item item, String id, int baseline) {}

    /**
     * 本轮的目标计数（箱子方案 C9）：物品栏（不含光标）与工作站容器里各物品 id 的数量都恰好如此、且光标为空，
     * 就算到达。取 / 放、要几个这些语义由插件定，mod 只比对。
     */
    public record Expect(Map<String, Integer> inventory, Map<String, Integer> container) {}

    /** 进行中的一轮；null = 没有进行中的训练。 */
    private static final class Run {
        final String arena;
        final BlockPos origin;
        final UUID player;
        final List<Watch> watch;
        final long startedAtMs;
        final String stationName; // 没有工作站时为 null
        final Map<BlockPos, Block> stationBlocks; // 工作站占的各格应有的方块（大箱子两格，漏斗连同下面的红石块）；没有工作站时为空
        final Block station;
        final Expect expect; // 没有目标计数时为 null
        Long craftedAtMs;
        String craftedItem;
        Long openedAtMs;
        Long reachedAtMs;

        Run(String arena, BlockPos origin, UUID player, List<Watch> watch, long startedAtMs, String stationName, Block station, Expect expect) {
            this.arena = arena;
            this.origin = origin;
            this.player = player;
            this.watch = watch;
            this.startedAtMs = startedAtMs;
            this.stationName = stationName;
            Map<BlockPos, Block> blocks = new LinkedHashMap<>();
            stationStates(stationName, origin).forEach((pos, state) -> blocks.put(pos, state.getBlock()));
            this.stationBlocks = Collections.unmodifiableMap(blocks);
            this.station = station;
            this.expect = expect;
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

    /** 容器工作站：小箱子、大箱子、漏斗、发射器（箱子方案、§8）。 */
    public static boolean isStorage(String station) {
        return storageCapacity(station) > 0;
    }

    /** 容器工作站的格数：小箱子 27、大箱子 54、漏斗 5、发射器 9；不是容器工作站 → 0。 */
    public static int storageCapacity(String station) {
        if (station == null) return 0;
        return switch (station) {
            case "chest" -> 27;
            case "large_chest" -> 54;
            case "hopper" -> 5;
            case "dispenser" -> 9;
            default -> 0;
        };
    }

    /**
     * 工作站占的方块与状态。工作台、小箱子占一格；大箱子占两格（箱子方案 C2）。
     *
     * <p>箱子朝北，正面对着站在 -z 一侧的玩家。两个相邻箱子<b>不会</b>因为 setBlock 自动连成大箱子
     * （{@code ChestBlock.updateShape} 只在邻居已经是 LEFT/RIGHT 时才跟着连，{@code ChestBlock.java:170-180}），
     * 所以两半显式设 TYPE。{@code getConnectedDirection}：LEFT 连向 FACING 的顺时针方向，朝北时是东，
     * 故 LEFT 在 (ox, oz+2)、RIGHT 在 (ox+1, oz+2)。准星对着 LEFT 那一半。
     *
     * <p>漏斗（§8 C15）：正下方的地板换成红石块。漏斗的 ENABLED 在放置、邻居变化时按红石信号重设
     * （{@code HopperBlock.java:99-125}），只有真的有信号才锁得住，锁住后不推送、不吸掉落物。
     * 状态里也写 ENABLED=false：同一块漏斗重搭时状态相同就不动它，不会被写回"启用"。
     * 搭建时同一列先放地板再放工作站，所以换成发射器时红石块先变回石头，发射器不会被触发。
     */
    private static Map<BlockPos, BlockState> stationStates(String station, BlockPos o) {
        Map<BlockPos, BlockState> out = new LinkedHashMap<>();
        if (station == null) return out;
        BlockPos at = stationPos(o);
        switch (station) {
            case "chest" -> out.put(at, chestState(ChestType.SINGLE));
            case "large_chest" -> {
                out.put(at, chestState(ChestType.LEFT));
                out.put(at.east(), chestState(ChestType.RIGHT));
            }
            case "hopper" -> {
                out.put(at, Blocks.HOPPER.defaultBlockState().setValue(HopperBlock.ENABLED, false));
                out.put(at.below(), Blocks.REDSTONE_BLOCK.defaultBlockState());
            }
            default -> out.put(at, station(station).defaultBlockState());
        }
        return out;
    }

    private static BlockState chestState(ChestType type) {
        return Blocks.CHEST.defaultBlockState().setValue(ChestBlock.FACING, Direction.NORTH).setValue(ChestBlock.TYPE, type);
    }

    /**
     * 容器工作站的容器。大箱子取合并容器，格号与界面一致（RIGHT 那半在前，{@code ChestBlock.combine}）；
     * 只剩一半时就是那一半。漏斗、发射器就是方块实体本身。那一格不是这种容器（被挖掉了）→ null。
     */
    private static Container stationContainer(ServerLevel level, BlockPos o, String station) {
        BlockPos at = stationPos(o);
        BlockState state = level.getBlockState(at);
        if (state.getBlock() instanceof ChestBlock chest && state.is(Blocks.CHEST) && ("chest".equals(station) || "large_chest".equals(station))) {
            return ChestBlock.getContainer(chest, state, level, at, true);
        }
        Block block = STATIONS.get(station);
        if ((block == Blocks.HOPPER || block == Blocks.DISPENSER) && state.is(block) && level.getBlockEntity(at) instanceof Container container) {
            return container;
        }
        return null;
    }

    /** 世界关闭时丢掉进行中的状态，避免带进下一个世界。 */
    public static void reset() {
        active = null;
    }

    // ── 搭建 ─────────────────────────────────────────────────────────────

    /** 幂等搭建场地，返回实际改动的方块数。station 不为 null 时在场内放工作站，被挖掉的会补回（W8）。 */
    public static int build(MinecraftServer server, String arena, BlockPos o, String station) {
        station(station); // 未知名字在这里报错
        KNOWN.put(arena, new Site(o.immutable(), station));
        ServerLevel level = server.overworld();
        int ox = o.getX(), oy = o.getY(), oz = o.getZ();
        Map<BlockPos, BlockState> stationAt = stationStates(station, o);
        int placed = 0;
        // 场内：地板 11×11，外圈屏障墙 3 格高；场内上方清空（所以箱子上方一定是空气、打得开，箱子方案 S4）。
        // 换箱子大小时，多出来的那半随场内清空改回空气
        for (int dx = -5; dx <= 5; dx++) {
            for (int dz = -5; dz <= 5; dz++) {
                // 地板也从工作站表里取（漏斗下面的红石块），同一列先放地板再放工作站（§8 C15）
                BlockPos floor = new BlockPos(ox + dx, oy, oz + dz);
                placed += set(level, floor, stationAt.getOrDefault(floor, Blocks.STONE.defaultBlockState()));
                boolean wall = Math.abs(dx) == 5 || Math.abs(dz) == 5;
                for (int dy = 1; dy <= 3; dy++) {
                    BlockPos pos = new BlockPos(ox + dx, oy + dy, oz + dz);
                    BlockState state = wall ? Blocks.BARRIER.defaultBlockState()
                            : stationAt.getOrDefault(pos, Blocks.AIR.defaultBlockState());
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
     * 箱子里的物品（箱子方案 C4）：格号在 [0, capacity) 里、不重复，数量在 [1, 堆叠上限] 里——
     * 出题器保证不超上限，这里不兜底拆堆，超了直接报错。
     */
    static void checkChestItems(List<Give> items, int capacity) {
        if (!items.isEmpty() && capacity == 0) throw new IllegalArgumentException("chestItems need a chest station");
        boolean[] used = new boolean[Math.max(capacity, 1)];
        for (Give g : items) {
            if (g.slot() < 0 || g.slot() >= capacity) throw new IllegalArgumentException("chest slot out of range [0, " + (capacity - 1) + "]: " + g.slot());
            if (used[g.slot()]) throw new IllegalArgumentException("duplicate chest slot: " + g.slot());
            used[g.slot()] = true;
            int max = item(g.id()).getDefaultMaxStackSize();
            if (g.count() < 1 || g.count() > max) throw new IllegalArgumentException("bad count for " + g.id() + " in the chest: " + g.count() + " (stack size " + max + ")");
        }
    }

    /**
     * 每轮重置（方案 T8）并发放材料，开始监测 watch 里各物品的 crafted 统计。
     * 箱子工作站（箱子方案）：清空箱子后放进 chestItems；给了 expect 就在 tick 里检测到达（C9）。
     * 已有进行中的一轮时拒绝：先 finish 再开新一轮。
     */
    public static Map<String, Object> prepare(MinecraftServer server, ServerPlayer player, String arena, BlockPos o, String station,
                                              List<Give> requested, List<Give> chestItems, long seed, List<String> watchIds,
                                              Expect expect, long dayTime) {
        if (active != null) throw new IllegalStateException("a run is already active in arena " + active.arena + " (call arena/finish first)");
        Block stationBlock = station(station);
        checkChestItems(chestItems, storageCapacity(station));
        if (expect != null && !isStorage(station)) throw new IllegalArgumentException("expect needs a container station (chest, large_chest, hopper, dispenser)");
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
        // 8. 箱子：先清空（上一轮剩下的不能留），再放本轮的
        Container chest = null;
        if (isStorage(station)) {
            chest = stationContainer(level, o, station);
            if (chest == null) throw new IllegalStateException("no " + station + " at " + stationPos(o) + " after building the arena");
            chest.clearContent();
            for (Give g : chestItems) chest.setItem(g.slot(), new ItemStack(item(g.id()), g.count()));
            chest.setChanged();
        }
        List<Watch> watch = new ArrayList<>();
        Map<String, Object> baseline = new LinkedHashMap<>();
        for (int i = 0; i < watchIds.size(); i++) {
            int value = crafted(player, watchItems.get(i));
            watch.add(new Watch(watchItems.get(i), watchIds.get(i), value));
            baseline.put(watchIds.get(i), value);
        }
        active = new Run(arena, o.immutable(), player.getUUID(), watch, System.currentTimeMillis(), station, stationBlock, expect);

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
            out.put("aimOk", aimsAt(player, stationPos(o), stationBlock));
        }
        if (chest != null) {
            // 大箱子没连上时这里是 27（C2 自检）
            out.put("chestSlots", chest.getContainerSize());
            out.put("chest", counts(chest));
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
        ServerLevel level = server.overworld();
        if (active.station != null) {
            out.put("openedAtMs", active.openedAtMs);
            out.put("stationIntact", stationIntact(level, active));
        }
        if (active.expect != null) out.put("reachedAtMs", active.reachedAtMs);
        ServerPlayer player = server.getPlayerList().getPlayer(active.player);
        out.put("playerOnline", player != null);
        if (player == null) return out;
        Map<String, Object> delta = new LinkedHashMap<>();
        for (Watch w : active.watch) delta.put(w.id(), crafted(player, w.item()) - w.baseline());
        out.put("craftedDelta", delta);
        out.put("inventory", inventory(player, active.watch));
        out.put("insideArena", inside(server, player, active.origin));
        if (isStorage(active.stationName)) {
            // 箱子方案 C8：四处分开计数——物品栏（不含光标）、容器、光标、场内地上
            Container chest = stationContainer(level, active.origin, active.stationName);
            out.put("chestSlots", chest != null ? chest.getContainerSize() : null);
            out.put("chest", chest != null ? counts(chest) : null);
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
        }
        return out;
    }

    /** 工作站的每一格都还是应有的方块（大箱子要两半都在，漏斗下面的红石块也要在，§8 S22）。 */
    private static boolean stationIntact(ServerLevel level, Run run) {
        for (Map.Entry<BlockPos, Block> e : run.stationBlocks.entrySet()) if (!level.getBlockState(e.getKey()).is(e.getValue())) return false;
        return true;
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

    /** 服务器 tick：记第一次合成、第一次打开工作站、第一次恰好达到目标计数的时刻；定期清掉场内敌对生物。 */
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
        if (run.station != null && run.openedAtMs == null && opensStation(run.stationName, player.containerMenu)) {
            run.openedAtMs = System.currentTimeMillis();
        }
        if (run.expect != null && run.reachedAtMs == null && reached(server.overworld(), player, run)) {
            run.reachedAtMs = System.currentTimeMillis();
        }
        if (++tickCounter % MONSTER_SWEEP_TICKS == 0) {
            for (Entity e : server.overworld().getEntitiesOfClass(Entity.class, box(run.origin), e -> e instanceof Enemy)) e.discard();
        }
    }

    /**
     * 当前界面是不是这个工作站的界面：工作台 → CraftingMenu（物品栏的 2×2 是 InventoryMenu，不会误记）；
     * 箱子 → ChestMenu；漏斗 → HopperMenu；发射器 → DispenserMenu。
     */
    private static boolean opensStation(String station, AbstractContainerMenu menu) {
        return switch (station) {
            case "chest", "large_chest" -> menu instanceof ChestMenu;
            case "hopper" -> menu instanceof HopperMenu;
            case "dispenser" -> menu instanceof DispenserMenu;
            default -> menu instanceof CraftingMenu;
        };
    }

    /** 箱子方案 C9：物品栏（不含光标）与容器的计数恰好等于 expect，且光标为空。容器不在了 → 否。 */
    private static boolean reached(ServerLevel level, ServerPlayer player, Run run) {
        if (!player.containerMenu.getCarried().isEmpty()) return false;
        Container chest = stationContainer(level, run.origin, run.stationName);
        return chest != null && counts(player.getInventory()).equals(run.expect.inventory()) && counts(chest).equals(run.expect.container());
    }

    // ── 工具 ─────────────────────────────────────────────────────────────

    private static String id(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    /** 容器按物品 id 汇总数量（只列有的；插件传来的 expect 也去掉了 0）。玩家物品栏含盔甲、副手格。 */
    private static Map<String, Integer> counts(Container container) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (int i = 0; i < container.getContainerSize(); i++) {
            ItemStack stack = container.getItem(i);
            if (!stack.isEmpty()) out.merge(id(stack), stack.getCount(), Integer::sum);
        }
        return out;
    }

    /** 光标上的物品：{ id: count }，空 → {}。 */
    private static Map<String, Integer> carried(AbstractContainerMenu menu) {
        ItemStack stack = menu.getCarried();
        return stack.isEmpty() ? Map.of() : Map.of(id(stack), stack.getCount());
    }

    /** 场内地上的掉落物按 id 汇总（扔出来的、箱子被挖掉后掉出来的）。 */
    private static Map<String, Integer> dropped(ServerLevel level, BlockPos o) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box(o))) {
            ItemStack stack = e.getItem();
            if (!stack.isEmpty()) out.merge(id(stack), stack.getCount(), Integer::sum);
        }
        return out;
    }

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
