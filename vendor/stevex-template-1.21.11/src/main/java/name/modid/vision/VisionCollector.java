package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.storage.TagValueOutput;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;

/**
 * 视觉系统 —— 序列化中枢 + Tier-2 实体 NBT + 数据层访问。
 *
 * <p>v2（GPU 深度缓冲驱动）重构后，本类收窄为"非采集"部分：
 * <ul>
 *   <li><b>Tier-2 实体全量 NBT</b>：{@link #collectEntityNbt(UUID, boolean)} 按需序列化 + TTL 缓存</li>
 *   <li><b>BlockState 序列化</b>：blockId / stateProps 助手</li>
 *   <li><b>快照记录类型</b>：BlockEntitySnapshot / TerrainBlockSnapshot / EntityLightSnapshot，
 *       供深度驱动采集管线与各 store 复用</li>
 *   <li><b>数据层</b>：持有一个 {@link VisionBlockEntityStore} 实例（增量持久化）</li>
 * </ul>
 *
 * <p>原 v1 采集逻辑（Path A/B/C/D 遍历、visibleSections 帧缓存、collectAndSave）已删除，
 * 由 v2 的 DepthCapture → Unprojector → ObjectResolver 三阶段管线取代。
 */
public class VisionCollector {

    private static final Logger LOGGER = LogUtils.getLogger();

    /** NBT 持久化存储 —— 增量保存，自动去重。 */
    private static final VisionBlockEntityStore store = new VisionBlockEntityStore();

    /** 地形方块快照存储 —— 快照覆盖写（v2 起内容 = 本次可见方块，无 scannedSections）。 */
    private static final VisionTerrainStore terrainStore = new VisionTerrainStore();

    /** 实体轻量快照存储 —— 快照覆盖写（v2 起内容 = 本次可见实体，无 scannedSections）。 */
    private static final VisionEntityStore entityStore = new VisionEntityStore();

    /**
     * 实体全量 NBT 的 TTL 缓存（uuid → 最近一次序列化结果）。
     *
     * <p>防呆：即使"按需"查询，agent 若每 tick 轮询同一实体仍会反复全量序列化。
     * 同一 uuid 在 {@code ENTITY_NBT_TTL_MS}（1000ms）内命中缓存直接返回，除非
     * {@code force:true}。仅在渲染线程访问，无需同步；LRU 上限 256 防无限增长。
     */
    private static final long ENTITY_NBT_TTL_MS = 1000L;
    private static final Map<UUID, CachedEntityNbt> entityNbtCache =
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(final Map.Entry<UUID, CachedEntityNbt> eldest) {
                    return size() > 256;
                }
            };

    // ==================== 实体全量 NBT（按需，低频） ====================

    /**
     * 按 uuid 查询实体全量 NBT（Tier 2：{@code saveWithoutId}，含背包/血量/属性等）。
     *
     * <p>低频路径：只在 agent 明确请求某个实体时触发，且同一 uuid 在 1000ms 内
     * 命中 TTL 缓存直接返回（除非 {@code force:true}），防止反复全量序列化。
     * 必须在渲染线程上调用（通过 {@link Minecraft#execute(Runnable)}）。
     *
     * @return 完整实体 NBT（含 id / UUID / Pos / Motion / Rotation + 类型专属数据），
     *         找不到实体或无法序列化时返回 null
     */
    public static CompoundTag collectEntityNbt(final UUID uuid, final boolean force) {
        ClientLevel level = Minecraft.getInstance().level;
        if (level == null) return null;

        long now = System.currentTimeMillis();
        CachedEntityNbt cached = entityNbtCache.get(uuid);
        if (!force && cached != null && now - cached.lastMillis() < ENTITY_NBT_TTL_MS) {
            return cached.nbt();
        }

        // Level.getEntities() 是 protected，无法从外部访问；线性匹配已足够（低频 + TTL 缓存）
        Entity entity = null;
        for (Entity candidate : level.entitiesForRendering()) {
            if (candidate.getUUID().equals(uuid)) {
                entity = candidate;
                break;
            }
        }
        if (entity == null || entity.isRemoved()) return null;

        // getEncodeId() 是 protected；用注册表 key 等价取 id，且类型需可序列化（如玩家返回 null）
        if (!entity.getType().canSerialize()) return null;
        String encodeId = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();

        try (ProblemReporter.ScopedCollector reporter =
                     new ProblemReporter.ScopedCollector(entity.problemPath(), LOGGER)) {
            TagValueOutput output = TagValueOutput.createWithContext(reporter, entity.registryAccess());
            output.putString("id", encodeId);
            entity.saveWithoutId(output);
            CompoundTag nbt = output.buildResult();
            entityNbtCache.put(uuid, new CachedEntityNbt(now, nbt));
            return nbt;
        } catch (Exception e) {
            LOGGER.warn("[Vision] Failed to serialize entity {}: {}", uuid, e.getMessage());
            return null;
        }
    }

    /** TTL 缓存条目：序列化时刻 + 结果 NBT。 */
    private record CachedEntityNbt(long lastMillis, CompoundTag nbt) {}

    // ==================== BlockState 序列化（供 ObjectResolver 复用，v2.2 改 package-private） ====================

    /** 方块注册名，如 "minecraft:chest"。 */
    static String blockId(final BlockState state) {
        if (state == null) return "";
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    /** 方块状态属性，如 {"facing":"east","waterlogged":"false"}。 */
    static Map<String, String> stateProps(final BlockState state) {
        Map<String, String> props = new LinkedHashMap<>();
        if (state == null) return props;
        for (Property<?> prop : state.getProperties()) {
            props.put(prop.getName(), String.valueOf(state.getValue(prop)));
        }
        return props;
    }

    // ==================== 数据结构 ====================

    public record BlockEntitySnapshot(
            BlockPos pos,
            String typeId,
            String blockId,
            Map<String, String> stateProps,
            CompoundTag nbt,
            long timestamp
    ) {}

    /**
     * 地形方块快照：只有 block + state，没有 NBT（块实体由方块实体通道单独采集）。
     *
     * <p>v2.23（§7.11）：{@code surface} 字段已移除——减量改由采集侧 {@link DeletionJudge}
     * 用记忆侧反向通道 cells 文件逐块深度判定（v2.22 的「表面点 → 记忆侧 DDA 投票」因稀疏
     * 采样盲区被完全取代）；{@code Unprojector.visibleBlockHits} 内部的 nudged 点仍保留，
     * 供 §5.1 方块直查 / air 近侧回退使用（不落盘）。
     */
    public record TerrainBlockSnapshot(
            BlockPos pos,
            String blockId,
            Map<String, String> stateProps,
            long timestamp
    ) {}

    /**
     * 实体轻量物理状态（Tier 1）：纯字段读取即可获得，不含 NBT。
     * 全量 NBT 走 {@link #collectEntityNbt(UUID, boolean)} 按需查询。
     */
    public record EntityLightSnapshot(
            int id,
            UUID uuid,
            String typeId,
            double x, double y, double z,
            float yaw, float pitch,
            double vx, double vy, double vz,
            boolean onGround,
            float health
    ) {}

    // ==================== 查询接口 ====================

    public static VisionBlockEntityStore getStore() {
        return store;
    }

    public static VisionTerrainStore getTerrainStore() {
        return terrainStore;
    }

    public static VisionEntityStore getEntityStore() {
        return entityStore;
    }
}
