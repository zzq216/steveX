package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.StringUtil;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StandingSignBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.state.BlockState;

/**
 * 告示牌训练场（docs/告示牌训练场设计方案.md）的计算部分：工作站的方块状态（Q1）、写开局内容（Q4）、读告示牌（Q11）、到达检测（Q8）。
 * 全部在服务器线程上调用（同 {@link ArenaManager}）。
 *
 * <p>文字一律读原文（{@code getMessage(i, false)}，单人世界不开文字过滤）。行宽（90 像素）要用客户端字体量，
 * 由 {@code ArenaApi} 在客户端线程上查（Q7），这里只查字符。
 */
public final class SignArena {

    public static final int LINES = 4;

    /** prepare 的 sign：开局正面 4 行和颜色（Q4）。不发光、不涂蜡、背面空着。 */
    public record Setup(List<String> lines, String color) {}

    /** expect.sign：正面 4 行、颜色、是否涂蜡（Q8）。发光不判。 */
    public record Spec(List<String> lines, String color, boolean waxed) {}

    private SignArena() {}

    /** 立着的橡木告示牌，ROTATION=8：正面朝 −z，对着站在原点的玩家（F2）。 */
    public static BlockState stationState() {
        return Blocks.OAK_SIGN.defaultBlockState().setValue(StandingSignBlock.ROTATION, 8);
    }

    /** 染料颜色名（white、light_blue…）→ DyeColor；不认识的报错。 */
    public static DyeColor color(String name) {
        DyeColor c = name == null ? null : DyeColor.byName(name, null);
        if (c == null) throw new IllegalArgumentException("unknown dye color: " + name);
        return c;
    }

    /** 4 行、每行只含编辑框打得出来的字符（F3，宽度另查）。 */
    public static void checkLines(List<String> lines, String what) {
        if (lines == null || lines.size() != LINES) throw new IllegalArgumentException(what + " must have exactly " + LINES + " lines");
        for (int i = 0; i < LINES; i++) {
            String line = lines.get(i);
            if (line == null) throw new IllegalArgumentException(what + "[" + i + "] is null");
            for (int k = 0; k < line.length(); k++) {
                if (!StringUtil.isAllowedChatCharacter(line.charAt(k))) {
                    throw new IllegalArgumentException(String.format("%s[%d] has a character the sign editor rejects at index %d (U+%04X)", what, i, k, (int) line.charAt(k)));
                }
            }
        }
    }

    public static void check(Setup setup) {
        checkLines(setup.lines(), "sign.lines");
        color(setup.color());
    }

    public static void check(Spec spec) {
        checkLines(spec.lines(), "expect.sign.lines");
        color(spec.color());
    }

    /** 在刚放好的告示牌上写开局内容（Q4）：正面纯文字 + 颜色，不发光；背面空着。 */
    public static void write(ServerLevel level, BlockPos pos, Setup setup) {
        if (!(level.getBlockEntity(pos) instanceof SignBlockEntity sign)) throw new IllegalStateException("no sign at " + pos + " after building the arena");
        SignText front = new SignText();
        for (int i = 0; i < LINES; i++) front = front.setMessage(i, Component.literal(setup.lines().get(i)));
        front = front.setColor(color(setup.color()));
        sign.setText(front, true);
        sign.setText(new SignText(), false);
        sign.setWaxed(false);
        sign.setAllowedPlayerEditor(null);
    }

    public static SignBlockEntity at(ServerLevel level, BlockPos pos) {
        return level.getBlockEntity(pos) instanceof SignBlockEntity sign ? sign : null;
    }

    private static List<String> lines(SignText text) {
        List<String> out = new ArrayList<>(LINES);
        for (int i = 0; i < LINES; i++) out.add(text.getMessage(i, false).getString());
        return out;
    }

    private static Map<String, Object> side(SignText text) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", lines(text));
        out.put("color", text.getColor().getSerializedName());
        out.put("glow", text.hasGlowingText());
        return out;
    }

    /** { front: { lines, color, glow }, back: { … }, waxed, editing }；editing = 有人登记了正在编辑（F1、F5）。告示牌不在了 → null。 */
    public static Map<String, Object> describe(SignBlockEntity sign) {
        if (sign == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("front", side(sign.getFrontText()));
        out.put("back", side(sign.getBackText()));
        out.put("waxed", sign.isWaxed());
        out.put("editing", sign.getPlayerWhoMayEdit() != null);
        return out;
    }

    /**
     * Q8（光标为空由调用方检查）：正面 4 行逐字、颜色、是否涂蜡等于目标；背面还是空的、黑色、不发光；
     * 没有人正在编辑（编辑已经提交）。
     */
    public static boolean reached(SignBlockEntity sign, Spec spec) {
        if (sign == null || sign.getPlayerWhoMayEdit() != null) return false;
        SignText front = sign.getFrontText();
        if (!lines(front).equals(spec.lines())) return false;
        if (front.getColor() != color(spec.color())) return false;
        if (sign.isWaxed() != spec.waxed()) return false;
        SignText back = sign.getBackText();
        return lines(back).stream().allMatch(String::isEmpty) && back.getColor() == DyeColor.BLACK && !back.hasGlowingText();
    }

    /** finish 读完状态后清掉登记的编辑人：之后才到的改字包对不上，服务端不收（Q11、F5）。 */
    public static void release(SignBlockEntity sign) {
        if (sign != null) sign.setAllowedPlayerEditor(null);
    }
}
