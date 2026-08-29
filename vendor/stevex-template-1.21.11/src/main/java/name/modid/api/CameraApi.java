package name.modid.api;

import java.util.Map;
import name.modid.AgentCamera;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;

/** 视角类 API —— 增量旋转 + 注视坐标 */
public class CameraApi {
    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("camera/turn", params -> {
            double dx = AgentWebSocketServer.num(params, "dx", 0.0);
            double dy = AgentWebSocketServer.num(params, "dy", 0.0);
            AgentCamera.turn(dx, dy);
            return Map.of("status", "ok");
        });
        handlers.put("camera/look-at", params -> {
            double x = AgentWebSocketServer.num(params, "x", 0.0);
            double y = AgentWebSocketServer.num(params, "y", 0.0);
            double z = AgentWebSocketServer.num(params, "z", 0.0);
            AgentCamera.lookAt(x, y, z);
            return Map.of("status", "ok");
        });
    }
}
