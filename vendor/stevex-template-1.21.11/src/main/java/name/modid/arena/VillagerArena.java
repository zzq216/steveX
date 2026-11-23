package name.modid.arena;

import it.unimi.dsi.fastutil.ints.Int2ObjectMap;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.NbtOps;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.npc.villager.Villager;
import net.minecraft.world.entity.npc.villager.VillagerData;
import net.minecraft.world.entity.npc.villager.VillagerProfession;
import net.minecraft.world.entity.npc.villager.VillagerTrades;
import net.minecraft.world.entity.npc.villager.VillagerType;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.MerchantMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.trading.ItemCost;
import net.minecraft.world.item.trading.MerchantOffer;
import net.minecraft.world.item.trading.MerchantOffers;

/**
 * 村民交易训练场（docs/村民交易训练场设计方案.md）的计算部分：交易项生成（V2）、预览与描述（V3）、村民状态和到达检测（V6、V9）。
 *
 * <p>交易项按原版 {@code addOffersFromItemListings} 的算法逐级生成（1..L 每级抽 2 笔），但随机数用 {@code RandomSource.create(seed)}
 * （F2：listing 只用传进来的随机数），所以同一组参数一定生成同一组交易，预览和 prepare 一致。藏宝图在抽之前就拿掉（F3）。
 * 村民 NoAI + 无敌（F5、F14）：一轮内不走动、不升级、口碑不变，价格和交易列表固定。
 */
public final class VillagerArena {

    private VillagerArena() {}

    public static final int MAX_LEVEL = 5;
    /** 每级抽几笔（原版 updateTrades 的 2） */
    public static final int PER_LEVEL = 2;
    /** 5 级的经验门槛（VillagerData.NEXT_LEVEL_XP_THRESHOLDS[4]；getMinXpPerLevel(5) 返回 0） */
    public static final int MAX_LEVEL_XP = 250;

    /** V2：本轮村民的职业、类型、等级、交易项种子。 */
    public record Setup(String profession, String type, int level, long seed) {}

    /** V9 的到达目标：每笔交易的 uses 恰好是 uses[i]（数量 = 交易项数）；物品栏按 id 恰好是 held（0 的不出现），没有别的东西。 */
    public record Spec(List<Integer> uses, Map<String, Integer> held) {}

    /** 生成好的村民（还没加入世界）和每笔交易是在第几级生成的。 */
    public record Created(Villager villager, List<Integer> levels) {}

    private static String id(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static Identifier key(String id, String what) {
        Identifier key = Identifier.tryParse(id.contains(":") ? id : "minecraft:" + id);
        if (key == null) throw new IllegalArgumentException("bad " + what + " id: " + id);
        return key;
    }

    /** 职业：要有交易表，不能是 none / nitwit（F13）。 */
    static ResourceKey<VillagerProfession> professionKey(String id) {
        ResourceKey<VillagerProfession> key = ResourceKey.create(Registries.VILLAGER_PROFESSION, key(id, "profession"));
        if (key.equals(VillagerProfession.NONE) || key.equals(VillagerProfession.NITWIT) || !VillagerTrades.TRADES.containsKey(key)) {
            throw new IllegalArgumentException("profession must be a villager profession with trades (not none / nitwit): " + id);
        }
        return key;
    }

    static ResourceKey<VillagerType> typeKey(String id) {
        ResourceKey<VillagerType> key = ResourceKey.create(Registries.VILLAGER_TYPE, key(id, "villager type"));
        if (!BuiltInRegistries.VILLAGER_TYPE.containsKey(key)) throw new IllegalArgumentException("unknown villager type: " + id);
        return key;
    }

    /** 有交易表的职业（训练场的职业池，V2），按注册名排序。 */
    public static List<String> professions() {
        List<String> out = new ArrayList<>();
        for (ResourceKey<VillagerProfession> key : VillagerTrades.TRADES.keySet()) {
            if (!key.equals(VillagerProfession.NONE) && !key.equals(VillagerProfession.NITWIT)) out.add(key.identifier().toString());
        }
        out.sort(String::compareTo);
        return out;
    }

    /** 藏宝图（F3）：本身，或包着它的 TypeSpecificTrade。 */
    private static boolean isTreasureMap(VillagerTrades.ItemListing listing) {
        if (listing instanceof VillagerTrades.TreasureMapForEmeralds) return true;
        return listing instanceof VillagerTrades.TypeSpecificTrade typed
            && typed.trades().values().stream().anyMatch(l -> l instanceof VillagerTrades.TreasureMapForEmeralds);
    }

    /**
     * V2：生成一只村民（不加入世界）——成年、职业 / 类型 / 等级按 setup，经验设成该级门槛，交易项按 seed 从 1 级逐级生成到 L 级。
     * listing 表和原版 updateTrades 一致：开了 TRADE_REBALANCE 实验特性就用 EXPERIMENTAL_TRADES（这个职业没有时退回 TRADES）。
     */
    public static Created create(ServerLevel level, Setup setup) {
        if (setup.level() < 1 || setup.level() > MAX_LEVEL) throw new IllegalArgumentException("villager level must be within 1-" + MAX_LEVEL + ": " + setup.level());
        ResourceKey<VillagerProfession> professionKey = professionKey(setup.profession());
        Holder<VillagerProfession> profession = BuiltInRegistries.VILLAGER_PROFESSION.getOrThrow(professionKey);
        Holder<VillagerType> type = BuiltInRegistries.VILLAGER_TYPE.getOrThrow(typeKey(setup.type()));
        Villager villager = EntityType.VILLAGER.create(level, EntitySpawnReason.COMMAND);
        if (villager == null) throw new IllegalStateException("cannot create a villager");
        villager.setAge(0);
        villager.setVillagerData(villager.getVillagerData().withType(type).withProfession(profession).withLevel(setup.level()));
        villager.setVillagerXp(setup.level() < MAX_LEVEL ? VillagerData.getMinXpPerLevel(setup.level()) : MAX_LEVEL_XP);

        Int2ObjectMap<VillagerTrades.ItemListing[]> table = VillagerTrades.TRADES.get(professionKey);
        if (level.enabledFeatures().contains(FeatureFlags.TRADE_REBALANCE)) {
            Int2ObjectMap<VillagerTrades.ItemListing[]> experimental = VillagerTrades.EXPERIMENTAL_TRADES.get(professionKey);
            if (experimental != null) table = experimental;
        }
        RandomSource random = RandomSource.create(setup.seed());
        MerchantOffers offers = new MerchantOffers();
        List<Integer> levels = new ArrayList<>();
        for (int lv = 1; lv <= setup.level(); lv++) {
            VillagerTrades.ItemListing[] listings = table.get(lv);
            if (listings == null) continue;
            List<VillagerTrades.ItemListing> pool = new ArrayList<>();
            for (VillagerTrades.ItemListing listing : listings) if (!isTreasureMap(listing)) pool.add(listing);
            int added = 0;
            while (added < PER_LEVEL && !pool.isEmpty()) {
                MerchantOffer offer = pool.remove(random.nextInt(pool.size())).getOffer(level, villager, random);
                if (offer != null) {
                    offers.add(offer);
                    levels.add(lv);
                    added++;
                }
            }
        }
        villager.setOffers(offers);
        return new Created(villager, List.copyOf(levels));
    }

    /** V1：放进世界——NoAI、无敌、不会消失，朝 yaw。 */
    public static void place(ServerLevel level, Villager villager, double x, double y, double z, float yaw) {
        villager.setNoAi(true);
        villager.setInvulnerable(true);
        villager.setPersistenceRequired();
        villager.snapTo(x, y, z, yaw, 0f);
        villager.setYHeadRot(yaw);
        villager.setYBodyRot(yaw);
        level.addFreshEntity(villager);
    }

    private static Map<String, Object> cost(ItemCost cost, int count) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", BuiltInRegistries.ITEM.getKey(cost.item().value()).toString());
        out.put("count", count);
        out.put("maxStack", cost.itemStack().getMaxStackSize());
        return out;
    }

    /**
     * V3 的交易描述：{ index, level, costA{ id, count（实际价）, base（基础价）, maxStack }, costB{ id, count, maxStack } | null,
     * result{ id, count, maxStack, components（带不带组件）, enchantments{id:level}, name }, uses, maxUses, xp, encoded }。
     * encoded 是 MerchantOffer.CODEC 的 NBT 文本：插件拿 prepare 返回的和预览的逐笔比对。
     */
    public static List<Map<String, Object>> describe(ServerLevel level, Villager villager, List<Integer> levels) {
        var ops = level.registryAccess().createSerializationContext(NbtOps.INSTANCE);
        List<Map<String, Object>> out = new ArrayList<>();
        MerchantOffers offers = villager.getOffers();
        for (int i = 0; i < offers.size(); i++) {
            MerchantOffer offer = offers.get(i);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("index", i);
            row.put("level", i < levels.size() ? levels.get(i) : null);
            Map<String, Object> a = cost(offer.getItemCostA(), offer.getCostA().getCount());
            a.put("base", offer.getItemCostA().count());
            row.put("costA", a);
            Optional<ItemCost> b = offer.getItemCostB();
            row.put("costB", b.isPresent() ? cost(b.get(), b.get().count()) : null);
            ItemStack result = offer.getResult();
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("id", id(result));
            r.put("count", result.getCount());
            r.put("maxStack", result.getMaxStackSize());
            r.put("components", !result.getComponentsPatch().isEmpty());
            r.put("enchantments", AnvilArena.enchantments(result));
            r.put("name", result.getHoverName().getString());
            row.put("result", r);
            row.put("uses", offer.getUses());
            row.put("maxUses", offer.getMaxUses());
            row.put("xp", offer.getXp());
            row.put("encoded", MerchantOffer.CODEC.encodeStart(ops, offer).getOrThrow().toString());
            out.add(row);
        }
        return out;
    }

    /** status 的村民状态（V6）：{ uuid, profession, level, uses[每笔交易的次数], trading（有没有玩家正在和它交易） }。 */
    public static Map<String, Object> state(Villager villager) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("uuid", villager.getUUID().toString());
        out.put("profession", villager.getVillagerData().profession().unwrapKey().map(k -> k.identifier().toString()).orElse(null));
        out.put("level", villager.getVillagerData().level());
        out.put("uses", uses(villager));
        out.put("trading", villager.getTradingPlayer() != null);
        return out;
    }

    public static List<Integer> uses(Villager villager) {
        List<Integer> out = new ArrayList<>();
        for (MerchantOffer offer : villager.getOffers()) out.add(offer.getUses());
        return out;
    }

    /** 交易界面开着时两个支付格里的东西（按 id 计数）；不是交易界面 → {}。 */
    public static Map<String, Integer> payment(AbstractContainerMenu menu) {
        Map<String, Integer> out = new LinkedHashMap<>();
        if (!(menu instanceof MerchantMenu)) return out;
        for (int i = 0; i < 2; i++) {
            ItemStack stack = menu.getSlot(i).getItem();
            if (!stack.isEmpty()) out.merge(id(stack), stack.getCount(), Integer::sum);
        }
        return out;
    }

    /** V9（界面关闭、光标为空由调用方检查）：每笔交易的次数恰好是 spec.uses，物品栏恰好是 spec.held。 */
    public static boolean reached(Villager villager, Map<String, Integer> held, Spec spec) {
        return uses(villager).equals(spec.uses()) && held.equals(spec.held());
    }
}
