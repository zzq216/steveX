package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
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
            String station = station(params, arena);
            return onServer(15_000, server -> Map.of("arena", arena, "placed", ArenaManager.build(server, arena, origin, station)));
        });
        handlers.put("arena/prepare", params -> {
            String arena = arena(params);
            BlockPos origin = origin(params, arena);
            String station = station(params, arena);
            List<ArenaManager.Give> items = gives(params.get("items"), "items");
            // 箱子训练场（箱子方案）：箱子里放什么、本轮的目标计数；合成场地不给
            List<ArenaManager.Give> chestItems = params.get("chestItems") == null ? List.of() : gives(params.get("chestItems"), "chestItems");
            ArenaManager.Expect expect = expect(params.get("expect"));
            List<String> watch = params.get("watch") == null ? List.of() : strings(params.get("watch"), "watch");
            if (items.isEmpty() && chestItems.isEmpty()) throw new IllegalArgumentException("items and chestItems are both empty: nothing to hand out");
            long dayTime = AgentWebSocketServer.num(params, "dayTime", 1000);
            long seed = params.get("seed") instanceof Number n ? n.longValue() : 0L;
            UUID uuid = localPlayer();
            return onServer(15_000, server -> ArenaManager.prepare(server, player(server, uuid), arena, origin, station, items, chestItems, seed, watch, expect, dayTime));
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
            ArenaManager.Site known = ArenaManager.known().get(arena);
            if (known == null) throw new IllegalArgumentException("unknown arena " + arena + ": origin [x, y, z] required");
            return known.origin();
        }
        if (!(v instanceof List<?> list) || list.size() != 3 || !list.stream().allMatch(n -> n instanceof Number)) {
            throw new IllegalArgumentException("origin must be [x, y, z]");
        }
        int y = ((Number) list.get(1)).intValue();
        if (y < -60 || y > 300) throw new IllegalArgumentException("origin y out of range [-60, 300]: " + y);
        return new BlockPos(((Number) list.get(0)).intValue(), y, ((Number) list.get(2)).intValue());
    }

    /** station 缺省时用已登记场地的工作站（未登记 = 没有）；显式 null = 没有工作站。 */
    private static String station(Map<String, Object> params, String arena) {
        if (!params.containsKey("station")) {
            ArenaManager.Site known = ArenaManager.known().get(arena);
            return known != null ? known.station() : null;
        }
        Object v = params.get("station");
        if (v != null && !(v instanceof String)) throw new IllegalArgumentException("station must be a string or null");
        ArenaManager.station((String) v); // 未知名字在这里就报错
        return (String) v;
    }

    /** [{ slot, id, count }]，可以为空（箱子题"取"的物品栏、"放"的箱子开局都是空的）。 */
    private static List<ArenaManager.Give> gives(Object v, String name) {
        if (!(v instanceof List<?> list)) throw new IllegalArgumentException(name + " must be a list of { slot, id, count }");
        List<ArenaManager.Give> out = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> m) || !(m.get("slot") instanceof Number slot) || !(m.get("id") instanceof String id)
                    || !(m.get("count") instanceof Number count)) {
                throw new IllegalArgumentException("each entry of " + name + " must be { slot:int, id:string, count:int }");
            }
            out.add(new ArenaManager.Give(slot.intValue(), id, count.intValue()));
        }
        return out;
    }

    /** { inventory: { id: n }, container: { id: n } }；省略 → null（不检测到达）。数量为 0 的项去掉，与 mod 的计数口径一致。 */
    private static ArenaManager.Expect expect(Object v) {
        if (v == null) return null;
        if (!(v instanceof Map<?, ?> m)) throw new IllegalArgumentException("expect must be { inventory: { id: n }, container: { id: n } }");
        return new ArenaManager.Expect(counts(m.get("inventory"), "expect.inventory"), counts(m.get("container"), "expect.container"));
    }

    private static Map<String, Integer> counts(Object v, String name) {
        if (v == null) return Map.of();
        if (!(v instanceof Map<?, ?> m)) throw new IllegalArgumentException(name + " must be { id: count }");
        Map<String, Integer> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : m.entrySet()) {
            if (!(e.getKey() instanceof String id) || !(e.getValue() instanceof Number n) || n.intValue() < 0) {
                throw new IllegalArgumentException(name + " must map item ids to non-negative counts");
            }
            if (n.intValue() > 0) out.put(id, n.intValue());
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
