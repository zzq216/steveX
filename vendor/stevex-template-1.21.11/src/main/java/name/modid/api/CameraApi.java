package name.modid.api;

import java.util.Map;
import name.modid.AgentCamera;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;

/**
 * 视角类 API —— 增量旋转 + 注视坐标（docs/视角平滑转动设计方案.md）。
 * 缺省平滑转动；instant=true 一步到位；speed 是平滑转动的平均角速度（度/秒）。两种转法终点相同，都在视角到位后才返回
 * （返回 future，由 {@link AgentWebSocketServer} 异步应答，转动期间不挡其他请求）。
 * instant、speed 由插件按配置填，agent 改不了（插件侧 GameState.env 拦）。
 */
public class CameraApi {
    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("camera/turn", params -> {
            double dx = AgentWebSocketServer.num(params, "dx", 0.0);
            double dy = AgentWebSocketServer.num(params, "dy", 0.0);
            return AgentCamera.turn(dx, dy, instant(params), speed(params));
        });
        handlers.put("camera/look-at", params -> {
            double x = AgentWebSocketServer.num(params, "x", 0.0);
            double y = AgentWebSocketServer.num(params, "y", 0.0);
            double z = AgentWebSocketServer.num(params, "z", 0.0);
            return AgentCamera.lookAt(x, y, z, instant(params), speed(params));
        });
    }

    private static boolean instant(Map<String, Object> params) {
        Object v = params.get("instant");
        if (v == null) return false;
        if (!(v instanceof Boolean b)) throw new IllegalArgumentException("instant must be a boolean");
        return b;
    }

    private static double speed(Map<String, Object> params) {
        double speed = AgentWebSocketServer.num(params, "speed", AgentCamera.DEFAULT_SPEED);
        if (!(speed >= AgentCamera.MIN_SPEED && speed <= AgentCamera.MAX_SPEED)) {
            throw new IllegalArgumentException("speed must be within " + (int) AgentCamera.MIN_SPEED + "-" + (int) AgentCamera.MAX_SPEED + " degrees per second: " + speed);
        }
        return speed;
    }
}
