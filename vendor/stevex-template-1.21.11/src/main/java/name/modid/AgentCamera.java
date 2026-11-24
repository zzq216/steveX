package name.modid;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * 视角控制 —— 模拟鼠标移动（docs/视角平滑转动设计方案.md）。
 * API 参数单位：度（degree）。
 *
 * <p>两种转法，终点完全相同（S2）：
 * <ul>
 *   <li>平滑（缺省）：按最小加加速度曲线（10t³ − 15t⁴ + 6t⁵）每帧推进，平均角速度 speed 度/秒；最后一帧精确落在终点；</li>
 *   <li>瞬间（instant）：一步到位，和原来的实现一样。</li>
 * </ul>
 * 终点在调用时一次算定：偏航走最短路径，俯仰夹在 ±90°；增量的换算和原来调用 {@code LocalPlayer.turn} 时逐位相同。
 * 两种转法都在视角真正到位之后才完成返回的 future（S1）。
 *
 * <p>转动状态只在客户端主线程上读写：{@link #onFrame} 由 {@code MouseHandlerMixin}（每帧）和客户端 tick 调用。
 */
public class AgentCamera {

    private static final Minecraft mc = Minecraft.getInstance();
    private static final double RAW_PER_DEGREE = 1.0 / 0.15;
    /** 缺省平均角速度（度/秒）：180° 用 0.5 秒 */
    public static final double DEFAULT_SPEED = 360.0;
    public static final double MIN_SPEED = 30.0;
    public static final double MAX_SPEED = 3600.0;

    /** 一次进行中的转动 */
    private static final class Motion {
        final float startYaw, startPitch, targetYaw, targetPitch;
        final long startNs, durationNs;
        final CompletableFuture<Map<String, Object>> done;

        Motion(float startYaw, float startPitch, float targetYaw, float targetPitch, long durationNs, CompletableFuture<Map<String, Object>> done) {
            this.startYaw = startYaw;
            this.startPitch = startPitch;
            this.targetYaw = targetYaw;
            this.targetPitch = targetPitch;
            this.startNs = System.nanoTime();
            this.durationNs = durationNs;
            this.done = done;
        }
    }

    private static Motion motion;

    /** 增量旋转。dx=水平角度, dy=垂直角度（度），水平自动走最短路径 */
    public static CompletableFuture<Map<String, Object>> turn(double dx, double dy, boolean instant, double speed) {
        CompletableFuture<Map<String, Object>> done = new CompletableFuture<>();
        mc.execute(() -> {
            LocalPlayer p = mc.player;
            if (p == null) {
                done.completeExceptionally(new IllegalStateException("not in a world"));
                return;
            }
            start(p, Mth.wrapDegrees(dx), dy, instant, speed, done);
        });
        return done;
    }

    /** 注视指定坐标 */
    public static CompletableFuture<Map<String, Object>> lookAt(double x, double y, double z, boolean instant, double speed) {
        CompletableFuture<Map<String, Object>> done = new CompletableFuture<>();
        mc.execute(() -> {
            LocalPlayer p = mc.player;
            if (p == null) {
                done.completeExceptionally(new IllegalStateException("not in a world"));
                return;
            }
            Vec3 eye = p.getEyePosition();

            double dx = x - eye.x;
            double dy = y - eye.y;
            double dz = z - eye.z;
            double hDist = Math.sqrt(dx * dx + dz * dz);

            double targetYaw   = Math.toDegrees(Math.atan2(-dx, dz));
            double targetPitch = Math.toDegrees(-Math.atan2(dy, hDist));

            double deltaYaw   = Mth.wrapDegrees(targetYaw   - p.getYRot());
            double deltaPitch = Mth.wrapDegrees(targetPitch - p.getXRot());

            start(p, deltaYaw, deltaPitch, instant, speed, done);
        });
        return done;
    }

    /**
     * 开始一次转动（客户端主线程）。终点的算法和原来 {@code p.turn(dYaw / 0.15, dPitch / 0.15)} 逐位相同（{@code Entity.turn}：
     * 先转成 float 再乘 0.15F，俯仰夹在 ±90°）。上一次还没转完就被这一次取代，它的 future 以错误结束。
     */
    private static void start(LocalPlayer p, double dYaw, double dPitch, boolean instant, double speed, CompletableFuture<Map<String, Object>> done) {
        float yaw0 = p.getYRot();
        float pitch0 = p.getXRot();
        float stepYaw = (float) (dYaw * RAW_PER_DEGREE) * 0.15F;
        float stepPitch = (float) (dPitch * RAW_PER_DEGREE) * 0.15F;
        float targetYaw = yaw0 + stepYaw;
        float targetPitch = Mth.clamp(pitch0 + stepPitch, -90.0F, 90.0F);
        Motion previous = motion;
        motion = null;
        if (previous != null) previous.done.completeExceptionally(new IllegalStateException("camera move superseded by a newer camera call"));
        double angle = Math.hypot(targetYaw - yaw0, targetPitch - pitch0);
        if (instant || angle == 0) {
            apply(p, targetYaw, targetPitch);
            done.complete(result(p, 0));
            return;
        }
        long durationNs = (long) (angle / speed * 1e9);
        motion = new Motion(yaw0, pitch0, targetYaw, targetPitch, durationNs, done);
    }

    /** 每帧推进（客户端主线程）：按经过的时间取曲线上的位置；到时间就精确落在终点、完成 future */
    public static void onFrame() {
        Motion m = motion;
        if (m == null) return;
        LocalPlayer p = mc.player;
        if (p == null) {
            motion = null;
            m.done.completeExceptionally(new IllegalStateException("left the world while turning"));
            return;
        }
        double t = m.durationNs <= 0 ? 1.0 : (System.nanoTime() - m.startNs) / (double) m.durationNs;
        if (t >= 1.0) {
            motion = null;
            apply(p, m.targetYaw, m.targetPitch);
            m.done.complete(result(p, (System.nanoTime() - m.startNs) / 1_000_000L));
            return;
        }
        double s = t * t * t * (10 - 15 * t + 6 * t * t);
        apply(p, m.startYaw + (float) (s * (m.targetYaw - m.startYaw)), m.startPitch + (float) (s * (m.targetPitch - m.startPitch)));
    }

    /** 把视角设到 (yaw, pitch)，其余和 {@code Entity.turn} 一样：上一帧的角度跟着加同样的增量（不做帧间插值），通知坐骑 */
    private static void apply(LocalPlayer p, float yaw, float pitch) {
        float dYaw = yaw - p.getYRot();
        float dPitch = pitch - p.getXRot();
        p.setYRot(yaw);
        p.setXRot(pitch);
        p.yRotO += dYaw;
        p.xRotO = Mth.clamp(p.xRotO + dPitch, -90.0F, 90.0F);
        if (p.getVehicle() != null) p.getVehicle().onPassengerTurned(p);
    }

    private static Map<String, Object> result(LocalPlayer p, long ms) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        out.put("yaw", (double) p.getYRot());
        out.put("pitch", (double) p.getXRot());
        out.put("ms", ms);
        return out;
    }

    /** 离开世界时丢掉进行中的转动 */
    public static void reset() {
        Motion m = motion;
        motion = null;
        if (m != null) m.done.completeExceptionally(new IllegalStateException("left the world while turning"));
    }
}
