package name.modid;

import java.util.List;
import name.modid.arena.LandArena;
import net.minecraft.client.Camera;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix4f;
import org.joml.Vector4f;

/**
 * 陆地寻路训练场的观察标记（docs/陆地寻路训练场设计方案.md Q4b）：起点、各中间点（带序号）、终点各画一根竖直的彩色光柱，
 * 给人看 agent 走到了哪里；已经经过的点变灰。
 *
 * <p>agent 和人用的是同一个客户端画面，所以标记要"画出来，但视觉采集不到"：视觉读的是世界渲染结束时的深度（F15），
 * 这里画在 HUD 层——世界渲染之后、不写深度；不用调试图形（会让采集整帧跳过）、不用粒子（可能写进深度）。
 * 标记不是方块、不是实体，不进任何记忆文件。
 *
 * <p>投影用本帧世界渲染的 P·MV·T(−相机)（和 {@code Unprojector} 的 worldToClip 同一算法），由
 * {@code LevelRendererMixin} 在 renderLevel 结尾交过来。只在有标记时才拷贝矩阵。
 */
public final class LandMarkerHud {

    private static final int[] COLORS = {0xFF33DD55, 0xFFFFCC22, 0xFFFF4444};
    private static final int PASSED = 0xFF888888;
    /** 光柱高 3 格，每 0.15 格画一个点 */
    private static final double HEIGHT = 3.0, STEP = 0.15;

    private static volatile Matrix4f worldToClip;

    private LandMarkerHud() {}

    /** 渲染线程：记下本帧的投影（没有标记时不做事） */
    public static void onFrame(Camera camera, Matrix4f projection, Matrix4f modelView) {
        if (LandArena.markers() == null) {
            worldToClip = null;
            return;
        }
        Vec3 cam = camera.position();
        Matrix4f view = new Matrix4f().translation((float) -cam.x, (float) -cam.y, (float) -cam.z);
        worldToClip = new Matrix4f(projection).mul(modelView).mul(view);
    }

    /** HUD：把每个标记的光柱投到屏幕上 */
    public static void render(GuiGraphics g, DeltaTracker delta) {
        List<LandArena.Marker> list = LandArena.markers();
        Matrix4f pv = worldToClip;
        if (list == null || pv == null) return;
        Minecraft mc = Minecraft.getInstance();
        int gw = g.guiWidth(), gh = g.guiHeight();
        for (LandArena.Marker m : list) {
            int color = m.passed() && m.kind() != 0 ? PASSED : COLORS[Math.max(0, Math.min(2, m.kind()))];
            double[] top = null;
            for (double dy = 0; dy <= HEIGHT; dy += STEP) {
                double[] s = project(pv, m.x(), m.y() + dy, m.z(), gw, gh);
                if (s == null) continue;
                int x = (int) Math.round(s[0]), y = (int) Math.round(s[1]);
                g.fill(x - 1, y - 1, x + 2, y + 2, color);
                top = s;
            }
            if (top != null) g.drawString(mc.font, m.label(), (int) Math.round(top[0]) + 4, (int) Math.round(top[1]) - 4, color, true);
        }
    }

    /** 世界坐标 → GUI 坐标（左上角为原点）；在相机背后或屏幕外 → null */
    private static double[] project(Matrix4f pv, double x, double y, double z, int gw, int gh) {
        Vector4f clip = new Vector4f((float) x, (float) y, (float) z, 1f);
        pv.transform(clip);
        if (clip.w <= 0f) return null;
        double nx = clip.x / clip.w, ny = clip.y / clip.w;
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
        return new double[]{(nx + 1) * 0.5 * gw, (1 - ny) * 0.5 * gh};
    }
}
