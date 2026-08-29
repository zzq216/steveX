package name.modid.api;

import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import name.modid.AgentWebSocketServer.WsHandler;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ChatScreen;

/**
 * 聊天 API —— 在聊天栏中输入文字、按回车发送、关闭聊天栏。
 * 工作流: key/chat → chat/text (可选) → chat/send
 *                        或 chat/close (放弃输入)
 */
public class ChatApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("chat/text",  ChatApi::setText);
        handlers.put("chat/send",  ChatApi::send);
        handlers.put("chat/close", params -> close());
    }

    // ==================== 设置文字（不发送） ====================

    private static Map<String, Object> setText(Map<String, Object> params) {
        String text = (String) params.getOrDefault("text", "");
        var result = new Object(){ boolean ok = false; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var screen = Minecraft.getInstance().screen;
            if (screen instanceof ChatScreen) {
                for (var child : screen.children()) {
                    if (child instanceof EditBox eb && eb.isFocused()) {
                        eb.setValue(text);
                        result.ok = true;
                        break;
                    }
                }
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        return result.ok ? Map.of("status", "ok")
                         : Map.of("status", "error", "message", "chat screen not open");
    }

    // ==================== 发送消息（模拟按回车） ====================

    private static Map<String, Object> send(Map<String, Object> params) {
        String text = (String) params.getOrDefault("text", "");
        var result = new Object(){ boolean ok = false; String error = null; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof ChatScreen chatScreen) {
                // 如果传入 text，先写入输入框（视觉反馈），再通过 handleChatInput 发送
                if (!text.isEmpty()) {
                    for (var child : chatScreen.children()) {
                        if (child instanceof EditBox eb && eb.isFocused()) {
                            eb.setValue(text);
                            break;
                        }
                    }
                }
                String msg = !text.isEmpty() ? text : getInputValue(chatScreen);
                chatScreen.handleChatInput(msg, true);
                mc.setScreen(null);
                result.ok = true;
            } else {
                // 聊天栏未打开：直接通过连接发送（无 ChatScreen 时的降级路径）
                if (text.isEmpty()) {
                    result.error = "no chat screen open and no text provided";
                } else {
                    if (text.startsWith("/")) {
                        mc.player.connection.sendCommand(text.substring(1));
                    } else {
                        mc.player.connection.sendChat(text);
                    }
                    result.ok = true;
                }
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (!result.ok) return Map.of("status", "error", "message", result.error);
        return Map.of("status", "ok");
    }

    // ==================== 关闭聊天栏（模拟按 Esc） ====================

    private static Map<String, Object> close() {
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof ChatScreen) {
                mc.screen.onClose();
                mc.setScreen(null);
            }
        });
        return Map.of("status", "ok");
    }

    // ==================== 辅助方法 ====================

    /** 从 ChatScreen 中获取输入框当前文字 */
    private static String getInputValue(ChatScreen screen) {
        for (var child : screen.children()) {
            if (child instanceof EditBox eb && eb.isFocused()) {
                return eb.getValue();
            }
        }
        return "";
    }
}
