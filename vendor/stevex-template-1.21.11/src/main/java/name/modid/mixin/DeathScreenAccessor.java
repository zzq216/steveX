package name.modid.mixin;

import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** 死亡界面的死亡信息（{@code player.deathMessage}，P2 实施细则 §8.2）。字段是 private，界面本身没有 getter。 */
@Mixin(DeathScreen.class)
public interface DeathScreenAccessor {

    @Accessor
    Component getCauseOfDeath();
}
