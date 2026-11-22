package name.modid.mixin;

import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 酿造台的燃料值和剩余酿造 tick（酿造台训练场设计方案 P8）：两个字段只有包内可见，菜单的 ContainerData 要开着界面才拿得到。
 * 训练场的 status 用它们报 fuelCharges、brewTicks。
 */
@Mixin(BrewingStandBlockEntity.class)
public interface BrewingStandAccessor {

    @Accessor("fuel")
    int stevex$getFuel();

    @Accessor("brewTime")
    int stevex$getBrewTime();
}
