package name.modid.api;

import java.util.LinkedHashMap;
import java.util.Map;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.vision.VisionWorldContext;

/** 系统状态 API —— 实时 busy 状态 + 最近一次请求失败信息 */
public class StatusApi {
    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("status", params -> {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("busy", AgentWebSocketServer.isBusy());
            map.put("error", AgentWebSocketServer.lastError());
            // v2.55：当前记忆世界（不在世界里 → null）
            final VisionWorldContext ctx = VisionWorldContext.current();
            map.put("worldKey", ctx == null ? null : ctx.worldKey());
            return map;
        });
    }
}
