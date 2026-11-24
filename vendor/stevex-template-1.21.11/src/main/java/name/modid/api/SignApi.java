package name.modid.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.mixin.AbstractSignEditScreenAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.screens.inventory.AbstractSignEditScreen;
import net.minecraft.util.StringUtil;

/**
 * 告示牌 API —— 读取告示牌编辑框、切换当前行、改当前行的文字、保存并关闭。
 * 工作流: sign/get → (sign/line → sign/set)… → sign/close
 *
 * <p>和原版编辑框一致（告示牌训练场设计方案 Q9）：打字只改当前行，切行是单独的操作（原版的上下方向键、回车）；
 * sign/set 按编辑框的规则查文字：只收 {@link StringUtil#isAllowedChatCharacter} 放行的字符（不收 §、码值 &lt; 32 的控制字符含换行、DEL），
 * 宽度不超过这块告示牌的行宽上限（AbstractSignEditScreen 54–60 行）。不符合就报错、这一行不变、不截断。
 */
public class SignApi {

    /** 立着的告示牌每行最多 90 像素（SignBlockEntity 37 行；悬挂告示牌 60，HangingSignBlockEntity 9 行） */
    public static final int STANDING_SIGN_WIDTH = 90;
    /** 1 秒内客户端线程没做完（Map.of 不收 null，所以给一句明确的话） */
    private static final String TIMEOUT = "timed out waiting for the client thread";

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("sign/get",   SignApi::getText);
        handlers.put("sign/line",  SignApi::setLine);
        handlers.put("sign/set",   SignApi::setText);
        handlers.put("sign/close", params -> close());
    }

    /**
     * 一行文字是不是编辑框打得出来的（Q9）：有编辑框不收的字符、或者宽度超过 maxWidth 像素 → 说明哪里不行；可以 → null。
     * 要在客户端线程上调用（用客户端字体量宽度）。arena/prepare 查开局行、目标行时也用它（Q7）。
     */
    public static String lineError(Font font, int maxWidth, String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (!StringUtil.isAllowedChatCharacter(c)) {
                return String.format("text has a character the sign editor rejects at index %d (U+%04X); §, control characters (line breaks too) and DEL are not allowed", i, (int) c);
            }
        }
        int width = font.width(text);
        if (width > maxWidth) return "text is " + width + " px wide, a sign line holds at most " + maxWidth + " px";
        return null;
    }

    // ==================== 获取当前告示牌文字 ====================

    @SuppressWarnings("unchecked")
    private static Map<String, Object> getText(Map<String, Object> params) {
        Map<String, Object>[] box = new Map[1];
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var screen = Minecraft.getInstance().screen;
            if (screen instanceof AbstractSignEditScreen signScreen) {
                var acc = (AbstractSignEditScreenAccessor) signScreen;
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("lines",       acc.getMessages().clone());
                data.put("currentLine", acc.getLine());
                data.put("isFront",     acc.getIsFrontText());
                box[0] = data;
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (box[0] == null) return Map.of("status", "error", "message", "sign editor not open");
        return box[0];
    }

    // ==================== 切换当前行 ====================

    /** 当前行切到 0–3 的某一行，光标移到行末；等同于按方向键切行（AbstractSignEditScreen 76–88 行）。 */
    private static Map<String, Object> setLine(Map<String, Object> params) {
        if (!(params.get("line") instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())) {
            return Map.of("status", "error", "message", "line must be an integer 0-3");
        }
        int line = n.intValue();
        if (line < 0 || line > 3) return Map.of("status", "error", "message", "line " + line + " out of range (0-3)");
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            if (Minecraft.getInstance().screen instanceof AbstractSignEditScreen signScreen) {
                var acc = (AbstractSignEditScreenAccessor) signScreen;
                acc.setLine(line);
                acc.getSignField().setCursorToEnd();
                result.ok = true;
            } else {
                result.error = "sign editor not open";
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (!result.ok) return Map.of("status", "error", "message", result.error);
        return Map.of("status", "ok");
    }

    // ==================== 设置文字 ====================

    /** 把当前行改成 text（Q9）：只改当前行，切行用 sign/line。 */
    private static Map<String, Object> setText(Map<String, Object> params) {
        if (params.containsKey("line")) {
            return Map.of("status", "error", "message", "sign/set only edits the current line; switch lines with sign/line first");
        }
        if (!(params.get("text") instanceof String text)) return Map.of("status", "error", "message", "text must be a string");
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof AbstractSignEditScreen signScreen) {
                var acc = (AbstractSignEditScreenAccessor) signScreen;
                String error = lineError(mc.font, acc.getSign().getMaxTextLineWidth(), text);
                if (error != null) {
                    result.error = error;
                } else {
                    acc.invokeSetMessage(text);
                    acc.getSignField().setCursorToEnd();
                    result.ok = true;
                }
            } else {
                result.error = "sign editor not open";
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (!result.ok) return Map.of("status", "error", "message", result.error);
        return Map.of("status", "ok");
    }

    // ==================== 保存并关闭 ====================

    /**
     * 保存并关闭：关掉编辑框时 removed() 把 4 行发给服务端（AbstractSignEditScreen 108–116 行）。等客户端线程做完再返回；
     * 当前不是告示牌编辑框时报错。
     */
    private static Map<String, Object> close() {
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof AbstractSignEditScreen) {
                mc.setScreen(null);
                result.ok = true;
            } else {
                result.error = "sign editor not open";
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (!result.ok) return Map.of("status", "error", "message", result.error);
        return Map.of("status", "ok");
    }
}
