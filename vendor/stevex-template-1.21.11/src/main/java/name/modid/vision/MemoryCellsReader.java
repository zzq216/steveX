package name.modid.vision;

import com.mojang.logging.LogUtils;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
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
 *   [4]      version（1 字节）：1 = 旧版（无维标签）；2 = v2.32 起（带 UTF-8 维 id）
 *
 *   version = 2（v2.32）：
 *   [5..8]   int 维 id 字节长度 L（UTF-8）
 *   [9..9+L) UTF-8 dimensionId（记忆侧活动维）
 *   之后与 version=1 相同（整体偏移 +L+4）：
 *   [..]     int removalPixelThreshold（删除判定像素阈值，采集侧读取）
 *   [..]     double removalMaxRayDist（记忆侧距离球过滤半径，信息性）
 *   [..]     int count（格数）
 *   [..]     count × 8 字节 long（BlockPos.asLong，小端）
 *
 *   version = 1（旧版，读取兼容）：
 *   [5..8]   int removalPixelThreshold
 *   [9..16]  double removalMaxRayDist
 *   [17..20] int count（格数）
 *   [21..]   count × 8 字节 long（BlockPos.asLong，小端）
 * }</pre>
 * <p>version=1 文件没有维标签 → {@link CellsData#dimension()} 为空串；采集侧据此视为
 * 「维度未知」、删除证据置空（宁可不删，不误删）。
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
    /** v2.32：格式版本——1 = 旧版无维标签；2 = v2.32 起带 UTF-8 维 id。两版都读取。 */
    private static final int VERSION_1 = 1;
    private static final int VERSION_2 = 2;
    /** 解析失败 / 文件缺失时的默认阈值（与设计 §7.11 默认一致；正常由文件头提供）。 */
    public static final int DEFAULT_PIXEL_THRESHOLD = 2;
    public static final double DEFAULT_MAX_RAY_DIST = 96.0;

    /**
     * 一帧 cells 数据：待判定记忆格 + 记忆侧下发的删除阈值 + v2.32 维标签。
     *
     * @param dimension 记忆侧写入 cells 时所在的活动维（version=1 旧文件 / 缺失 → 空串 = 维度未知）
     */
    public record CellsData(List<BlockPos> cells, int pixelThreshold, double maxRayDist, String dimension) {
        static final CellsData EMPTY =
                new CellsData(List.of(), DEFAULT_PIXEL_THRESHOLD, DEFAULT_MAX_RAY_DIST, "");
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
            final int ver = bytes[4];
            if (ver != VERSION_1 && ver != VERSION_2) {
                LOGGER.warn("[Vision] Cells file unsupported version {}", ver);
                return null;
            }
            final ByteBuffer buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            int o = 5;
            String dimension = "";
            if (ver == VERSION_2) {
                // v2.32：version=2 → [5..8] 维 id 字节长度 L，[9..9+L) UTF-8 dimensionId
                final int len = buf.getInt(o);
                o += 4;
                if (len < 0 || o + len + 16 > bytes.length) {
                    LOGGER.warn("[Vision] Cells file bad dimension length {} (len={})", len, bytes.length);
                    return null;
                }
                dimension = new String(bytes, o, len, StandardCharsets.UTF_8);
                o += len;
            }
            final int threshold = buf.getInt(o);
            final double maxDist = buf.getDouble(o + 4);
            final int count = buf.getInt(o + 12);
            final int bodyOffset = o + 16;
            if (count < 0 || bytes.length < bodyOffset + (long) count * 8) {
                LOGGER.warn("[Vision] Cells file truncated (count={}, len={})", count, bytes.length);
                return null;
            }
            final List<BlockPos> cells = new ArrayList<>(count);
            buf.position(bodyOffset);
            for (int i = 0; i < count; i++) {
                cells.add(BlockPos.of(buf.getLong()));
            }
            return new CellsData(cells, threshold <= 0 ? DEFAULT_PIXEL_THRESHOLD : threshold,
                    maxDist > 0 ? maxDist : DEFAULT_MAX_RAY_DIST, dimension);
        } catch (IOException e) {
            LOGGER.warn("[Vision] Failed to read cells file {}: {}", path, e.getMessage());
            return null;
        }
    }
}
