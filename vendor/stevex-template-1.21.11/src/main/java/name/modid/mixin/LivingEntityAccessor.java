package name.modid.mixin;

import net.minecraft.world.entity.LivingEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 最近一次受伤的时刻（{@code player.lastDamage.ticksAgo}，P3 实施细则 §2.2）。
 * 客户端在 {@code handleDamageEvent} 里和伤害来源一起写入（LivingEntity.java:1948-1949），字段是 private、没有 getter。
 */
@Mixin(LivingEntity.class)
public interface LivingEntityAccessor {

    @Accessor
    long getLastDamageStamp();
}
