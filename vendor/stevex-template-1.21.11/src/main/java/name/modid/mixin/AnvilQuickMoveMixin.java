package name.modid.mixin;

import name.modid.arena.ArenaManager;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.ItemCombinerMenu;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * 铁砧取出记录的补充（铁砧训练场设计方案 A7，2026-11-21 修正）：Shift 点击产物格时，{@code ItemCombinerMenu.quickMoveStack}
 * 先把产物整叠移进背包（121–163 行），再用那个已经被移空的叠调用 {@code onTake}——{@link AnvilTakeMixin} 拿到的是空物品，
 * 记录里的附魔是 {}、名字是 null。这里在 quickMoveStack 开头、对铁砧产物格的那一次，先把产物复制一份交给
 * {@link ArenaManager#noteAnvilResult}，onTake 拿到空物品时用它。客户端的菜单也会调用 quickMoveStack，只记服务端玩家的。
 */
@Mixin(ItemCombinerMenu.class)
public abstract class AnvilQuickMoveMixin {

    @Inject(method = "quickMoveStack", at = @At("HEAD"))
    private void stevex$noteAnvilResult(Player player, int index, CallbackInfoReturnable<ItemStack> cir) {
        if ((Object) this instanceof AnvilMenu menu && player instanceof ServerPlayer serverPlayer && index == menu.getResultSlot()) {
            ArenaManager.noteAnvilResult(serverPlayer, menu.getSlot(index).getItem());
        }
    }
}
