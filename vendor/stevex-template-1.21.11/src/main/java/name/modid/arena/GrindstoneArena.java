package name.modid.arena;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.GrindstoneMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.AttachFace;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.phys.AABB;

/**
 * 砂轮训练场（docs/砂轮训练场设计方案.md）的计算部分：用原版砂轮菜单核对目标（K8）、物品签名（K7）、到达检测、砂轮格子。
 * 全部在服务器线程上调用（同 {@link ArenaManager}）。
 *
 * <p>签名 = id + 附魔（附魔书读存储的附魔，{@link AnvilArena#enchantments}）+ 损坏值 + 自定义名字；不看 repair_cost（K7）。
 */
public final class GrindstoneArena {

    /** 一件目标：物品 id、附魔 { 注册名: 级数 }、损坏值（K7；目标没有自定义名字）。 */
    public record Goal(String id, Map<String, Integer> enchantments, int damage) {}

    /** expect.grindstone：本轮每件物品磨完后的样子，顺序和 items 一致。 */
    public record Spec(List<Goal> goals) {}

    /** 砂轮的格子（GrindstoneMenu 46–79 行，F1）：0、1 是输入格，2 是产物格 */
    public static final int INPUT_0 = 0;
    public static final int INPUT_1 = 1;
    public static final int RESULT = 2;

    private GrindstoneArena() {}

    /** 工作站的方块状态（K1）：落地、朝东。默认状态是挂墙的（GrindstoneBlock 42 行，F9）。 */
    public static BlockState stationState() {
        return Blocks.GRINDSTONE.defaultBlockState()
                .setValue(BlockStateProperties.ATTACH_FACE, AttachFace.FLOOR)
                .setValue(BlockStateProperties.HORIZONTAL_FACING, Direction.EAST);
    }

    /** 物品签名的几项（K7）：{ id, count, enchantments, name, damage? }；空 → null。damage 只有有耐久的物品才有。 */
    public static Map<String, Object> describe(ItemStack stack) {
        Map<String, Object> out = AnvilArena.describe(stack);
        if (out == null) return null;
        if (stack.isDamageableItem()) out.put("damage", stack.getDamageValue());
        return out;
    }

    /** 签名字符串（K7）：id | 附魔（按注册名排序）| 损坏值 | 自定义名字。 */
    public static String signature(ItemStack stack) {
        return key(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), AnvilArena.enchantments(stack), stack.getDamageValue(), AnvilArena.customName(stack));
    }

    public static String signature(Goal goal) {
        return key(goal.id(), new TreeMap<>(goal.enchantments()), goal.damage(), null);
    }

    private static String key(String id, Map<String, Integer> enchantments, int damage, String name) {
        return id + "|" + new TreeMap<>(enchantments) + "|" + damage + "|" + (name == null ? "" : name);
    }

    /**
     * K8：每件发放的物品单独放进一个临时砂轮菜单（不绑定方块、不打开给玩家），读出产物格——就是原版的 computeResult，不另写规则；
     * 和插件给的目标比签名，对不上就报错。临时菜单不调用 onTake，不会生成经验球（F6）。
     * @param stacks 本轮发放的物品，顺序和 spec.goals 一致
     */
    public static void check(ServerPlayer player, List<ItemStack> stacks, Spec spec) {
        if (spec.goals().isEmpty()) throw new IllegalArgumentException("expect.grindstone.goals is empty");
        if (stacks.size() != spec.goals().size()) {
            throw new IllegalArgumentException("expect.grindstone.goals has " + spec.goals().size() + " entries, items has " + stacks.size());
        }
        for (int i = 0; i < stacks.size(); i++) {
            ItemStack given = stacks.get(i);
            if (given.getCount() != 1) throw new IllegalArgumentException("grindstone items must have count 1: " + BuiltInRegistries.ITEM.getKey(given.getItem()));
            GrindstoneMenu menu = new GrindstoneMenu(0, player.getInventory());
            menu.getSlot(INPUT_0).set(given.copy());
            ItemStack result = menu.getSlot(RESULT).getItem();
            String want = signature(spec.goals().get(i));
            String got = result.isEmpty() ? "(no result)" : signature(result);
            if (!want.equals(got)) {
                throw new IllegalArgumentException("grindstone data out of date: item " + i + " (" + signature(given) + ") grinds to " + got + ", expected " + want);
            }
        }
    }

    /** 按签名计数（数量相加）。 */
    private static Map<String, Integer> counts(Iterable<ItemStack> stacks) {
        Map<String, Integer> out = new HashMap<>();
        for (ItemStack s : stacks) if (!s.isEmpty()) out.merge(signature(s), s.getCount(), Integer::sum);
        return out;
    }

    /** K7（光标为空由调用方检查）：玩家身上（主物品栏、快捷栏、盔甲、副手）按签名计数恰好等于全部目标，没有别的东西。不要求关界面。 */
    public static boolean reached(Inventory inv, Spec spec) {
        List<ItemStack> stacks = new ArrayList<>();
        for (int i = 0; i < inv.getContainerSize(); i++) stacks.add(inv.getItem(i));
        Map<String, Integer> want = new HashMap<>();
        for (Goal g : spec.goals()) want.merge(signature(g), 1, Integer::sum);
        return counts(stacks).equals(want);
    }

    /** 当前界面是砂轮时两个输入格：{ input0, input1 }（各是物品摘要或 null）；不是砂轮界面 → null。 */
    public static Map<String, Object> slots(AbstractContainerMenu menu) {
        if (!(menu instanceof GrindstoneMenu gm)) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("input0", describe(gm.getSlot(INPUT_0).getItem()));
        out.put("input1", describe(gm.getSlot(INPUT_1).getItem()));
        return out;
    }

    /** 玩家身上（不含光标）的每一件物品：[{ slot, id, count, enchantments, name, damage? }]。 */
    public static List<Map<String, Object>> items(Inventory inv) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            Map<String, Object> d = describe(inv.getItem(i));
            if (d == null) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("slot", i);
            row.putAll(d);
            out.add(row);
        }
        return out;
    }

    /** 场内地上的每一件物品（各带签名的几项）。 */
    public static List<Map<String, Object>> dropped(ServerLevel level, AABB box) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) {
            Map<String, Object> d = describe(e.getItem());
            if (d != null) out.add(d);
        }
        return out;
    }

    /** 工作站还在（K1）：那一格是砂轮方块，落地、挂墙都算。 */
    public static boolean intact(ServerLevel level, BlockPos at) {
        return level.getBlockState(at).is(Blocks.GRINDSTONE);
    }
}
