package name.modid.mixin;

import name.modid.AgentCamera;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 视角平滑转动（docs/视角平滑转动设计方案.md S3）：真人的鼠标在每帧的 {@code handleAccumulatedMovement} 里转视角，
 * agent 的平滑转动挂在同一处，每帧推进一次（{@link AgentCamera#onFrame}）。
 */
@Mixin(MouseHandler.class)
public abstract class MouseHandlerMixin {

    @Inject(method = "handleAccumulatedMovement", at = @At("TAIL"))
    private void stevex$advanceAgentCamera(CallbackInfo ci) {
        AgentCamera.onFrame();
    }
}
