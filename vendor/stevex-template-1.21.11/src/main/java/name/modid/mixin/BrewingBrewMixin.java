package name.modid.mixin;

import name.modid.arena.ArenaManager;
import net.minecraft.core.BlockPos;
import net.minecraft.core.NonNullList;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 酿造次数（酿造台训练场设计方案 P9）：每酿完一次扣 1 个材料，光看物品栏分不清"用掉了"和"扔出场外了"，
 * 所以在 {@code doBrew}（酿完、药水换成产物、材料扣 1 的那一刻）开头报给 {@link ArenaManager#onBrew}，只记本轮场地的那台。
 */
@Mixin(BrewingStandBlockEntity.class)
public abstract class BrewingBrewMixin {

    @Inject(method = "doBrew", at = @At("HEAD"))
    private static void stevex$recordBrew(Level level, BlockPos pos, NonNullList<ItemStack> items, CallbackInfo ci) {
        ArenaManager.onBrew(level, pos);
    }
}
