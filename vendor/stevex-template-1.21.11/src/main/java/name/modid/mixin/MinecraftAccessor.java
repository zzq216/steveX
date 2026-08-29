package name.modid.mixin;

import net.minecraft.client.Minecraft;
import net.minecraft.util.profiling.ContinuousProfiler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(Minecraft.class)
public interface MinecraftAccessor {
    @Accessor
    ContinuousProfiler getFpsPieProfiler();
}
