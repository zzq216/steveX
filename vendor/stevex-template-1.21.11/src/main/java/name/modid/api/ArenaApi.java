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
            // 告示牌训练场（告示牌方案 Q4）：开局正面 4 行和颜色；text 题不发物品
            name.modid.arena.SignArena.Setup signSetup = signSetup(params.get("sign"));
            // 弓箭训练场（弓箭方案 Q3、Q9）：本轮的标靶
            name.modid.arena.BowArena.Setup bowSetup = params.get("bow") == null ? null : new name.modid.arena.BowArena.Setup(bowTargets(params.get("bow"), "bow"));
            if (items.isEmpty() && chestItems.isEmpty() && params.get("mount") == null && signSetup == null) throw new IllegalArgumentException("items and chestItems are both empty: nothing to hand out");
            // 告示牌方案 Q7：开局行、目标行都要写得进编辑框（宽度用客户端字体量，和 sign/set 同一个检查）
            if (signSetup != null) checkSignWidths(signSetup.lines(), "sign.lines");
            if (expect != null && expect.sign() != null) checkSignWidths(expect.sign().lines(), "expect.sign.lines");
            long dayTime = AgentWebSocketServer.num(params, "dayTime", 1000);
            long seed = params.get("seed") instanceof Number n ? n.longValue() : 0L;
            // 附魔台训练场（附魔台方案 N2、N4）：书架数、经验等级、附魔种子；不给 = 书架 15 个，经验和种子不动；其他工作站忽略
            ArenaManager.EnchantSetup enchantSetup = new ArenaManager.EnchantSetup(optionalInt(params, "bookshelves"), optionalInt(params, "xpLevel"), optionalInt(params, "enchantSeed"));
            // 信标训练场（信标方案 G2）：底座层数 1–4；不给 = 4；其他工作站忽略
            Integer beaconLevel = optionalInt(params, "beaconLevel");
            // 坐骑训练场（坐骑方案 H2）：本轮生成什么动物；其他工作站不给
            ArenaManager.MountSetup mountSetup = mountSetup(params.get("mount"));
            // 村民交易训练场（村民交易方案 V2）：本轮村民的职业、类型、等级、交易项种子；其他工作站不给
            name.modid.arena.VillagerArena.Setup villagerSetup = villagerSetup(params.get("villager"));
            // 书与笔训练场（书与笔方案 J4）：当前选中的快捷栏格 0–8；不给 = 不动
            Integer selectedSlot = optionalInt(params, "selectedSlot");
            UUID uuid = localPlayer();
            return onServer(15_000, server -> ArenaManager.prepare(server, player(server, uuid), arena, origin, station, items, chestItems, seed, watch, expect, dayTime, enchantSetup, beaconLevel, mountSetup, villagerSetup, selectedSlot, signSetup, bowSetup));
        });
        // 村民交易训练场（村民交易方案 V3）：按职业、类型、等级、交易项种子生成交易项，只读、不碰世界
        handlers.put("arena/trade-preview", params -> {
            name.modid.arena.VillagerArena.Setup setup = villagerSetup(params);
            return onServer(10_000, server -> ArenaManager.tradePreview(server, setup));
        });
        // 村民交易训练场（村民交易方案 V2）：有交易表的职业，只读
        handlers.put("arena/trade-catalog", params -> onServer(5_000, ArenaManager::tradeCatalog));
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
        // 织布机训练场（织布机方案 L11）：素旗、染料、基础图案、图案物，只读
        handlers.put("arena/loom-catalog", params -> onServer(5_000, ArenaManager::loomCatalog));
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

    /**
     * [{ slot, id, count, enchantments?, map? }]，可以为空（箱子题"取"的物品栏、"放"的箱子开局都是空的）；enchantments 是铁砧题用的（铁砧方案 A7）；
     * map: { scale } 是制图台题的开局地图（制图台方案 K6）；potion 是酿造台题发的药水的药水注册名（酿造台方案 P8）。
     */
    private static List<ArenaManager.Give> gives(Object v, String name) {
        if (!(v instanceof List<?> list)) throw new IllegalArgumentException(name + " must be a list of { slot, id, count }");
        List<ArenaManager.Give> out = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> m) || !(m.get("slot") instanceof Number slot) || !(m.get("id") instanceof String id)
                    || !(m.get("count") instanceof Number count)) {
                throw new IllegalArgumentException("each entry of " + name + " must be { slot:int, id:string, count:int }");
            }
            Integer mapScale = null;
            if (m.get("map") != null) {
                // 制图台方案 K6：{ map: { scale } } 由 mod 现做开局地图
                if (!(m.get("map") instanceof Map<?, ?> map) || !(map.get("scale") instanceof Number scale)) throw new IllegalArgumentException(name + "[].map must be { scale:int }");
                mapScale = scale.intValue();
            }
            Object potion = m.get("potion");
            // 酿造台方案 P8：{ potion: 药水注册名 } 发带药水内容的药水
            if (potion != null && !(potion instanceof String)) throw new IllegalArgumentException(name + "[].potion must be a potion id string");
            // 书与笔方案 J11：{ pages: [string] } 发带内容的书与笔
            List<String> pages = m.get("pages") == null ? null : strings(m.get("pages"), name + "[].pages");
            out.add(new ArenaManager.Give(slot.intValue(), id, count.intValue(), levels(m.get("enchantments"), name + ".enchantments"), mapScale, (String) potion, pages));
        }
        return out;
    }

    /**
     * 三种写法：箱子 { inventory: { id: n }, container: { id: n } }；切石机 { targets: { id: n }, allowed: [id...] }（切石机方案 Q9）；
     * 炉子 { cook: { raw, rawLeft, fuel, fuelLeft, product } }（熔炉方案 K8）；附魔台 { enchant: { item, result, enchantment, level } }（附魔台方案 N8）；
     * 信标 { beacon: { payment, effects: [{ effect, amplifier }] } }（信标方案 G7）；铁砧 { anvil: { item, enchantments: { id: level }, name } }（铁砧方案 A7）；
     * 锻造台 { smithing: [{ item, trim: { pattern, material } | null }] }（锻造台方案 M7）；
     * 织布机 { loom: { goals: [{ banner, pattern, color, count }], allowed: [id...] } }（织布机方案 L9）；
     * 制图台 { cartography: { goals: [{ scale, locked, count }], allowed: [id...] } }（制图台方案 K9）；
     * 酿造台 { brew: { fuel, fuelLeft, ingredient, ingredientLeft, potion, potionLeft, placed, products: [签名...] } }（酿造台方案 P8）；
     * 合成器 { crafter: { target, portions, held: { id: n }, layout: [id | null ×9] } }（合成器方案 R7、R8）；
     * 交易 { trade: { uses: [n...], held: { id: n } } }（村民交易方案 V9；uses 的个数 = 村民的交易项数）；
     * 砂轮 { grindstone: { goals: [{ id, enchantments: { id: level }, damage }] } }（砂轮方案 K8；goals 的顺序和 items 一致）；
     * 书 { book: { goals: [[页文字...], ...] } }（书与笔方案 J11；按多重集合比）；
     * 告示牌 { sign: { lines: [4 个字符串], color, waxed } }（告示牌方案 Q8、Q11）；
     * 弓箭 { bow: { targets: [{ pos: [x, y, z], face }] } }（弓箭方案 Q7；和 prepare 的 bow 相同）；
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
        if (m.containsKey("bow")) return new ArenaManager.Expect(new name.modid.arena.BowArena.Spec(bowTargets(m.get("bow"), "expect.bow")));
        if (m.containsKey("sign")) {
            String usage = "expect.sign must be { lines: [4 strings], color: string, waxed: boolean }";
            if (!(m.get("sign") instanceof Map<?, ?> g) || !(g.get("color") instanceof String color) || !(g.get("waxed") instanceof Boolean waxed)) throw new IllegalArgumentException(usage);
            return new ArenaManager.Expect(new name.modid.arena.SignArena.Spec(List.copyOf(strings(g.get("lines"), "expect.sign.lines")), color, waxed));
        }
        if (m.containsKey("book")) {
            String usage = "expect.book must be { goals: [[string...], ...] }";
            if (!(m.get("book") instanceof Map<?, ?> b) || !(b.get("goals") instanceof List<?> rawGoals)) throw new IllegalArgumentException(usage);
            List<List<String>> goals = new ArrayList<>();
            for (Object g : rawGoals) {
                if (!(g instanceof List<?>)) throw new IllegalArgumentException(usage);
                goals.add(List.copyOf(strings(g, "expect.book.goals[]")));
            }
            return new ArenaManager.Expect(new name.modid.arena.BookArena.Spec(List.copyOf(goals)));
        }
        if (m.containsKey("grindstone")) {
            String usage = "expect.grindstone must be { goals: [{ id:string, enchantments: { id: level }, damage:int }] }";
            if (!(m.get("grindstone") instanceof Map<?, ?> g) || !(g.get("goals") instanceof List<?> rawGoals)) throw new IllegalArgumentException(usage);
            List<name.modid.arena.GrindstoneArena.Goal> goals = new ArrayList<>();
            for (Object raw : rawGoals) {
                if (!(raw instanceof Map<?, ?> goal) || !(goal.get("id") instanceof String id) || !(goal.get("damage") instanceof Number damage)
                        || damage.doubleValue() != Math.rint(damage.doubleValue()) || damage.intValue() < 0) {
                    throw new IllegalArgumentException(usage);
                }
                Map<String, Integer> enchantments = goal.get("enchantments") == null ? Map.of() : levels(goal.get("enchantments"), "expect.grindstone.goals[].enchantments");
                goals.add(new name.modid.arena.GrindstoneArena.Goal(id, Map.copyOf(enchantments), damage.intValue()));
            }
            return new ArenaManager.Expect(new name.modid.arena.GrindstoneArena.Spec(List.copyOf(goals)));
        }
        if (m.containsKey("trade")) {
            String usage = "expect.trade must be { uses: [int...], held: { id: n } }";
            if (!(m.get("trade") instanceof Map<?, ?> t) || !(t.get("uses") instanceof List<?> rawUses)) throw new IllegalArgumentException(usage);
            List<Integer> uses = new ArrayList<>();
            for (Object u : rawUses) {
                if (!(u instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.intValue() < 0) throw new IllegalArgumentException(usage);
                uses.add(n.intValue());
            }
            return new ArenaManager.Expect(new name.modid.arena.VillagerArena.Spec(List.copyOf(uses), Map.copyOf(counts(t.get("held"), "expect.trade.held"))));
        }
        if (m.containsKey("crafter")) {
            String usage = "expect.crafter must be { target:string, portions:int, held:{id:int}, layout:[string|null ×9] }";
            if (!(m.get("crafter") instanceof Map<?, ?> c) || !(c.get("target") instanceof String target)
                    || !(c.get("portions") instanceof Number portions) || !(c.get("layout") instanceof List<?> rawLayout)) {
                throw new IllegalArgumentException(usage);
            }
            List<String> layout = new ArrayList<>();
            for (Object cell : rawLayout) {
                if (cell != null && !(cell instanceof String)) throw new IllegalArgumentException(usage);
                layout.add((String) cell);
            }
            return new ArenaManager.Expect(new name.modid.arena.CrafterArena.Spec(target, portions.intValue(),
                    Map.copyOf(counts(c.get("held"), "expect.crafter.held")), java.util.Collections.unmodifiableList(layout)));
        }
        if (m.containsKey("brew")) {
            String usage = "expect.brew must be { fuel:string, fuelLeft:int, ingredient:string, ingredientLeft:int, potion:string, potionLeft:int, placed:int, products:[string] }";
            if (!(m.get("brew") instanceof Map<?, ?> b) || !(b.get("fuel") instanceof String fuel) || !(b.get("ingredient") instanceof String ingredient)
                    || !(b.get("potion") instanceof String potion) || !(b.get("fuelLeft") instanceof Number fuelLeft) || !(b.get("ingredientLeft") instanceof Number ingredientLeft)
                    || !(b.get("potionLeft") instanceof Number potionLeft) || !(b.get("placed") instanceof Number placed) || b.get("products") == null) {
                throw new IllegalArgumentException(usage);
            }
            Set<String> products = new HashSet<>(strings(b.get("products"), "expect.brew.products"));
            return new ArenaManager.Expect(new name.modid.arena.BrewArena.Spec(fuel, fuelLeft.intValue(), ingredient, ingredientLeft.intValue(), potion, potionLeft.intValue(), placed.intValue(), Set.copyOf(products)));
        }
        if (m.containsKey("cartography")) {
            String usage = "expect.cartography must be { goals: [{ scale:int, locked:boolean, count:int>=1 }], allowed: [id...] }";
            if (!(m.get("cartography") instanceof Map<?, ?> c) || !(c.get("goals") instanceof List<?> list) || list.isEmpty()) throw new IllegalArgumentException(usage);
            List<name.modid.arena.CartographyArena.Goal> goals = new ArrayList<>();
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> g) || !(g.get("scale") instanceof Number scale) || !(g.get("locked") instanceof Boolean locked)
                        || !(g.get("count") instanceof Number count) || count.intValue() < 1) {
                    throw new IllegalArgumentException(usage);
                }
                goals.add(new name.modid.arena.CartographyArena.Goal(scale.intValue(), locked, count.intValue()));
            }
            Set<String> allowed = new HashSet<>(c.get("allowed") == null ? List.of() : strings(c.get("allowed"), "expect.cartography.allowed"));
            return new ArenaManager.Expect(new name.modid.arena.CartographyArena.Spec(List.copyOf(goals), Set.copyOf(allowed)));
        }
        if (m.containsKey("loom")) {
            String usage = "expect.loom must be { goals: [{ banner:string, pattern:string, color:string, count:int>=1 }], allowed: [id...] }";
            if (!(m.get("loom") instanceof Map<?, ?> l) || !(l.get("goals") instanceof List<?> list) || list.isEmpty()) throw new IllegalArgumentException(usage);
            List<name.modid.arena.LoomArena.Goal> goals = new ArrayList<>();
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> g) || !(g.get("banner") instanceof String banner) || !(g.get("pattern") instanceof String pattern)
                        || !(g.get("color") instanceof String color) || !(g.get("count") instanceof Number count) || count.intValue() < 1) {
                    throw new IllegalArgumentException(usage);
                }
                goals.add(new name.modid.arena.LoomArena.Goal(banner, pattern, color, count.intValue()));
            }
            Set<String> allowed = new HashSet<>(l.get("allowed") == null ? List.of() : strings(l.get("allowed"), "expect.loom.allowed"));
            return new ArenaManager.Expect(new name.modid.arena.LoomArena.Spec(List.copyOf(goals), Set.copyOf(allowed)));
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

    /** 村民交易方案 V2：{ profession, type, level, offerSeed }；null → null。 */
    @SuppressWarnings("unchecked")
    private static name.modid.arena.VillagerArena.Setup villagerSetup(Object v) {
        if (v == null) return null;
        String usage = "villager must be { profession:string, type:string, level:int, offerSeed:int }";
        if (!(v instanceof Map<?, ?> m) || !(m.get("profession") instanceof String profession) || !(m.get("type") instanceof String type)) throw new IllegalArgumentException(usage);
        Map<String, Object> params = (Map<String, Object>) m;
        Integer level = optionalInt(params, "level");
        if (level == null || !(params.get("offerSeed") instanceof Number seed) || seed.doubleValue() != Math.rint(seed.doubleValue())) throw new IllegalArgumentException(usage);
        return new name.modid.arena.VillagerArena.Setup(profession, type, level, seed.longValue());
    }

    /** 弓箭方案 Q3、Q9：{ targets: [{ pos: [x, y, z], face: north|south|east|west|up|down }] }。 */
    private static List<name.modid.arena.BowArena.Target> bowTargets(Object v, String what) {
        String usage = what + " must be { targets: [{ pos: [x, y, z], face: north|south|east|west|up|down }] }";
        if (!(v instanceof Map<?, ?> m) || !(m.get("targets") instanceof List<?> raw)) throw new IllegalArgumentException(usage);
        List<name.modid.arena.BowArena.Target> out = new ArrayList<>();
        for (Object t : raw) {
            if (!(t instanceof Map<?, ?> row) || !(row.get("pos") instanceof List<?> pos) || pos.size() != 3 || !(row.get("face") instanceof String face)) throw new IllegalArgumentException(usage);
            int[] xyz = new int[3];
            for (int i = 0; i < 3; i++) {
                if (!(pos.get(i) instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())) throw new IllegalArgumentException(usage);
                xyz[i] = n.intValue();
            }
            out.add(new name.modid.arena.BowArena.Target(new BlockPos(xyz[0], xyz[1], xyz[2]), name.modid.arena.BowArena.face(face)));
        }
        return List.copyOf(out);
    }

    /** 告示牌方案 Q4：{ lines: [4 个字符串], color }；缺省 → null。 */
    private static name.modid.arena.SignArena.Setup signSetup(Object v) {
        if (v == null) return null;
        if (!(v instanceof Map<?, ?> m) || !(m.get("color") instanceof String color)) throw new IllegalArgumentException("sign must be { lines: [4 strings], color: string }");
        return new name.modid.arena.SignArena.Setup(List.copyOf(strings(m.get("lines"), "sign.lines")), color);
    }

    /** 告示牌方案 Q7：每行在客户端线程上按编辑框的规则查（{@link SignApi#lineError}，立着的告示牌行宽 90 像素）；不合格或等不到客户端线程就报错。 */
    private static void checkSignWidths(List<String> lines, String what) {
        String error = AgentWebSocketServer.runOnClient(2_000, "Sign width check", ref -> {
            var font = Minecraft.getInstance().font;
            String found = "";
            for (int i = 0; i < lines.size() && found.isEmpty(); i++) {
                String e = SignApi.lineError(font, SignApi.STANDING_SIGN_WIDTH, lines.get(i));
                if (e != null) found = what + "[" + i + "]: " + e;
            }
            ref.value = found;
        });
        if (error == null) throw new IllegalStateException("timed out waiting for the client thread to measure " + what);
        if (!error.isEmpty()) throw new IllegalArgumentException(error);
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
