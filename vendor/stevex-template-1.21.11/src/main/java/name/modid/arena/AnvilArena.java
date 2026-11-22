package name.modid.arena;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.Holder;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.EnchantmentTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.level.GameType;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

/**
 * 铁砧训练场（docs/铁砧训练场设计方案.md）的计算部分：物品池和每件物品能附的附魔（A2）、按原版算法预览产物和花费（A4）、
 * 发带附魔的物品、比对目标物品（A6）。全部在服务器线程上调用（同 {@link ArenaManager}）。
 *
 * <p>附魔一律写成 { 注册名: 级数 }，按注册名排序；附魔书读、写的是"存储的附魔"（{@code EnchantmentHelper.getComponentType}）。
 */
public final class AnvilArena {

    /** 生存模式下铁砧最多花这么多级，再多就"过于昂贵"（AnvilMenu.createResult 250–252 行，F3） */
    public static final int MAX_COST = 39;

    private AnvilArena() {}

    /**
     * 物品池（A2，F13）：{@code enchantable/durability} 标签里的全部物品，按 id 排序；每件带能附到它上面的附魔
     * （{@link Enchantment#canEnchant}，看 supportedItems，和铁砧的判断一致，F2），各带最高级、是不是诅咒、和这件物品上的哪些附魔冲突。
     * @return { items: [{ id, enchantments: [{ id, maxLevel, curse, exclusive: [id…] }] }] }
     */
    public static Map<String, Object> catalog(RegistryAccess registries) {
        List<Holder.Reference<Enchantment>> all = registries.lookupOrThrow(Registries.ENCHANTMENT).listElements()
                .sorted(Comparator.comparing(Holder::getRegisteredName)).toList();
        List<Item> items = new ArrayList<>();
        for (Item item : BuiltInRegistries.ITEM) if (new ItemStack(item).is(ItemTags.DURABILITY_ENCHANTABLE)) items.add(item);
        items.sort(Comparator.comparing(i -> BuiltInRegistries.ITEM.getKey(i).toString()));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Item item : items) {
            ItemStack stack = new ItemStack(item);
            List<Holder.Reference<Enchantment>> usable = all.stream().filter(e -> e.value().canEnchant(stack)).toList();
            List<Map<String, Object>> enchantments = new ArrayList<>();
            for (Holder.Reference<Enchantment> e : usable) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("id", e.getRegisteredName());
                entry.put("maxLevel", e.value().getMaxLevel());
                entry.put("curse", e.is(EnchantmentTags.CURSE));
                List<String> exclusive = new ArrayList<>();
                for (Holder.Reference<Enchantment> other : usable) {
                    if (!other.equals(e) && !Enchantment.areCompatible(e, other)) exclusive.add(other.getRegisteredName());
                }
                entry.put("exclusive", exclusive);
                enchantments.add(entry);
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", BuiltInRegistries.ITEM.getKey(item).toString());
            row.put("enchantments", enchantments);
            out.add(row);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("items", out);
        return result;
    }

    /** 注册名 → 附魔；不存在 → 报错。 */
    public static Holder<Enchantment> enchantment(RegistryAccess registries, String id) {
        Identifier key = Identifier.tryParse(id);
        var holder = key == null ? null : registries.lookupOrThrow(Registries.ENCHANTMENT).get(ResourceKey.create(Registries.ENCHANTMENT, key)).orElse(null);
        if (holder == null) throw new IllegalArgumentException("unknown enchantment: " + id);
        return holder;
    }

    /**
     * 新建一件带附魔的物品（A7 的 prepare）：附魔书写进存储的附魔，其他物品写进附魔。每个附魔要存在，级数在 1 到最高级之间；
     * 普通物品上的附魔还要能附到它上面——不检查互相冲突（铁砧的产物本来就可能有，交给出题方保证）。
     */
    public static ItemStack stack(RegistryAccess registries, Item item, int count, Map<String, Integer> enchantments) {
        ItemStack stack = new ItemStack(item, count);
        if (enchantments == null || enchantments.isEmpty()) return stack;
        ItemEnchantments.Mutable mutable = new ItemEnchantments.Mutable(ItemEnchantments.EMPTY);
        boolean book = stack.has(DataComponents.STORED_ENCHANTMENTS);
        for (Map.Entry<String, Integer> e : enchantments.entrySet()) {
            Holder<Enchantment> holder = enchantment(registries, e.getKey());
            int level = e.getValue();
            if (level < 1 || level > holder.value().getMaxLevel()) {
                throw new IllegalArgumentException(e.getKey() + " level must be within 1-" + holder.value().getMaxLevel() + ": " + level);
            }
            if (!book && !holder.value().canEnchant(stack)) throw new IllegalArgumentException(e.getKey() + " cannot be applied to " + BuiltInRegistries.ITEM.getKey(item));
            mutable.set(holder, level);
        }
        if (!EnchantmentHelper.canStoreEnchantments(stack)) throw new IllegalArgumentException(BuiltInRegistries.ITEM.getKey(item) + " cannot hold enchantments");
        EnchantmentHelper.setEnchantments(stack, mutable.toImmutable());
        return stack;
    }

    /** 物品的附魔（附魔书读存储的附魔）：{ 注册名: 级数 }，按注册名排序。 */
    public static Map<String, Integer> enchantments(ItemStack stack) {
        Map<String, Integer> out = new TreeMap<>();
        ItemEnchantments enchantments = EnchantmentHelper.getEnchantmentsForCrafting(stack);
        for (var e : enchantments.entrySet()) out.put(e.getKey().getRegisteredName(), e.getIntValue());
        return out;
    }

    /** 自定义名字（铁砧改的名字）；没有 → null。 */
    public static String customName(ItemStack stack) {
        Component name = stack.get(DataComponents.CUSTOM_NAME);
        return name == null ? null : name.getString();
    }

    /**
     * 一件物品的摘要：{ id, count, enchantments, name, trim?, trimMaterial? }；空 → null。
     * trim、trimMaterial 只在物品有纹饰、能当纹饰材料时才有（锻造台方案 M8，场地 status 和 agent 看到的一致）。
     */
    public static Map<String, Object> describe(ItemStack stack) {
        if (stack == null || stack.isEmpty()) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        out.put("count", stack.getCount());
        out.put("enchantments", enchantments(stack));
        out.put("name", customName(stack));
        Map<String, Object> trim = SmithingArena.trim(stack);
        if (trim != null) out.put("trim", trim);
        String trimMaterial = SmithingArena.trimMaterial(stack);
        if (trimMaterial != null) out.put("trimMaterial", trimMaterial);
        return out;
    }

    /**
     * 出题预览（A4）：在服务器上临时建一个铁砧菜单（不绑定方块、不打开给玩家、不调用 removed），放进两件物品的副本，
     * 有名字就设名字，读出产物和花费——算法就是原版的 {@code AnvilMenu.createResult}，不另写合并规则。
     * 玩家先设成生存模式（F6：创造模式下任何附魔都能附上去，也没有"过于昂贵"）。
     * @param right 右格；null = 空（改名题）
     * @param name  名字；null = 不改名（和真实界面一样：名字框留着原名时 AnvilScreen.onNameChanged 发的是空串）
     * @return { result: { id, count, enchantments, name } | null, cost }
     */
    public static Map<String, Object> preview(ServerPlayer player, ItemStack left, ItemStack right, String name) {
        player.setGameMode(GameType.SURVIVAL);
        AnvilMenu menu = new AnvilMenu(0, player.getInventory());
        menu.getSlot(AnvilMenu.INPUT_SLOT).set(left.copy());
        if (right != null && !right.isEmpty()) menu.getSlot(AnvilMenu.ADDITIONAL_SLOT).set(right.copy());
        menu.setItemName(name == null ? "" : name);
        menu.createResult();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("result", describe(menu.getSlot(AnvilMenu.RESULT_SLOT).getItem()));
        out.put("cost", menu.getCost());
        return out;
    }

    /** A6：物品类型、附魔（完全相同）、自定义名字（逐字相同；null = 没有自定义名字）都对上。 */
    public static boolean matches(ItemStack stack, ArenaManager.Anvil goal) {
        if (stack.isEmpty() || !BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(goal.item())) return false;
        if (!enchantments(stack).equals(new TreeMap<>(goal.enchantments()))) return false;
        String name = customName(stack);
        return goal.name() == null ? name == null : goal.name().equals(name);
    }

    /** 铁砧的状态（A7）：anvil / chipped_anvil / damaged_anvil；那一格不是铁砧 → missing。 */
    public static String state(ServerLevel level, BlockPos at) {
        BlockState state = level.getBlockState(at);
        if (!state.is(BlockTags.ANVIL)) return "missing";
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath();
    }
}
