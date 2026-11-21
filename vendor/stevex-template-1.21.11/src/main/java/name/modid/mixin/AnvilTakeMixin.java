package name.modid.mixin;

import name.modid.arena.ArenaManager;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 铁砧的取出记录（铁砧训练场设计方案 A7）：取了几次、每次花多少级、取出的是什么。
 *
 * <p>挂在 {@code AnvilMenu.onTake} 开头（74–113 行）：这时花费还没清零、经验还没扣，参数就是取出的产物。
 * 客户端的菜单也会调用 onTake，那边的玩家不是 {@link ServerPlayer}，不记。
 */
@Mixin(AnvilMenu.class)
public abstract class AnvilTakeMixin {

    @Inject(method = "onTake", at = @At("HEAD"))
    private void stevex$recordAnvilTake(Player player, ItemStack stack, CallbackInfo ci) {
        if (player instanceof ServerPlayer serverPlayer) {
            ArenaManager.onAnvilTake(serverPlayer, ((AnvilMenu) (Object) this).getCost(), stack);
        }
    }
}
