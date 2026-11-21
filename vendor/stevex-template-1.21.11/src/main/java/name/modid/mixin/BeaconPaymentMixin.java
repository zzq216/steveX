package name.modid.mixin;

import name.modid.arena.ArenaManager;
import net.minecraft.network.protocol.game.ServerboundSetBeaconPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.inventory.BeaconMenu;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 信标的付款记录（信标训练场设计方案 G7）：付款物品一旦被扣就消失了，光看物品栏分不清"付出去了"和"扔出场外了"，
 * 所以在服务端处理设信标包、即将调用 {@code BeaconMenu.updateEffects} 时记一次。
 *
 * <p>挂在 {@code handleSetBeaconPacket} 而不是 {@code updateEffects}：这里拿得到是哪个玩家，而且已经在服务器线程上、
 * 已经过了 {@code stillValid} 检查（ServerGamePacketListenerImpl 778–788 行）。付款格空着时 updateEffects 什么都不做，
 * 所以只在 {@code hasPayment()} 时记。
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class BeaconPaymentMixin {

    @Shadow
    public ServerPlayer player;

    @Inject(method = "handleSetBeaconPacket", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/inventory/BeaconMenu;updateEffects(Ljava/util/Optional;Ljava/util/Optional;)V"))
    private void stevex$recordBeaconPayment(ServerboundSetBeaconPacket packet, CallbackInfo ci) {
        if (player.containerMenu instanceof BeaconMenu menu && menu.hasPayment()) {
            ArenaManager.onBeaconPaid(player, packet.primary().orElse(null), packet.secondary().orElse(null));
        }
    }
}
