package name.modid.api;

import java.util.LinkedHashMap;
import java.util.Map;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import net.minecraft.client.Minecraft;

/** 设置 API —— 读取/修改渲染距离、模拟距离和视场角 */
public class SettingsApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("settings/get", params -> getSettings());
        handlers.put("settings/set", params -> setSettings(params));
    }

    private static Map<String, Object> getSettings() {
        Map<String, Object> s = AgentWebSocketServer.runOnClient(1_000, "Settings get", ref -> {
            var opts = Minecraft.getInstance().options;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("renderDistance",     opts.renderDistance().get());
            result.put("simulationDistance", opts.simulationDistance().get());
            result.put("fov",                opts.fov().get());
            ref.value = result;
        });
        return s != null ? s : Map.of();
    }

    private static Map<String, Object> setSettings(Map<String, Object> params) {
        Map<String, Object> r = AgentWebSocketServer.runOnClient(1_000, "Settings set", ref -> {
            var opts = Minecraft.getInstance().options;
            if (params.containsKey("renderDistance"))
                opts.renderDistance().set(AgentWebSocketServer.num(params, "renderDistance", 12));
            if (params.containsKey("simulationDistance"))
                opts.simulationDistance().set(AgentWebSocketServer.num(params, "simulationDistance", 12));
            if (params.containsKey("fov"))
                opts.fov().set(AgentWebSocketServer.num(params, "fov", 70));
            opts.save();
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("renderDistance",     opts.renderDistance().get());
            result.put("simulationDistance", opts.simulationDistance().get());
            result.put("fov",                opts.fov().get());
            ref.value = result;
        });
        return r != null ? r : Map.of();
    }
}
