package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.mixin.BeaconBlockEntityAccessor;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.level.block.entity.BeaconBlockEntity;

/**
 * 信标训练场（docs/信标训练场设计方案.md）的纯计算部分：底座位置、效果的所需等级、"界面能设出来"的检查（G6）、
 * 信标实际给的效果（照搬 {@code BeaconBlockEntity.applyEffects} 231–253 行，F4）。
 *
 * <p>级数一律用游戏里的写法：1 = I，2 = II（applyEffects 里的 amplifier + 1）。
 */
public final class BeaconArena {

    public static final int MAX_LEVEL = 4;

    private BeaconArena() {}

    /**
     * 底座第 1–level 层的位置（F2，{@code updateBase} 197–223 行）：第 m 层在信标下方 m 格，(2m+1)×(2m+1)。
     * 第 1 层就是场地地板的一部分（G1）。
     */
    public static List<BlockPos> basePositions(BlockPos beacon, int level) {
        List<BlockPos> out = new ArrayList<>();
        for (int m = 1; m <= level; m++) out.addAll(layer(beacon, m));
        return out;
    }

    /** 底座第 m 层的全部位置。 */
    public static List<BlockPos> layer(BlockPos beacon, int m) {
        List<BlockPos> out = new ArrayList<>();
        for (int dx = -m; dx <= m; dx++) {
            for (int dz = -m; dz <= m; dz++) out.add(beacon.offset(dx, -m, dz));
        }
        return out;
    }

    /** 效果的注册名（minecraft:speed）；null → null。 */
    public static String effectId(Holder<MobEffect> effect) {
        return effect == null ? null : effect.getRegisteredName();
    }

    /** 注册名 → 信标效果；不是 6 个信标效果之一 → 报错。 */
    public static Holder<MobEffect> effect(String id) {
        Identifier key = Identifier.tryParse(id);
        var holder = key == null ? null : BuiltInRegistries.MOB_EFFECT.get(key).orElse(null);
        if (holder == null || tierOf(holder) < 0) throw new IllegalArgumentException("not a beacon effect: " + id);
        return holder;
    }

    /** 效果在 {@code BEACON_EFFECTS} 里的组号 0–3（所需等级 = 组号 + 1）；不是信标效果 → -1。 */
    public static int tierOf(Holder<MobEffect> effect) {
        if (effect == null) return -1;
        for (int tier = 0; tier < BeaconBlockEntity.BEACON_EFFECTS.size(); tier++) {
            if (BeaconBlockEntity.BEACON_EFFECTS.get(tier).contains(effect)) return tier;
        }
        return -1;
    }

    /** 本题要求的一个效果（G3）：再生只能 I 级；II 级、再生要 4 级底座，其余要"组号 + 1"级。返回所需等级；要求不合法 → 报错。 */
    public static int requiredLevel(String id, int amplifier) {
        int tier = tierOf(effect(id));
        if (amplifier != 1 && amplifier != 2) throw new IllegalArgumentException("amplifier must be 1 or 2: " + amplifier);
        if (tier == 3 && amplifier != 1) throw new IllegalArgumentException(id + " can only be level 1");
        return amplifier == 2 || tier == 3 ? MAX_LEVEL : tier + 1;
    }

    /**
     * G6 "界面能设出来"（F1，{@code BeaconScreen.init} 74–101、183、231 行）：主效果不为空，是前 3 组之一，所需等级不超过 levels；
     * 副效果为空，或者 levels = 4 且副效果是任意一个信标效果。
     *
     * <p>副效果不限于"再生或和主效果相同"（2026-11-20 修正）：界面上先点主效果 X、再点"X II"按钮（副效果设成 X）、
     * 再把主效果改成 Y，副效果仍是 X（{@code BeaconPowerButton.onPress} 只改主效果），确认后得到 (Y, X)，信标给 Y I 和 X I。
     */
    public static boolean legal(int levels, Holder<MobEffect> primary, Holder<MobEffect> secondary) {
        int tier = tierOf(primary);
        if (tier < 0 || tier > 2 || tier >= levels) return false;
        if (secondary == null) return true;
        return levels >= MAX_LEVEL && tierOf(secondary) >= 0;
    }

    /**
     * 信标实际给的效果（F4，照搬 applyEffects）：主效果为空 → 无；levels ≥ 4 且主副相同 → 主效果 II；
     * levels ≥ 4、副效果不为空且不同于主效果 → 另加副效果 I。levels = 0 时信标不工作 → 无。
     * @return [{ effect, amplifier }]
     */
    public static List<Map<String, Object>> effective(int levels, Holder<MobEffect> primary, Holder<MobEffect> secondary) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (levels <= 0 || primary == null) return out;
        boolean upgraded = levels >= MAX_LEVEL && primary.equals(secondary);
        out.add(want(effectId(primary), upgraded ? 2 : 1));
        if (levels >= MAX_LEVEL && secondary != null && !secondary.equals(primary)) out.add(want(effectId(secondary), 1));
        return out;
    }

    private static Map<String, Object> want(String effect, int amplifier) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("effect", effect);
        out.put("amplifier", amplifier);
        return out;
    }

    /** 信标的等级和主副效果：{ levels, primary, secondary }。 */
    public static Map<String, Object> state(BeaconBlockEntity beacon) {
        BeaconBlockEntityAccessor access = (BeaconBlockEntityAccessor) beacon;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("levels", access.stevex$getLevels());
        out.put("primary", effectId(access.stevex$getPrimaryPower()));
        out.put("secondary", effectId(access.stevex$getSecondaryPower()));
        return out;
    }

    /** G7 的第 3、4 条：设置是界面能设出来的，且实际给的效果里有 wants 的每一项。 */
    public static boolean satisfies(BeaconBlockEntity beacon, List<ArenaManager.Want> wants) {
        BeaconBlockEntityAccessor access = (BeaconBlockEntityAccessor) beacon;
        int levels = access.stevex$getLevels();
        Holder<MobEffect> primary = access.stevex$getPrimaryPower();
        Holder<MobEffect> secondary = access.stevex$getSecondaryPower();
        if (!legal(levels, primary, secondary)) return false;
        List<Map<String, Object>> given = effective(levels, primary, secondary);
        for (ArenaManager.Want w : wants) {
            if (given.stream().noneMatch(g -> w.effect().equals(g.get("effect")) && Integer.valueOf(w.amplifier()).equals(g.get("amplifier")))) return false;
        }
        return true;
    }
}
