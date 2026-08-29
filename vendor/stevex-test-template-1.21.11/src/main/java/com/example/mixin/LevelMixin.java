package com.example.mixin;

import com.example.memworld.MemoryWorldManager;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * v2.21 全局冻结：取消记忆世界里的方块实体 tick（{@code Level.tickBlockEntities}）。
 *
 * <p>{@code tickBlockEntities} 定义在 {@link Level}（Level.java:524，public），由
 * {@code ServerLevel.tick} 调用（ServerLevel.java:434），是方块实体 tick 的<b>唯一分发入口</b>。
 * 在分发点取消 = 熔炉 / 漏斗 / 刷怪笼 / 活塞移动方块动画 / 潜影盒等<b>全部</b>方块实体停在 NBT
 * 记录的初始状态——正符合"冻结复现"（设计 §7.9 陷阱 ③：BE 初始状态通常无害，多数读 NBT 字段
 * 即正确渲染，不依赖首次 tick）。
 *
 * <p>目标类是 {@link Level}（而非 {@link ServerLevel}）——方法定义在 Level，注入父类目标即覆盖
 * 全部子类；客户端维度（如单人世界的客户端 Level）不受影响，仅记忆世界（服务端）被取消。
 */
@Mixin(Level.class)
public abstract class LevelMixin {

    @Inject(method = "tickBlockEntities", at = @At("HEAD"), cancellable = true)
    private void stevex$freezeBlockEntityTick(final CallbackInfo ci) {
        if ((Object) this instanceof ServerLevel serverLevel && MemoryWorldManager.isMemoryWorld(serverLevel)) {
            ci.cancel();
        }
    }
}
