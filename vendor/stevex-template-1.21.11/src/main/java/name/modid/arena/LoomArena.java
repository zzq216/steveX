package name.modid.arena;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BannerPatternTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.Container;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.LoomMenu;
import net.minecraft.world.item.BannerItem;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.DyeItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BannerPattern;
import net.minecraft.world.level.block.entity.BannerPatternLayers;
import net.minecraft.world.phys.AABB;

/**
 * 织布机训练场（docs/织布机训练场设计方案.md）的计算部分：物品的计数签名（L9）、目录（L11）、到达检测（L9）。
 *
 * <p>签名：没有图案层的物品就是 id；带图案的旗帜是 {@code id#图案/颜色}，多层用 {@code +} 连接
 * （如 {@code minecraft:white_banner#minecraft:stripe_bottom/red}）。带图案的旗帜和素旗 id 相同（F3），只按 id 数会混在一起。
 */
public final class LoomArena {

    private LoomArena() {}

    /**
     * 本轮的一个目标：底色旗帜 banner 加一层 pattern（图案注册名）+ color（颜色名），要 count 面。
     */
    public record Goal(String banner, String pattern, String color, int count) {
        public String key() {
            return banner + "#" + pattern + "/" + color;
        }
    }

    /** L9 的到达目标：goals 是全部目标；allowed 是开局发的全部物品 id（素旗、染料、图案物）。 */
    public record Spec(List<Goal> goals, Set<String> allowed) {}

    /** 一叠物品的计数签名（见类注释）。 */
    public static String signature(ItemStack stack) {
        String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        BannerPatternLayers layers = stack.get(DataComponents.BANNER_PATTERNS);
        if (layers == null || layers.layers().isEmpty()) return id;
        StringBuilder out = new StringBuilder(id).append('#');
        for (int i = 0; i < layers.layers().size(); i++) {
            BannerPatternLayers.Layer layer = layers.layers().get(i);
            if (i > 0) out.append('+');
            out.append(layer.pattern().getRegisteredName()).append('/').append(layer.color().getName());
        }
        return out.toString();
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

    /** 当前界面是织布机时三个输入格（旗帜、染料、图案物）按签名汇总；不是织布机界面 → {}（F8：关界面时会退回物品栏）。 */
    public static Map<String, Integer> input(AbstractContainerMenu menu) {
        Map<String, Integer> out = new LinkedHashMap<>();
        if (!(menu instanceof LoomMenu loom)) return out;
        add(out, loom.getBannerSlot().getItem());
        add(out, loom.getDyeSlot().getItem());
        add(out, loom.getPatternSlot().getItem());
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

    /**
     * L9 到达（光标为空由调用方检查）：每个目标在物品栏里恰好是 count 面、在输入格里没有；
     * 物品栏和输入格里没有 allowed 以外的 id，也没有目标以外的带图案旗帜。剩多少素旗、染料不比较。
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

    /** prepare 时核对目标：底色是旗帜、图案存在、颜色是染料颜色、数量 ≥ 1，素旗在 allowed 里。不对 → 报错。 */
    public static void check(MinecraftServer server, Spec spec) {
        if (spec.goals().isEmpty()) throw new IllegalArgumentException("expect.loom.goals is empty");
        var patterns = server.registryAccess().lookupOrThrow(Registries.BANNER_PATTERN);
        for (Goal g : spec.goals()) {
            Identifier banner = Identifier.tryParse(g.banner());
            if (banner == null || !BuiltInRegistries.ITEM.containsKey(banner) || !(BuiltInRegistries.ITEM.getValue(banner) instanceof BannerItem)) {
                throw new IllegalArgumentException("expect.loom: not a banner: " + g.banner());
            }
            Identifier pattern = Identifier.tryParse(g.pattern());
            if (pattern == null || patterns.get(ResourceKey.create(Registries.BANNER_PATTERN, pattern)).isEmpty()) {
                throw new IllegalArgumentException("expect.loom: unknown banner pattern: " + g.pattern());
            }
            if (DyeColor.byName(g.color(), null) == null) throw new IllegalArgumentException("expect.loom: unknown color: " + g.color());
            if (g.count() < 1) throw new IllegalArgumentException("expect.loom: count must be >= 1: " + g.count());
            if (!spec.allowed().contains(g.banner())) throw new IllegalArgumentException("expect.loom.allowed must include the banner " + g.banner());
        }
    }

    /**
     * L11：{ banners: [{ id, color }], dyes: [{ id, color }], patterns: [图案注册名…]（按 no_item_required 标签的顺序，F2），
     * patternItems: [{ item, patterns: [图案注册名…] }] }。旗帜、染料、图案物按 id 排序。
     */
    public static Map<String, Object> catalog(MinecraftServer server) {
        HolderLookup.RegistryLookup<BannerPattern> lookup = server.registryAccess().lookupOrThrow(Registries.BANNER_PATTERN);
        List<Map<String, Object>> banners = new ArrayList<>();
        List<Map<String, Object>> dyes = new ArrayList<>();
        List<Map<String, Object>> patternItems = new ArrayList<>();
        List<Item> items = BuiltInRegistries.ITEM.stream().sorted(Comparator.comparing(LoomArena::id)).toList();
        for (Item item : items) {
            if (item instanceof BannerItem banner) banners.add(row("id", id(item), "color", banner.getColor().getName()));
            if (item instanceof DyeItem dye) dyes.add(row("id", id(item), "color", dye.getDyeColor().getName()));
            TagKey<BannerPattern> provides = new ItemStack(item).get(DataComponents.PROVIDES_BANNER_PATTERNS);
            if (provides != null) patternItems.add(row("item", id(item), "patterns", patternNames(lookup, provides)));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("banners", banners);
        out.put("dyes", dyes);
        out.put("patterns", patternNames(lookup, BannerPatternTags.NO_ITEM_REQUIRED));
        out.put("patternItems", patternItems);
        return out;
    }

    private static List<String> patternNames(HolderLookup.RegistryLookup<BannerPattern> lookup, TagKey<BannerPattern> tag) {
        List<String> out = new ArrayList<>();
        lookup.get(tag).ifPresent(set -> {
            for (Holder<BannerPattern> h : set) out.add(h.getRegisteredName());
        });
        return out;
    }

    private static Map<String, Object> row(String k1, Object v1, String k2, Object v2) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(k1, v1);
        out.put(k2, v2);
        return out;
    }

    private static String id(Item item) {
        return BuiltInRegistries.ITEM.getKey(item).toString();
    }
}
