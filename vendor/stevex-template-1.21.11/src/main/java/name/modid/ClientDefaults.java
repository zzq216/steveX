package name.modid;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import net.minecraft.client.GraphicsPreset;
import net.minecraft.client.Minecraft;
import net.minecraft.sounds.SoundSource;
import org.slf4j.Logger;

/**
 * 真实世界（采集端）客户端设置一次性初始化。
 *
 * <p>首次启动设置：语言 → 简体中文、主音量 → 0、隐藏式字幕 → 开、画质 → Fabulous。
 * 以标记文件 {@code config/stevex/client_defaults.applied} 持久化"已初始化"状态，
 * 后续启动直接跳过（值经 options.txt 持久化）。与记忆端 {@code MemoryWorldManager} 的
 * 首启初始化对称，只是挂在标题界面空闲时执行（真实世界需手动进入世界）。
 */
public final class ClientDefaults {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static boolean appliedOnce;

    private ClientDefaults() {}

    /** 由 {@link SteveXClient} 注册到 ClientTickEvents；等标题界面空闲后一次性应用。 */
    public static void onClientTick(final Minecraft mc) {
        if (appliedOnce) return;
        if (mc.level != null) return;                       // 已在世界中
        if (mc.getSingleplayerServer() != null) return;     // 正在进入服务器
        if (mc.screen == null) return;                      // 等标题界面出现
        appliedOnce = true;
        mc.execute(() -> apply(mc));
    }

    private static void apply(final Minecraft mc) {
        Path marker = mc.gameDirectory.toPath().resolve("config").resolve("stevex")
                .resolve("client_defaults.applied");
        if (Files.exists(marker)) {
            LOGGER.info("[ClientDefaults] Already applied, skip");
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
        // ④ 画质 Fabulous
        mc.options.graphicsPreset().set(GraphicsPreset.FABULOUS);
        // 统一持久化到 options.txt
        mc.options.save();
        // 语言重载资源后生效（异步，返回的 future 可忽略）
        mc.reloadResourcePacks();

        // 写入标记，确保整个生命周期只初始化一次
        try {
            Files.createDirectories(marker.getParent());
            Files.writeString(marker, Long.toString(System.currentTimeMillis()));
            LOGGER.info("[ClientDefaults] Applied: language=zh_cn, masterVolume=0, subtitles=on, graphics=fabulous");
        } catch (IOException e) {
            LOGGER.warn("[ClientDefaults] Failed to write marker: {}", e.getMessage());
        }
    }
}
