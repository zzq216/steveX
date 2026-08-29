package name.modid;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * 视角控制 —— 模拟鼠标移动。
 * API 参数单位：度（degree）。内部转换为 turn() 所需的鼠标 Raw Input 单位。
 */
public class AgentCamera {

    private static final Minecraft mc = Minecraft.getInstance();
    private static final double RAW_PER_DEGREE = 1.0 / 0.15;

    /** 增量旋转。dx=水平角度, dy=垂直角度（度），自动走最短路径 */
    public static void turn(double dx, double dy) {
        mc.execute(() -> {
            LocalPlayer p = mc.player;
            if (p != null) p.turn(
                Mth.wrapDegrees(dx) * RAW_PER_DEGREE,
                dy * RAW_PER_DEGREE
            );
        });
    }

    /** 注视指定坐标 */
    public static void lookAt(double x, double y, double z) {
        mc.execute(() -> {
            LocalPlayer p = mc.player;
            if (p == null) return;

            Vec3 eye = p.getEyePosition();

            double dx = x - eye.x;
            double dy = y - eye.y;
            double dz = z - eye.z;
            double hDist = Math.sqrt(dx * dx + dz * dz);

            double targetYaw   = Math.toDegrees(Math.atan2(-dx, dz));
            double targetPitch = Math.toDegrees(-Math.atan2(dy, hDist));

            double deltaYaw   = Mth.wrapDegrees(targetYaw   - p.getYRot());
            double deltaPitch = Mth.wrapDegrees(targetPitch - p.getXRot());

            p.turn(deltaYaw * RAW_PER_DEGREE, deltaPitch * RAW_PER_DEGREE);
        });
    }
}
