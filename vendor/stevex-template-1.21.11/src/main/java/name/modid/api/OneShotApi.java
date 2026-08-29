package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.AgentInput;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import net.minecraft.client.Minecraft;

/** 单击类 API —— 11 个一次性按键 + 热键栏 + Tab 列表 */
public class OneShotApi {
    private static Map<String, Object> ok() { return Map.of("status", "ok"); }

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("key/attack-once",   params -> { AgentInput.attackOnce();        return ok(); });
        handlers.put("key/use-once",      params -> { AgentInput.useOnce();           return ok(); });
        handlers.put("key/drop",          params -> { AgentInput.drop();              return ok(); });
        handlers.put("key/pick-item",     params -> { AgentInput.pickItem();          return ok(); });
        handlers.put("key/inventory",     params -> { AgentInput.openInventory();     return ok(); });
        handlers.put("key/swap-hands",    params -> { AgentInput.swapHands();         return ok(); });
        handlers.put("key/chat",          params -> { AgentInput.chat();              return ok(); });
        handlers.put("key/command",       params -> { AgentInput.command();           return ok(); });
        handlers.put("key/perspective",   params -> { AgentInput.togglePerspective(); return ok(); });
        handlers.put("key/quick-actions", params -> { AgentInput.quickActions();      return ok(); });
        handlers.put("key/hotbar", params -> {
            int slot = AgentWebSocketServer.num(params, "slot", 0);
            AgentInput.hotbarSlot(slot);
            return ok();
        });
        handlers.put("tablist", params -> tabList());
    }

    private static Map<String, Object> tabList() {
        Map<String, Object> data = AgentWebSocketServer.runOnClient(2_000, "TabList query", ref -> {
            var mc = Minecraft.getInstance();
            var player = mc.player;
            var level = mc.level;
            if (player == null || level == null) return;

            Map<String, Object> result = new LinkedHashMap<>();
            var connection = player.connection;
            List<Map<String, Object>> playerList = new ArrayList<>();
            for (var info : connection.getListedOnlinePlayers()) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("name", info.getProfile().name());
                p.put("uuid", info.getProfile().id().toString());
                p.put("gamemode", info.getGameMode().getName());
                p.put("latency", info.getLatency());
                var team = info.getTeam();
                if (team != null) p.put("team", team.getName());
                if (info.getTabListDisplayName() != null)
                    p.put("displayName", info.getTabListDisplayName().getString());
                if (info.getTabListOrder() != 0) p.put("order", info.getTabListOrder());
                playerList.add(p);
            }
            result.put("players", playerList);

            var scoreboard = level.getScoreboard();
            var listObj = scoreboard.getDisplayObjective(net.minecraft.world.scores.DisplaySlot.LIST);
            if (listObj != null) {
                Map<String, Object> sb = new LinkedHashMap<>();
                sb.put("name", listObj.getName());
                sb.put("displayName", listObj.getDisplayName().getString());
                sb.put("criteria", listObj.getCriteria().getName());
                sb.put("renderType", listObj.getRenderType().name());
                List<Map<String, Object>> scores = new ArrayList<>();
                for (var entry : scoreboard.listPlayerScores(listObj)) {
                    Map<String, Object> s = new LinkedHashMap<>();
                    s.put("player", entry.owner());
                    s.put("score", entry.value());
                    if (entry.display() != null) s.put("display", entry.display().getString());
                    scores.add(s);
                }
                sb.put("scores", scores);
                result.put("objective", sb);
            }
            ref.value = result;
        });
        return data != null ? data : Map.of("players", List.of());
    }
}
