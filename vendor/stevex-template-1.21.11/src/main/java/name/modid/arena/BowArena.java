package name.modid.arena;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ChargedProjectiles;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * 弓箭训练场（docs/弓箭训练场设计方案.md）：场地（Q1）、放标靶、登记本轮射出的每一支箭（Q8）、离开平台的检测（Q7）、到达检测。
 * 全部在服务器线程上调用（同 {@link ArenaManager}）；箭的命中由 {@code AbstractArrowHitMixin} 报来，生成由实体加载事件报来。
 *
 * <p>几何（以 origin 为射击平台中心的地板方块）：平台 3×3（x、z ∈ [o−1, o+1]，顶面 y = oy），玩家站在 (ox, oy+1, oz) 朝 +x；
 * 后面（x = ox−2）和两侧（z = oz ± 2）2 格高屏障护栏，前面敞开。空场地 x ∈ [ox+2, ox+49]、z ∈ [oz−24, oz+23]、y ∈ [oy−21, oy+26]，
 * 48 × 48 × 48 格，里面只有标靶。
 */
public final class BowArena {

    public static final int FIELD = 48;
    /** 空场地相对原点的范围（含两端） */
    public static final int FIELD_X0 = 2, FIELD_X1 = FIELD_X0 + FIELD - 1;
    public static final int FIELD_Z0 = -24, FIELD_Z1 = FIELD_Z0 + FIELD - 1;
    public static final int FIELD_Y0 = -21, FIELD_Y1 = FIELD_Y0 + FIELD - 1;
    public static final int MAX_TARGETS = 4;
    /** 飞出场地（空场地加平台，外扩 2 格）就算 out，删掉这支箭（Q8） */
    private static final int MARGIN = 2;
    /** 发射后这么多 tick 还没有结果就记 stuck（Q6） */
    private static final int STUCK_TICKS = 200;
    /** 每支箭最多记这么多个轨迹点（Q8） */
    private static final int MAX_PATH = 200;
    /** 玩家中心离开平台多远算离开（站在边沿时中心可以伸出半个身位） */
    private static final double EDGE = 0.3;
    /** 只有弓射出的箭判 weak（第四稿 Q24）：弩射出的都是暴击箭（F14），三叉戟都不是暴击、也没有拉满一说（F20） */
    private static final String BOW = "minecraft:bow";

    /** 一个标靶：方块坐标 + 指定的面（Q2）。 */
    public record Target(BlockPos pos, Direction face) {}

    /** prepare 的 bow：本轮的标靶（Q3）。 */
    public record Setup(List<Target> targets) {}

    /** expect.bow：每个标靶都被一支有效的箭射中过指定面（Q7）。 */
    public record Spec(List<Target> targets) {}

    /** 本轮射出的一支箭（Q8）。 */
    private static final class Shot {
        final int n;
        final UUID uuid;
        final long ms;
        final boolean crit;
        /** 射出它的武器的物品 id（F14，{@code getWeaponItem}）；读不到 → null */
        final String weapon;
        final Vec3 from;
        final Vec3 velocity;
        final Vec3 playerPos;
        final float yaw, pitch;
        final List<Vec3> path = new ArrayList<>();
        int age;
        String result; // null = 还在飞
        Long resultMs;
        BlockPos block;
        Direction face;
        Vec3 point;
        Integer target;
        Double err;
        Vec3 offset;

        Shot(int n, AbstractArrow arrow, ServerPlayer player) {
            this.n = n;
            this.uuid = arrow.getUUID();
            this.ms = System.currentTimeMillis();
            this.crit = arrow.isCritArrow();
            ItemStack w = arrow.getWeaponItem();
            this.weapon = w == null || w.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(w.getItem()).toString();
            this.from = arrow.position();
            this.velocity = arrow.getDeltaMovement();
            this.playerPos = player.position();
            this.yaw = player.getYRot();
            this.pitch = player.getXRot();
            path.add(from);
        }
    }

    /** 进行中的一轮。 */
    private static final class Round {
        final BlockPos origin;
        final UUID player;
        final List<Target> targets;
        final boolean[] hit;
        final List<Shot> shots = new ArrayList<>();
        Long leftAtMs;

        Round(BlockPos origin, UUID player, List<Target> targets) {
            this.origin = origin;
            this.player = player;
            this.targets = targets;
            this.hit = new boolean[targets.size()];
        }
    }

    private static Round round;

    private BowArena() {}

    /** 面名（north / south / east / west / up / down）→ Direction；不认识的报错。 */
    public static Direction face(String name) {
        for (Direction d : Direction.values()) if (d.getSerializedName().equals(name)) return d;
        throw new IllegalArgumentException("unknown face: " + name + " (north, south, east, west, up, down)");
    }

    public static boolean inField(BlockPos o, BlockPos p) {
        int dx = p.getX() - o.getX(), dy = p.getY() - o.getY(), dz = p.getZ() - o.getZ();
        return dx >= FIELD_X0 && dx <= FIELD_X1 && dz >= FIELD_Z0 && dz <= FIELD_Z1 && dy >= FIELD_Y0 && dy <= FIELD_Y1;
    }

    /** 标靶 1–4 个，都在空场地里，互不重叠。 */
    public static void check(BlockPos o, List<Target> targets) {
        if (targets.isEmpty() || targets.size() > MAX_TARGETS) throw new IllegalArgumentException("bow.targets must have 1-" + MAX_TARGETS + " entries, got " + targets.size());
        for (int i = 0; i < targets.size(); i++) {
            Target t = targets.get(i);
            if (!inField(o, t.pos())) throw new IllegalArgumentException("bow.targets[" + i + "] " + t.pos().toShortString() + " is outside the field");
            for (int j = 0; j < i; j++) if (targets.get(j).pos().equals(t.pos())) throw new IllegalArgumentException("bow.targets[" + i + "] overlaps bow.targets[" + j + "]");
        }
    }

    /** 射击平台的一格（地板或护栏）：射中它判 platform（Q6）。 */
    private static boolean isPlatform(BlockPos o, BlockPos p) {
        int dx = p.getX() - o.getX(), dy = p.getY() - o.getY(), dz = p.getZ() - o.getZ();
        return dx >= -2 && dx <= 1 && Math.abs(dz) <= 2 && dy >= 0 && dy <= 2;
    }

    /** 箭飞出这个范围就算 out（空场地加平台，外扩 MARGIN 格）。 */
    private static AABB bounds(BlockPos o) {
        return new AABB(o.getX() - 2 - MARGIN, o.getY() + FIELD_Y0 - MARGIN, o.getZ() + FIELD_Z0 - MARGIN,
                o.getX() + FIELD_X1 + 1 + MARGIN, o.getY() + FIELD_Y1 + 1 + MARGIN, o.getZ() + FIELD_Z1 + 1 + MARGIN);
    }

    /**
     * 搭场地（Q1）：射击平台和护栏，空场地清成空气（这一带可能有山；上一轮的标靶也在这里清掉）。返回实际改动的方块数。
     * 场外平台由 {@link ArenaManager#build} 照常搭。
     */
    static int build(ServerLevel level, BlockPos o) {
        int ox = o.getX(), oy = o.getY(), oz = o.getZ();
        int placed = 0;
        BlockState air = Blocks.AIR.defaultBlockState();
        for (int x = ox + FIELD_X0; x <= ox + FIELD_X1; x++) {
            for (int z = oz + FIELD_Z0; z <= oz + FIELD_Z1; z++) {
                for (int y = oy + FIELD_Y0; y <= oy + FIELD_Y1; y++) {
                    BlockPos p = new BlockPos(x, y, z);
                    if (level.getBlockState(p).isAir()) continue;
                    level.setBlock(p, air, 2);
                    placed++;
                }
            }
        }
        for (int dx = -2; dx <= 1; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                boolean rail = dx == -2 || Math.abs(dz) == 2;
                if (!rail) placed += set(level, new BlockPos(ox + dx, oy, oz + dz), Blocks.STONE.defaultBlockState());
                for (int dy = 1; dy <= 3; dy++) {
                    BlockState state = rail && dy <= 2 ? Blocks.BARRIER.defaultBlockState() : air;
                    placed += set(level, new BlockPos(ox + dx, oy + dy, oz + dz), state);
                }
            }
        }
        // 场外平台朝场地一侧（x = ox−6）敞开，其他场地靠场地的墙挡住；这里没有墙，补一排 2 格高的屏障
        for (int dz = -2; dz <= 2; dz++) {
            for (int dy = 1; dy <= 2; dy++) placed += set(level, new BlockPos(ox - 5, oy + dy, oz + dz), Blocks.BARRIER.defaultBlockState());
        }
        return placed;
    }

    private static int set(ServerLevel level, BlockPos pos, BlockState state) {
        if (level.getBlockState(pos).equals(state)) return 0;
        level.setBlockAndUpdate(pos, state);
        return 1;
    }

    /** 开始一轮：删掉场地里所有的箭，放本轮的标靶（场地刚由 build 清过）。 */
    static void begin(ServerLevel level, BlockPos o, UUID player, Setup setup) {
        for (Entity e : level.getEntitiesOfClass(AbstractArrow.class, bounds(o))) e.discard();
        for (Target t : setup.targets()) level.setBlockAndUpdate(t.pos(), Blocks.TARGET.defaultBlockState());
        round = new Round(o.immutable(), player, List.copyOf(setup.targets()));
    }

    /** 结束本轮：删掉还在飞的箭。 */
    static void end(ServerLevel level) {
        Round r = round;
        round = null;
        if (r == null) return;
        for (Shot s : r.shots) {
            if (s.result != null) continue;
            Entity e = level.getEntity(s.uuid);
            if (e != null) e.discard();
        }
    }

    static void reset() {
        round = null;
    }

    /** 标靶都还在。 */
    static boolean intact(ServerLevel level) {
        Round r = round;
        if (r == null) return false;
        for (Target t : r.targets) if (!level.getBlockState(t.pos()).is(Blocks.TARGET)) return false;
        return true;
    }

    /** Q7 的到达条件：每个标靶都被一支有效的箭射中过指定面。 */
    static boolean reached() {
        Round r = round;
        if (r == null) return false;
        for (boolean h : r.hit) if (!h) return false;
        return true;
    }

    /** 玩家还在射击平台上（Q7）：脚不低于平台顶面，中心水平方向不超出平台（站在边沿时可以伸出 EDGE）。 */
    static boolean onPlatform(MinecraftServer server, ServerPlayer player, BlockPos o) {
        if (player.level() != server.overworld()) return false;
        double dx = player.getX() - (o.getX() + 0.5), dz = player.getZ() - (o.getZ() + 0.5);
        return Math.abs(dx) <= 1.5 + EDGE && Math.abs(dz) <= 1.5 + EDGE && player.getY() >= o.getY() + 1 - 0.01;
    }

    /** 服务端实体加载：本轮玩家刚射出的箭，登记并改成不能捡（Q8，F7）。 */
    public static void onEntityLoad(Entity entity, ServerLevel level) {
        Round r = round;
        if (r == null || !(entity instanceof AbstractArrow arrow) || arrow.tickCount != 0) return;
        if (!(arrow.getOwner() instanceof ServerPlayer player) || !player.getUUID().equals(r.player)) return;
        arrow.pickup = AbstractArrow.Pickup.DISALLOWED;
        r.shots.add(new Shot(r.shots.size() + 1, arrow, player));
    }

    /** 箭命中方块（{@code AbstractArrowHitMixin}）：判 hit / repeat / wrong_face / platform / out，弓没拉满的记 weak（Q6；弩、三叉戟不判，Q17、Q24）。 */
    public static void onHitBlock(AbstractArrow arrow, BlockHitResult hit) {
        Round r = round;
        if (r == null || arrow.level().isClientSide()) return;
        Shot s = shotOf(r, arrow.getUUID());
        if (s == null || s.result != null) return;
        s.block = hit.getBlockPos().immutable();
        s.face = hit.getDirection();
        s.point = hit.getLocation();
        s.path.add(s.point);
        int idx = -1;
        for (int i = 0; i < r.targets.size(); i++) if (r.targets.get(i).pos().equals(s.block)) idx = i;
        if (idx >= 0) {
            s.target = idx;
            Target t = r.targets.get(idx);
            if (t.face() == s.face) {
                Vec3 center = faceCenter(t);
                s.offset = s.point.subtract(center);
                s.err = planeError(s.offset, t.face());
            }
        }
        String result;
        if (!s.crit && BOW.equals(s.weapon)) result = "weak";
        else if (idx >= 0 && r.targets.get(idx).face() == s.face) {
            if (r.hit[idx]) result = "repeat";
            else {
                r.hit[idx] = true;
                result = "hit";
            }
        } else if (idx >= 0) result = "wrong_face";
        else if (isPlatform(r.origin, s.block)) result = "platform";
        else result = "out";
        resolve(s, result);
    }

    private static void resolve(Shot s, String result) {
        s.result = result;
        s.resultMs = System.currentTimeMillis();
    }

    private static Shot shotOf(Round r, UUID uuid) {
        for (Shot s : r.shots) if (s.uuid.equals(uuid)) return s;
        return null;
    }

    /** 指定面的中点（Q2）：方块中心沿面的法线移半格。 */
    public static Vec3 faceCenter(Target t) {
        return Vec3.atCenterOf(t.pos()).add(t.face().getStepX() * 0.5, t.face().getStepY() * 0.5, t.face().getStepZ() * 0.5);
    }

    /** 面内两个方向的偏差取大的（同标靶方块的算法，F6）。 */
    static double planeError(Vec3 offset, Direction face) {
        return switch (face.getAxis()) {
            case X -> Math.max(Math.abs(offset.y), Math.abs(offset.z));
            case Y -> Math.max(Math.abs(offset.x), Math.abs(offset.z));
            case Z -> Math.max(Math.abs(offset.x), Math.abs(offset.y));
        };
    }

    /**
     * 服务器 tick（Q7、Q8）：记还在飞的箭的位置，飞出场地的记 out 并删掉，被别的原因删掉的、10 秒还没结果的记 stuck；
     * 玩家离开平台就记下时刻并传送到场外平台。
     */
    static void tick(MinecraftServer server, ServerPlayer player) {
        Round r = round;
        if (r == null) return;
        ServerLevel level = server.overworld();
        AABB bounds = bounds(r.origin);
        for (Shot s : r.shots) {
            if (s.result != null) continue;
            Entity e = level.getEntity(s.uuid);
            if (e == null || e.isRemoved()) {
                resolve(s, s.path.isEmpty() || bounds.contains(s.path.get(s.path.size() - 1)) ? "stuck" : "out");
                continue;
            }
            Vec3 p = e.position();
            if (s.path.size() < MAX_PATH) s.path.add(p);
            if (!bounds.contains(p)) {
                resolve(s, "out");
                e.discard();
            } else if (++s.age >= STUCK_TICKS) {
                resolve(s, "stuck");
            }
        }
        if (r.leftAtMs == null && !onPlatform(server, player, r.origin)) {
            r.leftAtMs = System.currentTimeMillis();
            player.stopRiding();
            ArenaManager.teleportOutside(server, player, r.origin);
        }
    }

    /** 还在飞的箭有几支（Q7 的 out-of-arrows 用）。 */
    static int flying() {
        Round r = round;
        if (r == null) return 0;
        int n = 0;
        for (Shot s : r.shots) if (s.result == null) n++;
        return n;
    }

    /** 弩装着的箭按 id 加进 out（Q17，F18）。 */
    private static void addCharged(ItemStack stack, Map<String, Integer> out) {
        ChargedProjectiles charged = stack.get(DataComponents.CHARGED_PROJECTILES);
        if (charged == null || charged.isEmpty()) return;
        for (ItemStack p : charged.getItems()) if (!p.isEmpty()) out.merge(BuiltInRegistries.ITEM.getKey(p.getItem()).toString(), p.getCount(), Integer::sum);
    }

    /**
     * status 的 loaded（Q17，F18）：物品栏、光标、场内地上的掉落物里，所有弩装着的东西 { id: count }。
     * 装在弩里的箭存在组件里，held / carried / dropped 按物品 id 数不到它。
     */
    static Map<String, Integer> loaded(ServerPlayer player, ServerLevel level, AABB box) {
        Map<String, Integer> out = new LinkedHashMap<>();
        Inventory inv = player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) addCharged(inv.getItem(i), out);
        addCharged(player.containerMenu.getCarried(), out);
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) addCharged(e.getItem(), out);
        return out;
    }

    /** status / finish 的 bow：标靶、每一支箭、命中数、离开平台的时刻（Q9）。 */
    static Map<String, Object> describe() {
        Round r = round;
        Map<String, Object> out = new LinkedHashMap<>();
        if (r == null) return out;
        List<Map<String, Object>> targets = new ArrayList<>();
        int hits = 0;
        for (int i = 0; i < r.targets.size(); i++) {
            Target t = r.targets.get(i);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("pos", pos(t.pos()));
            row.put("face", t.face().getSerializedName());
            row.put("point", vec(faceCenter(t)));
            row.put("hit", r.hit[i]);
            if (r.hit[i]) hits++;
            targets.add(row);
        }
        out.put("targets", targets);
        out.put("hits", hits);
        List<Map<String, Object>> shots = new ArrayList<>();
        for (Shot s : r.shots) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("n", s.n);
            row.put("ms", s.ms);
            row.put("crit", s.crit);
            row.put("weapon", s.weapon);
            row.put("from", vec(s.from));
            row.put("velocity", vec(s.velocity));
            row.put("playerPos", vec(s.playerPos));
            row.put("rotation", Map.of("yaw", (double) s.yaw, "pitch", (double) s.pitch));
            row.put("result", s.result);
            row.put("resultMs", s.resultMs);
            if (s.block != null) {
                row.put("block", pos(s.block));
                row.put("face", s.face.getSerializedName());
                row.put("point", vec(s.point));
            }
            if (s.target != null) row.put("target", s.target);
            if (s.err != null) {
                row.put("err", s.err);
                row.put("offset", vec(s.offset));
            }
            List<List<Double>> path = new ArrayList<>();
            for (Vec3 p : s.path) path.add(vec(p));
            row.put("path", path);
            shots.add(row);
        }
        out.put("arrows", shots);
        out.put("flying", flying());
        out.put("leftPlatformAtMs", r.leftAtMs);
        return out;
    }

    private static List<Integer> pos(BlockPos p) {
        return List.of(p.getX(), p.getY(), p.getZ());
    }

    private static List<Double> vec(Vec3 v) {
        return List.of(round4(v.x), round4(v.y), round4(v.z));
    }

    private static double round4(double d) {
        return Math.round(d * 10000.0) / 10000.0;
    }
}
