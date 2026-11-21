package name.modid.mixin;

import net.minecraft.core.Holder;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.level.block.entity.BeaconBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 信标的等级和主副效果（信标训练场设计方案 F11、G7）：三个字段都不是公开的，也没有公开的读取方法。
 * 训练场用它们判断"信标实际给什么效果"、等信标生效（G2）。
 */
@Mixin(BeaconBlockEntity.class)
public interface BeaconBlockEntityAccessor {

    @Accessor("levels")
    int stevex$getLevels();

    @Accessor("primaryPower")
    Holder<MobEffect> stevex$getPrimaryPower();

    @Accessor("secondaryPower")
    Holder<MobEffect> stevex$getSecondaryPower();
}
