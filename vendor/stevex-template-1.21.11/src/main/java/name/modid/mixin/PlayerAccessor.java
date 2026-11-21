package name.modid.mixin;

import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 玩家的附魔种子（附魔台训练场设计方案 N4、E14）：附魔台三档的门槛、提示和结果都由它决定（EnchantmentMenu.slotsChanged）。
 * 字段是 protected，原版只在 onEnchantmentPerformed 里换成新的随机数；训练场每轮按出题种子写入，同一种子出同一道题。
 */
@Mixin(Player.class)
public interface PlayerAccessor {

    @Accessor("enchantmentSeed")
    void stevex$setEnchantmentSeed(int seed);
}
