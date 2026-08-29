package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import org.slf4j.Logger;

/**
 * v2.23（§7.11）反向通道读取器 —— 读取记忆侧 {@code MemoryCellReporter} 写的
 * {@code memory_cells.bin}，供 {@link DeletionJudge} 做逐块深度判定。
 *
 * <p>格式（{@code MemoryCellReporter} 写入，小端）：
 * <pre>{@code
 *   [0..3]   magic "SCEL"（4 字节）
 *   [4]      version = 1（1 字节）
 *   [5..8]   int removalPixelThreshold（删除判定像素阈值，采集侧读取）
 *   [9..16]  double removalMaxRayDist（记忆侧距离球过滤半径，信息性）
 *   [17..20] int count（格数）
 *   [21..]   count × 8 字节 long（BlockPos.asLong，小端）
 * }</pre>
 *
 * <p>读取语义（§7.11）：
 * <ul>
 *   <li><b>mtime 门控</b>：快照时 stat 文件 mtime，未变不读（复用上次解析结果）；</li>
 *   <li><b>半截写防护</b>：解析失败（写中途 / 损坏）→ 保留旧 mtime，下轮重试；</li>
 *   <li><b>优雅降级</b>：文件缺失（记忆侧离线）→ 空格清单 + 默认阈值 → 采集侧无删除证据
 *       → 只增不删（恢复后自愈：记忆侧下次写 cells，采集侧重新判定）。</li>
 * </ul>
 *
 * <p>文件路径 = 本采集器 {@code <gameDir>/stevex/vision/memory_cells.bin}（与 terrain.nbt 同目录；
 * 记忆侧 {@code MemoryConfig.resolveMemoryCellsFile} 自动探测到 terrain.nbt 所在目录、写同一路径）。
 */
public final class MemoryCellsReader {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String DIR_NAME = "stevex/vision";
    private static final String FILE_NAME = "memory_cells.bin";
    private static final byte[] MAGIC = {'S', 'C', 'E', 'L'};
    private static final int VERSION = 1;
    /** 解析失败 / 文件缺失时的默认阈值（与设计 §7.11 默认一致；正常由文件头提供）。 */
    public static final int DEFAULT_PIXEL_THRESHOLD = 2;
    public static final double DEFAULT_MAX_RAY_DIST = 96.0;

    /** 一帧 cells 数据：待判定记忆格 + 记忆侧下发的删除阈值（配置随通道下发，单一来源）。 */
    public record CellsData(List<BlockPos> cells, int pixelThreshold, double maxRayDist) {
        static final CellsData EMPTY = new CellsData(List.of(), DEFAULT_PIXEL_THRESHOLD, DEFAULT_MAX_RAY_DIST);
    }

    private final Path filePath;
    private FileTime lastMtime;
    private CellsData cached;

    public MemoryCellsReader() {
        Path dir = Minecraft.getInstance().gameDirectory.toPath().resolve(DIR_NAME);
        this.filePath = dir.resolve(FILE_NAME);
    }

    /**
     * 读取（mtime 门控）。文件缺失 → 空数据（优雅降级）；解析失败 → 保留旧 mtime、返回上次
     * 结果（或空），下轮重试。快照时调用，成本 = 一次 stat + 偶尔几十 KB 读。
     */
    public CellsData read() {
        if (!Files.exists(filePath)) {
            // 记忆侧离线 / 尚未写过 → 无删除证据 → 优雅降级；文件重新出现后 mtime 变化自然触发读取
            lastMtime = null;
            cached = null;
            return CellsData.EMPTY;
        }
        final FileTime mtime;
        try {
            mtime = Files.getLastModifiedTime(filePath);
        } catch (IOException e) {
            LOGGER.warn("[Vision] Failed to stat cells file {}: {}", filePath, e.getMessage());
            return cached == null ? CellsData.EMPTY : cached;
        }
        if (mtime.equals(lastMtime)) {
            return cached == null ? CellsData.EMPTY : cached; // 未变不读（mtime 门控）
        }

        final CellsData parsed = parse(filePath);
        if (parsed == null) {
            // 半截写 / 损坏 → 不推进 mtime，下轮重试（§7.4 语义）；先用上次结果兜底
            return cached == null ? CellsData.EMPTY : cached;
        }
        lastMtime = mtime; // 只在成功解析后才推进
        cached = parsed;
        LOGGER.debug("[Vision] Read {} memory cells (threshold={}, maxDist={}) from {}",
                parsed.cells().size(), parsed.pixelThreshold(), parsed.maxRayDist(), filePath);
        return parsed;
    }

    /** 解析二进制文件；失败返回 null（调用方不推进 mtime）。 */
    private static CellsData parse(final Path path) {
        try {
            final byte[] bytes = Files.readAllBytes(path);
            if (bytes.length < 21) {
                LOGGER.warn("[Vision] Cells file too short ({} bytes)", bytes.length);
                return null;
            }
            for (int i = 0; i < MAGIC.length; i++) {
                if (bytes[i] != MAGIC[i]) {
                    LOGGER.warn("[Vision] Cells file bad magic at {}: {}", path, path);
                    return null;
                }
            }
            if (bytes[4] != VERSION) {
                LOGGER.warn("[Vision] Cells file unsupported version {}", bytes[4]);
                return null;
            }
            final ByteBuffer buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            final int threshold = buf.getInt(5);
            final double maxDist = buf.getDouble(9);
            final int count = buf.getInt(17);
            if (count < 0 || bytes.length < 21 + (long) count * 8) {
                LOGGER.warn("[Vision] Cells file truncated (count={}, len={})", count, bytes.length);
                return null;
            }
            final List<BlockPos> cells = new ArrayList<>(count);
            buf.position(21);
            for (int i = 0; i < count; i++) {
                cells.add(BlockPos.of(buf.getLong()));
            }
            return new CellsData(cells, threshold <= 0 ? DEFAULT_PIXEL_THRESHOLD : threshold,
                    maxDist > 0 ? maxDist : DEFAULT_MAX_RAY_DIST);
        } catch (IOException e) {
            LOGGER.warn("[Vision] Failed to read cells file {}: {}", path, e.getMessage());
            return null;
        }
    }
}
