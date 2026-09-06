package com.example.memworld;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 记忆世界实体复原引擎 —— 与 {@link TerrainRestorer}（地形）、{@link MemoryRestorer}（方块实体）
 * 并行的第三通道。
 *
 * <p>读取实体源 NBT 文件（{@code entities.nbt}，由 stevex 视觉采集器写入），
 * <b>仅在文件内容发生变化时</b>做增量同步：
 *
 * <ul>
 *   <li><b>放置</b>：按 {@code type} 创建实体（{@code EntityType.create}），强制设为文件里的
 *       uuid，放到记录的坐标，然后<b>冻结</b>（NoAI + NoGravity + Invulnerable + 零速度），
 *       防止在虚空里自由落体 / 游荡 / 死亡</li>
 *   <li><b>移动</b>：已放置的实体位置变化时 {@code teleportTo} 到新坐标（含朝向）</li>
 * </ul>
 *
 * <p><b>纯累积语义（v2，§7）</b>：只放置 / 移动 / 冻结文件里出现的实体，<b>绝不移除</b>。
 * 已删除 v1 的 scannedSections 移除权威——实体走进墙后 / 移出视野时不再可见，就不再更新，
 * 留在记忆世界<b>最后一次可见位置</b>（冻结态），符合"记忆"直觉。
 *
 * <p>v2.23（§7.11）：减量删除由 {@code DeletionApplier} 驱动——冻结实体 <b>全部占用格被采集侧
 * 逐块证明消失</b>（∈ terrain.nbt deletions ∪ 相机格，且不在当前帧实体快照内）时，经
 * {@link #discard} 移除。本类仍不主动删，只暴露查询与删除入口。
 *
 * <p>v2.32（世界类型区分，见 docs/世界类型区分与镜像复原设计方案.md §5）：源文件按维分桶，已放置
 * 实体表 / 快照 uuid 集 / 内容指纹<b>按维隔离</b>——主世界与下界同名实体各自落各自维的 level，
 * 坐标永不跨维碰撞。每 tick 只对 {@code level.dimension()} 桶做放置 / 移动；公开查询
 * （{@link #uuids} / {@link #entities} / {@link #currentUuids} / {@link #allCellsEmpty}）与删除
 * 入口（{@link #discard}）都要带维度参数，调用方（DeletionApplier / MemoryCellReporter）传它正在
 * 处理的那个 level 的维。冻结集合 {@link #FROZEN} 跨维共享（各维被冻结的实体都在其中，防 tick 分发）。
 *
 * <p>{@code applied} 是纯累积的：已放置的实体一直保留，永不因"本次没看到"而移除（删除只走
 * 几何证据路径）。
 */
public class EntityRestorer {

    private static final Logger LOGGER = LoggerFactory.getLogger("stevex-test/memory");

    private static final String KEY_ENTITIES = "entities";
    private static final String KEY_TYPE = "type";
    private static final String KEY_POS = "pos";
    private static final String KEY_MOTION = "motion";
    private static final String KEY_ROTATION = "rotation";
    private static final String KEY_ON_GROUND = "onGround";
    private static final String KEY_HEALTH = "health";

    /** v2.32：已放置的实体按维隔离：维度 → uuid → 实体引用。累积，永不因"本次没看到"而移除。 */
    private final Map<String, Map<UUID, Entity>> appliedByDim = new LinkedHashMap<>();

    /**
     * v2.21 冻结标记（§7.9 陷阱 ②）：本类放置并冻结的实体集合（跨全部维）。
     *
     * <p>本版本已移除 {@code getPersistentData}（全源码搜索为空），冻结标记无法挂到实体 NBT 上，
     * 改用静态内存集合（{@link IdentityHashMap} 支撑，按引用判等、不按 equals）。供
     * {@code ServerLevelMixin.tickNonPassenger} 查询——冻结标记实体在分发层取消实体 tick，
     * 覆盖 TNT 引信 / 箭矢寿命 / 经验球合并与过期等一切自毁计时器。
     */
    private static final Set<Entity> FROZEN = Collections.newSetFromMap(new IdentityHashMap<>());

    /** 查询实体是否为本类放置并冻结的标记实体（v2.21，供全局 Mixin 分发层取消 tick）。 */
    public static boolean isFrozen(final Entity entity) {
        return FROZEN.contains(entity);
    }

    /** v2.32：该维已应用（冻结）实体 uuid 快照副本——调用方（DeletionApplier）可安全遍历后 {@link #discard}。 */
    public List<UUID> uuids(final String dimension) {
        Map<UUID, Entity> applied = appliedByDim.get(dimension);
        return applied == null ? List.of() : new ArrayList<>(applied.keySet());
    }

    /** v2.32：该维已应用（冻结）实体引用快照副本（供 DeletionApplier / MemoryCellReporter 计算 AABB 占用格）。 */
    public List<Entity> entities(final String dimension) {
        Map<UUID, Entity> applied = appliedByDim.get(dimension);
        return applied == null ? List.of() : new ArrayList<>(applied.values());
    }

    /** v2.23：世界变化版本（每次 sync 递增），供 {@link MemoryCellReporter} 触发重算 cells。 */
    private int mutationVersion;

    /** v2.23：世界变化版本（每次 sync 递增）。 */
    public int mutationVersion() {
        return mutationVersion;
    }

    /**
     * v2.22/v2.32：指定维<b>当前可见</b>实体 uuid 集（实体删除的跳过集）——最近一次该维快照
     * 内容，随该维 serve 更新（内容未变化时集合相同，更新无害）。该维尚未出现过 → 空集。
     */
    public Set<UUID> currentUuids(final String dimension) {
        Set<UUID> uuids = lastSnapshotUuidsByDim.get(dimension);
        return uuids == null ? Set.of() : uuids;
    }

    /**
     * v2.22（§7.11）：移除指定维的一个冻结实体（删除入口）。从该维已应用表 + 冻结集合移除并
     * discard；实体快照后续若重新包含该 uuid 会自然重建。
     */
    public void discard(final String dimension, final UUID uuid) {
        Map<UUID, Entity> applied = appliedByDim.get(dimension);
        if (applied == null) return;
        Entity e = applied.remove(uuid);
        if (e != null) {
            FROZEN.remove(e);
            e.discard();
            LOGGER.info("[MemoryWorld] Removed stale entity {} ({}) in [{}]", uuid,
                    e.position().x + "," + e.position().y + "," + e.position().z, dimension);
        }
    }

    /**
     * v2.22（§7.11）：指定维冻结实体 <b>全部 AABB 占用格</b>是否都在 {@code provenEmpty} 中。
     * 占用格即实体 AABB 覆盖的所有方块格；全部被几何证据证明为空 → 该实体在现实中已不存在。
     */
    public boolean allCellsEmpty(final String dimension, final UUID uuid, final Set<BlockPos> provenEmpty) {
        Map<UUID, Entity> applied = appliedByDim.get(dimension);
        if (applied == null) return true;
        Entity e = applied.get(uuid);
        if (e == null || e.isRemoved()) return true;
        final AABB box = e.getBoundingBox();
        final int minX = Mth.floor(box.minX), maxX = Mth.floor(box.maxX);
        final int minY = Mth.floor(box.minY), maxY = Mth.floor(box.maxY);
        final int minZ = Mth.floor(box.minZ), maxZ = Mth.floor(box.maxZ);
        for (int x = minX; x <= maxX; x++) {
            for (int y = minY; y <= maxY; y++) {
                for (int z = minZ; z <= maxZ; z++) {
                    if (!provenEmpty.contains(new BlockPos(x, y, z))) return false;
                }
            }
        }
        return true;
    }

    /** v2.32：已应用版本的源文件内容指纹按维；该维未出现过（null）→ 需要应用。 */
    private final Map<String, String> appliedFingerprintByDim = new LinkedHashMap<>();

    /**
     * v2.32：最近一次该维快照的 uuid 集（= 当前可见实体，entities.nbt 为快照覆盖写），按维。
     * DeletionApplier 删除实体时跳过这些 uuid——当前可见实体绝不可删。
     */
    private final Map<String, Set<UUID>> lastSnapshotUuidsByDim = new LinkedHashMap<>();

    /** v2.32：最近一次成功读取解析出的各维桶（维度 → EntityData），跨 tick 缓存。 */
    private Map<String, EntityData> parsedBuckets = Map.of();

    /** v2.32：一次读取代际内已向调用方交付过数据的维集合。 */
    private final Set<String> servedThisRead = new HashSet<>();

    /** v2.13 mtime 门控（§7.4）：最近一次成功读取的源文件 mtime；未变 → 不读不解压。 */
    private FileTime lastMtime;

    private int ticks;
    private int missingSourceCounter;

    /** 服务器（世界）启动 / 切换时调用，清空已放置状态。 */
    public void onServerStart() {
        appliedByDim.clear();
        FROZEN.clear();
        lastSnapshotUuidsByDim.clear();
        appliedFingerprintByDim.clear();
        parsedBuckets = Map.of();
        servedThisRead.clear();
        lastMtime = null;
        mutationVersion = 0;
        ticks = 0;
        LOGGER.info("[MemoryWorld] Entity restorer ready");
    }

    /** 命令触发：强制重新读取源文件。须同时清 mtime 门控，否则 mtime 相同会被提前拦下。 */
    public void forceRefresh() {
        appliedFingerprintByDim.clear();
        parsedBuckets = Map.of();
        servedThisRead.clear();
        lastMtime = null;
    }

    /**
     * 驱动一次轮询：源文件 mtime 变化时读取（解析全文件各维桶）；之后只对<b>当前 level 维</b>桶做
     * 放置 / 移动同步。文件缺失 / mtime 未变且本代际该维已交付 → 直接返回。
     */
    public void tick(final ServerLevel level) {
        MemoryConfig config = MemoryConfig.get();
        if (ticks++ % Math.max(1, config.pollIntervalTicks) != 0) return;

        Path source = config.resolveEntityFile();
        if (source == null || !Files.exists(source)) {
            if (missingSourceCounter++ % 30 == 0) {
                LOGGER.warn("[MemoryWorld] Entity source file missing, entity restore paused (gameDir={}).",
                        config.gameDirectory());
            }
            lastMtime = null; // 文件重新出现后自然触发首次读取
            servedThisRead.clear();
            appliedFingerprintByDim.clear();
            return;
        }
        missingSourceCounter = 0;

        // v2.13 mtime 门控（§7.4）：文件只在采集器侧 vision/snapshot 落盘时变化 → 以 mtime 作为
        // 快照到达信号。mtime 未变 → 不读不解压（空闲成本≈0）。
        final FileTime mtime;
        try {
            mtime = Files.getLastModifiedTime(source);
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to stat entity file {}: {}", source, e.getMessage());
            return;
        }
        if (!mtime.equals(lastMtime)) {
            Map<String, EntityData> parsed = readFile(source);
            if (parsed == null) return; // 写入半截等 → 保留旧 mtime，下轮重试
            lastMtime = mtime; // 只在成功读取后才推进
            parsedBuckets = parsed;
            servedThisRead.clear();
        }

        final String dim = level.dimension().identifier().toString();
        final EntityData current = parsedBuckets.get(dim);
        if (current == null) return; // 该维还没有数据
        if (servedThisRead.contains(dim)) return; // 本代际已交付
        servedThisRead.add(dim);

        // v2.22：更新该维"当前可见"uuid 集（实体删除跳过集）；内容未变化时集合相同，更新无害
        lastSnapshotUuidsByDim.put(dim, new HashSet<>(current.entities().keySet()));
        String fp = current.fingerprint();
        if (fp.equals(appliedFingerprintByDim.get(dim))) return; // 内容未变化 → 不更新世界
        appliedFingerprintByDim.put(dim, fp);
        mutationVersion++; // v2.23：内容变化 → 通知 MemoryCellReporter

        sync(level, dim, current);
    }

    // ==================== 差异计算与应用 ====================

    private void sync(final ServerLevel level, final String dimension, final EntityData current) {
        if (current.entities.isEmpty()) return;
        Map<UUID, Entity> applied = appliedByDim.computeIfAbsent(dimension, k -> new LinkedHashMap<>());

        // 累积已放置表：本次文件里的实体直接登记（无论是否变化）
        Map<UUID, Entity> nextApplied = new LinkedHashMap<>(applied);

        // 放置 / 移动：文件里有、但应用表里没有（或已失效）→ 新建；位置变化 → 传送
        int spawned = 0;
        int moved = 0;
        for (Map.Entry<UUID, EntitySnapshot> e : current.entities.entrySet()) {
            UUID uuid = e.getKey();
            EntitySnapshot es = e.getValue();

            Entity existing = nextApplied.get(uuid);
            if (existing == null || existing.isRemoved()) {
                // v2.21：旧引用已失效（实体被外力移除）→ 从冻结集合清理，防 IdentityHashMap 泄漏
                if (existing != null) FROZEN.remove(existing);
                Entity created = spawn(level, uuid, es);
                if (created != null) {
                    nextApplied.put(uuid, created);
                    spawned++;
                }
            } else {
                if (move(level, existing, es)) moved++;
            }
        }

        applied.clear();
        applied.putAll(nextApplied);

        LOGGER.info("[MemoryWorld] Entity sync [{}]: +{} spawned, {} moved, total {} entities",
                dimension, spawned, moved, applied.size());
    }

    /** 创建并放置一个冻结实体。成功返回实体引用，失败返回 null。 */
    private Entity spawn(final ServerLevel level, final UUID uuid, final EntitySnapshot es) {
        EntityType<?> type = EntityType.byString(es.type()).orElse(null);
        if (type == null) {
            LOGGER.warn("[MemoryWorld] Unknown entity type '{}' for {}", es.type(), uuid);
            return null;
        }

        Entity entity = type.create(level, EntitySpawnReason.LOAD);
        if (entity == null) return null;

        entity.setUUID(uuid);
        entity.snapTo(es.pos()[0], es.pos()[1], es.pos()[2], es.rot()[0], es.rot()[1]);
        if (es.health() >= 0 && entity instanceof LivingEntity living) {
            living.setHealth(es.health());
        }
        freeze(entity);

        if (!level.addFreshEntity(entity)) {
            LOGGER.warn("[MemoryWorld] Failed to add entity {} ({})", uuid, es.type());
            return null;
        }
        return entity;
    }

    /** 位置变化时传送到新坐标；并重新断言冻结状态。返回是否移动了。 */
    private boolean move(final ServerLevel level, final Entity entity, final EntitySnapshot es) {
        double x = es.pos()[0];
        double y = es.pos()[1];
        double z = es.pos()[2];
        boolean positionChanged = entity.distanceToSqr(x, y, z) > 1.0E-4;
        if (positionChanged) {
            entity.teleportTo(x, y, z);
            entity.setYRot(es.rot()[0]);
            entity.setXRot(es.rot()[1]);
        }
        freeze(entity); // 重新断言，防止被外力解锁
        return positionChanged;
    }

    /**
     * 冻结实体：不开 AI、不受重力、无敌、零速度、不会自然消失。
     * 记忆世界是纯虚空，不冻结的话实体会掉下去 / 自己游荡 / 离开扫描范围。
     */
    private static void freeze(final Entity entity) {
        entity.setNoGravity(true);
        entity.setInvulnerable(true);
        entity.setDeltaMovement(Vec3.ZERO);
        if (entity instanceof Mob mob) {
            mob.setNoAi(true);
            mob.setPersistenceRequired();
        }
        if (entity instanceof ItemEntity item) {
            item.setUnlimitedLifetime();
        }
        // v2.21：登记到冻结集合，供 ServerLevelMixin.tickNonPassenger 分发层取消实体 tick
        //（§7.9 陷阱 ②）——NoAI/Invulnerable 只是"不动/不死"，tick 分发层取消才是"时间冻结"，
        // 一并停掉 TNT 引信 / 箭矢寿命 / 经验球合并与过期等自毁计时器。
        FROZEN.add(entity);
    }

    // ==================== 读取源文件 ====================

    /** 读取整份文件 → 各维 EntityData。旧版单维文件经 {@link WorldsFile#read} 自动包成 overworld 桶。 */
    private Map<String, EntityData> readFile(final Path source) {
        try {
            CompoundTag root = NbtIo.readCompressed(source, NbtAccounter.unlimitedHeap());
            if (root == null) return Map.of();

            WorldsFile.Result r = WorldsFile.read(root);
            Map<String, EntityData> out = new LinkedHashMap<>();
            for (Map.Entry<String, CompoundTag> e : r.worlds().entrySet()) {
                out.put(e.getKey(), parseBucket(e.getValue()));
            }
            return out;
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to read entity file {}: {}", source, e.getMessage());
            return null;
        }
    }

    /** 解析一个维桶（正文形态与旧版文件顶层逐字一致）：entities 表。 */
    private static EntityData parseBucket(final CompoundTag bucket) {
        Map<UUID, EntitySnapshot> entities = new LinkedHashMap<>();
        CompoundTag entitiesTag = bucket.getCompoundOrEmpty(KEY_ENTITIES);
        for (String key : entitiesTag.keySet()) {
            UUID uuid;
            try {
                uuid = UUID.fromString(key);
            } catch (IllegalArgumentException e) {
                continue;
            }
            CompoundTag entry = entitiesTag.getCompoundOrEmpty(key);
            String type = entry.getStringOr(KEY_TYPE, "");
            if (type.isBlank()) continue;

            double[] pos = readDoubleList(entry.getListOrEmpty(KEY_POS), 3);
            if (pos == null) continue;
            double[] motion = readDoubleListDefault(entry.getListOrEmpty(KEY_MOTION), 3);
            float[] rot = readFloatListDefault(entry.getListOrEmpty(KEY_ROTATION), 2);
            boolean onGround = entry.getBooleanOr(KEY_ON_GROUND, false);
            float health = entry.getFloatOr(KEY_HEALTH, -1f);

            entities.put(uuid, new EntitySnapshot(type, pos, motion, rot, onGround, health));
        }
        return new EntityData(entities);
    }

    /** 严格读取：元素不足返回 null（用于 pos）。 */
    private static double[] readDoubleList(final ListTag list, final int required) {
        if (list == null || list.size() < required) return null;
        double[] out = new double[required];
        for (int i = 0; i < required; i++) out[i] = list.getDoubleOr(i, 0.0);
        return out;
    }

    /** 宽松读取：元素不足用 0 补齐（用于 motion / rotation）。 */
    private static double[] readDoubleListDefault(final ListTag list, final int length) {
        double[] out = new double[length];
        if (list != null) {
            for (int i = 0; i < length && i < list.size(); i++) out[i] = list.getDoubleOr(i, 0.0);
        }
        return out;
    }

    private static float[] readFloatListDefault(final ListTag list, final int length) {
        float[] out = new float[length];
        if (list != null) {
            for (int i = 0; i < length && i < list.size(); i++) out[i] = list.getFloatOr(i, 0f);
        }
        return out;
    }

    // ==================== 数据结构 ====================

    private record EntitySnapshot(String type, double[] pos, double[] motion, float[] rot, boolean onGround, float health) {
        String fingerprint() {
            return type + "|" + Arrays.toString(pos) + "|" + Arrays.toString(motion)
                    + "|" + Arrays.toString(rot) + "|" + onGround + "|" + health;
        }
    }

    /** 一帧实体数据：实体表（v2 起无 scannedSections，纯累积语义）。 */
    private record EntityData(Map<UUID, EntitySnapshot> entities) {
        String fingerprint() {
            return entities.toString();
        }
    }
}
