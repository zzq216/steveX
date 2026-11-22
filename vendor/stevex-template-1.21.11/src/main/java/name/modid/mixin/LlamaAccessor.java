package name.modid.mixin;

import net.minecraft.world.entity.animal.equine.Llama;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** 羊驼的力量（坐骑训练场设计方案 H2、H3）：决定箱子有 3 × 力量格，原版的 setStrength 是私有的。 */
@Mixin(Llama.class)
public interface LlamaAccessor {

    @Invoker("setStrength")
    void stevex$setStrength(int strength);
}
