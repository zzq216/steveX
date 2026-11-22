package name.modid.arena;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.CartographyTableMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.MapItem;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.saveddata.maps.MapId;
import net.minecraft.world.level.saveddata.maps.MapItemSavedData;
import net.minecraft.world.phys.AABB;

/**
 * 制图台训练场（docs/制图台训练场设计方案.md）的计算部分：开局地图（K6）、地图签名（K9）、到达检测（K9）。
 *
 * <p>签名：没有地图编号的物品就是 id；由开局地图做出来的地图是 {@code minecraft:filled_map#scale=N}，锁定的加 {@code ,locked}；
 * 其他地图（中心对不上、不在主世界、没有地图数据）是 {@code minecraft:filled_map#foreign}。
 * "由开局地图做出来"按中心判断（F5）：放大的中心由上一级的中心推出，锁定、复制不改中心；开局地图建在离场地很远的地方，
 * 场地里右键空地图新做的地图（F6）中心对不上。不比较编号：复制同编号，放大、锁定换新编号，分开锁定的两张编号也不同（F13）。
 */
public final class CartographyArena {

    private CartographyArena() {}

    public static final String FILLED_MAP = "minecraft:filled_map";
    public static final String FOREIGN = FILLED_MAP + "#foreign";
    public static final int MAX_SCALE = 4;
    /** K6：开局地图的建图坐标在 (ox + 8192, oz)。缩放等级 4 的一格是 2048 方块，隔了 4 格。 */
    public static final int SOURCE_OFFSET = 8192;

    /** 本轮的一个目标：缩放等级 scale、是否锁定 locked 的地图要 count 张。 */
    public record Goal(int scale, boolean locked, int count) {
        public String key() {
            return CartographyArena.key(scale, locked);
        }
    }

    /** K9 的到达目标：goals 是全部目标；allowed 是开局发的全部物品 id（已绘制地图、纸、玻璃板、空地图）。 */
    public record Spec(List<Goal> goals, Set<String> allowed) {}

    /** 开局地图：编号、缩放等级、各级的中心（下标是缩放等级；低于开局等级的不用）。 */
    public record Source(int mapId, int scale, int[] centerX, int[] centerZ) {
        public Map<String, Object> describe() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", mapId);
            out.put("scale", scale);
            out.put("center", List.of(centerX[scale], centerZ[scale]));
            return out;
        }
    }

    public static String key(int scale, boolean locked) {
        return FILLED_MAP + "#scale=" + scale + (locked ? ",locked" : "");
    }

    /** K6：在主世界现做一张缩放等级 scale 的空白地图（不追踪玩家），并推出它各级的中心。 */
    public static Map.Entry<ItemStack, Source> create(ServerLevel level, BlockPos origin, int scale) {
        if (scale < 0 || scale > MAX_SCALE) throw new IllegalArgumentException("map.scale must be within 0-" + MAX_SCALE + ": " + scale);
        ItemStack stack = MapItem.create(level, origin.getX() + SOURCE_OFFSET, origin.getZ(), (byte) scale, false, false);
        MapItemSavedData data = MapItem.getSavedData(stack, level);
        MapId id = stack.get(DataComponents.MAP_ID);
        if (data == null || id == null) throw new IllegalStateException("could not create the source map");
        int[] cx = new int[MAX_SCALE + 1];
        int[] cz = new int[MAX_SCALE + 1];
        cx[scale] = data.centerX;
        cz[scale] = data.centerZ;
        for (int s = scale; s < MAX_SCALE; s++) {
            // 与 MapItemSavedData.scaled() 相同：createFresh(上一级中心, 缩放等级 + 1)
            MapItemSavedData next = MapItemSavedData.createFresh(cx[s], cz[s], (byte) (s + 1), false, false, Level.OVERWORLD);
            cx[s + 1] = next.centerX;
            cz[s + 1] = next.centerZ;
        }
        return Map.entry(stack, new Source(id.id(), scale, cx, cz));
    }

    /** 一叠物品的签名（见类注释）。source 为 null 时所有地图都是 foreign。 */
    public static String signature(ItemStack stack, Level level, Source source) {
        String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        if (!stack.has(DataComponents.MAP_ID)) return id;
        MapItemSavedData data = MapItem.getSavedData(stack, level);
        if (data == null || source == null || data.dimension != Level.OVERWORLD) return FOREIGN;
        int s = data.scale;
        if (s < source.scale() || s > MAX_SCALE || data.centerX != source.centerX()[s] || data.centerZ != source.centerZ()[s]) return FOREIGN;
        return key(s, data.locked);
    }

    /** 容器（玩家物品栏）按签名汇总。 */
    public static Map<String, Integer> counts(Container container, Level level, Source source) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (int i = 0; i < container.getContainerSize(); i++) add(out, container.getItem(i), level, source);
        return out;
    }

    /** 光标上的物品按签名：空 → {}。 */
    public static Map<String, Integer> carried(AbstractContainerMenu menu, Level level, Source source) {
        Map<String, Integer> out = new LinkedHashMap<>();
        add(out, menu.getCarried(), level, source);
        return out;
    }

    /** 当前界面是制图台时 0、1 两格按签名汇总；不是制图台界面 → {}（F10：关界面时会退回物品栏，结果格只是预览）。 */
    public static Map<String, Integer> input(AbstractContainerMenu menu, Level level, Source source) {
        Map<String, Integer> out = new LinkedHashMap<>();
        if (!(menu instanceof CartographyTableMenu table)) return out;
        add(out, table.getSlot(0).getItem(), level, source);
        add(out, table.getSlot(1).getItem(), level, source);
        return out;
    }

    /** 场内地上的掉落物按签名汇总。 */
    public static Map<String, Integer> dropped(ServerLevel level, AABB box, Source source) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) add(out, e.getItem(), level, source);
        return out;
    }

    private static void add(Map<String, Integer> out, ItemStack stack, Level level, Source source) {
        if (!stack.isEmpty()) out.merge(signature(stack, level, source), stack.getCount(), Integer::sum);
    }

    /**
     * K9 到达（光标为空由调用方检查）：每个目标在物品栏里恰好是 count 张、在输入格里没有；
     * 物品栏和输入格里没有目标以外的地图签名（含 foreign），也没有 allowed 以外的 id。剩多少纸、玻璃板、空地图不比较。
     */
    public static boolean reached(Map<String, Integer> held, Map<String, Integer> input, Spec spec) {
        Set<String> goals = new HashSet<>();
        for (Goal g : spec.goals()) {
            goals.add(g.key());
            if (held.getOrDefault(g.key(), 0) != g.count() || input.containsKey(g.key())) return false;
        }
        Set<String> seen = new HashSet<>(held.keySet());
        seen.addAll(input.keySet());
        for (String key : seen) {
            if (goals.contains(key)) continue;
            if (key.contains("#") || !spec.allowed().contains(key)) return false;
        }
        return true;
    }

    /** prepare 时核对目标：非空、缩放等级 0–4、数量 ≥ 1、allowed 里有已绘制地图。不对 → 报错。 */
    public static void check(Spec spec) {
        if (spec.goals().isEmpty()) throw new IllegalArgumentException("expect.cartography.goals is empty");
        for (Goal g : spec.goals()) {
            if (g.scale() < 0 || g.scale() > MAX_SCALE) throw new IllegalArgumentException("expect.cartography: scale must be within 0-" + MAX_SCALE + ": " + g.scale());
            if (g.count() < 1) throw new IllegalArgumentException("expect.cartography: count must be >= 1: " + g.count());
        }
        if (!spec.allowed().contains(FILLED_MAP)) throw new IllegalArgumentException("expect.cartography.allowed must include " + FILLED_MAP);
    }
}
