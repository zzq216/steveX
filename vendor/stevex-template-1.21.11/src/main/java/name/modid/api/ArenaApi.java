package name.modid.api;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.arena.ArenaManager;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * 训练场 API（docs/训练场设计方案.md T3）—— 只供 DSH 插件的训练器调用，不登记给 agent。
 *
 * <p>需要单人世界（集成服务器在同一个 JVM 里）；操作全部转到服务器线程执行。
 */
public class ArenaApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("arena/build", params -> {
            String arena = arena(params);
            BlockPos origin = origin(params, arena);
            return onServer(15_000, server -> Map.of("arena", arena, "placed", ArenaManager.build(server, arena, origin)));
        });
        handlers.put("arena/prepare", params -> {
            String arena = arena(params);
            BlockPos origin = origin(params, arena);
            List<ArenaManager.Give> items = gives(params.get("items"));
            List<String> watch = strings(params.get("watch"), "watch");
            if (watch.isEmpty()) throw new IllegalArgumentException("watch must list at least one item id");
            long dayTime = AgentWebSocketServer.num(params, "dayTime", 1000);
            UUID uuid = localPlayer();
            return onServer(15_000, server -> ArenaManager.prepare(server, player(server, uuid), arena, origin, items, watch, dayTime));
        });
        handlers.put("arena/status", params -> onServer(5_000, ArenaManager::status));
        handlers.put("arena/finish", params -> {
            String arena = arena(params);
            BlockPos origin = origin(params, arena);
            UUID uuid = localPlayer();
            return onServer(10_000, server -> ArenaManager.finish(server, player(server, uuid), origin));
        });
    }

    private static <T> T onServer(long timeoutMs, Function<MinecraftServer, T> action) throws Exception {
        MinecraftServer server = Minecraft.getInstance().getSingleplayerServer();
        if (server == null) throw new IllegalStateException("arena requires a single-player world");
        try {
            return server.submit(() -> action.apply(server)).get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ex ? ex : new RuntimeException(cause);
        } catch (TimeoutException e) {
            throw new IllegalStateException("arena operation timed out after " + timeoutMs + " ms");
        }
    }

    private static UUID localPlayer() {
        UUID uuid = AgentWebSocketServer.runOnClient(2_000, "Arena player lookup", ref -> {
            var p = Minecraft.getInstance().player;
            if (p != null) ref.value = p.getUUID();
        });
        if (uuid == null) throw new IllegalStateException("player not connected");
        return uuid;
    }

    private static ServerPlayer player(MinecraftServer server, UUID uuid) {
        ServerPlayer player = server.getPlayerList().getPlayer(uuid);
        if (player == null) throw new IllegalStateException("player not found on the integrated server");
        return player;
    }

    private static String arena(Map<String, Object> params) {
        Object v = params.get("arena");
        if (!(v instanceof String s) || !s.matches("[a-z0-9_]{1,32}")) throw new IllegalArgumentException("arena must match [a-z0-9_]{1,32}");
        return s;
    }

    /** origin 缺省时用已登记的位置；未登记的场地必须给 origin。 */
    private static BlockPos origin(Map<String, Object> params, String arena) {
        Object v = params.get("origin");
        if (v == null) {
            BlockPos known = ArenaManager.known().get(arena);
            if (known == null) throw new IllegalArgumentException("unknown arena " + arena + ": origin [x, y, z] required");
            return known;
        }
        if (!(v instanceof List<?> list) || list.size() != 3 || !list.stream().allMatch(n -> n instanceof Number)) {
            throw new IllegalArgumentException("origin must be [x, y, z]");
        }
        int y = ((Number) list.get(1)).intValue();
        if (y < -60 || y > 300) throw new IllegalArgumentException("origin y out of range [-60, 300]: " + y);
        return new BlockPos(((Number) list.get(0)).intValue(), y, ((Number) list.get(2)).intValue());
    }

    private static List<ArenaManager.Give> gives(Object v) {
        if (!(v instanceof List<?> list) || list.isEmpty()) throw new IllegalArgumentException("items must be a non-empty list of { slot, id, count }");
        List<ArenaManager.Give> out = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> m) || !(m.get("slot") instanceof Number slot) || !(m.get("id") instanceof String id)
                    || !(m.get("count") instanceof Number count)) {
                throw new IllegalArgumentException("each item must be { slot:int, id:string, count:int }");
            }
            out.add(new ArenaManager.Give(slot.intValue(), id, count.intValue()));
        }
        return out;
    }

    private static List<String> strings(Object v, String name) {
        if (!(v instanceof List<?> list) || !list.stream().allMatch(s -> s instanceof String)) {
            throw new IllegalArgumentException(name + " must be a list of strings");
        }
        List<String> out = new ArrayList<>();
        for (Object s : list) out.add((String) s);
        return out;
    }
}
