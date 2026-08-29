package name.modid.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.mixin.AbstractSignEditScreenAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.AbstractSignEditScreen;

/**
 * 告示牌 API —— 读取/编辑告示牌上的 4 行文字，关闭告示牌编辑界面。
 * 工作流: sign/get → sign/set (多行分别设) → sign/close
 */
public class SignApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("sign/get",   SignApi::getText);
        handlers.put("sign/set",   SignApi::setText);
        handlers.put("sign/close", params -> close());
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
                data.put("lines",       acc.getMessages());
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

    // ==================== 设置文字 ====================

    private static Map<String, Object> setText(Map<String, Object> params) {
        int line = params.containsKey("line") ? ((Number) params.get("line")).intValue() : -1;
        String text = (String) params.getOrDefault("text", "");
        var result = new Object(){ boolean ok = false; String error = null; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var screen = Minecraft.getInstance().screen;
            if (screen instanceof AbstractSignEditScreen signScreen) {
                var acc = (AbstractSignEditScreenAccessor) signScreen;
                if (line >= 0 && line <= 3) {
                    int prev = acc.getLine();
                    acc.setLine(line);
                    acc.invokeSetMessage(text);
                    acc.setLine(prev);          // 恢复原编辑行
                } else {
                    acc.invokeSetMessage(text); // 使用当前行
                }
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

    // ==================== 关闭告示牌编辑器 ====================

    private static Map<String, Object> close() {
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof AbstractSignEditScreen) {
                mc.setScreen(null);  // 触发 removed() → 发送 ServerboundSignUpdatePacket
            }
        });
        return Map.of("status", "ok");
    }
}
