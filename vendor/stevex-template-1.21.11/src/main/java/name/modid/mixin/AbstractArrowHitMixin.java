package name.modid.mixin;

import name.modid.arena.BowArena;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 箭命中方块（弓箭训练场设计方案 Q8）：在 {@code onHitBlock} 开头把命中的方块、面、命中点报给 {@link BowArena#onHitBlock}。
 * 只处理本轮登记过的箭，其余照原版。
 */
@Mixin(AbstractArrow.class)
public abstract class AbstractArrowHitMixin {

    @Inject(method = "onHitBlock", at = @At("HEAD"))
    private void stevex$recordHit(BlockHitResult hit, CallbackInfo ci) {
        BowArena.onHitBlock((AbstractArrow) (Object) this, hit);
    }
}
