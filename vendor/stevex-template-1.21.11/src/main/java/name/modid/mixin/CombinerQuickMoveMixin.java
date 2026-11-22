package name.modid.mixin;

import name.modid.arena.ArenaManager;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.ItemCombinerMenu;
import net.minecraft.world.inventory.SmithingMenu;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * 铁砧、锻造台取出记录的补充（铁砧训练场设计方案 A7 修正 ③；锻造台训练场设计方案 M7）：Shift 点击产物格时，
 * {@code ItemCombinerMenu.quickMoveStack} 先把产物整叠移进背包（121–163 行），再用那个已经被移空的叠调用 {@code onTake}——
 * {@link AnvilTakeMixin}、{@link SmithingTakeMixin} 拿到的是空物品。这里在 quickMoveStack 开头、对铁砧或锻造台产物格的那一次，
 * 先把产物复制一份交给 {@link ArenaManager#noteCombinerResult}，onTake 拿到空物品时用它。客户端的菜单也会调用 quickMoveStack，只记服务端玩家的。
 * （2026-11-21 由 AnvilQuickMoveMixin 改名，扩展到锻造台。）
 */
@Mixin(ItemCombinerMenu.class)
public abstract class CombinerQuickMoveMixin {

    @Inject(method = "quickMoveStack", at = @At("HEAD"))
    private void stevex$noteCombinerResult(Player player, int index, CallbackInfoReturnable<ItemStack> cir) {
        ItemCombinerMenu menu = (ItemCombinerMenu) (Object) this;
        if ((menu instanceof AnvilMenu || menu instanceof SmithingMenu) && player instanceof ServerPlayer serverPlayer && index == menu.getResultSlot()) {
            ArenaManager.noteCombinerResult(serverPlayer, menu.getSlot(index).getItem());
        }
    }
}
