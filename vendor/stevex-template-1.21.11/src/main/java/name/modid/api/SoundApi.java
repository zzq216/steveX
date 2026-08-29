package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.mixin.SoundEngineAccessor;
import net.minecraft.client.Minecraft;

/** 声音 API —— 返回当前客户端听到的所有声音及参数 */
public class SoundApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("sound", params -> {
            List<Map<String, Object>> sounds = snapshot();
            return Map.of("sounds", sounds);
        });
    }

    private static List<Map<String, Object>> snapshot() {
        List<Map<String, Object>> sounds = AgentWebSocketServer.runOnClient(2_000, "Sound query", ref -> {
            var mc = Minecraft.getInstance();
            var engine = ((name.modid.mixin.SoundManagerAccessor) mc.getSoundManager()).getSoundEngine();
            var playing = ((SoundEngineAccessor) engine).getInstanceToChannel();
            List<Map<String, Object>> list = new ArrayList<>();
            for (var si : playing.keySet()) {
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("id",          si.getIdentifier().toString());
                s.put("source",      si.getSource().getName());
                s.put("x",           AgentWebSocketServer.f3(si.getX()));
                s.put("y",           AgentWebSocketServer.f3(si.getY()));
                s.put("z",           AgentWebSocketServer.f3(si.getZ()));
                s.put("volume",      AgentWebSocketServer.f2(si.getVolume()));
                s.put("pitch",       AgentWebSocketServer.f2(si.getPitch()));
                s.put("looping",     si.isLooping());
                s.put("relative",    si.isRelative());
                s.put("attenuation", si.getAttenuation().name());
                s.put("delay",       si.getDelay());
                list.add(s);
            }
            ref.value = list;
        });
        return sounds != null ? sounds : List.of();
    }
}
