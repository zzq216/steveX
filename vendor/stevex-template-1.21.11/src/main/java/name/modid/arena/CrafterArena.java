package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.CraftingInput;
import net.minecraft.world.level.block.CrafterBlock;
import net.minecraft.world.level.block.entity.CrafterBlockEntity;

/**
 * 合成器训练场（docs/合成器训练场设计方案.md）的计算部分：配方核对（R8）、合成器状态（R8 的 status）、到达检测（R7）。
 *
 * <p>产物一律用合成器预览产物的同一个方法算（{@code CrafterBlock.getPotentialResults} + {@code assemble}，C1），
 * 所以平移、镜像后的摆法和无序配方的任意摆法都按原版认（R2）。材料都是不带组件的普通物品，按 id 计数（R5）。
 */
public final class CrafterArena {

    private CrafterArena() {}

    public static final int GRID = 9;

    /**
     * R7 的到达目标：合成器预览出 target；每个非空格正好 portions 个；空格全部禁用；
     * 物品栏恰好是 held（0 的不出现），没有别的东西。layout 是 prepare 核对用的规范摆法（9 个，物品 id 或 null，R8）。
     */
    public record Spec(String target, int portions, Map<String, Integer> held, List<String> layout) {}

    private static String id(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static ItemStack stackOf(String id) {
        Identifier key = Identifier.tryParse(id);
        if (key == null || !BuiltInRegistries.ITEM.containsKey(key)) throw new IllegalArgumentException("unknown item: " + id);
        return new ItemStack(BuiltInRegistries.ITEM.getValue(key));
    }

    /** 这 9 格（按 3×3 排）在服务器上会合成出什么：物品 id；没有配方 → null。 */
    public static String product(ServerLevel level, CraftingInput input) {
        return CrafterBlock.getPotentialResults(level, input)
                .map(holder -> holder.value().assemble(input, level.registryAccess()))
                .filter(stack -> !stack.isEmpty())
                .map(CrafterArena::id)
                .orElse(null);
    }

    /**
     * R8 prepare 时核对：规范摆法在服务器上合成出 target；其余参数合法。不对 → 报错（插件提示数据过期或配方冲突）。
     * 返回服务器算出的产物 id。
     */
    public static String check(ServerLevel level, Spec spec) {
        if (spec.portions() < 1 || spec.portions() > 64) throw new IllegalArgumentException("expect.crafter.portions must be within 1-64: " + spec.portions());
        if (spec.layout().size() != GRID) throw new IllegalArgumentException("expect.crafter.layout must have 9 entries, got " + spec.layout().size());
        for (Map.Entry<String, Integer> e : spec.held().entrySet()) {
            if (e.getValue() < 1) throw new IllegalArgumentException("expect.crafter.held counts must be >= 1 (leave out items with none left): " + e.getKey());
            stackOf(e.getKey());
        }
        stackOf(spec.target());
        List<ItemStack> items = new ArrayList<>();
        for (String id : spec.layout()) items.add(id == null ? ItemStack.EMPTY : stackOf(id));
        String product = product(level, CraftingInput.of(3, 3, items));
        if (!spec.target().equals(product)) throw new IllegalArgumentException("crafting data out of date or conflicting recipe: layout " + spec.layout() + " crafts " + product + " on this server, expected " + spec.target());
        return product;
    }

    /** 合成器的状态（R8 的 status）：{ grid: [{ id, count } | null ×9], disabled: [格号…], result: id | null, powered }。 */
    public static Map<String, Object> state(ServerLevel level, CrafterBlockEntity crafter) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> grid = new ArrayList<>();
        List<Integer> disabled = new ArrayList<>();
        for (int i = 0; i < GRID; i++) {
            ItemStack stack = crafter.getItem(i);
            if (stack.isEmpty()) {
                grid.add(null);
            } else {
                Map<String, Object> cell = new LinkedHashMap<>();
                cell.put("id", id(stack));
                cell.put("count", stack.getCount());
                grid.add(cell);
            }
            if (crafter.isSlotDisabled(i)) disabled.add(i);
        }
        out.put("grid", grid);
        out.put("disabled", disabled);
        out.put("result", product(level, crafter.asCraftInput()));
        out.put("powered", crafter.getBlockState().hasProperty(CrafterBlock.TRIGGERED) && crafter.getBlockState().getValue(CrafterBlock.TRIGGERED));
        return out;
    }

    /**
     * R7 到达（界面关闭、光标为空由调用方检查）：物品栏恰好是 held，没有别的东西；
     * 每个非空格正好 portions 个；每个空格都已禁用；合成器预览出 target。
     */
    public static boolean reached(ServerLevel level, Map<String, Integer> held, CrafterBlockEntity crafter, Spec spec) {
        if (!held.equals(spec.held())) return false;
        for (int i = 0; i < GRID; i++) {
            ItemStack stack = crafter.getItem(i);
            if (stack.isEmpty() ? !crafter.isSlotDisabled(i) : stack.getCount() != spec.portions()) return false;
        }
        return spec.target().equals(product(level, crafter.asCraftInput()));
    }
}
