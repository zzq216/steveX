package name.modid.arena;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ProvidesTrimMaterial;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.SmithingRecipeInput;
import net.minecraft.world.item.crafting.SmithingTransformRecipe;
import net.minecraft.world.item.crafting.SmithingTrimRecipe;
import net.minecraft.world.item.equipment.trim.ArmorTrim;

/**
 * 锻造台训练场（docs/锻造台训练场设计方案.md）的计算部分：从游戏里读出全部锻造配方、可加纹饰的盔甲、纹饰材料（M2），
 * 用服务器的锻造配方预览产物（M4），读物品上的纹饰（M8），比对目标（M6）。catalog / preview 在服务器线程上调用；
 * {@link #trim}、{@link #trimMaterial} 两个读组件的方法客户端也用（{@code InventoryApi}）。
 *
 * <p>配方的结果、纹饰样式在 {@code SmithingTransformRecipe.result}、{@code SmithingTrimRecipe.pattern} 里，都是包内可见的字段；
 * 这里不加访问器，而是拿配方自己的材料实际 {@code assemble} 一次，从产物上读出来（和锻造台算产物走同一条路）。
 */
public final class SmithingArena {

    private SmithingArena() {}

    /** 物品上的纹饰：{ pattern, material }（注册名）；没有纹饰 → null。 */
    public static Map<String, Object> trim(ItemStack stack) {
        ArmorTrim trim = stack.get(DataComponents.TRIM);
        if (trim == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("pattern", trim.pattern().getRegisteredName());
        out.put("material", trim.material().getRegisteredName());
        return out;
    }

    /**
     * 这件物品能当哪种纹饰材料（{@code provides_trim_material} 组件）：注册名；不能 → null。
     * 原版物品的组件里存的是 ResourceKey（{@code Items} 里 {@code .trimMaterial(TrimMaterials.X)}），直接取 key，不需要注册表；
     * 存的是 Holder 时取它的注册名。
     */
    public static String trimMaterial(ItemStack stack) {
        ProvidesTrimMaterial provides = stack.get(DataComponents.PROVIDES_TRIM_MATERIAL);
        if (provides == null) return null;
        var key = provides.material().key();
        if (key.isPresent()) return key.get().identifier().toString();
        return provides.material().contents().left().map(h -> h.getRegisteredName()).orElse(null);
    }

    /**
     * M2：{ upgrades: [{ template, base, addition: [id…], result }], trims: [{ template, pattern }], armors: [id…], materials: [{ item, material }] }，
     * 全部按 id 排序。升级配方的底材展开成一件一条；纹饰配方的样式按"第一件可加纹饰的盔甲 + 第一种纹饰材料"assemble 读出。
     */
    public static Map<String, Object> catalog(MinecraftServer server) {
        HolderLookup.Provider registries = server.registryAccess();
        List<Map<String, Object>> upgrades = new ArrayList<>();
        List<Map<String, Object>> trims = new ArrayList<>();
        List<String> armors = sortedIds(BuiltInRegistries.ITEM.stream().filter(i -> new ItemStack(i).is(ItemTags.TRIMMABLE_ARMOR)).toList());
        List<Map<String, Object>> materials = new ArrayList<>();
        for (Item item : sortedItems(BuiltInRegistries.ITEM.stream().toList())) {
            String material = trimMaterial(new ItemStack(item));
            if (material == null) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("item", id(item));
            row.put("material", material);
            materials.add(row);
        }
        for (RecipeHolder<?> holder : server.getRecipeManager().getRecipes()) {
            if (holder.value() instanceof SmithingTransformRecipe recipe) {
                Item template = first(recipe.templateIngredient().orElse(null));
                List<Item> additions = items(recipe.additionIngredient().orElse(null));
                for (Item base : items(recipe.baseIngredient())) {
                    ItemStack out = recipe.assemble(new SmithingRecipeInput(stack(template), new ItemStack(base), stack(additions.isEmpty() ? null : additions.get(0))), registries);
                    if (out.isEmpty()) continue;
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("template", template == null ? null : id(template));
                    row.put("base", id(base));
                    row.put("addition", sortedIds(additions));
                    row.put("result", id(out.getItem()));
                    upgrades.add(row);
                }
            } else if (holder.value() instanceof SmithingTrimRecipe recipe) {
                Item template = first(recipe.templateIngredient().orElse(null));
                Item base = first(recipe.baseIngredient());
                Item addition = first(recipe.additionIngredient().orElse(null));
                if (template == null || base == null || addition == null) continue;
                Map<String, Object> trim = trim(recipe.assemble(new SmithingRecipeInput(new ItemStack(template), new ItemStack(base), new ItemStack(addition)), registries));
                if (trim == null) continue;
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("template", id(template));
                row.put("pattern", trim.get("pattern"));
                trims.add(row);
            }
        }
        upgrades.sort(Comparator.comparing(r -> (String) r.get("base")));
        trims.sort(Comparator.comparing(r -> (String) r.get("template")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("upgrades", upgrades);
        out.put("trims", trims);
        out.put("armors", armors);
        out.put("materials", materials);
        return out;
    }

    /**
     * M4：三件物品各 1 个，交给服务器的配方管理器找锻造配方（和 {@code SmithingMenu.createResult} 同一条路），有配方就 assemble。
     * @return { result: { id, trim } | null }
     */
    public static Map<String, Object> preview(MinecraftServer server, Item template, Item base, Item addition) {
        SmithingRecipeInput input = new SmithingRecipeInput(stack(template), stack(base), stack(addition));
        ItemStack result = server.getRecipeManager().getRecipeFor(RecipeType.SMITHING, input, server.overworld())
                .map(h -> h.value().assemble(input, server.registryAccess()))
                .orElse(ItemStack.EMPTY);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("result", describe(result));
        return out;
    }

    /** 一件物品的摘要：{ id, count, trim }；空 → null。 */
    public static Map<String, Object> describe(ItemStack stack) {
        if (stack == null || stack.isEmpty()) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id(stack.getItem()));
        out.put("count", stack.getCount());
        out.put("trim", trim(stack));
        return out;
    }

    /** M6：物品 id 相同，纹饰相同（目标没有纹饰时，物品也不能有）。 */
    public static boolean matches(ItemStack stack, ArenaManager.Smith goal) {
        if (stack.isEmpty() || !id(stack.getItem()).equals(goal.item())) return false;
        Map<String, Object> trim = trim(stack);
        if (goal.pattern() == null) return trim == null;
        return trim != null && Objects.equals(trim.get("pattern"), goal.pattern()) && Objects.equals(trim.get("material"), goal.material());
    }

    /** M6：goals 里的每一项都配到 stacks 里各不相同的一件（回溯；最多 4 个目标、41 格）。 */
    public static boolean assign(List<ItemStack> stacks, List<ArenaManager.Smith> goals) {
        return assign(stacks, goals, 0, new boolean[stacks.size()]);
    }

    private static boolean assign(List<ItemStack> stacks, List<ArenaManager.Smith> goals, int g, boolean[] used) {
        if (g == goals.size()) return true;
        for (int i = 0; i < stacks.size(); i++) {
            if (used[i] || !matches(stacks.get(i), goals.get(g))) continue;
            used[i] = true;
            if (assign(stacks, goals, g + 1, used)) return true;
            used[i] = false;
        }
        return false;
    }

    private static ItemStack stack(Item item) {
        return item == null ? ItemStack.EMPTY : new ItemStack(item);
    }

    private static List<Item> items(Ingredient ingredient) {
        if (ingredient == null) return List.of();
        return sortedItems(ingredient.items().map(h -> h.value()).toList());
    }

    private static Item first(Ingredient ingredient) {
        List<Item> list = items(ingredient);
        return list.isEmpty() ? null : list.get(0);
    }

    private static List<Item> sortedItems(List<Item> items) {
        List<Item> out = new ArrayList<>(items);
        out.sort(Comparator.comparing(SmithingArena::id));
        return out;
    }

    private static List<String> sortedIds(List<Item> items) {
        return sortedItems(items).stream().map(SmithingArena::id).toList();
    }

    private static String id(Item item) {
        return BuiltInRegistries.ITEM.getKey(item).toString();
    }
}
