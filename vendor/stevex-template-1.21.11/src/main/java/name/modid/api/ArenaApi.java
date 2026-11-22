package name.modid.api;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
            if (items.isEmpty() && chestItems.isEmpty() && params.get("mount") == null) throw new IllegalArgumentException("items and chestItems are both empty: nothing to hand out");
            long dayTime = AgentWebSocketServer.num(params, "dayTime", 1000);
            long seed = params.get("seed") instanceof Number n ? n.longValue() : 0L;
            // 附魔台训练场（附魔台方案 N2、N4）：书架数、经验等级、附魔种子；不给 = 书架 15 个，经验和种子不动；其他工作站忽略
            ArenaManager.EnchantSetup enchantSetup = new ArenaManager.EnchantSetup(optionalInt(params, "bookshelves"), optionalInt(params, "xpLevel"), optionalInt(params, "enchantSeed"));
            // 信标训练场（信标方案 G2）：底座层数 1–4；不给 = 4；其他工作站忽略
            Integer beaconLevel = optionalInt(params, "beaconLevel");
            // 坐骑训练场（坐骑方案 H2）：本轮生成什么动物；其他工作站不给
            ArenaManager.MountSetup mountSetup = mountSetup(params.get("mount"));
            UUID uuid = localPlayer();
            return onServer(15_000, server -> ArenaManager.prepare(server, player(server, uuid), arena, origin, station, items, chestItems, seed, watch, expect, dayTime, enchantSetup, beaconLevel, mountSetup));
        });
        // 附魔台训练场（附魔台方案 N5）：三档预览，只读、不碰世界
        handlers.put("arena/enchant-preview", params -> {
            if (!(params.get("item") instanceof String item)) throw new IllegalArgumentException("item must be an item id");
            Integer seed = optionalInt(params, "enchantSeed");
            if (seed == null) throw new IllegalArgumentException("enchantSeed must be an integer");
            Integer shelves = optionalInt(params, "bookshelves");
            int count = shelves == null ? 15 : shelves;
            if (count < 0 || count > 15) throw new IllegalArgumentException("bookshelves must be within 0-15");
            return onServer(5_000, server -> ArenaManager.enchantPreview(server, item, seed, count));
        });
        // 铁砧训练场（铁砧方案 A2）：物品池和每件物品能附的附魔，只读
        handlers.put("arena/anvil-catalog", params -> onServer(5_000, ArenaManager::anvilCatalog));
        // 铁砧训练场（铁砧方案 A4）：按原版算法预览产物和花费，只读（会把玩家设成生存模式）
        handlers.put("arena/anvil-preview", params -> {
            ArenaManager.Give left = anvilItem(params.get("left"), "left");
            if (left == null) throw new IllegalArgumentException("left must be { id:string, enchantments?: { id: level } }");
            ArenaManager.Give right = anvilItem(params.get("right"), "right");
            Object name = params.get("name");
            if (name != null && !(name instanceof String)) throw new IllegalArgumentException("name must be a string or null");
            UUID uuid = localPlayer();
            return onServer(5_000, server -> ArenaManager.anvilPreview(server, player(server, uuid), left, right, (String) name));
        });
        // 锻造台训练场（锻造台方案 M2）：全部锻造配方、可加纹饰的盔甲、纹饰材料，只读
        handlers.put("arena/smithing-catalog", params -> onServer(5_000, ArenaManager::smithingCatalog));
        // 锻造台训练场（锻造台方案 M4）：用服务器的锻造配方算产物，只读
        handlers.put("arena/smithing-preview", params -> {
            if (!(params.get("template") instanceof String template) || !(params.get("base") instanceof String base) || !(params.get("addition") instanceof String addition)) {
                throw new IllegalArgumentException("template, base and addition must be item ids");
            }
            return onServer(5_000, server -> ArenaManager.smithingPreview(server, template, base, addition));
        });
        // 坐骑训练场（坐骑方案 H10）：每种动物能装什么、箱子几格，只读
        handlers.put("arena/mount-catalog", params -> onServer(10_000, ArenaManager::mountCatalog));
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

    /** 铁砧预览的一件物品：{ id, enchantments?: { id: level } }；null → null（右格空着）。 */
    private static ArenaManager.Give anvilItem(Object v, String name) {
        if (v == null) return null;
        if (!(v instanceof Map<?, ?> m) || !(m.get("id") instanceof String id)) throw new IllegalArgumentException(name + " must be { id:string, enchantments?: { id: level } }");
        return new ArenaManager.Give(0, id, 1, levels(m.get("enchantments"), name + ".enchantments"));
    }

    /** { 附魔注册名: 级数 }（级数 ≥ 1）；null → null。 */
    private static Map<String, Integer> levels(Object v, String name) {
        if (v == null) return null;
        if (!(v instanceof Map<?, ?> m)) throw new IllegalArgumentException(name + " must be { enchantment: level }");
        Map<String, Integer> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : m.entrySet()) {
            if (!(e.getKey() instanceof String id) || !(e.getValue() instanceof Number n) || n.intValue() < 1) {
                throw new IllegalArgumentException(name + " must map enchantment ids to levels >= 1");
            }
            out.put(id, n.intValue());
        }
        return out;
    }

    /** [{ slot, id, count, enchantments? }]，可以为空（箱子题"取"的物品栏、"放"的箱子开局都是空的）；enchantments 是铁砧题用的（铁砧方案 A7）。 */
    private static List<ArenaManager.Give> gives(Object v, String name) {
        if (!(v instanceof List<?> list)) throw new IllegalArgumentException(name + " must be a list of { slot, id, count }");
        List<ArenaManager.Give> out = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> m) || !(m.get("slot") instanceof Number slot) || !(m.get("id") instanceof String id)
                    || !(m.get("count") instanceof Number count)) {
                throw new IllegalArgumentException("each entry of " + name + " must be { slot:int, id:string, count:int }");
            }
            out.add(new ArenaManager.Give(slot.intValue(), id, count.intValue(), levels(m.get("enchantments"), name + ".enchantments")));
        }
        return out;
    }

    /**
     * 三种写法：箱子 { inventory: { id: n }, container: { id: n } }；切石机 { targets: { id: n }, allowed: [id...] }（切石机方案 Q9）；
     * 炉子 { cook: { raw, rawLeft, fuel, fuelLeft, product } }（熔炉方案 K8）；附魔台 { enchant: { item, result, enchantment, level } }（附魔台方案 N8）；
     * 信标 { beacon: { payment, effects: [{ effect, amplifier }] } }（信标方案 G7）；铁砧 { anvil: { item, enchantments: { id: level }, name } }（铁砧方案 A7）；
     * 锻造台 { smithing: [{ item, trim: { pattern, material } | null }] }（锻造台方案 M7）；
     * 坐骑 { mount: { saddle?: id | null, body?: id | null, chest: { id: n }, inventory: { id: n } } }（坐骑方案 H6；写了 saddle / body 才检查，null = 要空着）。
     * 省略 → null（不检测到达）。数量为 0 的项去掉，与 mod 的计数口径一致。
     */
    private static ArenaManager.Expect expect(Object v) {
        if (v == null) return null;
        if (!(v instanceof Map<?, ?> m)) throw new IllegalArgumentException("expect must be { inventory: { id: n }, container: { id: n } }, { targets: { id: n }, allowed: [id...] } or { cook: { raw, rawLeft, fuel, fuelLeft, product } }");
        if (m.containsKey("mount")) {
            String usage = "expect.mount must be { saddle?: string | null, body?: string | null, chest: { id: n }, inventory: { id: n } }";
            if (!(m.get("mount") instanceof Map<?, ?> g)) throw new IllegalArgumentException(usage);
            for (String key : List.of("saddle", "body")) if (g.get(key) != null && !(g.get(key) instanceof String)) throw new IllegalArgumentException(usage);
            return new ArenaManager.Expect(new ArenaManager.MountGoal(
                    g.containsKey("saddle"), (String) g.get("saddle"), g.containsKey("body"), (String) g.get("body"),
                    Map.copyOf(counts(g.get("chest"), "expect.mount.chest")), Map.copyOf(counts(g.get("inventory"), "expect.mount.inventory"))));
        }
        if (m.containsKey("smithing")) {
            String usage = "expect.smithing must be a non-empty list of { item:string, trim: { pattern:string, material:string } | null }";
            if (!(m.get("smithing") instanceof List<?> list) || list.isEmpty()) throw new IllegalArgumentException(usage);
            List<ArenaManager.Smith> goals = new ArrayList<>();
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> g) || !(g.get("item") instanceof String item)) throw new IllegalArgumentException(usage);
                Object trim = g.get("trim");
                if (trim == null) {
                    goals.add(new ArenaManager.Smith(item, null, null));
                } else if (trim instanceof Map<?, ?> t && t.get("pattern") instanceof String pattern && t.get("material") instanceof String material) {
                    goals.add(new ArenaManager.Smith(item, pattern, material));
                } else {
                    throw new IllegalArgumentException(usage);
                }
            }
            return new ArenaManager.Expect(List.copyOf(goals));
        }
        if (m.containsKey("anvil")) {
            if (!(m.get("anvil") instanceof Map<?, ?> a) || !(a.get("item") instanceof String item) || !(a.get("enchantments") instanceof Map<?, ?>)
                    || (a.get("name") != null && !(a.get("name") instanceof String))) {
                throw new IllegalArgumentException("expect.anvil must be { item:string, enchantments: { id: level }, name: string | null }");
            }
            return new ArenaManager.Expect(new ArenaManager.Anvil(item, Map.copyOf(levels(a.get("enchantments"), "expect.anvil.enchantments")), (String) a.get("name")));
        }
        if (m.containsKey("beacon")) {
            String usage = "expect.beacon must be { payment:string, effects: [{ effect:string, amplifier:1|2 }] }";
            if (!(m.get("beacon") instanceof Map<?, ?> b) || !(b.get("payment") instanceof String payment) || !(b.get("effects") instanceof List<?> list) || list.isEmpty()) {
                throw new IllegalArgumentException(usage);
            }
            List<ArenaManager.Want> wants = new ArrayList<>();
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> w) || !(w.get("effect") instanceof String effect) || !(w.get("amplifier") instanceof Number amp)
                        || (amp.intValue() != 1 && amp.intValue() != 2)) {
                    throw new IllegalArgumentException(usage);
                }
                wants.add(new ArenaManager.Want(effect, amp.intValue()));
            }
            return new ArenaManager.Expect(new ArenaManager.Beacon(payment, List.copyOf(wants)));
        }
        if (m.containsKey("enchant")) {
            if (!(m.get("enchant") instanceof Map<?, ?> e) || !(e.get("item") instanceof String item) || !(e.get("result") instanceof String result)
                    || !(e.get("enchantment") instanceof String enchantment) || !(e.get("level") instanceof Number level) || level.intValue() < 1) {
                throw new IllegalArgumentException("expect.enchant must be { item:string, result:string, enchantment:string, level:int>=1 }");
            }
            return new ArenaManager.Expect(new ArenaManager.Enchant(item, result, enchantment, level.intValue()));
        }
        if (m.containsKey("cook")) {
            if (!(m.get("cook") instanceof Map<?, ?> c) || !(c.get("raw") instanceof String raw) || !(c.get("fuel") instanceof String fuel)
                    || !(c.get("product") instanceof String product) || !(c.get("rawLeft") instanceof Number rawLeft)
                    || !(c.get("fuelLeft") instanceof Number fuelLeft) || rawLeft.intValue() < 0 || fuelLeft.intValue() < 0) {
                throw new IllegalArgumentException("expect.cook must be { raw:string, rawLeft:int>=0, fuel:string, fuelLeft:int>=0, product:string }");
            }
            if (raw.equals(fuel) || raw.equals(product) || fuel.equals(product)) throw new IllegalArgumentException("expect.cook: raw, fuel and product must be three different items");
            return new ArenaManager.Expect(new ArenaManager.Cook(raw, rawLeft.intValue(), fuel, fuelLeft.intValue(), product));
        }
        if (m.containsKey("targets")) {
            Map<String, Integer> targets = counts(m.get("targets"), "expect.targets");
            if (targets.isEmpty()) throw new IllegalArgumentException("expect.targets must name at least one item with a positive count");
            Set<String> allowed = new HashSet<>(m.get("allowed") == null ? List.of() : strings(m.get("allowed"), "expect.allowed"));
            if (!allowed.containsAll(targets.keySet())) throw new IllegalArgumentException("expect.allowed must include every target");
            return new ArenaManager.Expect(Map.of(), Map.of(), targets, Set.copyOf(allowed));
        }
        return new ArenaManager.Expect(counts(m.get("inventory"), "expect.inventory"), counts(m.get("container"), "expect.container"));
    }

    /** 坐骑方案 H2：{ animal, saddle?, body?, chest?: [{ slot, id, count }], strength? }；null → null。 */
    private static ArenaManager.MountSetup mountSetup(Object v) {
        if (v == null) return null;
        String usage = "mount must be { animal:string, saddle?:string, body?:string, chest?: [{ slot, id, count }], strength?:int }";
        if (!(v instanceof Map<?, ?> m) || !(m.get("animal") instanceof String animal)) throw new IllegalArgumentException(usage);
        for (String key : List.of("saddle", "body")) if (m.get(key) != null && !(m.get(key) instanceof String)) throw new IllegalArgumentException(usage);
        Object strength = m.get("strength");
        if (strength != null && !(strength instanceof Number n && n.doubleValue() == Math.rint(n.doubleValue()))) throw new IllegalArgumentException(usage);
        List<ArenaManager.Give> chest = m.get("chest") == null ? List.of() : gives(m.get("chest"), "mount.chest");
        return new ArenaManager.MountSetup(animal, (String) m.get("saddle"), (String) m.get("body"), chest, strength == null ? null : ((Number) strength).intValue());
    }

    /** 可选的整数参数：缺省或 null → null；不是整数 → 报错。 */
    private static Integer optionalInt(Map<String, Object> params, String name) {
        Object v = params.get(name);
        if (v == null) return null;
        if (!(v instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())) throw new IllegalArgumentException(name + " must be an integer");
        return n.intValue();
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
