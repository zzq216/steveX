package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.mixin.MinecraftAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.util.profiling.ProfileResults;

/** f3+1 API —— 性能分析饼图递归树 */
public class ProfilerApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("profiler", params -> {
            var tree = profilerTree();
            if (tree == null) throw new RuntimeException("profiler not available");
            return tree;
        });
    }

    private static Map<String, Object> profilerTree() {
        AtomicBoolean wasEnabled = new AtomicBoolean(true);

        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            var fp = ((MinecraftAccessor) mc).getFpsPieProfiler();
            var overlay = mc.getDebugOverlay();
            wasEnabled.set(fp.isEnabled());
            if (!fp.isEnabled()) overlay.toggleProfilerChart();
        });

        try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

        return AgentWebSocketServer.runOnClient(3_000, "Profiler query", ref -> {
            var mc = Minecraft.getInstance();
            var fp = ((MinecraftAccessor) mc).getFpsPieProfiler();
            var overlay = mc.getDebugOverlay();
            var results = fp.getResults();

            if (results != null && !results.getTimes("root").isEmpty())
                ref.value = buildTreeNode(results, "root", "");

            if (!wasEnabled.get() && overlay.showProfilerChart()) overlay.toggleProfilerChart();
        });
    }

    private static Map<String, Object> buildTreeNode(ProfileResults results, String parentPath, String name) {
        Map<String, Object> node = new LinkedHashMap<>();
        String fullPath = parentPath.isEmpty() ? name : parentPath + "" + name;
        var entries = results.getTimes(fullPath);
        if (entries.isEmpty()) return node;

        var self = entries.get(0);
        node.put("name", name.isEmpty() ? "root" : name);
        node.put("percentage", AgentWebSocketServer.f2(self.percentage));
        node.put("globalPercentage", AgentWebSocketServer.f2(self.globalPercentage));
        node.put("count", self.count);

        List<Map<String, Object>> children = new ArrayList<>();
        for (int i = 1; i < entries.size(); i++) {
            var entry = entries.get(i);
            if ("unspecified".equals(entry.name)) continue;
            children.add(buildTreeNode(results, fullPath, entry.name));
        }
        if (!children.isEmpty()) node.put("children", children);
        return node;
    }
}
