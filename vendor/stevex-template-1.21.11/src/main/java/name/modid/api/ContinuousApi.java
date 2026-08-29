package name.modid.api;

import java.util.Map;
import name.modid.AgentInput;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;

/** 持续性按键 API —— 9 个方法 */
public class ContinuousApi {
    private static Map<String, Object> ok() { return Map.of("status", "ok"); }

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("key/up",      params -> { AgentInput.forward(AgentWebSocketServer.bool(params, "pressed", true));  return ok(); });
        handlers.put("key/down",    params -> { AgentInput.backward(AgentWebSocketServer.bool(params, "pressed", true)); return ok(); });
        handlers.put("key/left",    params -> { AgentInput.left(AgentWebSocketServer.bool(params, "pressed", true));     return ok(); });
        handlers.put("key/right",   params -> { AgentInput.right(AgentWebSocketServer.bool(params, "pressed", true));    return ok(); });
        handlers.put("key/jump",    params -> { AgentInput.jump(AgentWebSocketServer.bool(params, "pressed", true));     return ok(); });
        handlers.put("key/sprint",  params -> { AgentInput.sprint(AgentWebSocketServer.bool(params, "pressed", true));   return ok(); });
        handlers.put("key/sneak",   params -> { AgentInput.sneak(AgentWebSocketServer.bool(params, "pressed", true));    return ok(); });
        handlers.put("key/attack",  params -> { AgentInput.attack(AgentWebSocketServer.bool(params, "pressed", true));   return ok(); });
        handlers.put("key/use",     params -> { AgentInput.use(AgentWebSocketServer.bool(params, "pressed", true));      return ok(); });
    }
}
