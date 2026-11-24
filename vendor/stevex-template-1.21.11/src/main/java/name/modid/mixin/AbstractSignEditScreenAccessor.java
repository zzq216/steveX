package name.modid.mixin;

import net.minecraft.client.gui.font.TextFieldHelper;
import net.minecraft.client.gui.screens.inventory.AbstractSignEditScreen;
import net.minecraft.world.level.block.entity.SignBlockEntity;
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

    /** 正在编辑的告示牌：取行宽上限 getMaxTextLineWidth（立着的 90、悬挂的 60 像素） */
    @Accessor("sign")
    SignBlockEntity getSign();

    /** 编辑框的文字助手：切行后把光标移到行末（原版 keyPressed 切行时同样调用 setCursorToEnd） */
    @Accessor("signField")
    TextFieldHelper getSignField();
}
