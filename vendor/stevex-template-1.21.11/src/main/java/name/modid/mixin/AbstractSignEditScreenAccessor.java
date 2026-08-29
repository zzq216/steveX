package name.modid.mixin;

import net.minecraft.client.gui.screens.inventory.AbstractSignEditScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(AbstractSignEditScreen.class)
public interface AbstractSignEditScreenAccessor {

    @Accessor
    String[] getMessages();

    @Accessor
    int getLine();

    @Accessor("line")
    void setLine(int line);

    @Accessor
    boolean getIsFrontText();

    @Invoker("setMessage")
    void invokeSetMessage(String message);
}
