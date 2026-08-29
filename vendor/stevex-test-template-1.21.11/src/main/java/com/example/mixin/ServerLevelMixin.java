package com.example.mixin;

import com.example.memworld.EntityRestorer;
import com.example.memworld.MemoryWorldManager;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.material.Fluid;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * v2.21 全局冻结：在<b>分发层</b>取消记忆世界里的全部排程方块 / 流体 / 实体 tick。
 *
 * <p>为何选这三个注入点而非逐方块 / 逐实体 Mixin（设计 §7.9）：
 *
 * <ul>
 *   <li>{@code tickBlock}/{@code tickFluid} 是 {@code LevelTicks} 队列到方块 / 流体的
 *       <b>唯一分发入口</b>——{@code ServerLevel.tick} 里 {@code blockTicks.tick(..., this::tickBlock)}
 *       把队列里到期的排程 tick 逐个分发到 {@code state.tick}。在分发点取消 = 红石 / 活塞 / TNT /
 *       火焰 / 树叶衰减 / 重力方块（含下落方块、脚手架、滴水石锥，覆盖旧 v2.17 三个 Mixin）
 *       与流体流动 / 蒸发（覆盖旧 v2.20 FlowingFluidMixin）<b>全部</b>冻结，一个注入点穷尽所有
 *       方块。</li>
 *   <li>{@code tickNonPassenger} 是所有实体每 tick 的<b>唯一分发入口</b>（对 Restorer 放置的
 *       实体按冻结标记取消）。为何不注入 {@code Entity.tick}：自毁 / 引信 / 寿命逻辑在实体自身
 *       重写的 {@code tick()} 里且<b>不调 super.tick()</b>（如 {@code PrimedTnt.tick} 把引信递减到
 *       {@code explode()} 全写在自身方法内），对 {@code Entity.tick} HEAD 注入根本拦不到；分发层
 *       取消则覆盖 TNT 引信 / 箭矢寿命 / 经验球合并与过期 / 物品旋转等一切 tick 计时器，未来新增
 *       自毁类实体无需再写 Mixin。</li>
 * </ul>
 *
 * <p>识别记忆世界见 {@link MemoryWorldManager#isMemoryWorld}；冻结标记见 {@link EntityRestorer#isFrozen}。
 */
@Mixin(ServerLevel.class)
public abstract class ServerLevelMixin {

    /** 排程方块 tick 分发（ServerLevel.java:801）：冻结红石 / 活塞 / TNT / 火焰 / 重力方块等。 */
    @Inject(method = "tickBlock", at = @At("HEAD"), cancellable = true)
    private void stevex$freezeBlockTick(final BlockPos pos, final Block type, final CallbackInfo ci) {
        if (MemoryWorldManager.isMemoryWorld((ServerLevel) (Object) this)) {
            ci.cancel();
        }
    }

    /** 排程流体 tick 分发（ServerLevel.java:793）：冻结水 / 岩浆流动与蒸发。 */
    @Inject(method = "tickFluid", at = @At("HEAD"), cancellable = true)
    private void stevex$freezeFluidTick(final BlockPos pos, final Fluid type, final CallbackInfo ci) {
        if (MemoryWorldManager.isMemoryWorld((ServerLevel) (Object) this)) {
            ci.cancel();
        }
    }

    /**
     * 实体每 tick 分发（ServerLevel.java:808）：只对 {@link EntityRestorer} 放置并冻结的实体取消，
     * 玩家 / 其他实体不受影响。
     */
    @Inject(method = "tickNonPassenger", at = @At("HEAD"), cancellable = true)
    private void stevex$freezeEntityTick(final Entity entity, final CallbackInfo ci) {
        if (MemoryWorldManager.isMemoryWorld((ServerLevel) (Object) this) && EntityRestorer.isFrozen(entity)) {
            ci.cancel();
        }
    }
}
