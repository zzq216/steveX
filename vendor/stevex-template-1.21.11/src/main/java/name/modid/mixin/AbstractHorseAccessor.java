package name.modid.mixin;

import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.animal.equine.AbstractHorse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/**
 * 马类动物身上的箱子（坐骑训练场设计方案 H2）：inventory 是 protected；挂上箱子后要重建它（原版 equipChest 里 setChest 后调 createInventory）。
 * 训练场用它往驴、骡、羊驼的箱子里放题目的物品，并读出最终的内容。
 */
@Mixin(AbstractHorse.class)
public interface AbstractHorseAccessor {

    @Accessor("inventory")
    SimpleContainer stevex$inventory();

    @Invoker("createInventory")
    void stevex$createInventory();
}
