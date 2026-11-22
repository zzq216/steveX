package name.modid.mixin;

import name.modid.arena.ArenaManager;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.SmithingMenu;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 锻造台的取出记录（锻造台训练场设计方案 M7）：取了几次、每次取出的是什么。
 *
 * <p>挂在 {@code SmithingMenu.onTake} 开头（71–78 行），参数就是取出的产物；Shift 点击时它是空的，由 {@link CombinerQuickMoveMixin} 补上。
 * 客户端的菜单也会调用 onTake，那边的玩家不是 {@link ServerPlayer}，不记。
 */
@Mixin(SmithingMenu.class)
public abstract class SmithingTakeMixin {

    @Inject(method = "onTake", at = @At("HEAD"))
    private void stevex$recordSmithingTake(Player player, ItemStack stack, CallbackInfo ci) {
        if (player instanceof ServerPlayer serverPlayer) ArenaManager.onSmithingTake(serverPlayer, stack);
    }
}
