package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.IdMap;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.EnchantmentTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.inventory.ContainerLevelAccess;
import net.minecraft.world.inventory.EnchantmentMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.item.enchantment.EnchantmentInstance;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.level.block.EnchantingTableBlock;

/**
 * 附魔台训练场（docs/附魔台训练场设计方案.md）的计算部分：书架位置、三档预览、用真实菜单核对、读物品的附魔。
 * 全部在服务器线程上调用（同 {@link ArenaManager}）。
 */
public final class EnchantArena {

    /** 书架最多算 15 个（EnchantmentHelper.getEnchantmentCost） */
    public static final int MAX_SHELVES = 15;

    private EnchantArena() {}

    /**
     * 书架的位置（N1）：附魔台同一层、以它为中心 5×5 的外圈，去掉玩家站的那一格（附魔台正前方两格），正好 15 个。
     * 只摆前 count 个：远端一排 → 两侧 → 近端一排（玩家两边）。这些位置和附魔台之间的一圈都是空气，满足
     * EnchantingTableBlock.isValidBookShelf。
     * @param table 附魔台的位置；玩家在它的 -z 方向两格
     */
    public static List<BlockPos> shelfPositions(BlockPos table, int count) {
        List<int[]> order = new ArrayList<>();
        for (int dx = -2; dx <= 2; dx++) order.add(new int[]{dx, 2});
        for (int dz = 1; dz >= -1; dz--) {
            order.add(new int[]{-2, dz});
            order.add(new int[]{2, dz});
        }
        for (int dx : new int[]{-2, -1, 1, 2}) order.add(new int[]{dx, -2});
        List<BlockPos> out = new ArrayList<>();
        for (int i = 0; i < Math.min(count, order.size()); i++) out.add(table.offset(order.get(i)[0], 0, order.get(i)[1]));
        return out;
    }

    /** 附魔台周围实际有效的书架数（和 EnchantmentMenu.slotsChanged 的数法一致，不封顶）。 */
    public static int countShelves(ServerLevel level, BlockPos table) {
        int n = 0;
        for (BlockPos offset : EnchantingTableBlock.BOOKSHELF_OFFSETS) if (EnchantingTableBlock.isValidBookShelf(level, table, offset)) n++;
        return n;
    }

    /**
     * 三档预览（N5）：逐行照搬 EnchantmentMenu.slotsChanged（86–123 行）与 getEnchantmentList（185–198 行）——
     * 同一种随机数源、同样的调用顺序；种子按 int 相加（菜单里 enchantmentSeed 是 DataSlot 的 int）。
     * @return { enchantable, offers: [{ slot, cost, clue: {enchantment, level} | null, result: [{enchantment, level}] }] }
     */
    public static Map<String, Object> preview(RegistryAccess registries, ItemStack stack, int seed, int shelves) {
        Map<String, Object> out = new LinkedHashMap<>();
        boolean enchantable = !stack.isEmpty() && stack.isEnchantable();
        out.put("enchantable", enchantable);
        List<Map<String, Object>> offers = new ArrayList<>();
        out.put("offers", offers);
        if (!enchantable) return out;
        int counted = Math.max(0, shelves);
        RandomSource random = RandomSource.create();
        random.setSeed(seed);
        int[] costs = new int[3];
        for (int j = 0; j < 3; j++) {
            costs[j] = EnchantmentHelper.getEnchantmentCost(random, j, counted, stack);
            if (costs[j] < j + 1) costs[j] = 0;
        }
        for (int j = 0; j < 3; j++) {
            Map<String, Object> offer = new LinkedHashMap<>();
            offer.put("slot", j + 1);
            offer.put("cost", costs[j]);
            Map<String, Object> clue = null;
            List<Map<String, Object>> result = List.of();
            if (costs[j] > 0) {
                List<EnchantmentInstance> list = enchantmentList(registries, stack, j, costs[j], random, seed);
                if (!list.isEmpty()) {
                    EnchantmentInstance hint = list.get(random.nextInt(list.size()));
                    clue = entry(hint.enchantment(), hint.level());
                    List<Map<String, Object>> all = new ArrayList<>();
                    for (EnchantmentInstance e : list) all.add(entry(e.enchantment(), e.level()));
                    result = all;
                }
            }
            offer.put("clue", clue);
            offer.put("result", result);
            offers.add(offer);
        }
        return out;
    }

    private static List<EnchantmentInstance> enchantmentList(RegistryAccess registries, ItemStack stack, int slot, int cost, RandomSource random, int seed) {
        random.setSeed(seed + slot);
        Optional<HolderSet.Named<Enchantment>> table = registries.lookupOrThrow(Registries.ENCHANTMENT).get(EnchantmentTags.IN_ENCHANTING_TABLE);
        if (table.isEmpty()) return List.of();
        List<EnchantmentInstance> list = EnchantmentHelper.selectEnchantment(random, stack, cost, table.get().stream());
        if (stack.is(Items.BOOK) && list.size() > 1) list.remove(random.nextInt(list.size()));
        return list;
    }

    /**
     * 用真实的附魔台菜单算三档（N5 的核对）：在服务器上临时建一个 EnchantmentMenu（种子取玩家当前的附魔种子，书架按世界里实际的数），
     * 放进物品的副本，读出 costs / enchantClue / levelClue。菜单只是临时对象：不打开给玩家、不调用 removed，物品副本随它丢弃。
     * @return [{ slot, cost, clue: {enchantment, level} | null }]
     */
    public static List<Map<String, Object>> menuOffers(ServerLevel level, ServerPlayer player, BlockPos table, ItemStack stack) {
        EnchantmentMenu menu = new EnchantmentMenu(0, player.getInventory(), ContainerLevelAccess.create(level, table));
        menu.getSlot(0).set(stack.copy());
        IdMap<Holder<Enchantment>> ids = level.registryAccess().lookupOrThrow(Registries.ENCHANTMENT).asHolderIdMap();
        List<Map<String, Object>> out = new ArrayList<>();
        for (int j = 0; j < 3; j++) {
            Map<String, Object> offer = new LinkedHashMap<>();
            offer.put("slot", j + 1);
            offer.put("cost", menu.costs[j]);
            Holder<Enchantment> clue = menu.enchantClue[j] >= 0 ? ids.byId(menu.enchantClue[j]) : null;
            offer.put("clue", clue == null ? null : entry(clue, menu.levelClue[j]));
            out.add(offer);
        }
        return out;
    }

    /** 物品的全部附魔（附魔书读"存储的附魔"，E4）：[{ enchantment, level }]，按注册名排序。 */
    public static List<Map<String, Object>> enchantmentsOf(ItemStack stack) {
        ItemEnchantments enchantments = EnchantmentHelper.getEnchantmentsForCrafting(stack);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Holder<Enchantment> holder : enchantments.keySet()) out.add(entry(holder, enchantments.getLevel(holder)));
        out.sort((a, b) -> ((String) a.get("enchantment")).compareTo((String) b.get("enchantment")));
        return out;
    }

    /** 物品带不带某个附魔、等级是不是 level。 */
    public static boolean hasEnchantment(ItemStack stack, String enchantment, int level) {
        ItemEnchantments enchantments = EnchantmentHelper.getEnchantmentsForCrafting(stack);
        for (Holder<Enchantment> holder : enchantments.keySet()) {
            if (holder.getRegisteredName().equals(enchantment) && enchantments.getLevel(holder) == level) return true;
        }
        return false;
    }

    private static Map<String, Object> entry(Holder<Enchantment> holder, int level) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enchantment", holder.getRegisteredName());
        out.put("level", level);
        return out;
    }
}
