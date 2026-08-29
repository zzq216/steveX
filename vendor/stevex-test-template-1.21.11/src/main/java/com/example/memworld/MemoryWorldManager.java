package com.example.memworld;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorSettings;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.storage.LevelStorageSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 记忆世界的创建 / 打开 / 服务器集成。
 *
 * <p>客户端启动后自动创建或进入记忆世界（创造模式 + 作弊模式、超平坦空世界），
 * 进入后由 {@link MemoryRestorer} 持续把源 NBT 文件里的方块实体复原到世界中。
 */
public final class MemoryWorldManager {

    private static final Logger LOGGER = LoggerFactory.getLogger("stevex-test/memory");

    private static final MemoryRestorer RESTORER = new MemoryRestorer();
    // v2.10：TerrainRestorer 需持有方块实体通道，用于在方块类型改变且新方块无 BE 时清除旧 BE 记录
    private static final TerrainRestorer TERRAIN = new TerrainRestorer(RESTORER);
    private static final EntityRestorer ENTITY = new EntityRestorer();
    // v2.23（§7.11）：减量执行器（消费采集侧 deletions）+ 反向通道上报器（写 memory_cells.bin）
    // 前者持有方块实体通道（删块清 BE）；后者持有地形 + 实体通道（上报实心不透明块 + 实体占用格）
    private static final DeletionApplier DELETION = new DeletionApplier(RESTORER, ENTITY);
    private static final MemoryCellReporter CELLS = new MemoryCellReporter(TERRAIN, ENTITY);
    private static MinecraftServer lastServer;
    private static boolean clientStarted;

    /** 当前服务器是否已对玩家做过"创造 + 飞行 + 传送"的一次性初始化。 */
    private static boolean playerReady;

    private MemoryWorldManager() {}

    // ==================== 客户端：启动进入记忆世界 ====================

    /** 由 ClientTickEvents 每 tick 调用；等到标题界面出现后一次性创建/打开记忆世界。 */
    public static void onClientTick(final Minecraft mc) {
        if (clientStarted) return;
        if (mc.level != null) return;                       // 已在世界中
        if (mc.getSingleplayerServer() != null) return;     // 正在进入服务器
        if (mc.screen == null) return;                      // 等标题界面出现

        clientStarted = true;
        mc.execute(() -> bootstrap(mc));
    }

    private static void bootstrap(final Minecraft mc) {
        MemoryConfig config = MemoryConfig.get();
        if (!config.autoOpenOnLaunch) return;

        // 首次启动一次性初始化客户端设置（语言/音量/字幕），之后不再重复
        applyClientDefaults(mc);

        String worldId = config.worldName;
        LevelStorageSource storage = mc.getLevelSource();
        Screen parent = mc.screen;

        if (config.resetOnLaunch && storage.levelExists(worldId)) {
            deleteWorld(storage, worldId);
        }

        if (storage.levelExists(worldId)) {
            LOGGER.info("[MemoryWorld] Opening existing memory world '{}'", worldId);
            mc.createWorldOpenFlows().openWorld(worldId, () ->
                    LOGGER.warn("[MemoryWorld] Cancelled opening memory world"));
        } else {
            LOGGER.info("[MemoryWorld] Creating memory world '{}' (creative + cheats)", worldId);
            LevelSettings settings = new LevelSettings(
                    worldId,
                    GameType.CREATIVE,   // 创造模式
                    false,               // 非硬核
                    Difficulty.PEACEFUL,
                    true,                // 允许作弊
                    new GameRules(WorldDataConfiguration.DEFAULT.enabledFeatures()),
                    WorldDataConfiguration.DEFAULT
            );
            mc.createWorldOpenFlows().createFreshLevel(
                    worldId,
                    settings,
                    WorldOptions.defaultWithRandomSeed(),
                    MemoryWorldManager::createVoidWorldDimensions, // 完全空世界（纯虚空）
                    parent
            );
        }
    }

    /**
     * 记忆端客户端设置一次性初始化（仅在第一次启动时执行）。
     *
     * <p>三项设置：语言 → 简体中文、主音量 → 0、隐藏式字幕 → 开。
     * 以标记文件 {@code config/stevex-test/client_defaults.applied} 持久化"已初始化"状态，
     * 后续启动直接跳过（语言经 options.txt 持久化，再次启动读到的就是已设值）。
     */
    private static void applyClientDefaults(final Minecraft mc) {
        Path marker = mc.gameDirectory.toPath().resolve("config").resolve("stevex-test")
                .resolve("client_defaults.applied");
        if (Files.exists(marker)) {
            LOGGER.info("[MemoryWorld] Client defaults already applied, skip");
            return;
        }

        // ① 语言：简体中文。setSelected 只记录 currentCode，须 reloadResourcePacks 才真正生效
        if (!"zh_cn".equals(mc.options.languageCode)) {
            mc.options.languageCode = "zh_cn";
            mc.getLanguageManager().setSelected("zh_cn");
        }
        // ② 主音量 0（1.21.11 无独立 soundMasterVolume，主音量 = SoundSource.MASTER 的 OptionInstance）
        mc.options.getSoundSourceOptionInstance(SoundSource.MASTER).set(0.0);
        // ③ 隐藏式字幕打开
        mc.options.showSubtitles().set(true);
        // 统一持久化到 options.txt
        mc.options.save();
        // 语言重载资源后生效（异步，返回的 future 可忽略）
        mc.reloadResourcePacks();

        // 写入标记，确保整个生命周期只初始化一次
        try {
            Files.createDirectories(marker.getParent());
            Files.writeString(marker, Long.toString(System.currentTimeMillis()));
            LOGGER.info("[MemoryWorld] Client defaults applied: language=zh_cn, masterVolume=0, subtitles=on");
        } catch (IOException e) {
            LOGGER.warn("[MemoryWorld] Failed to write client defaults marker: {}", e.getMessage());
        }
    }

    private static void deleteWorld(final LevelStorageSource storage, final String worldId) {
        try {
            LevelStorageSource.LevelStorageAccess access = storage.validateAndCreateAccess(worldId);
            try {
                access.deleteLevel();
            } finally {
                access.safeClose();
            }
            LOGGER.info("[MemoryWorld] Deleted old memory world '{}'", worldId);
        } catch (Exception e) {
            LOGGER.warn("[MemoryWorld] Failed to delete world '{}': {}", worldId, e.getMessage());
        }
    }

    /**
     * 生成"完全空世界"的主世界维度：没有图层（纯虚空）、没有结构（村庄/要塞）、没有湖泊。
     *
     * <p>下界 / 末地沿用超平坦预设的默认配置，只把主世界换成虚空生成器。
     */
    private static WorldDimensions createVoidWorldDimensions(final HolderLookup.Provider registries) {
        Holder<Biome> plains = registries.lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.PLAINS);
        FlatLevelGeneratorSettings voidSettings = new FlatLevelGeneratorSettings(
                // 空结构覆盖集：禁用所有结构（注意 Optional.empty() 反而会启用全部结构集）
                Optional.of(HolderSet.direct(List.of())),
                plains,            // 平原生物群系（正常昼夜光照，便于查看复原的方块）
                List.of()          // 不生成湖泊
        );
        FlatLevelSource voidGenerator = new FlatLevelSource(voidSettings);

        WorldDimensions flatDimensions = WorldPresets.createFlatWorldDimensions(registries);
        return flatDimensions.replaceOverworldGenerator(registries, voidGenerator);
    }

    // ==================== 服务器：每 tick 驱动复原 ====================

    /** 由 ServerTickEvents 每 tick 调用；只在记忆世界里驱动复原引擎。 */
    public static void onServerTick(final MinecraftServer server) {
        if (server.isDedicatedServer()) return; // 只支持单人内置服务器
        if (server != lastServer) {
            lastServer = server;
            playerReady = false;
            RESTORER.onServerStart();
            TERRAIN.onServerStart();
            ENTITY.onServerStart();
            DELETION.onServerStart();
            CELLS.onServerStart();
            LOGGER.info("[MemoryWorld] Active server level name: '{}' (expected '{}')",
                    server.getWorldData().getLevelName(), MemoryConfig.get().worldName);
        }

        if (!server.getWorldData().getLevelName().equals(MemoryConfig.get().worldName)) return;

        ServerLevel level = server.getLevel(Level.OVERWORLD);
        if (level == null) return;

        // 进入记忆世界后一次性：创造 + 飞行，防止掉入虚空（传送职责移至每次更新后的 teleportToPose）
        if (!playerReady) {
            List<ServerPlayer> players = server.getPlayerList().getPlayers();
            if (!players.isEmpty()) {
                setupPlayer(players.get(0));
                // v2.21：一次性设置冻结 gamerule（§7.9）——停随机 tick / 昼夜 / 天气自推进
                applyFreezeGameRules(level, server);
                playerReady = true;
            }
        }

        // 先复原地形（地基），再叠加冻结实体，最后叠加方块实体（功能性方块）
        // v2.23（§7.11）：先增量后减量——DELETION.apply 在本帧增量把当前可见集构建进各 applied 表
        // 之后执行，减量据此拿「当前可见集」作假阳性防护；反序会把删掉的方块经指纹同步立即重建
        //（见 §7.11 执行顺序）。TERRAIN.tick 返回本次 TerrainData（blocks/deletions/cameraPos），
        // 供减量执行；CELLS.tick 在 deletions 应用之后上报下一轮 cells（滞后一快照，设计接受）。
        TerrainRestorer.TerrainData terrain = TERRAIN.tick(level);
        ENTITY.tick(level);
        MemoryRestorer.AgentPose pose = RESTORER.tick(level);
        DELETION.apply(level, terrain, ENTITY.currentUuids());
        CELLS.tick(level);

        // v2.15：每次更新后读位置 + 传送 + 调视角（跟随 agent 最新视角）
        if (pose != null) {
            ServerPlayer player = server.getPlayerList().getPlayers().stream().findFirst().orElse(null);
            if (player != null) {
                teleportToPose(player, level, pose);
            }
        }
    }

    /**
     * 判断给定维度是否属于记忆世界（v2.21：供全局 Mixin / {@code ServerLevelMixin}、
     * {@code LevelMixin} 在分发层取消 tick，见设计 §7.9）。
     *
     * <p>记忆世界与普通主世界同用 {@code minecraft:overworld} 维度，无法按维度区分，
     * 只能按世界名（存档名）判断——与 {@link #onServerTick} 的过滤条件完全一致。
     */
    public static boolean isMemoryWorld(final ServerLevel level) {
        if (level == null) return false;
        MinecraftServer server = level.getServer();
        if (server == null) return false;
        return server.getWorldData().getLevelName().equals(MemoryConfig.get().worldName);
    }

    /**
     * 进入记忆世界时的一次性设置：切到创造模式 + 开启飞行（避免掉入虚空）。
     * 传送职责移至 {@link #teleportToPose}，在每次更新后执行（v2.15）。
     */
    private static void setupPlayer(final ServerPlayer player) {
        player.setGameMode(GameType.CREATIVE);
        player.getAbilities().mayfly = true;
        player.getAbilities().flying = true;
        player.onUpdateAbilities();
    }

    /**
     * v2.21：进入记忆世界后一次性设置冻结 gamerule（§7.9）。
     *
     * <ul>
     *   <li>{@code random_tick_speed=0}：{@code ServerChunkCache.tick} 读它作 tickSpeed，为 0 时
     *       {@code ServerLevel.tickChunk} 整段跳过 → 作物生长 / 冰雪融化 / 藤蔓蔓延 / 岩浆 randomTick
     *       点火全部停止；</li>
     *   <li>{@code advance_time=false} + {@code advance_weather=false}：{@code tickTime} 里分别门控
     *       {@code setDayTime} 与天气推进 → 昼夜 / 天气不再自推进（时间对齐由 {@link MemoryRestorer}
     *       {@code setDayTime} 到采集值，§7.10，不冲突）。</li>
     * </ul>
     *
     * <p>用 {@link GameRules} 常量字段而非字符串（本版本 gamerule 已 snake_case 改名）。gamerule 是
     * 世界级状态、随记忆世界存档持久化，只影响记忆世界；仅在首次进入时设置。
     */
    private static void applyFreezeGameRules(final ServerLevel level, final MinecraftServer server) {
        GameRules rules = level.getGameRules();
        rules.set(GameRules.RANDOM_TICK_SPEED, 0, server);
        rules.set(GameRules.ADVANCE_TIME, false, server);
        rules.set(GameRules.ADVANCE_WEATHER, false, server);
        LOGGER.info("[MemoryWorld] Freeze gamerules applied: random_tick_speed=0, advance_time=false, advance_weather=false");
    }

    /**
     * v2.15：把玩家传送到源文件记录的 agent 位置，并调整到记录的朝向。
     * 旧文件无 yaw/pitch（NaN）时沿用玩家当前朝向。
     *
     * <p>v2.18：agent 坐标为相机（眼睛）双精度坐标，传送时把脚部放到眼睛下方
     * {@code getEyeHeight()} 处，使记忆世界玩家的眼睛精确落在 agent 采集时的眼睛位置。
     *
     * <p>v2.19：同步 agent 基础视场角（{@link #applyFov}），使记忆世界与采集时看到同一
     * 视场角；旧文件无 FOV（{@code -1}）时沿用玩家当前 FOV。
     */
    private static void teleportToPose(final ServerPlayer player, final ServerLevel level,
                                       final MemoryRestorer.AgentPose pose) {
        final float yaw = Float.isNaN(pose.yaw()) ? player.getYRot() : pose.yaw();
        final float pitch = Float.isNaN(pose.pitch()) ? player.getXRot() : pose.pitch();
        // 空 relative 集合 = 绝对坐标；眼睛 = agentPos，脚部 = 眼睛 − eyeHeight（还原同一视角）
        final double eyeHeight = player.getEyeHeight();
        player.teleportTo(level, pose.pos().x, pose.pos().y - eyeHeight, pose.pos().z,
                Set.of(), yaw, pitch, true);
        // v2.19：同步 agent 基础视场角（客户端选项，经 mc.execute 在渲染线程设置）
        applyFov(pose.fov());
        LOGGER.info("[MemoryWorld] Player teleported to agent eye pose {},{},{} yaw={} pitch={}",
                pose.pos().x, pose.pos().y, pose.pos().z, yaw, pitch);
    }

    /**
     * v2.19：把 agent 基础视场角应用到记忆世界客户端。
     *
     * <p>FOV 是客户端 {@code options.fov()}（与 yaw/pitch 不同，后者是服务端玩家的旋转），
     * 须经 {@code Minecraft.getInstance().execute} 在渲染线程设置；与当前值相等则跳过，
     * 避免每次传送都写 options.txt。旧文件 FOV 为 {@code -1} → 不改（沿用本地默认）。
     */
    private static void applyFov(final int fov) {
        if (fov < 0) return;
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            if (mc.options.fov().get() == fov) return;
            mc.options.fov().set(fov);
            mc.options.save();
            LOGGER.info("[MemoryWorld] Applied agent FOV {}", fov);
        });
    }

    /** 命令触发：强制重新读取源文件并同步世界。 */
    public static void forceRestore(final MinecraftServer server) {
        if (server == null) return;
        RESTORER.forceRefresh();
        TERRAIN.forceRefresh();
        ENTITY.forceRefresh();
    }
}
