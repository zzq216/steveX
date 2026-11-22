package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import name.modid.mixin.BrewingStandAccessor;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.alchemy.Potion;
import net.minecraft.world.item.alchemy.PotionBrewing;
import net.minecraft.world.item.alchemy.PotionContents;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import net.minecraft.world.phys.AABB;

/**
 * 酿造台训练场（docs/酿造台训练场设计方案.md）的计算部分：药水签名（P7）、发药水（P8）、配方核对（P8）、酿造台状态、到达检测（P8）。
 *
 * <p>签名：带药水内容的物品是 {@code 瓶子 id#药水注册名}（如 {@code minecraft:splash_potion#minecraft:awkward}），其他物品就是 id。
 * 同一种瓶子的药水 id 相同（F2），只按 id 数会混在一起。
 */
public final class BrewArena {

    private BrewArena() {}

    /** 酿造台的格子（F1）：0–2 药水格，3 材料格，4 燃料格 */
    public static final int INGREDIENT_SLOT = 3;
    public static final int FUEL_SLOT = 4;

    /**
     * P8 的到达目标：物品栏里 fuel 恰好 fuelLeft 个、ingredient 恰好 ingredientLeft 个、potion（签名）恰好 potionLeft 瓶，没有别的东西；
     * 药水格里恰好 placed 瓶，每瓶是 potion 或 products 之一；products 是插件按 brewing.json 算的产物签名（prepare 时和服务器核对）。
     */
    public record Spec(String fuel, int fuelLeft, String ingredient, int ingredientLeft, String potion, int potionLeft, int placed, Set<String> products) {}

    /** 一叠物品的签名（见类注释）。 */
    public static String signature(ItemStack stack) {
        String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        PotionContents contents = stack.get(DataComponents.POTION_CONTENTS);
        if (contents == null) return id;
        Optional<Holder<Potion>> potion = contents.potion();
        return potion.map(p -> id + "#" + p.getRegisteredName()).orElse(id);
    }

    /** 签名 → 一个物品：{@code 瓶子 id#药水注册名} 做出这瓶药水，其余按 id。认不出 → 报错。 */
    public static ItemStack stackOf(String signature) {
        int hash = signature.indexOf('#');
        Item item = item(hash < 0 ? signature : signature.substring(0, hash));
        if (hash < 0) return new ItemStack(item);
        return PotionContents.createItemStack(item, potion(signature.substring(hash + 1)));
    }

    /** P8：items[].potion 发的药水（count 必须是 1，药水一个一叠）。 */
    public static ItemStack potionStack(String itemId, String potionId) {
        return PotionContents.createItemStack(item(itemId), potion(potionId));
    }

    private static Item item(String id) {
        Identifier key = Identifier.tryParse(id);
        if (key == null || !BuiltInRegistries.ITEM.containsKey(key)) throw new IllegalArgumentException("unknown item: " + id);
        return BuiltInRegistries.ITEM.getValue(key);
    }

    private static Holder<Potion> potion(String id) {
        Identifier key = Identifier.tryParse(id);
        Optional<? extends Holder<Potion>> holder = key == null ? Optional.empty() : BuiltInRegistries.POTION.get(key);
        if (holder.isEmpty()) throw new IllegalArgumentException("unknown potion: " + id);
        return holder.get();
    }

    /** 容器（玩家物品栏）按签名汇总。 */
    public static Map<String, Integer> counts(Container container) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (int i = 0; i < container.getContainerSize(); i++) add(out, container.getItem(i));
        return out;
    }

    /** 光标上的物品按签名：空 → {}。 */
    public static Map<String, Integer> carried(AbstractContainerMenu menu) {
        Map<String, Integer> out = new LinkedHashMap<>();
        add(out, menu.getCarried());
        return out;
    }

    /** 场内地上的掉落物按签名汇总。 */
    public static Map<String, Integer> dropped(ServerLevel level, AABB box) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) add(out, e.getItem());
        return out;
    }

    private static void add(Map<String, Integer> out, ItemStack stack) {
        if (!stack.isEmpty()) out.merge(signature(stack), stack.getCount(), Integer::sum);
    }

    private static Map<String, Integer> slot(Container container, int i) {
        Map<String, Integer> out = new LinkedHashMap<>();
        add(out, container.getItem(i));
        return out;
    }

    /**
     * 酿造台的状态（P8 的 status）：{ potions: [签名 | null ×3], ingredient: {签名: n}, fuel: {签名: n}, fuelCharges, brewTicks }。
     * fuelCharges 是剩余可酿造次数（燃料值，0–20），brewTicks 是剩余酿造 tick（0 = 没在酿）。
     */
    public static Map<String, Object> stand(BrewingStandBlockEntity stand) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<String> potions = new ArrayList<>();
        for (int i = 0; i < 3; i++) potions.add(stand.getItem(i).isEmpty() ? null : signature(stand.getItem(i)));
        out.put("potions", potions);
        out.put("ingredient", slot(stand, INGREDIENT_SLOT));
        out.put("fuel", slot(stand, FUEL_SLOT));
        out.put("fuelCharges", ((BrewingStandAccessor) stand).stevex$getFuel());
        out.put("brewTicks", ((BrewingStandAccessor) stand).stevex$getBrewTime());
        return out;
    }

    /**
     * P8 prepare 时核对：potion 签名的药水和 ingredient 在服务器的酿造配方里确实能酿（hasMix），产物（mix）在 products 里。
     * 不对 → 报错（插件提示数据过期）。返回服务器算出的产物签名。
     */
    public static String check(PotionBrewing brewing, Spec spec) {
        ItemStack potion = stackOf(spec.potion());
        ItemStack ingredient = stackOf(spec.ingredient());
        if (!brewing.isIngredient(ingredient)) throw new IllegalArgumentException("brewing data out of date: " + spec.ingredient() + " is not a brewing ingredient on this server");
        if (!brewing.hasMix(potion, ingredient)) throw new IllegalArgumentException("brewing data out of date: " + spec.potion() + " + " + spec.ingredient() + " has no brewing mix on this server");
        String product = signature(brewing.mix(ingredient, potion));
        if (!spec.products().contains(product)) throw new IllegalArgumentException("brewing data out of date: " + spec.potion() + " + " + spec.ingredient() + " brews " + product + " on this server, expected " + spec.products());
        if (spec.placed() < 1 || spec.placed() > 3) throw new IllegalArgumentException("expect.brew.placed must be within 1-3: " + spec.placed());
        if (spec.fuelLeft() < 0 || spec.ingredientLeft() < 0 || spec.potionLeft() < 0) throw new IllegalArgumentException("expect.brew: counts left must be >= 0");
        return product;
    }

    /**
     * P8 到达（界面关闭、光标为空由调用方检查）：
     * 物品栏恰好是 { fuel: fuelLeft, ingredient: ingredientLeft, potion: potionLeft }（0 的不出现），没有别的东西；
     * 燃料格空或只有 fuel；材料格空、只有 ingredient 或只有它的剩余物（龙息的玻璃瓶，F5）；药水格恰好 placed 瓶，每瓶是 potion 或 products 之一。
     */
    public static boolean reached(Map<String, Integer> held, BrewingStandBlockEntity stand, Spec spec) {
        Map<String, Integer> want = new LinkedHashMap<>();
        if (spec.fuelLeft() > 0) want.merge(spec.fuel(), spec.fuelLeft(), Integer::sum);
        if (spec.ingredientLeft() > 0) want.merge(spec.ingredient(), spec.ingredientLeft(), Integer::sum);
        if (spec.potionLeft() > 0) want.merge(spec.potion(), spec.potionLeft(), Integer::sum);
        if (!held.equals(want)) return false;
        ItemStack fuel = stand.getItem(FUEL_SLOT);
        if (!fuel.isEmpty() && !signature(fuel).equals(spec.fuel())) return false;
        ItemStack ingredient = stand.getItem(INGREDIENT_SLOT);
        if (!ingredient.isEmpty() && !signature(ingredient).equals(spec.ingredient()) && !signature(ingredient).equals(remainder(spec.ingredient()))) return false;
        int potions = 0;
        for (int i = 0; i < 3; i++) {
            ItemStack p = stand.getItem(i);
            if (p.isEmpty()) continue;
            String sig = signature(p);
            if (!sig.equals(spec.potion()) && !spec.products().contains(sig)) return false;
            potions++;
        }
        return potions == spec.placed();
    }

    /** 材料用掉后的剩余物（龙息 → 玻璃瓶）；没有 → null */
    public static String remainder(String ingredient) {
        ItemStack rest = stackOf(ingredient).getItem().getCraftingRemainder();
        return rest.isEmpty() ? null : signature(rest);
    }
}
