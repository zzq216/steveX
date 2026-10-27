package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.nio.file.Path;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;

/**
 * v2.55（多世界记忆隔离，见 docs/多世界记忆隔离设计方案.md §5，D6）：<b>一个世界的全部记忆 store</b>。
 *
 * <p>v2.55 之前各 store 是 {@link VisionCollector} 的静态字段、目录写死 {@code <gameDir>/stevex/vision}，
 * 整个进程只加载一次——换存档后旧世界的记忆原样并进新世界。现在每个世界一组实例，目录 =
 * {@code stevex/vision/worlds/<worldKey>/}；换世界 = 关掉旧的一组、建新的一组（各 store 的构造本就
 * 负责加载既有文件与旧格式迁移，不用逐个写"清空再重载"）。
 *
 * <p><b>线程</b>：切换（{@link #onJoin} / {@link #onDisconnect}）与各 store 的写入都在客户端主线程上；
 * {@link #current()} 是 volatile 读，WS 线程也可以取（{@code VisionApi} 在派发到主线程前取一次，派发后
 * 再核对没换过世界）。
 */
public final class VisionWorldContext {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String ROOT_DIR = "stevex/vision";

    private static volatile VisionWorldContext current;
    /** 最近一次进入的世界（退出后仍保留，用于把 current.json 标成 inWorld:false）。 */
    private static WorldKey.Identity lastIdentity;

    private final WorldKey.Identity identity;
    private final Path dir;
    private final UnionSaveScheduler unionScheduler;
    private final VisionBlockEntityStore blockEntities;
    private final VisionTerrainStore terrain;
    private final VisionEntityStore entities;
    private final VisionBiomeStore biomes;
    private final TerrainUnionStore terrainUnion;
    private final EntityUnionStore entityUnion;
    private final ContainerMemoryStore containers;
    private final SpriteTableCache sprites;

    private VisionWorldContext(final WorldKey.Identity identity, final Path dir) {
        this.identity = identity;
        this.dir = dir;
        this.blockEntities = new VisionBlockEntityStore(dir);
        this.terrain = new VisionTerrainStore(dir);
        this.entities = new VisionEntityStore(dir);
        this.biomes = new VisionBiomeStore(dir);
        // 调度器先于两个 union store 建好——它们的构造会把自己注册进来
        this.unionScheduler = new UnionSaveScheduler();
        this.terrainUnion = new TerrainUnionStore(unionScheduler, dir);
        this.entityUnion = new EntityUnionStore(unionScheduler, dir);
        this.containers = new ContainerMemoryStore(dir);
        this.sprites = new SpriteTableCache(dir);
    }

    /** {@code <gameDir>/stevex/vision}。 */
    public static Path root() {
        return Minecraft.getInstance().gameDirectory.toPath().resolve(ROOT_DIR);
    }

    /** 当前世界；不在世界里（标题界面 / 尚未进入过）→ null。 */
    public static VisionWorldContext current() {
        return current;
    }

    /** 当前世界；不在世界里 → {@link IllegalStateException}（采集 / 提交路径都在 try 内，转成错误返回）。 */
    public static VisionWorldContext require() {
        final VisionWorldContext ctx = current;
        if (ctx == null) throw new IllegalStateException("not in a world");
        return ctx;
    }

    /**
     * 进入世界（JOIN）。同一 worldKey（断线重连）→ 只刷新指针；不同 → 旧组同步落盘关闭 → 建新组 →
     * 最后才写 current.json（另外两个进程看到新指针时，新世界的 store 已就位、旧世界已写完）。
     */
    public static synchronized void onJoin(final Minecraft mc) {
        final WorldKey.Identity id = WorldKey.compute(mc);
        if (id == null) {
            LOGGER.warn("[Vision] Joined a world but could not identify it; memory capture disabled for this session");
            closeCurrent();
            return;
        }
        final Path root = root();
        final VisionWorldContext old = current;
        if (old != null && old.identity.key().equals(id.key())) {
            CurrentWorldFile.writeCurrent(root, id, true);
            lastIdentity = id;
            return;
        }
        closeCurrent();
        CurrentWorldFile.migrateLegacyIfNeeded(root);
        final Path dir = CurrentWorldFile.worldDir(root, id.key());
        current = new VisionWorldContext(id, dir);
        CurrentWorldFile.touchWorldMeta(dir, id);
        CurrentWorldFile.writeCurrent(root, id, true);
        lastIdentity = id;
        LOGGER.info("[Vision] World memory → {} ({} '{}')", dir, id.kind(), id.label());
    }

    /** 退出世界（DISCONNECT）：落盘关闭，指针保留 worldKey、标 inWorld:false（D5）。 */
    public static synchronized void onDisconnect() {
        if (current == null && lastIdentity == null) return;
        closeCurrent();
        if (lastIdentity != null) {
            CurrentWorldFile.writeCurrent(root(), lastIdentity, false);
        }
    }

    private static void closeCurrent() {
        final VisionWorldContext ctx = current;
        if (ctx == null) return;
        current = null;
        ctx.close();
    }

    /** 同步落盘：union 调度器补写并停线程；容器 store 写掉未落盘的脏区（常态已在提交时写过）。 */
    private void close() {
        unionScheduler.close();
        containers.save();
        LOGGER.info("[Vision] World memory closed: {}", dir);
    }

    public WorldKey.Identity identity() {
        return identity;
    }

    public String worldKey() {
        return identity.key();
    }

    public Path dir() {
        return dir;
    }

    VisionBlockEntityStore blockEntities() {
        return blockEntities;
    }

    VisionTerrainStore terrain() {
        return terrain;
    }

    VisionEntityStore entities() {
        return entities;
    }

    VisionBiomeStore biomes() {
        return biomes;
    }

    TerrainUnionStore terrainUnion() {
        return terrainUnion;
    }

    EntityUnionStore entityUnion() {
        return entityUnion;
    }

    ContainerMemoryStore containers() {
        return containers;
    }

    SpriteTableCache sprites() {
        return sprites;
    }
}
