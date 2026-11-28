package name.modid.mixin;

import name.modid.arena.BowArena;
import net.minecraft.world.entity.projectile.FishingHook;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 浮标的射线命中方块（弓箭训练场设计方案第五稿 F28、Q31）：在 {@code FishingHook.onHitBlock} 开头报给 {@link BowArena#onHitBlock}，
 * 和箭的 {@code AbstractArrowHitMixin} 一样。碰撞箱先碰到、没有走这里的情况由 {@code BowArena} 每 tick 补判（F31）。
 * 只处理本轮登记过的浮标，其余照原版。
 */
@Mixin(FishingHook.class)
public abstract class FishingHookHitMixin {

    @Inject(method = "onHitBlock", at = @At("HEAD"))
    private void stevex$recordHit(BlockHitResult hit, CallbackInfo ci) {
        BowArena.onHitBlock((FishingHook) (Object) this, hit);
    }
}
