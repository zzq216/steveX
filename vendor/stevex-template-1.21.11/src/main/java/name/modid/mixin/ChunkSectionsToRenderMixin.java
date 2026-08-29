package name.modid.mixin;

import com.mojang.blaze3d.textures.GpuSampler;
import name.modid.vision.DepthCapture;
import net.minecraft.client.renderer.chunk.ChunkSectionLayerGroup;
import net.minecraft.client.renderer.chunk.ChunkSectionsToRender;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * v2.24 修复（第二轮）：在 {@link ChunkSectionsToRender#renderGroup} 渲染完
 * {@link ChunkSectionLayerGroup#TRANSLUCENT} 组的瞬间发起 translucent 目标深度的 PBO 回读。
 *
 * <p><b>为什么必须是这个时刻</b>：translucent 目标是帧内内部资源（{@code frame.createInternal}），
 * 其物理纹理只在 {@code frame.execute()} 的 main pass 执行期间被持有（acquire）。main pass 内
 * {@code copyDepthFrom(main)} + TRANSLUCENT 组 LEQUAL 深度写绘制完毕后，translucent 深度即定稿
 * （= 主深度拷贝 + "首个半透明面"，§3.3/§5.4 两深度锚点所需的语义），而 vanilla 自身此时也正
 * 通过 {@code group.outputTarget()} 解引用该目标（{@code ChunkSectionsToRender} L33）——资源存活
 * 由框架保证。
 *
 * <p>任何更晚的注入点（含 {@code targets.clear()} 之前）都落在 {@code frame.execute()} 返回之后：
 * 最后一个使用 translucent 的 pass（透明度后处理链）已把它 release（{@code InternalVirtualResource}
 * 把 physicalResource 置 null），{@code getTranslucentTarget().get()} 抛 NPE → 回读软失败 →
 * 工序 B 恒空。故必须把读取插进 frame 执行流内部，即本注入点。
 *
 * <p>PBO 读命令按顺序排在本帧渲染命令之后：GPU 先执行 TRANSLUCENT 组的绘制再执行本读，数据确定
 * 正确；随后 {@code renderLevel} TAIL 的主深度回读排在更后，两条 PBO 由同一 fence 保证填充完成。
 */
@Mixin(ChunkSectionsToRender.class)
public abstract class ChunkSectionsToRenderMixin {

    @Inject(method = "renderGroup", at = @At("TAIL"))
    private void onRenderGroupTail(
            final ChunkSectionLayerGroup group,
            final GpuSampler sampler,
            final CallbackInfo ci
    ) {
        if (group == ChunkSectionLayerGroup.TRANSLUCENT) {
            DepthCapture.prepareTranslucentRead();
        }
    }
}
