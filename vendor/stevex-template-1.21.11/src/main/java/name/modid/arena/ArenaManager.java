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
import net.minecraft.world.inventory.StonecutterMenu;
import net.minecraft.world.inventory.LoomMenu;
import net.minecraft.world.inventory.CartographyTableMenu;
import net.minecraft.world.inventory.BrewingStandMenu;
import net.minecraft.world.inventory.CrafterMenu;
import net.minecraft.world.inventory.MerchantMenu;
import net.minecraft.world.level.block.entity.CrafterBlockEntity;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import net.minecraft.world.level.block.LoomBlock;
import net.minecraft.world.inventory.EnchantmentMenu;
import net.minecraft.world.inventory.BeaconMenu;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.SmithingMenu;
import net.minecraft.world.inventory.AbstractMountInventoryMenu;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.npc.villager.Villager;
import net.minecraft.world.entity.animal.equine.AbstractHorse;
import net.minecraft.world.entity.animal.nautilus.AbstractNautilus;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.phys.EntityHitResult;
import name.modid.mixin.MountMenuAccessor;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.block.AnvilBlock;
import net.minecraft.tags.BlockTags;
import net.minecraft.core.Holder;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.level.block.entity.BeaconBlockEntity;
import name.modid.mixin.PlayerAccessor;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.HopperBlock;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.item.crafting.AbstractCookingRecipe;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.SingleRecipeInput;
import net.minecraft.world.inventory.BlastFurnaceMenu;
import net.minecraft.world.inventory.FurnaceMenu;
import net.minecraft.world.inventory.SmokerMenu;
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
 *
 * <p>切石机场地（docs/切石机训练场设计方案.md）：工作站是切石机（{@code stonecutter}，没有容器）。prepare 登记"只看目标"的
 * 目标计数（{@link Expect} 的 targets / allowed，Q9）；status 另报物品栏、光标、切石机输入格、地上掉落物的计数（Q8）。
 *
 * <p>熔炉场地（docs/熔炉训练场设计方案.md）：工作站是熔炉、高炉或烟熏炉（{@code furnace} / {@code blast_furnace} / {@code smoker}，
 * 每轮由插件指定）。prepare 先清空并拆掉上一轮的炉子再放新的（K12），登记"炉子"写法的目标（{@link Cook}，K8），
 * 返回服务器端的燃料时长、烧制时间、产物和堆叠上限供插件核对；炉子按原版速度工作（第二版不加速，K6）；
 * status 另报物品栏、光标、炉子三格和点燃状态、地上掉落物的计数。
 *
 * <p>附魔台场地（docs/附魔台训练场设计方案.md）：工作站是附魔台加同层外圈的书架（{@code enchanting_table}，书架也算工作站）。
 * arena/enchant-preview 按物品、附魔种子、书架数预览三档（{@link EnchantArena#preview}）；prepare 设经验等级和附魔种子，
 * 用真实的附魔台菜单再算一遍三档供插件核对，登记"附魔"写法的目标（{@link Enchant}，N8）；status 另报物品栏、光标、附魔台两格、
 * 地上掉落物、界面开没开、经验等级和那件物品现在的附魔。
 *
 * <p>信标场地（docs/信标训练场设计方案.md）：工作站是信标加埋在地板下的铁块底座（{@code beacon}，底座也算工作站，层数按轮设置，G1、G2）。
 * prepare 拆掉旧信标再放新的（清空效果），按本轮等级铺底座、拆掉多余的层；登记"信标"写法的目标（{@link Beacon}，G7）；
 * 付款由 {@code BeaconPaymentMixin} 报给 {@link #onBeaconPaid}；status 另报物品栏、光标、付款格、地上掉落物、界面开没开、
 * 信标的等级和主副效果、付款记录；finish 读完状态后再拆掉信标重放、清掉玩家身上的效果（G10）。
 *
 * <p>铁砧场地（docs/铁砧训练场设计方案.md）：工作站是铁砧（{@code anvil}，朝东）。build 遇到开裂、损坏的铁砧会换回完好的，所以每轮 prepare 都是新铁砧（A1）；
 * 开裂、损坏的铁砧也算工作站还在。arena/anvil-catalog、arena/anvil-preview 是出题用的只读接口（{@link AnvilArena}，A2、A4）；
 * prepare 发带附魔的物品、设经验等级，登记"铁砧"写法的目标（{@link Anvil}，A7）；取出产物由 {@code AnvilTakeMixin} 报给 {@link #onAnvilTake}；
 * status 另报物品栏、光标、铁砧两格、地上掉落物、界面开没开、铁砧的状态、经验等级、取出记录。
 *
 * <p>织布机场地（docs/织布机训练场设计方案.md）：工作站是织布机（{@code loom}）。arena/loom-catalog 是出题用的只读目录（{@link LoomArena}，L11）；
 * 物品按签名计数（带图案的旗帜和素旗 id 相同，L9）；prepare 登记 {@link LoomArena.Spec}；status 另报物品栏、光标、织布机输入格、地上的计数（L8）。
 *
 * <p>制图台场地（docs/制图台训练场设计方案.md）：工作站是制图台（{@code cartography}）。prepare 的 items 里带 map 的一项由 mod 现做开局地图（{@link CartographyArena#create}，K6），
 * 地图按签名计数（缩放等级、是否锁定、是不是从开局地图做出来的，K9）；prepare 登记 {@link CartographyArena.Spec}；status 另报物品栏、光标、制图台输入格、地上的计数（K8）。
 *
 * <p>酿造台场地（docs/酿造台训练场设计方案.md）：工作站是酿造台（{@code brewing_stand}），每轮清空后换一台新的（燃料值、酿造进度清掉，P11）。
 * prepare 的 items 里带 potion 的项发指定药水（P8），用服务器的酿造配方核对题目（{@link BrewArena#check}）；物品按签名计数（瓶子 id#药水，P7）；
 * status 另报物品栏、光标、地上、酿造台五格和燃料值、酿造次数（{@code BrewingBrewMixin} 报给 {@link #onBrew}，P9）。
 *
 * <p>合成器场地（docs/合成器训练场设计方案.md）：工作站是合成器（{@code crafter}），每轮清空后换一台新的（格子、禁用状态清掉，R8）。
 * prepare 用服务器配方核对规范摆法的产物（{@link CrafterArena#check}）；status 另报物品栏、光标、地上（按 id）和合成器九格、禁用格、预览产物、通电状态。
 *
 * <p>锻造台场地（docs/锻造台训练场设计方案.md）：工作站是锻造台（{@code smithing_table}，不会损坏，M1）。arena/smithing-catalog、
 * arena/smithing-preview 是出题用的只读接口（{@link SmithingArena}，M2、M4）；prepare 登记"锻造"写法的目标（{@link Smith}，可以有多个，M7）；
 * 取出产物由 {@code SmithingTakeMixin} 报给 {@link #onSmithingTake}；status 另报物品栏（每件带纹饰）、光标、锻造台三格、地上掉落物、
 * 界面开没开、取出记录。
 *
 * <p>坐骑场地（docs/坐骑训练场设计方案.md）：工作站是一只动物（{@code mount}，实体工作站）。方块上只留空气；鹦鹉螺组把下面那格地板换成水坑（H1）。
 * prepare 先让玩家下坐骑、清掉场内的坐骑类动物，再按 {@link MountSetup} 生成本轮的动物（{@link MountArena#spawn}，H2），记下 UUID；
 * 准星自检改成实体射线检测；登记"坐骑"写法的目标（{@link MountGoal}，H6）；status 另报动物身上的东西、物品栏、光标、地上掉落物、
 * 界面开没开、骑没骑着、第一次骑上的时刻、有没有不开界面直接装备；finish 先让玩家下来再传送（H8）。动物不在了算工作站被毁。
 *
 * <p>村民交易场地（docs/村民交易训练场设计方案.md）：工作站是一只村民（{@code villager}，实体工作站，方块上只留空气，V1）。
 * arena/trade-preview 是出题用的只读接口（{@link VillagerArena#create}，V2、V3）；prepare 清掉场内的村民，按 {@link VillagerArena.Setup}
 * 生成本轮的村民（NoAI、无敌、成年），记下 UUID，返回交易描述供插件和预览核对；登记"交易"写法的目标（{@link VillagerArena.Spec}，V9）；
 * status 另报村民每笔交易的次数、物品栏、光标、支付格、地上（按 id）、界面开没开。村民不在了算工作站被毁。
 */
public final class ArenaManager {

    public static final BlockPos DEFAULT_ORIGIN = new BlockPos(10000, 120, 10000);

    /** 一块场地：origin + 工作站名（null = 没有工作站）。 */
    public record Site(BlockPos origin, String station) {}

    /** 工作站名 → 方块：工作台（W2）；小箱子、大箱子（箱子方案 C2，大箱子是两块 CHEST）；漏斗、发射器（方案 §8）；切石机（切石机方案 Q1）。 */
    private static final Map<String, Block> STATIONS = Map.ofEntries(
            Map.entry("crafting_table", Blocks.CRAFTING_TABLE),
            Map.entry("chest", Blocks.CHEST),
            Map.entry("large_chest", Blocks.CHEST),
            Map.entry("hopper", Blocks.HOPPER),
            Map.entry("dispenser", Blocks.DISPENSER),
            Map.entry("stonecutter", Blocks.STONECUTTER),
            Map.entry("furnace", Blocks.FURNACE),
            Map.entry("blast_furnace", Blocks.BLAST_FURNACE),
            Map.entry("smoker", Blocks.SMOKER),
            Map.entry("enchanting_table", Blocks.ENCHANTING_TABLE),
            Map.entry("beacon", Blocks.BEACON),
            Map.entry("anvil", Blocks.ANVIL),
            Map.entry("smithing_table", Blocks.SMITHING_TABLE),
            Map.entry("loom", Blocks.LOOM),
            Map.entry("cartography", Blocks.CARTOGRAPHY_TABLE),
            Map.entry("brewing_stand", Blocks.BREWING_STAND),
            Map.entry("crafter", Blocks.CRAFTER),
            Map.entry("villager", Blocks.AIR),
            // 坐骑场地（坐骑方案 H1）：工作站是动物，方块位置上只留空气
            Map.entry("mount", Blocks.AIR));

    /**
     * 已知场地：名字 → Site。arena/build 会登记或更新；/arena 命令按这里传送。
     * 信标场地换到 x = 10100（信标方案 G1）：4 级信标的水平范围是 50 格，沿 z 轴每隔 30 格排会覆盖附魔台场地。
     */
    private static final Map<String, Site> KNOWN = new ConcurrentHashMap<>(Map.ofEntries(
            Map.entry("craft2x2", new Site(DEFAULT_ORIGIN, null)),
            Map.entry("craft3x3", new Site(new BlockPos(10000, 120, 10030), "crafting_table")),
            Map.entry("chest", new Site(new BlockPos(10000, 120, 10060), "chest")),
            Map.entry("stonecutter", new Site(new BlockPos(10000, 120, 10090), "stonecutter")),
            Map.entry("furnace", new Site(new BlockPos(10000, 120, 10120), "furnace")),
            Map.entry("enchanting", new Site(new BlockPos(10000, 120, 10150), "enchanting_table")),
            Map.entry("beacon", new Site(new BlockPos(10100, 120, 10000), "beacon")),
            Map.entry("anvil", new Site(new BlockPos(10000, 120, 10180), "anvil")),
            Map.entry("smithing", new Site(new BlockPos(10000, 120, 10210), "smithing_table")),
            Map.entry("mount", new Site(new BlockPos(10000, 120, 10240), "mount")),
            Map.entry("loom", new Site(new BlockPos(10000, 120, 10270), "loom")),
            Map.entry("cartography", new Site(new BlockPos(10000, 120, 10300), "cartography")),
            Map.entry("brewing", new Site(new BlockPos(10000, 120, 10330), "brewing_stand")),
            Map.entry("crafter", new Site(new BlockPos(10000, 120, 10360), "crafter")),
            Map.entry("villager", new Site(new BlockPos(10000, 120, 10390), "villager"))));

    private static final int MONSTER_SWEEP_TICKS = 20;

    private record Watch(Item item, String id, int baseline) {}

    /**
     * 本轮的目标计数，两种写法：
     * <ul>
     *   <li>箱子方案 C9（targets 为 null）：物品栏（不含光标）与工作站容器里各物品 id 的数量都恰好如此、且光标为空，就算到达；</li>
     *   <li>切石机方案 Q9（targets 不为 null）：只看目标——每个目标在物品栏里恰好是 n 个、在光标和切石机输入格里没有；
     *       光标为空；物品栏、光标、输入格里没有 allowed 以外的物品。剩多少材料不比较（走哪条路切，材料消耗都可能不同）。</li>
     *   <li>熔炉方案 K8（cook 不为 null）：见 {@link Cook}。</li>
     *   <li>附魔台方案 N8（enchant 不为 null）：见 {@link Enchant}。</li>
     *   <li>信标方案 G7（beacon 不为 null）：见 {@link Beacon}。</li>
     *   <li>铁砧方案 A7（anvil 不为 null）：见 {@link Anvil}。</li>
     *   <li>锻造台方案 M7（smithing 不为 null）：见 {@link Smith}。</li>
     *   <li>坐骑方案 H6（mount 不为 null）：见 {@link MountGoal}。</li>
     *   <li>织布机方案 L9（loom 不为 null）：见 {@link LoomArena#reached}。</li>
     *   <li>制图台方案 K9（cartography 不为 null）：见 {@link CartographyArena#reached}。</li>
     *   <li>酿造台方案 P8（brew 不为 null）：容器界面已关闭，光标为空，见 {@link BrewArena#reached}。</li>
     *   <li>合成器方案 R7（crafter 不为 null）：容器界面已关闭，光标为空，见 {@link CrafterArena#reached}。</li>
     *   <li>村民交易方案 V9（trade 不为 null）：容器界面已关闭，光标为空，见 {@link VillagerArena#reached}。</li>
     * </ul>
     * 取 / 放、要几个、哪些物品算材料这些语义由插件定，mod 只比对。
     */
    public record Expect(Map<String, Integer> inventory, Map<String, Integer> container, Map<String, Integer> targets, Set<String> allowed, Cook cook, Enchant enchant, Beacon beacon, Anvil anvil, List<Smith> smithing, MountGoal mount, LoomArena.Spec loom, CartographyArena.Spec cartography, BrewArena.Spec brew, CrafterArena.Spec crafter, VillagerArena.Spec trade) {
        public Expect(Map<String, Integer> inventory, Map<String, Integer> container) {
            this(inventory, container, null, null, null, null, null, null, null, null, null, null, null, null, null);
        }

        public Expect(Map<String, Integer> inventory, Map<String, Integer> container, Map<String, Integer> targets, Set<String> allowed) {
            this(inventory, container, targets, allowed, null, null, null, null, null, null, null, null, null, null, null);
        }

        public Expect(Cook cook) {
            this(Map.of(), Map.of(), null, null, cook, null, null, null, null, null, null, null, null, null, null);
        }

        public Expect(Enchant enchant) {
            this(Map.of(), Map.of(), null, null, null, enchant, null, null, null, null, null, null, null, null, null);
        }

        public Expect(Beacon beacon) {
            this(Map.of(), Map.of(), null, null, null, null, beacon, null, null, null, null, null, null, null, null);
        }

        public Expect(Anvil anvil) {
            this(Map.of(), Map.of(), null, null, null, null, null, anvil, null, null, null, null, null, null, null);
        }

        public Expect(List<Smith> smithing) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, smithing, null, null, null, null, null, null);
        }

        public Expect(MountGoal mount) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, null, mount, null, null, null, null, null);
        }

        public Expect(LoomArena.Spec loom) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, null, null, loom, null, null, null, null);
        }

        public Expect(CartographyArena.Spec cartography) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, null, null, null, cartography, null, null, null);
        }

        public Expect(BrewArena.Spec brew) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, null, null, null, null, brew, null, null);
        }

        public Expect(CrafterArena.Spec crafter) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, null, null, null, null, null, crafter, null);
        }

        public Expect(VillagerArena.Spec trade) {
            this(Map.of(), Map.of(), null, null, null, null, null, null, null, null, null, null, null, null, trade);
        }
    }

    /**
     * 坐骑方案 H5、H6 的目标：本轮的动物还在；checkSaddle / checkBody 为真时鞍槽、身体槽里恰好是 saddle / body（null = 空着）；
     * 动物的箱子按物品 id 合计恰好是 chest；玩家身上（不含光标）按物品 id 合计恰好是 inventory；光标为空。不要求关界面、不要求下坐骑。
     */
    public record MountGoal(boolean checkSaddle, String saddle, boolean checkBody, String body, Map<String, Integer> chest, Map<String, Integer> inventory) {}

    /**
     * 坐骑方案 H2：本轮生成什么动物。animal = 注册名（10 种之一）；saddle / body = 一开始装着的（null = 空）；
     * chest = 箱子里一开始放的（slot 是箱子格号，从 0 起）；strength = 羊驼的力量（null = 不设，只有羊驼能设）。
     */
    public record MountSetup(String animal, String saddle, String body, List<Give> chest, Integer strength) {}

    /** 鹦鹉螺组的水坑（坐骑方案 H1）：prepare 按本轮的动物设，build 据此把动物脚下那格地板换成水源或换回石头 */
    private static boolean mountWater = false;

    /**
     * 锻造台方案 M6、M7 的一个目标：物品 id 是 item，纹饰是 { pattern, material }（注册名；两者都为 null = 不带纹饰）。
     * 玩家身上（不含光标）能给每个目标配上各不相同的一件物品，就算到达（{@link SmithingArena#assign}）。不要求关界面。
     */
    public record Smith(String item, String pattern, String material) {}

    /**
     * 铁砧方案 A6、A7 的目标：玩家身上（不含光标）有一件物品，类型是 item，附魔恰好是 enchantments（附魔书读存储的附魔），
     * 自定义名字逐字是 name（null = 没有自定义名字），就算到达。不要求关界面。
     */
    public record Anvil(String item, Map<String, Integer> enchantments, String name) {}

    /** 信标要给的一个效果：注册名 + 级数（1 = I，2 = II）。 */
    public record Want(String effect, int amplifier) {}

    /**
     * 信标方案 G7 的目标：付款物品 payment，信标要给 effects 里的每一项（再生题两项，主效果在前）。
     * 同时满足以下几条算到达：容器界面已关闭；光标为空，场内地上没有物品；主副效果是界面能设出来的、实际给的效果里有每一项
     * （{@link BeaconArena#satisfies}）；物品栏里除了 payment 没有别的东西。
     */
    public record Beacon(String payment, List<Want> effects) {}

    /** 信标底座的层数（信标方案 G2）：prepare 按本轮设置改，build 和工作站完好检查都按它；缺省 4。 */
    private static int beaconLevel = BeaconArena.MAX_LEVEL;

    /**
     * 附魔台方案 N8 的目标：原材料 item 附魔成 result（书变附魔书，其余同 item），带有 enchantment 且等级是 level。
     * 同时满足以下几条算到达：容器界面已关闭；物品栏里恰好有一件 result，它的附魔（附魔书读存储的附魔）里有 enchantment、等级是 level；
     * 物品栏里除了它和青金石没有别的东西。
     */
    public record Enchant(String item, String result, String enchantment, int level) {}

    /**
     * 附魔台工作站这一轮的设置（附魔台方案 N2、N4）：书架数、初始经验等级、附魔种子。null = 不设（书架用默认 15 个，经验和种子不动）。
     */
    public record EnchantSetup(Integer bookshelves, Integer xpLevel, Integer seed) {}

    /** 附魔台周围摆几个书架（N2）：prepare 按本轮设置改，build 和工作站完好检查都按它；缺省 15。 */
    private static int shelfCount = EnchantArena.MAX_SHELVES;

    /**
     * 熔炉方案 K8 的目标（第二版）：物品栏里原料恰好剩 rawLeft、燃料恰好剩 fuelLeft，即 n 个原料、m 个燃料放进了炉子。
     * 同时满足以下几条算到达：光标为空；物品栏里 raw、fuel 的数量恰好如此，且没有这三种以外的物品（product 可有可无）；
     * 原料格空或只有 raw，燃料格空或只有 fuel。不看产物格，也不看炉子烧没烧完（K5）。
     */
    public record Cook(String raw, int rawLeft, String fuel, int fuelLeft, String product) {}

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
        // 信标方案 G7：付了几次、每次设的主副效果（BeaconPaymentMixin 报来）
        int paid;
        final List<Map<String, Object>> beaconSets = new ArrayList<>();
        // 铁砧方案 A7：每次取出产物的花费、产物和时刻（AnvilTakeMixin 报来）
        final List<Map<String, Object>> anvilTakes = new ArrayList<>();
        // 锻造台方案 M7：每次取出的产物和时刻（SmithingTakeMixin 报来）
        final List<Map<String, Object>> smithingTakes = new ArrayList<>();
        // 坐骑方案 H2、H6：本轮的动物、第一次骑上的时刻、有没有不开界面直接装备（上一 tick 看到的鞍槽 / 身体槽）
        UUID mountUuid;
        // 村民交易方案 V1：本轮的村民
        UUID villagerUuid;
        Long rodeAtMs;
        boolean equippedWithoutMenu;
        String lastSaddle;
        String lastBody;
        // 制图台方案 K6、K9：开局地图（编号、各级中心），用来认出"由开局地图做出来"的地图
        CartographyArena.Source mapSource;
        // 酿造台方案 P9：本轮场地那台酿造台酿了几次（BrewingBrewMixin 报来）
        int brews;

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

    /** 织布机工作站（织布机方案）：没有方块实体，关界面时三个输入格退回物品栏（F8）；计数按签名（L9）。 */
    public static boolean isLoom(String station) {
        return "loom".equals(station);
    }

    /** 酿造台工作站（酿造台方案）：每轮换新（P11）；物品按签名计数（P7）。 */
    public static boolean isBrewer(String station) {
        return "brewing_stand".equals(station);
    }

    private static BrewingStandBlockEntity standAt(ServerLevel level, BlockPos o) {
        return level.getBlockEntity(stationPos(o)) instanceof BrewingStandBlockEntity stand ? stand : null;
    }

    /** 酿造台方案 P9：某台酿造台酿完一次（BrewingBrewMixin 在 doBrew 开头报来）；只记本轮场地的那台。 */
    public static void onBrew(net.minecraft.world.level.Level level, BlockPos pos) {
        Run run = active;
        if (run == null || !isBrewer(run.stationName) || !(level instanceof ServerLevel) || level.dimension() != net.minecraft.world.level.Level.OVERWORLD) return;
        if (pos.equals(stationPos(run.origin))) run.brews++;
    }

    /** 合成器工作站（合成器方案）：每轮换新（R8）；材料按 id 计数（R5）。 */
    public static boolean isCrafter(String station) {
        return "crafter".equals(station);
    }

    private static CrafterBlockEntity crafterAt(ServerLevel level, BlockPos o) {
        return level.getBlockEntity(stationPos(o)) instanceof CrafterBlockEntity crafter ? crafter : null;
    }

    /** 制图台工作站（制图台方案）：关界面时 0、1 两格退回物品栏（F10）；地图按签名计数（K9）。 */
    public static boolean isCartography(String station) {
        return "cartography".equals(station);
    }

    /** 织布机方案 L11：素旗、染料、基础图案、图案物（只读）。 */
    public static Map<String, Object> loomCatalog(MinecraftServer server) {
        return LoomArena.catalog(server);
    }

    /** 切石机工作站（切石机方案）：没有容器，计数看物品栏、光标、切石机输入格。 */
    public static boolean isCutter(String station) {
        return "stonecutter".equals(station);
    }

    /** 炉子工作站（熔炉方案）：熔炉、高炉、烟熏炉。容器是方块实体本身，关界面后东西留在炉子里（F11）。 */
    public static boolean isFurnace(String station) {
        return "furnace".equals(station) || "blast_furnace".equals(station) || "smoker".equals(station);
    }

    /** 附魔台工作站（附魔台方案）：附魔台加周围的书架，没有方块实体里的物品（关界面时退回物品栏，E8）。 */
    public static boolean isEnchanter(String station) {
        return "enchanting_table".equals(station);
    }

    /** 信标工作站（信标方案）：信标加埋在地板下的底座。 */
    public static boolean isBeacon(String station) {
        return "beacon".equals(station);
    }

    /** 铁砧工作站（铁砧方案）：没有方块实体，关界面时两个输入格退回物品栏（F11）。 */
    public static boolean isAnvil(String station) {
        return "anvil".equals(station);
    }

    /** 坐骑工作站（坐骑方案）：工作站是一只动物，不是方块。 */
    public static boolean isMount(String station) {
        return "mount".equals(station);
    }

    /** 村民工作站（村民交易方案）：工作站是一只村民，不是方块。 */
    public static boolean isVillager(String station) {
        return "villager".equals(station);
    }

    /** 本轮的村民；不在了（被清掉、跑出场地范围）→ null */
    private static Villager villagerOf(ServerLevel level, Run run) {
        if (run == null || run.villagerUuid == null) return null;
        Entity entity = level.getEntity(run.villagerUuid);
        if (!(entity instanceof Villager villager) || !villager.isAlive() || !box(run.origin).contains(villager.position())) return null;
        return villager;
    }

    /** 村民的位置（V1）：工作站那一格的中心 */
    private static Vec3 villagerPos(BlockPos o) {
        BlockPos at = stationPos(o);
        return new Vec3(at.getX() + 0.5, at.getY(), at.getZ() + 0.5);
    }

    /** 站在场内中心朝 +z 时，眼睛 → 村民身上一点的俯角（V1，同坐骑方案 H1：瞄准身高的 0.7） */
    private static float villagerPitch(ServerPlayer player, BlockPos o) {
        Vec3 at = villagerPos(o);
        double aimY = at.y + EntityType.VILLAGER.getHeight() * 0.7;
        double dy = (o.getY() + 1 + player.getEyeHeight()) - aimY;
        double dz = at.z - (o.getZ() + 0.5);
        return (float) Math.toDegrees(Math.atan2(dy, dz));
    }

    /** 当前界面是不是和本轮村民的交易界面 */
    private static boolean opensVillager(ServerLevel level, ServerPlayer player, Run run) {
        if (!(player.containerMenu instanceof MerchantMenu)) return false;
        Villager villager = villagerOf(level, run);
        return villager != null && villager.getTradingPlayer() == player;
    }

    /** 村民交易方案 V3：按 setup 生成一只村民（不放进世界），返回它的交易描述（只读）。 */
    public static Map<String, Object> tradePreview(MinecraftServer server, VillagerArena.Setup setup) {
        ServerLevel level = server.overworld();
        VillagerArena.Created made = VillagerArena.create(level, setup);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("profession", setup.profession());
        out.put("type", setup.type());
        out.put("level", setup.level());
        out.put("offers", VillagerArena.describe(level, made.villager(), made.levels()));
        return out;
    }

    /** 村民交易方案 V2：有交易表的职业（只读）。 */
    public static Map<String, Object> tradeCatalog(MinecraftServer server) {
        return Map.of("professions", VillagerArena.professions());
    }

    /** 坐骑方案 H10：每种动物能装什么、箱子几格（只读）。 */
    public static Map<String, Object> mountCatalog(MinecraftServer server) {
        return MountArena.catalog(server.overworld());
    }

    /** 本轮的动物；不在了（被清掉、跑出场地范围）→ null */
    private static Mob mountOf(ServerLevel level, Run run) {
        if (run == null || run.mountUuid == null) return null;
        Entity entity = level.getEntity(run.mountUuid);
        if (!(entity instanceof Mob mob) || !mob.isAlive() || !box(run.origin).contains(mob.position())) return null;
        return mob;
    }

    /** 场内的坐骑类动物（马类、羊驼、骆驼、鹦鹉螺）：坐骑场地每轮开局清掉（H2） */
    private static boolean isMountEntity(Entity e) {
        return e instanceof AbstractHorse || e instanceof AbstractNautilus;
    }

    /** 动物生成的位置（H1）：工作站那一格的中心；鹦鹉螺组站在水坑里，低一格 */
    private static Vec3 mountPos(BlockPos o, String animal) {
        BlockPos at = stationPos(o);
        return new Vec3(at.getX() + 0.5, MountArena.needsWater(animal) ? at.getY() - 1 : at.getY(), at.getZ() + 0.5);
    }

    /** 站在场内中心朝 +z 时，眼睛 → 动物身上一点的俯角（H1）。瞄准点取身高的 0.7（不超过顶下 0.2），鹦鹉螺在坑里时视线不擦过地板边 */
    private static float mountPitch(ServerPlayer player, BlockPos o, String animal) {
        Vec3 at = mountPos(o, animal);
        float height = MountArena.type(animal).getHeight();
        double aimY = at.y + Math.min(height * 0.7, height - 0.2);
        double dy = (o.getY() + 1 + player.getEyeHeight()) - aimY;
        double dz = at.z - (o.getZ() + 0.5);
        return (float) Math.toDegrees(Math.atan2(dy, dz));
    }

    /**
     * 服务器侧按玩家当前位置与朝向做实体射线检测：准星命中的是这只动物，且中间没有方块挡着（H1 自检）。
     * 站着和潜行（眼睛低 0.35 格）各测一次（2026-11-22）：开坐骑界面要潜行右键，潜行时也得对得准
     */
    private static boolean aimsAtEntity(ServerPlayer player, Entity target) {
        Vec3 feet = player.position();
        return aimsAtEntity(player, target, feet.add(0, player.getEyeHeight(Pose.STANDING), 0))
            && aimsAtEntity(player, target, feet.add(0, player.getEyeHeight(Pose.CROUCHING), 0));
    }

    private static boolean aimsAtEntity(ServerPlayer player, Entity target, Vec3 eye) {
        Vec3 dir = Vec3.directionFromRotation(player.getXRot(), player.getYRot());
        double range = player.entityInteractionRange();
        Vec3 end = eye.add(dir.scale(range));
        AABB search = new AABB(eye, eye).expandTowards(dir.scale(range)).inflate(1.0);
        EntityHitResult hit = ProjectileUtil.getEntityHitResult(player, eye, end, search, e -> !e.isSpectator() && e.isPickable(), range * range);
        if (hit == null || !hit.getEntity().getUUID().equals(target.getUUID())) return false;
        BlockHitResult block = player.level().clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
        return block.getType() != HitResult.Type.BLOCK || eye.distanceToSqr(hit.getLocation()) <= eye.distanceToSqr(block.getLocation());
    }

    /** 当前界面是不是这只动物的物品栏 */
    private static boolean opensMount(Run run, AbstractContainerMenu menu) {
        if (!(menu instanceof AbstractMountInventoryMenu) || run.mountUuid == null) return false;
        var mount = ((MountMenuAccessor) menu).stevex$mount();
        return mount != null && run.mountUuid.equals(mount.getUUID());
    }

    /** 锻造台工作站（锻造台方案）：没有方块实体，关界面时三个输入格退回物品栏（F9）；不会损坏（F11）。 */
    public static boolean isSmithing(String station) {
        return "smithing_table".equals(station);
    }

    /**
     * 铁砧方案 A7：玩家即将从铁砧取出产物（{@code AnvilTakeMixin} 调用，服务器线程；此时还没扣经验）。
     * 本轮的玩家在铁砧场地取的才记：花费、产物的附魔和名字、时刻。
     */
    public static void onAnvilTake(ServerPlayer player, int cost, ItemStack result) {
        ItemStack noted = takeNoted(player);
        Run run = active;
        if (run == null || !isAnvil(run.stationName) || !player.getUUID().equals(run.player)) return;
        // Shift 点击取出时 onTake 拿到的是已经移空的叠，改用 quickMoveStack 开头复制的那份（CombinerQuickMoveMixin）
        if (result.isEmpty()) result = noted;
        Map<String, Object> take = new LinkedHashMap<>();
        take.put("cost", cost);
        take.put("enchantments", AnvilArena.enchantments(result));
        take.put("name", AnvilArena.customName(result));
        take.put("atMs", System.currentTimeMillis());
        run.anvilTakes.add(take);
    }

    /**
     * 锻造台方案 M7：玩家即将从锻造台取出产物（{@code SmithingTakeMixin} 调用，服务器线程）。本轮的玩家在锻造台场地取的才记：产物的 id、纹饰、时刻。
     * Shift 点击取出时拿到的是空物品（F8），改用 quickMoveStack 开头复制的那份。
     */
    public static void onSmithingTake(ServerPlayer player, ItemStack result) {
        ItemStack noted = takeNoted(player);
        Run run = active;
        if (run == null || !isSmithing(run.stationName) || !player.getUUID().equals(run.player)) return;
        if (result.isEmpty()) result = noted;
        Map<String, Object> take = new LinkedHashMap<>();
        take.put("result", SmithingArena.describe(result));
        take.put("atMs", System.currentTimeMillis());
        run.smithingTakes.add(take);
    }

    /**
     * Shift 点击铁砧、锻造台产物格时，移走之前的产物副本（CombinerQuickMoveMixin 记，onAnvilTake / onSmithingTake 取用后清掉；
     * 服务器线程，不加锁）
     */
    private static UUID combinerResultOwner;
    private static ItemStack combinerResult = ItemStack.EMPTY;

    /** CombinerQuickMoveMixin：quickMoveStack 开头、对铁砧或锻造台产物格的那一次，记下产物的副本。 */
    public static void noteCombinerResult(ServerPlayer player, ItemStack result) {
        combinerResultOwner = player.getUUID();
        combinerResult = result.copy();
    }

    /** 取走这个玩家记下的产物副本（不是这个玩家的 → 空），并清掉。 */
    private static ItemStack takeNoted(ServerPlayer player) {
        ItemStack noted = player.getUUID().equals(combinerResultOwner) ? combinerResult : ItemStack.EMPTY;
        combinerResultOwner = null;
        combinerResult = ItemStack.EMPTY;
        return noted;
    }

    /** 锻造台方案 M2：全部锻造配方、可加纹饰的盔甲、纹饰材料（只读）。 */
    public static Map<String, Object> smithingCatalog(MinecraftServer server) {
        return SmithingArena.catalog(server);
    }

    /** 锻造台方案 M4：用服务器的锻造配方算产物（只读）。 */
    public static Map<String, Object> smithingPreview(MinecraftServer server, String template, String base, String addition) {
        return SmithingArena.preview(server, item(template), item(base), item(addition));
    }

    /** 当前界面是锻造台时三个输入格：{ template, base, addition }（各是物品摘要或 null）；不是锻造台界面 → null。 */
    private static Map<String, Object> smithingSlots(AbstractContainerMenu menu) {
        if (!(menu instanceof SmithingMenu sm)) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("template", SmithingArena.describe(sm.getSlot(SmithingMenu.TEMPLATE_SLOT).getItem()));
        out.put("base", SmithingArena.describe(sm.getSlot(SmithingMenu.BASE_SLOT).getItem()));
        out.put("addition", SmithingArena.describe(sm.getSlot(SmithingMenu.ADDITIONAL_SLOT).getItem()));
        return out;
    }

    /** 锻造台方案 M7：目标里的物品、纹饰样式、纹饰材料都要存在；不存在 → 报错。 */
    private static void checkSmith(MinecraftServer server, Smith goal) {
        item(goal.item());
        if ((goal.pattern() == null) != (goal.material() == null)) throw new IllegalArgumentException("expect.smithing: pattern and material must both be set or both be null");
        if (goal.pattern() == null) return;
        Identifier pattern = Identifier.tryParse(goal.pattern());
        if (pattern == null || server.registryAccess().lookupOrThrow(Registries.TRIM_PATTERN).get(ResourceKey.create(Registries.TRIM_PATTERN, pattern)).isEmpty()) {
            throw new IllegalArgumentException("unknown trim pattern: " + goal.pattern());
        }
        Identifier material = Identifier.tryParse(goal.material());
        if (material == null || server.registryAccess().lookupOrThrow(Registries.TRIM_MATERIAL).get(ResourceKey.create(Registries.TRIM_MATERIAL, material)).isEmpty()) {
            throw new IllegalArgumentException("unknown trim material: " + goal.material());
        }
    }

    /** 铁砧方案 A2：物品池和每件物品能附的附魔（只读）。 */
    public static Map<String, Object> anvilCatalog(MinecraftServer server) {
        return AnvilArena.catalog(server.registryAccess());
    }

    /** 铁砧方案 A4：按原版算法预览产物和花费（只读；玩家会被设成生存模式）。right 为 null = 右格空着。 */
    public static Map<String, Object> anvilPreview(MinecraftServer server, ServerPlayer player, Give left, Give right, String name) {
        ItemStack l = AnvilArena.stack(server.registryAccess(), item(left.id()), left.count(), left.enchantments());
        ItemStack r = right == null ? null : AnvilArena.stack(server.registryAccess(), item(right.id()), right.count(), right.enchantments());
        return AnvilArena.preview(player, l, r, name);
    }

    /** 当前界面是铁砧时两个输入格：{ left, right }（各是物品摘要或 null）；不是铁砧界面 → null。 */
    private static Map<String, Object> anvilSlots(AbstractContainerMenu menu) {
        if (!(menu instanceof AnvilMenu am)) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("left", AnvilArena.describe(am.getSlot(AnvilMenu.INPUT_SLOT).getItem()));
        out.put("right", AnvilArena.describe(am.getSlot(AnvilMenu.ADDITIONAL_SLOT).getItem()));
        return out;
    }

    /** 玩家身上（主物品栏、快捷栏、盔甲、副手，不含光标）的每一件物品：[{ slot, id, count, enchantments, name }]。 */
    private static List<Map<String, Object>> itemDetails(ServerPlayer player) {
        List<Map<String, Object>> out = new ArrayList<>();
        var inv = player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            Map<String, Object> d = AnvilArena.describe(inv.getItem(i));
            if (d == null) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("slot", i);
            row.putAll(d);
            out.add(row);
        }
        return out;
    }

    /** 场地里的信标方块实体；那一格不是信标（被挖掉了）→ null。 */
    private static BeaconBlockEntity beaconAt(ServerLevel level, BlockPos o) {
        BlockPos at = stationPos(o);
        if (!level.getBlockState(at).is(Blocks.BEACON)) return null;
        return level.getBlockEntity(at) instanceof BeaconBlockEntity beacon ? beacon : null;
    }

    /**
     * 信标方案 G7：服务端即将按设信标包改效果、扣 1 个付款（{@code BeaconPaymentMixin} 调用，服务器线程）。
     * 本轮的玩家在信标场地付的才记：次数加一，记下这次设的主副效果（不是信标效果的按原版 filterEffect 记成 null）和时刻。
     */
    public static void onBeaconPaid(ServerPlayer player, Holder<MobEffect> primary, Holder<MobEffect> secondary) {
        Run run = active;
        if (run == null || !isBeacon(run.stationName) || !player.getUUID().equals(run.player)) return;
        run.paid++;
        Map<String, Object> set = new LinkedHashMap<>();
        set.put("primary", BeaconArena.tierOf(primary) >= 0 ? BeaconArena.effectId(primary) : null);
        set.put("secondary", BeaconArena.tierOf(secondary) >= 0 ? BeaconArena.effectId(secondary) : null);
        set.put("atMs", System.currentTimeMillis());
        run.beaconSets.add(set);
    }

    /** 拆掉信标再放一个新的：方块实体重建，主副效果清空、等级从 0 重新数（信标方案 F8、G2）。 */
    private static void replaceBeacon(ServerLevel level, BlockPos o) {
        BlockPos at = stationPos(o);
        level.setBlockAndUpdate(at, Blocks.AIR.defaultBlockState());
        level.setBlockAndUpdate(at, Blocks.BEACON.defaultBlockState());
    }

    /** 当前界面是信标时付款格里的东西：{ id: count }；空或不是信标界面 → {}。 */
    private static Map<String, Integer> beaconSlot(AbstractContainerMenu menu) {
        if (!(menu instanceof BeaconMenu bm)) return Map.of();
        ItemStack stack = bm.getSlot(0).getItem();
        return stack.isEmpty() ? Map.of() : Map.of(id(stack), stack.getCount());
    }

    /**
     * 附魔台方案 N5：三档预览（只读，不碰世界）。item 用默认组件新建一件；seed 是附魔种子，shelves 是书架数。
     * 见 {@link EnchantArena#preview}。
     */
    public static Map<String, Object> enchantPreview(MinecraftServer server, String itemId, int seed, int shelves) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("item", itemId);
        out.put("enchantSeed", seed);
        out.put("bookshelves", shelves);
        out.putAll(EnchantArena.preview(server.registryAccess(), new ItemStack(item(itemId)), seed, shelves));
        return out;
    }

    /** 场地里的炉子方块实体；那一格不是本轮的炉子（被挖掉了） → null。 */
    private static AbstractFurnaceBlockEntity furnaceAt(ServerLevel level, BlockPos o, String station) {
        BlockPos at = stationPos(o);
        Block block = STATIONS.get(station);
        if (block == null || !level.getBlockState(at).is(block)) return null;
        return level.getBlockEntity(at) instanceof AbstractFurnaceBlockEntity furnace ? furnace : null;
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
            case "enchanting_table" -> {
                // 附魔台方案 N1：附魔台 + 同层外圈的书架（shelfCount 个），书架也算工作站，被挖掉判 lost
                out.put(at, Blocks.ENCHANTING_TABLE.defaultBlockState());
                for (BlockPos shelf : EnchantArena.shelfPositions(at, shelfCount)) out.put(shelf, Blocks.BOOKSHELF.defaultBlockState());
            }
            case "beacon" -> {
                // 信标方案 G1、G2：信标 + 埋在地板下的铁块底座（beaconLevel 层，第 1 层是地板的一部分），底座也算工作站，被挖掉判 lost
                out.put(at, Blocks.BEACON.defaultBlockState());
                for (BlockPos base : BeaconArena.basePositions(at, beaconLevel)) out.put(base, Blocks.IRON_BLOCK.defaultBlockState());
            }
            // 铁砧方案 A1：朝向固定；开裂、损坏的铁砧状态不同，build 会把它换回完好的
            case "anvil" -> out.put(at, Blocks.ANVIL.defaultBlockState().setValue(AnvilBlock.FACING, Direction.EAST));
            // 织布机方案 L2：正面朝北，对着站在 -z 一侧的玩家（只影响外观）
            case "loom" -> out.put(at, Blocks.LOOM.defaultBlockState().setValue(LoomBlock.FACING, Direction.NORTH));
            // 制图台方案 K1：没有朝向属性
            case "cartography" -> out.put(at, Blocks.CARTOGRAPHY_TABLE.defaultBlockState());
            // 酿造台方案 P1：没有朝向属性；三个药水瓶的方块状态由酿造台自己更新，完好检查只看方块
            case "brewing_stand" -> out.put(at, Blocks.BREWING_STAND.defaultBlockState());
            case "mount" -> {
                // 坐骑方案 H1：动物站的那一格是空气；鹦鹉螺组下面那格地板换成水源（四周是地板，水不会流出去）。
                // 水坑朝玩家那边多一格（2026-11-22）：潜行时眼睛低 0.35 格，同样的俯角会落在坑沿那块地板上，潜行右键开不了界面；
                // 坑沿也是水，视线（点选不看流体）直接落进坑里。动物仍在原来那格
                BlockState floor = mountWater ? Blocks.WATER.defaultBlockState() : Blocks.STONE.defaultBlockState();
                out.put(at, Blocks.AIR.defaultBlockState());
                out.put(at.below(), floor);
                out.put(at.below().north(), floor);
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
        // 信标底座（信标方案 G1、G2）：地板以下的几层不在上面的循环里，单独铺；本轮用不到的层整层换成空气，否则等级会偏高。
        // 换成别的工作站时，上一次留下的底座也清掉
        BlockPos beaconPos = stationPos(o);
        int baseLayers = isBeacon(station) ? beaconLevel : 0;
        for (int m = 2; m <= BeaconArena.MAX_LEVEL; m++) {
            BlockState state = m <= baseLayers ? Blocks.IRON_BLOCK.defaultBlockState() : Blocks.AIR.defaultBlockState();
            for (BlockPos pos : BeaconArena.layer(beaconPos, m)) {
                if (state.isAir() && !level.getBlockState(pos).is(Blocks.IRON_BLOCK)) continue; // 只拆底座，不动原地形
                placed += set(level, pos, state);
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

    /**
     * 一个要发放的物品：slot ∈ [0, 35]（主物品栏），count ≥ 1（超过堆叠上限的由 {@link #split} 拆开）。
     * enchantments（铁砧方案 A7）：{ 注册名: 级数 }，附魔书写进存储的附魔；null = 不带附魔。
     * potion（酿造台方案 P8）：不为 null 时 id 必须是药水 / 喷溅药水 / 滞留药水，按这个药水注册名做出带药水内容的药水（一个一叠，超过 1 由 split 拆开）。
     * mapScale（制图台方案 K6）：不为 null 时 id 必须是已绘制地图、count 在 1–64，mod 现做一张这个缩放等级的开局地图，复制成 count 张同编号的一叠；一轮最多一项。
     */
    public record Give(int slot, String id, int count, Map<String, Integer> enchantments, Integer mapScale, String potion) {
        public Give(int slot, String id, int count) {
            this(slot, id, count, null, null, null);
        }

        public Give(int slot, String id, int count, Map<String, Integer> enchantments) {
            this(slot, id, count, enchantments, null, null);
        }

        public Give(int slot, String id, int count, Map<String, Integer> enchantments, Integer mapScale) {
            this(slot, id, count, enchantments, mapScale, null);
        }
    }

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
            out.add(new Give(g.slot(), g.id(), Math.min(g.count(), max), g.enchantments(), g.mapScale(), g.potion()));
            for (int left = g.count() - max; left > 0; left -= max) {
                if (next >= free.size()) throw new IllegalArgumentException("not enough free slots to split " + g.id() + " x" + g.count());
                out.add(new Give(free.get(next++), g.id(), Math.min(left, max), g.enchantments(), g.mapScale(), g.potion()));
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
     * 炉子工作站（熔炉方案）：先清空并拆掉上一轮的炉子再放新的（K12）；
     * 给了 expect.cook 就返回服务器端的燃料时长、烧制时间、产物、堆叠上限（K8），供插件和数据文件核对。
     * 附魔台工作站（附魔台方案）：按 enchantSetup 摆书架、设经验等级和附魔种子（N2、N4）；给了 expect.enchant 就用真实的附魔台菜单
     * 算一遍三档，连同实际数到的书架数一起返回（N5 的核对）。
     * 信标工作站（信标方案）：按 beaconLevel 铺底座（G2），拆掉旧信标再放新的；给了 expect.beacon 就核对付款物品和要求的效果（G7）。
     * 铁砧工作站（铁砧方案）：build 换上完好的铁砧（A1），按 enchantSetup.xpLevel 设经验等级（A7）；items 可以带附魔。
     * 已有进行中的一轮时拒绝：先 finish 再开新一轮。
     */
    public static Map<String, Object> prepare(MinecraftServer server, ServerPlayer player, String arena, BlockPos o, String station,
                                              List<Give> requested, List<Give> chestItems, long seed, List<String> watchIds,
                                              Expect expect, long dayTime, EnchantSetup enchantSetup, Integer requestedBeaconLevel, MountSetup mountSetup,
                                              VillagerArena.Setup villagerSetup) {
        if (active != null) throw new IllegalStateException("a run is already active in arena " + active.arena + " (call arena/finish first)");
        Block stationBlock = station(station);
        checkChestItems(chestItems, storageCapacity(station));
        int baseLevel = requestedBeaconLevel != null ? requestedBeaconLevel : BeaconArena.MAX_LEVEL;
        if (isBeacon(station) && (baseLevel < 1 || baseLevel > BeaconArena.MAX_LEVEL)) throw new IllegalArgumentException("beaconLevel must be within 1-" + BeaconArena.MAX_LEVEL + ": " + baseLevel);
        if (isMount(station)) {
            if (mountSetup == null) throw new IllegalArgumentException("the mount station needs mount: { animal, saddle?, body?, chest?, strength? }");
            MountArena.type(mountSetup.animal()); // 不认识的动物在这里报错
        }
        // 村民交易方案 V2：先生成本轮的村民（还不放进世界），参数不对在这里报错
        VillagerArena.Created villagerMade = null;
        if (isVillager(station)) {
            if (villagerSetup == null) throw new IllegalArgumentException("the villager station needs villager: { profession, type, level, offerSeed }");
            villagerMade = VillagerArena.create(server.overworld(), villagerSetup);
        }
        String brewProduct = null;
        String crafterProduct = null;
        if (expect != null && expect.trade() != null) {
            if (!isVillager(station)) throw new IllegalArgumentException("expect { trade } needs the villager station");
            int trades = villagerMade.villager().getOffers().size();
            if (expect.trade().uses().size() != trades) throw new IllegalArgumentException("expect.trade.uses has " + expect.trade().uses().size() + " entries, the villager has " + trades + " trades");
        } else if (expect != null && expect.crafter() != null) {
            if (!isCrafter(station)) throw new IllegalArgumentException("expect { crafter } needs the crafter station");
            // 合成器方案 R8：规范摆法在服务器上合成出目标
            crafterProduct = CrafterArena.check(server.overworld(), expect.crafter());
        } else if (expect != null && expect.brew() != null) {
            if (!isBrewer(station)) throw new IllegalArgumentException("expect { brew } needs the brewing_stand station");
            // 酿造台方案 P8：用服务器的酿造配方核对题目，返回产物签名
            brewProduct = BrewArena.check(server.overworld().potionBrewing(), expect.brew());
        } else if (expect != null && expect.cartography() != null) {
            if (!isCartography(station)) throw new IllegalArgumentException("expect { cartography } needs the cartography station");
            CartographyArena.check(expect.cartography());
        } else if (expect != null && expect.loom() != null) {
            if (!isLoom(station)) throw new IllegalArgumentException("expect { loom } needs the loom station");
            LoomArena.check(server, expect.loom());
        } else if (expect != null && expect.mount() != null) {
            if (!isMount(station)) throw new IllegalArgumentException("expect { mount } needs the mount station");
        } else if (expect != null && expect.smithing() != null) {
            if (!isSmithing(station)) throw new IllegalArgumentException("expect { smithing } needs the smithing_table station");
            if (expect.smithing().isEmpty()) throw new IllegalArgumentException("expect.smithing is empty");
            for (Smith goal : expect.smithing()) checkSmith(server, goal);
        } else if (expect != null && expect.anvil() != null) {
            if (!isAnvil(station)) throw new IllegalArgumentException("expect { anvil } needs the anvil station");
            AnvilArena.stack(server.registryAccess(), item(expect.anvil().item()), 1, expect.anvil().enchantments()); // 未知 id、级数不对在这里报错
        } else if (expect != null && expect.beacon() != null) {
            if (!isBeacon(station)) throw new IllegalArgumentException("expect { beacon } needs the beacon station");
            // 信标方案 G7：付款物品要在 beacon_payment_items 里（F6），要求的效果要是信标效果、底座等级够（F1）
            if (!new ItemStack(item(expect.beacon().payment())).is(ItemTags.BEACON_PAYMENT_ITEMS)) throw new IllegalArgumentException(expect.beacon().payment() + " is not a beacon payment item");
            if (expect.beacon().effects().isEmpty()) throw new IllegalArgumentException("expect.beacon.effects is empty");
            for (Want w : expect.beacon().effects()) {
                int needed = BeaconArena.requiredLevel(w.effect(), w.amplifier());
                if (needed > baseLevel) throw new IllegalArgumentException(w.effect() + " " + w.amplifier() + " needs a level " + needed + " beacon, the base is level " + baseLevel);
            }
        } else if (expect != null && expect.enchant() != null) {
            if (!isEnchanter(station)) throw new IllegalArgumentException("expect { enchant } needs the enchanting_table station");
            item(expect.enchant().item()); // 未知 id 在这里报错
        } else if (expect != null && expect.cook() != null) {
            if (!isFurnace(station)) throw new IllegalArgumentException("expect { cook } needs a furnace station (furnace, blast_furnace, smoker)");
        } else if (expect != null && expect.targets() == null && !isStorage(station)) {
            throw new IllegalArgumentException("expect { inventory, container } needs a container station (chest, large_chest, hopper, dispenser)");
        } else if (expect != null && expect.targets() != null && !isCutter(station)) {
            throw new IllegalArgumentException("expect { targets, allowed } needs the stonecutter station");
        }
        List<Give> items = split(requested, seed);
        List<ItemStack> stacks = new ArrayList<>();
        CartographyArena.Source mapSource = null;
        for (Give g : items) {
            if (g.potion() != null) {
                // 酿造台方案 P8：带药水内容的药水
                if (!List.of("minecraft:potion", "minecraft:splash_potion", "minecraft:lingering_potion").contains(g.id())) throw new IllegalArgumentException("items[].potion needs a potion, splash_potion or lingering_potion, got " + g.id());
                stacks.add(BrewArena.potionStack(g.id(), g.potion()).copyWithCount(g.count()));
                continue;
            }
            if (g.mapScale() == null) {
                stacks.add(AnvilArena.stack(server.registryAccess(), item(g.id()), g.count(), g.enchantments()));
                continue;
            }
            // 制图台方案 K6：开局地图由 mod 现做（F2：地图格里的地图要有地图数据）
            if (!isCartography(station)) throw new IllegalArgumentException("items[].map needs the cartography station");
            if (!CartographyArena.FILLED_MAP.equals(g.id()) || g.count() < 1 || g.count() > 64) throw new IllegalArgumentException("items[].map needs id " + CartographyArena.FILLED_MAP + " and count 1-64");
            if (mapSource != null) throw new IllegalArgumentException("at most one items[] entry may carry map");
            Map.Entry<ItemStack, CartographyArena.Source> made = CartographyArena.create(server.overworld(), o, g.mapScale());
            stacks.add(made.getKey().copyWithCount(g.count())); // K6：同编号的一叠
            mapSource = made.getValue();
        }
        List<Item> watchItems = new ArrayList<>();
        for (String id : watchIds) watchItems.add(item(id));
        ServerLevel level = server.overworld();
        Map<String, Object> cookInfo = expect != null && expect.cook() != null ? cookInfo(server, level, station, expect.cook()) : null;

        // 炉子（熔炉方案 K12、F11）：同一种方块只改点燃状态时方块实体会保留，上一轮剩下的东西、进度、存着的经验都还在。
        // 先清空三格（拆除时就不会掉东西），再换成空气，build 会放一台新的；拆除时弹出的经验球由下面第 3 步清掉
        BlockPos stationAt = stationPos(o);
        if (level.getBlockEntity(stationAt) instanceof AbstractFurnaceBlockEntity old) {
            old.clearContent();
            level.setBlockAndUpdate(stationAt, Blocks.AIR.defaultBlockState());
        }
        // 酿造台（酿造台方案 P11、F7）：同理，燃料值、酿造进度、格子里的东西都在方块实体上；先清空再拆，build 放一台新的
        if (level.getBlockEntity(stationAt) instanceof BrewingStandBlockEntity oldStand) {
            oldStand.clearContent();
            level.setBlockAndUpdate(stationAt, Blocks.AIR.defaultBlockState());
        }
        // 合成器（合成器方案 R8、C6）：格子里的东西、禁用状态都在方块实体上；先清空再拆，build 放一台新的
        if (level.getBlockEntity(stationAt) instanceof CrafterBlockEntity oldCrafter) {
            oldCrafter.clearContent();
            level.setBlockAndUpdate(stationAt, Blocks.AIR.defaultBlockState());
        }
        // 附魔台（附魔台方案 N2）：本轮的书架数决定 build 摆哪些书架、工作站完好检查看哪些格子
        if (isEnchanter(station)) {
            int shelves = enchantSetup != null && enchantSetup.bookshelves() != null ? enchantSetup.bookshelves() : EnchantArena.MAX_SHELVES;
            if (shelves < 0 || shelves > EnchantArena.MAX_SHELVES) throw new IllegalArgumentException("bookshelves must be within 0-" + EnchantArena.MAX_SHELVES + ": " + shelves);
            shelfCount = shelves;
        }
        // 信标（信标方案 G2、F8）：本轮的底座层数决定 build 铺哪几层、工作站完好检查看哪些格子；旧信标拆掉，build 放一个新的（效果清空）
        // 坐骑（坐骑方案 H1、H2、H8）：先让玩家下来；鹦鹉螺组的水坑由 build 按 mountWater 铺
        if (isMount(station)) {
            player.stopRiding();
            mountWater = MountArena.needsWater(mountSetup.animal());
        }
        if (isBeacon(station)) {
            beaconLevel = baseLevel;
            if (level.getBlockState(stationAt).is(Blocks.BEACON)) level.setBlockAndUpdate(stationAt, Blocks.AIR.defaultBlockState());
        }
        build(server, arena, o, station);
        // 1. 先关界面：2×2 / 工作台合成格里的物品退回物品栏、客户端界面一并关掉；光标物品清掉
        player.containerMenu.setCarried(ItemStack.EMPTY);
        player.closeContainer();
        player.containerMenu.setCarried(ItemStack.EMPTY);
        // 2. 清空物品栏（含盔甲、副手）
        player.getInventory().clearContent();
        player.inventoryMenu.getCraftSlots().clearContent();
        teleportInside(server, player, o, isMount(station) ? mountPitch(player, o, mountSetup.animal())
                : isVillager(station) ? villagerPitch(player, o) : stationBlock != null ? stationPitch(player, o) : 0f);
        // 3. 场内掉落物、经验球、敌对生物
        for (Entity e : level.getEntitiesOfClass(Entity.class, box(o),
                e -> e instanceof ItemEntity || e instanceof ExperienceOrb || e instanceof Enemy || (isMount(station) && isMountEntity(e))
                        || (isVillager(station) && e instanceof Villager))) {
            e.discard();
        }
        // 3b. 坐骑（坐骑方案 H2）：生成本轮的动物，参数不对在这里报错
        Mob mount = null;
        if (isMount(station)) {
            Vec3 at = mountPos(o, mountSetup.animal());
            mount = MountArena.spawn(level, player, mountSetup, at.x, at.y, at.z, 180f);
        }
        // 3c. 村民（村民交易方案 V1）：放进世界，面朝玩家
        Villager villager = null;
        if (villagerMade != null) {
            Vec3 at = villagerPos(o);
            villager = villagerMade.villager();
            VillagerArena.place(level, villager, at.x, at.y, at.z, 180f);
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
        // 7b. 附魔台（附魔台方案 N4）：经验等级（进度清零）、附魔种子
        Map<String, Object> enchantInfo = null;
        if (isEnchanter(station)) {
            if (enchantSetup != null && enchantSetup.xpLevel() != null) {
                if (enchantSetup.xpLevel() < 0) throw new IllegalArgumentException("xpLevel must be >= 0");
                player.setExperienceLevels(enchantSetup.xpLevel());
                player.setExperiencePoints(0);
            }
            if (enchantSetup != null && enchantSetup.seed() != null) ((PlayerAccessor) player).stevex$setEnchantmentSeed(enchantSetup.seed());
            enchantInfo = new LinkedHashMap<>();
            enchantInfo.put("bookshelves", EnchantArena.countShelves(level, stationPos(o)));
            enchantInfo.put("xpLevel", player.experienceLevel);
            enchantInfo.put("enchantSeed", player.getEnchantmentSeed());
            if (expect != null && expect.enchant() != null) {
                enchantInfo.put("offers", EnchantArena.menuOffers(level, player, stationPos(o), new ItemStack(item(expect.enchant().item()))));
            }
        }
        // 7c. 铁砧（铁砧方案 A7）：经验等级（进度清零）
        if (isAnvil(station) && enchantSetup != null && enchantSetup.xpLevel() != null) {
            if (enchantSetup.xpLevel() < 0) throw new IllegalArgumentException("xpLevel must be >= 0");
            player.setExperienceLevels(enchantSetup.xpLevel());
            player.setExperiencePoints(0);
        }
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
        active.mapSource = mapSource;
        if (mount != null) {
            active.mountUuid = mount.getUUID();
            active.lastSaddle = MountArena.worn(mount, EquipmentSlot.SADDLE);
            active.lastBody = MountArena.worn(mount, EquipmentSlot.BODY);
        }
        if (villager != null) active.villagerUuid = villager.getUUID();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("arena", arena);
        out.put("startedAtMs", active.startedAtMs);
        out.put("baseline", baseline);
        List<Map<String, Object>> given = new ArrayList<>();
        for (Give g : items) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("slot", g.slot());
            row.put("id", g.id());
            row.put("count", g.count());
            if (g.enchantments() != null && !g.enchantments().isEmpty()) row.put("enchantments", g.enchantments());
            given.add(row);
        }
        out.put("given", given);
        out.put("inventory", inventory(player, null));
        if (stationBlock != null) {
            out.put("station", station);
            out.put("pitch", player.getXRot());
            out.put("aimOk", mount != null ? aimsAtEntity(player, mount) : villager != null ? aimsAtEntity(player, villager) : aimsAt(player, stationPos(o), stationBlock));
        }
        if (chest != null) {
            // 大箱子没连上时这里是 27（C2 自检）
            out.put("chestSlots", chest.getContainerSize());
            out.put("chest", counts(chest));
        }
        if (cookInfo != null) out.put("cook", cookInfo);
        if (enchantInfo != null) out.put("enchant", enchantInfo);
        if (mapSource != null) out.put("map", mapSource.describe());
        if (brewProduct != null) out.put("brew", Map.of("product", brewProduct));
        if (crafterProduct != null) out.put("crafter", Map.of("product", crafterProduct));
        if (isBeacon(station)) {
            // 信标方案 G2：新放的信标等级是 0，要等它查完光柱、到 80 tick 的整数倍才数底座；插件轮询 status 的 beacon.levels 等它对上
            Map<String, Object> beaconInfo = new LinkedHashMap<>();
            beaconInfo.put("baseLevel", beaconLevel);
            BeaconBlockEntity beacon = beaconAt(level, o);
            beaconInfo.put("state", beacon != null ? BeaconArena.state(beacon) : null);
            out.put("beacon", beaconInfo);
        }
        if (isAnvil(station)) {
            Map<String, Object> anvilInfo = new LinkedHashMap<>();
            anvilInfo.put("state", AnvilArena.state(level, stationPos(o)));
            anvilInfo.put("xpLevel", player.experienceLevel);
            anvilInfo.put("items", itemDetails(player));
            out.put("anvil", anvilInfo);
        }
        if (mount != null) {
            // 坐骑方案 H2：插件用它核对动物生成对了、物品发对了
            Map<String, Object> mountInfo = new LinkedHashMap<>(MountArena.describe(mount));
            mountInfo.put("items", itemDetails(player));
            out.put("mount", mountInfo);
        }
        if (villager != null) {
            // 村民交易方案 V3：插件拿 offers 和预览逐笔比对
            Map<String, Object> villagerInfo = new LinkedHashMap<>();
            villagerInfo.put("uuid", villager.getUUID().toString());
            villagerInfo.put("profession", villagerSetup.profession());
            villagerInfo.put("type", villagerSetup.type());
            villagerInfo.put("level", villager.getVillagerData().level());
            villagerInfo.put("offers", VillagerArena.describe(level, villager, villagerMade.levels()));
            out.put("villager", villagerInfo);
        }
        if (isSmithing(station)) {
            // 锻造台方案 M7：插件用它核对材料发对了
            Map<String, Object> smithingInfo = new LinkedHashMap<>();
            smithingInfo.put("items", itemDetails(player));
            out.put("smithing", smithingInfo);
        }
        return out;
    }

    /**
     * 熔炉方案 K8：服务器端的真实数值——这台炉子里 cook.fuel 的燃料时长（高炉、烟熏炉减半，F3）、
     * cook.raw 的烧制时间和产物、两者的堆叠上限。这台炉子烧不了 cook.raw、或 cook.fuel 不是燃料 → 报错。
     */
    private static Map<String, Object> cookInfo(MinecraftServer server, ServerLevel level, String station, Cook cook) {
        Item raw = item(cook.raw());
        Item fuel = item(cook.fuel());
        item(cook.product()); // 未知 id 在这里报错
        SingleRecipeInput input = new SingleRecipeInput(new ItemStack(raw));
        var recipes = server.getRecipeManager();
        AbstractCookingRecipe recipe = switch (station) {
            case "blast_furnace" -> recipes.getRecipeFor(RecipeType.BLASTING, input, level).map(h -> (AbstractCookingRecipe) h.value()).orElse(null);
            case "smoker" -> recipes.getRecipeFor(RecipeType.SMOKING, input, level).map(h -> (AbstractCookingRecipe) h.value()).orElse(null);
            default -> recipes.getRecipeFor(RecipeType.SMELTING, input, level).map(h -> (AbstractCookingRecipe) h.value()).orElse(null);
        };
        if (recipe == null) throw new IllegalArgumentException(cook.raw() + " cannot be cooked in a " + station);
        int burn = server.fuelValues().burnDuration(new ItemStack(fuel));
        if (burn <= 0) throw new IllegalArgumentException(cook.fuel() + " is not a fuel");
        // BlastFurnaceBlockEntity / SmokerBlockEntity.getBurnDuration：super / 2
        if (!"furnace".equals(station)) burn = burn / 2;
        ItemStack result = recipe.assemble(input, level.registryAccess());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("burnTicks", burn);
        out.put("cookTicks", recipe.cookingTime());
        out.put("product", id(result));
        out.put("productCount", result.getCount());
        out.put("rawMaxStack", raw.getDefaultMaxStackSize());
        out.put("fuelMaxStack", fuel.getDefaultMaxStackSize());
        return out;
    }

    /** 炉子三格和点燃状态（熔炉方案 K8）：{ input, fuel, output: { id: count }, lit }；炉子不在了 → null。 */
    private static Map<String, Object> furnaceState(ServerLevel level, Run run) {
        AbstractFurnaceBlockEntity furnace = furnaceAt(level, run.origin, run.stationName);
        if (furnace == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("input", slotCount(furnace.getItem(0)));
        out.put("fuel", slotCount(furnace.getItem(1)));
        out.put("output", slotCount(furnace.getItem(2)));
        out.put("lit", furnace.getBlockState().getValue(AbstractFurnaceBlock.LIT));
        return out;
    }

    private static Map<String, Integer> slotCount(ItemStack stack) {
        return stack.isEmpty() ? Map.of() : Map.of(id(stack), stack.getCount());
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
        if (isLoom(active.stationName)) {
            // 织布机方案 L8、L9：物品栏（不含光标）、光标、织布机三个输入格（界面开着时；关界面时退回物品栏）、场内地上，都按签名计数
            out.put("held", LoomArena.counts(player.getInventory()));
            out.put("carried", LoomArena.carried(player.containerMenu));
            out.put("loomInput", LoomArena.input(player.containerMenu));
            out.put("dropped", LoomArena.dropped(level, box(active.origin)));
            out.put("containerOpen", containerOpen(player));
        }
        if (isBrewer(active.stationName)) {
            // 酿造台方案 P5、P8：物品栏（不含光标）、光标、地上按签名计数；酿造台五格、燃料值、剩余酿造 tick；酿造次数
            out.put("held", BrewArena.counts(player.getInventory()));
            out.put("carried", BrewArena.carried(player.containerMenu));
            out.put("dropped", BrewArena.dropped(level, box(active.origin)));
            BrewingStandBlockEntity stand = standAt(level, active.origin);
            out.put("stand", stand != null ? BrewArena.stand(stand) : null);
            out.put("containerOpen", containerOpen(player));
            out.put("brews", active.brews);
        }
        if (isCrafter(active.stationName)) {
            // 合成器方案 R5、R8：物品栏（不含光标）、光标、场内地上按 id 计数；合成器九格、禁用格、预览产物、通电状态
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            CrafterBlockEntity crafter = crafterAt(level, active.origin);
            out.put("crafter", crafter != null ? CrafterArena.state(level, crafter) : null);
            out.put("containerOpen", containerOpen(player));
        }
        if (isCartography(active.stationName)) {
            // 制图台方案 K8、K9：物品栏（不含光标）、光标、制图台 0、1 两格（界面开着时；关界面时退回物品栏）、场内地上，都按签名计数
            CartographyArena.Source src = active.mapSource;
            out.put("held", CartographyArena.counts(player.getInventory(), level, src));
            out.put("carried", CartographyArena.carried(player.containerMenu, level, src));
            out.put("tableInput", CartographyArena.input(player.containerMenu, level, src));
            out.put("dropped", CartographyArena.dropped(level, box(active.origin), src));
            out.put("containerOpen", containerOpen(player));
            out.put("map", src != null ? src.describe() : null);
        }
        if (isCutter(active.stationName)) {
            // 切石机方案 Q8：物品栏（不含光标）、光标、切石机输入格（界面开着时；关界面时会退回物品栏）、场内地上
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("cutterInput", cutterInput(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
        }
        if (isEnchanter(active.stationName)) {
            // 附魔台方案 N7、N8：物品栏（不含光标）、光标、附魔台两格（界面开着时；关界面时退回物品栏）、场内地上、界面开没开、经验等级、
            // 那件物品现在的附魔
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("table", enchantTable(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            out.put("containerOpen", containerOpen(player));
            out.put("xpLevel", player.experienceLevel);
            out.put("enchantments", active.expect != null && active.expect.enchant() != null ? EnchantArena.enchantmentsOf(enchantedStack(player, active.expect.enchant())) : List.of());
        }
        if (isFurnace(active.stationName)) {
            // 熔炉方案 K4、K8：物品栏（不含光标）、光标、炉子三格（关界面后东西留在炉子里）、场内地上
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("furnace", furnaceState(level, active));
            out.put("dropped", dropped(level, active.origin));
            // 熔炉方案 K8：任务要求放好后关掉界面；finish 先读状态再关界面，所以这里是 agent 自己留下的样子
            out.put("containerOpen", containerOpen(player));
        }
        if (isBeacon(active.stationName)) {
            // 信标方案 G6、G7：物品栏（不含光标）、光标、付款格（界面开着时；关界面时付款格里的东西会被扔到地上，F7）、场内地上、
            // 界面开没开、信标的等级和主副效果（信标不在了 → null）、付款次数和每次设的效果
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("slot", beaconSlot(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            out.put("containerOpen", containerOpen(player));
            BeaconBlockEntity beacon = beaconAt(level, active.origin);
            out.put("beacon", beacon != null ? BeaconArena.state(beacon) : null);
            out.put("paid", active.paid);
            out.put("sets", List.copyOf(active.beaconSets));
        }
        if (isAnvil(active.stationName)) {
            // 铁砧方案 A6、A7：物品栏（不含光标）的计数和每件的附魔、名字，光标，铁砧两格（界面开着时；关界面时退回物品栏），
            // 场内地上，界面开没开，铁砧的状态，经验等级，每次取出产物的记录
            out.put("held", counts(player.getInventory()));
            out.put("items", itemDetails(player));
            out.put("carried", carried(player.containerMenu));
            out.put("carriedItem", AnvilArena.describe(player.containerMenu.getCarried()));
            out.put("slots", anvilSlots(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            out.put("containerOpen", containerOpen(player));
            out.put("anvilState", AnvilArena.state(level, stationPos(active.origin)));
            out.put("xpLevel", player.experienceLevel);
            out.put("takes", List.copyOf(active.anvilTakes));
        }
        if (isMount(active.stationName)) {
            // 坐骑方案 H5、H6、H8：动物身上的东西（不在了为 null）、物品栏（不含光标）、光标、地上掉落物、界面开没开、骑没骑着、
            // 第一次骑上的时刻、有没有不开界面直接装备
            Mob mount = mountOf(level, active);
            out.put("mount", mount != null ? MountArena.describe(mount) : null);
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            out.put("containerOpen", containerOpen(player));
            out.put("riding", mount != null && player.getVehicle() == mount);
            out.put("rodeAtMs", active.rodeAtMs);
            out.put("equippedWithoutMenu", active.equippedWithoutMenu);
        }
        if (isVillager(active.stationName)) {
            // 村民交易方案 V6：村民每笔交易的次数（不在了为 null）；物品栏（不含光标）、光标、支付格（界面开着时；关界面时退回物品栏）、
            // 场内地上按 id 计数；界面开没开
            Villager villager = villagerOf(level, active);
            out.put("villager", villager != null ? VillagerArena.state(villager) : null);
            out.put("held", counts(player.getInventory()));
            out.put("carried", carried(player.containerMenu));
            out.put("payment", VillagerArena.payment(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            out.put("containerOpen", containerOpen(player));
        }
        if (isSmithing(active.stationName)) {
            // 锻造台方案 M6、M7：物品栏（不含光标）的计数和每件的纹饰，光标，锻造台三格（界面开着时；关界面时退回物品栏），
            // 场内地上（每件带纹饰），界面开没开，每次取出产物的记录
            out.put("held", counts(player.getInventory()));
            out.put("items", itemDetails(player));
            out.put("carried", carried(player.containerMenu));
            out.put("carriedItem", AnvilArena.describe(player.containerMenu.getCarried()));
            out.put("slots", smithingSlots(player.containerMenu));
            out.put("dropped", dropped(level, active.origin));
            out.put("droppedItems", droppedItems(level, active.origin));
            out.put("containerOpen", containerOpen(player));
            out.put("takes", List.copyOf(active.smithingTakes));
        }
        return out;
    }

    /** 工作站的每一格都还是应有的方块（大箱子要两半都在，漏斗下面的红石块也要在，§8 S22）。铁砧开裂、损坏也算在（铁砧方案 A1）。 */
    private static boolean stationIntact(ServerLevel level, Run run) {
        if (isAnvil(run.stationName)) return level.getBlockState(stationPos(run.origin)).is(BlockTags.ANVIL);
        // 坐骑方案 H2：动物还在（活着、在场地范围里）；鹦鹉螺组的水坑不算工作站
        if (isMount(run.stationName)) return mountOf(level, run) != null;
        // 村民交易方案 V1：村民还在（活着、在场地范围里）
        if (isVillager(run.stationName)) return villagerOf(level, run) != null;
        for (Map.Entry<BlockPos, Block> e : run.stationBlocks.entrySet()) if (!level.getBlockState(e.getKey()).is(e.getValue())) return false;
        return true;
    }

    /**
     * 结束本轮：读最终状态后传送到场外。没有进行中的一轮时只传送。
     * 信标场地（信标方案 G7、G10）：读完状态再拆掉信标重放（清空效果）、清掉玩家身上的效果，不带进下一轮或其他场地的训练。
     */
    public static Map<String, Object> finish(MinecraftServer server, ServerPlayer player, BlockPos fallbackOrigin) {
        Map<String, Object> out = status(server);
        BlockPos o = active != null ? active.origin : fallbackOrigin;
        boolean beacon = active != null && isBeacon(active.stationName);
        active = null;
        // 坐骑方案 H8：读完状态再让玩家下来（agent 可能骑在动物上）
        player.stopRiding();
        player.containerMenu.setCarried(ItemStack.EMPTY);
        player.closeContainer();
        if (beacon) {
            ServerLevel level = server.overworld();
            if (level.getBlockState(stationPos(o)).is(Blocks.BEACON)) replaceBeacon(level, o);
            player.removeAllEffects();
        }
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
        if (isMount(run.stationName)) trackMount(server.overworld(), player, run);
        if (run.station != null && run.openedAtMs == null && (isMount(run.stationName) ? opensMount(run, player.containerMenu)
                : isVillager(run.stationName) ? opensVillager(server.overworld(), player, run) : opensStation(run.stationName, player.containerMenu))) {
            run.openedAtMs = System.currentTimeMillis();
        }
        if (run.expect != null && run.reachedAtMs == null && reached(server.overworld(), player, run)) {
            run.reachedAtMs = System.currentTimeMillis();
        }
        if (++tickCounter % MONSTER_SWEEP_TICKS == 0) {
            for (Entity e : server.overworld().getEntitiesOfClass(Entity.class, box(run.origin), e -> e instanceof Enemy)) e.discard();
        }
    }

    /** 坐骑方案 H6：记第一次骑上的时刻；鞍槽 / 身体槽变了而当时没开着这只动物的物品栏 = 拿在手上右键装上的 */
    private static void trackMount(ServerLevel level, ServerPlayer player, Run run) {
        Mob mount = mountOf(level, run);
        if (mount == null) return;
        if (run.rodeAtMs == null && player.getVehicle() == mount) run.rodeAtMs = System.currentTimeMillis();
        String saddle = MountArena.worn(mount, EquipmentSlot.SADDLE);
        String body = MountArena.worn(mount, EquipmentSlot.BODY);
        boolean changed = !java.util.Objects.equals(saddle, run.lastSaddle) || !java.util.Objects.equals(body, run.lastBody);
        if (changed && !opensMount(run, player.containerMenu)) run.equippedWithoutMenu = true;
        run.lastSaddle = saddle;
        run.lastBody = body;
    }

    /**
     * 当前界面是不是这个工作站的界面：工作台 → CraftingMenu（物品栏的 2×2 是 InventoryMenu，不会误记）；
     * 箱子 → ChestMenu；漏斗 → HopperMenu；发射器 → DispenserMenu；切石机 → StonecutterMenu；
     * 熔炉 → FurnaceMenu；高炉 → BlastFurnaceMenu；烟熏炉 → SmokerMenu。
     */
    private static boolean opensStation(String station, AbstractContainerMenu menu) {
        return switch (station) {
            case "chest", "large_chest" -> menu instanceof ChestMenu;
            case "hopper" -> menu instanceof HopperMenu;
            case "dispenser" -> menu instanceof DispenserMenu;
            case "stonecutter" -> menu instanceof StonecutterMenu;
            case "furnace" -> menu instanceof FurnaceMenu;
            case "blast_furnace" -> menu instanceof BlastFurnaceMenu;
            case "smoker" -> menu instanceof SmokerMenu;
            case "enchanting_table" -> menu instanceof EnchantmentMenu;
            case "beacon" -> menu instanceof BeaconMenu;
            case "anvil" -> menu instanceof AnvilMenu;
            case "smithing_table" -> menu instanceof SmithingMenu;
            case "loom" -> menu instanceof LoomMenu;
            case "cartography" -> menu instanceof CartographyTableMenu;
            case "brewing_stand" -> menu instanceof BrewingStandMenu;
            case "crafter" -> menu instanceof CrafterMenu;
            default -> menu instanceof CraftingMenu;
        };
    }

    /** 箱子方案 C9：物品栏（不含光标）与容器的计数恰好等于 expect，且光标为空。容器不在了 → 否。切石机见 {@link #reachedTargets}，炉子见 {@link #reachedCook}。 */
    private static boolean reached(ServerLevel level, ServerPlayer player, Run run) {
        // 锻造台方案 M6：只看玩家身上（不含光标）的物品配不配得上，光标上拿着什么不影响
        if (run.expect.smithing() != null) return reachedSmithing(player, run.expect.smithing());
        if (!player.containerMenu.getCarried().isEmpty()) return false;
        if (run.expect.mount() != null) return reachedMount(level, player, run);
        if (run.expect.trade() != null) {
            // 村民交易方案 V9：界面关闭、光标为空（上面已查）、每笔交易的次数、物品栏
            if (containerOpen(player)) return false;
            Villager villager = villagerOf(level, run);
            return villager != null && VillagerArena.reached(villager, counts(player.getInventory()), run.expect.trade());
        }
        if (run.expect.brew() != null) {
            // 酿造台方案 P8：界面关闭、光标为空（上面已查）、物品栏和酿造台五格
            if (containerOpen(player)) return false;
            BrewingStandBlockEntity stand = standAt(level, run.origin);
            return stand != null && BrewArena.reached(BrewArena.counts(player.getInventory()), stand, run.expect.brew());
        }
        if (run.expect.crafter() != null) {
            // 合成器方案 R7：界面关闭、光标为空（上面已查）、物品栏和合成器九格
            if (containerOpen(player)) return false;
            CrafterBlockEntity crafter = crafterAt(level, run.origin);
            return crafter != null && CrafterArena.reached(level, counts(player.getInventory()), crafter, run.expect.crafter());
        }
        if (run.expect.cartography() != null) {
            ServerLevel lvl = level;
            return CartographyArena.reached(CartographyArena.counts(player.getInventory(), lvl, run.mapSource),
                    CartographyArena.input(player.containerMenu, lvl, run.mapSource), run.expect.cartography());
        }
        if (run.expect.loom() != null) return LoomArena.reached(LoomArena.counts(player.getInventory()), LoomArena.input(player.containerMenu), run.expect.loom());
        if (run.expect.anvil() != null) return reachedAnvil(player, run.expect.anvil());
        if (run.expect.beacon() != null) return reachedBeacon(level, player, run);
        if (run.expect.enchant() != null) return reachedEnchant(player, run.expect.enchant());
        if (run.expect.cook() != null) return reachedCook(level, player, run);
        if (run.expect.targets() != null) return reachedTargets(player, run.expect);
        Container chest = stationContainer(level, run.origin, run.stationName);
        return chest != null && counts(player.getInventory()).equals(run.expect.inventory()) && counts(chest).equals(run.expect.container());
    }

    /** 切石机方案 Q9（光标为空已由调用方检查）：目标恰好都在物品栏里，输入格里没有目标，任何地方没有 allowed 以外的物品。 */
    private static boolean reachedTargets(ServerPlayer player, Expect expect) {
        Map<String, Integer> held = counts(player.getInventory());
        Map<String, Integer> input = cutterInput(player.containerMenu);
        for (Map.Entry<String, Integer> t : expect.targets().entrySet()) {
            if (!t.getValue().equals(held.getOrDefault(t.getKey(), 0)) || input.containsKey(t.getKey())) return false;
        }
        return expect.allowed().containsAll(held.keySet()) && expect.allowed().containsAll(input.keySet());
    }

    /**
     * 熔炉方案 K8（第二版；光标为空已由调用方检查）：放对了并关掉界面就算——容器界面已关闭（当前菜单回到玩家自己的背包菜单）；
     * 物品栏里原料、燃料恰好剩 rawLeft、fuelLeft，没有原料、燃料、产物以外的物品（产物可有可无）；
     * 原料格空或只有原料，燃料格空或只有燃料。产物格、炉子还在不在烧都不看。炉子不在了 → 否。
     */
    private static boolean reachedCook(ServerLevel level, ServerPlayer player, Run run) {
        if (containerOpen(player)) return false;
        Cook cook = run.expect.cook();
        AbstractFurnaceBlockEntity furnace = furnaceAt(level, run.origin, run.stationName);
        if (furnace == null) return false;
        Map<String, Integer> held = counts(player.getInventory());
        if (held.getOrDefault(cook.raw(), 0) != cook.rawLeft() || held.getOrDefault(cook.fuel(), 0) != cook.fuelLeft()) return false;
        for (String id : held.keySet()) {
            if (!id.equals(cook.raw()) && !id.equals(cook.fuel()) && !id.equals(cook.product())) return false;
        }
        ItemStack input = furnace.getItem(0);
        if (!input.isEmpty() && !id(input).equals(cook.raw())) return false;
        ItemStack fuel = furnace.getItem(1);
        return fuel.isEmpty() || id(fuel).equals(cook.fuel());
    }

    /**
     * 玩家开着某个容器界面（炉子、箱子……）：服务器端的当前菜单不是玩家自己的背包菜单。
     * 客户端按 E 打开的背包界面服务器看不到，算作没开容器。
     */
    /**
     * 附魔台方案 N8（光标为空已由调用方检查）：容器界面已关闭；物品栏里恰好一件 result，带有目标附魔（附魔书读存储的附魔）；
     * 物品栏里除了它和青金石没有别的东西。
     */
    private static boolean reachedEnchant(ServerPlayer player, Enchant enchant) {
        if (containerOpen(player)) return false;
        Map<String, Integer> held = counts(player.getInventory());
        if (held.getOrDefault(enchant.result(), 0) != 1) return false;
        for (String id : held.keySet()) if (!id.equals(enchant.result()) && !id.equals(LAPIS)) return false;
        return EnchantArena.hasEnchantment(enchantedStack(player, enchant), enchant.enchantment(), enchant.level());
    }

    private static final String LAPIS = "minecraft:lapis_lazuli";

    /**
     * 信标方案 G7（光标为空已由调用方检查）：容器界面已关闭；场内地上没有物品；物品栏里除了付款物品没有别的东西；
     * 信标还在，主副效果是界面能设出来的，实际给的效果里有每一项。
     */
    private static boolean reachedBeacon(ServerLevel level, ServerPlayer player, Run run) {
        if (containerOpen(player)) return false;
        if (!dropped(level, run.origin).isEmpty()) return false;
        Beacon goal = run.expect.beacon();
        for (String id : counts(player.getInventory()).keySet()) if (!id.equals(goal.payment())) return false;
        BeaconBlockEntity beacon = beaconAt(level, run.origin);
        return beacon != null && BeaconArena.satisfies(beacon, goal.effects());
    }

    /** 铁砧方案 A6、A7（光标为空已由调用方检查）：玩家身上（主物品栏、快捷栏、盔甲、副手）有一件物品对上目标。不要求关界面。 */
    private static boolean reachedAnvil(ServerPlayer player, Anvil goal) {
        var inv = player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) if (AnvilArena.matches(inv.getItem(i), goal)) return true;
        return false;
    }

    /** 坐骑方案 H5、H6（光标为空已由调用方检查）：动物还在，鞍槽、身体槽、箱子对上目标，玩家身上（不含光标）按物品 id 合计恰好是目标。 */
    private static boolean reachedMount(ServerLevel level, ServerPlayer player, Run run) {
        Mob mount = mountOf(level, run);
        return mount != null && MountArena.matches(mount, run.expect.mount()) && counts(player.getInventory()).equals(run.expect.mount().inventory());
    }

    /** 锻造台方案 M6、M7：玩家身上（主物品栏、快捷栏、盔甲、副手，不含光标）能给每个目标配上各不相同的一件。不要求关界面。 */
    private static boolean reachedSmithing(ServerPlayer player, List<Smith> goals) {
        var inv = player.getInventory();
        List<ItemStack> stacks = new ArrayList<>();
        for (int i = 0; i < inv.getContainerSize(); i++) if (!inv.getItem(i).isEmpty()) stacks.add(inv.getItem(i));
        return SmithingArena.assign(stacks, goals);
    }

    /**
     * 本轮那件物品现在在哪：物品栏（原材料或附魔后的 result）→ 光标 → 附魔台物品格（界面开着时）。找不到 → 空。
     */
    private static ItemStack enchantedStack(ServerPlayer player, Enchant enchant) {
        var inv = player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack stack = inv.getItem(i);
            if (!stack.isEmpty() && (id(stack).equals(enchant.result()) || id(stack).equals(enchant.item()))) return stack;
        }
        ItemStack carried = player.containerMenu.getCarried();
        if (!carried.isEmpty() && (id(carried).equals(enchant.result()) || id(carried).equals(enchant.item()))) return carried;
        if (player.containerMenu instanceof EnchantmentMenu menu) {
            ItemStack inSlot = menu.getSlot(0).getItem();
            if (!inSlot.isEmpty()) return inSlot;
        }
        return ItemStack.EMPTY;
    }

    /** 当前界面是附魔台时它的两格：{ item: {id: n}, lapis: {id: n} }；不是附魔台界面 → 两格都是 {}。 */
    private static Map<String, Object> enchantTable(AbstractContainerMenu menu) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (menu instanceof EnchantmentMenu em) {
            ItemStack item = em.getSlot(0).getItem();
            ItemStack lapis = em.getSlot(1).getItem();
            out.put("item", item.isEmpty() ? Map.of() : Map.of(id(item), item.getCount()));
            out.put("lapis", lapis.isEmpty() ? Map.of() : Map.of(id(lapis), lapis.getCount()));
        } else {
            out.put("item", Map.of());
            out.put("lapis", Map.of());
        }
        return out;
    }

    private static boolean containerOpen(ServerPlayer player) {
        return player.containerMenu != player.inventoryMenu;
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

    /** 当前界面是切石机时它的输入格（0 号格）：{ id: count }；空或不是切石机界面 → {}。 */
    private static Map<String, Integer> cutterInput(AbstractContainerMenu menu) {
        if (!(menu instanceof StonecutterMenu sm)) return Map.of();
        ItemStack stack = sm.getSlot(0).getItem();
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

    /** 场内地上的每一件掉落物：[{ id, count, trim }]（锻造台方案 M6：底材和加了纹饰的盔甲扔在地上时要分得清）。 */
    private static List<Map<String, Object>> droppedItems(ServerLevel level, BlockPos o) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box(o))) {
            Map<String, Object> d = SmithingArena.describe(e.getItem());
            if (d != null) out.add(d);
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
