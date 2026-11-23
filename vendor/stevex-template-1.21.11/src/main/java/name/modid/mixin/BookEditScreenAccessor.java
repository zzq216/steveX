package name.modid.mixin;

import java.util.List;
import net.minecraft.client.gui.screens.inventory.BookEditScreen;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(BookEditScreen.class)
public interface BookEditScreenAccessor {

    @Accessor
    List<String> getPages();

    @Accessor
    int getCurrentPage();

    @Accessor("currentPage")
    void setCurrentPage(int page);

    @Invoker("updatePageContent")
    void invokeUpdatePageContent();

    @Invoker("updateLocalCopy")
    void invokeUpdateLocalCopy();

    @Invoker("updateButtonVisibility")
    void invokeUpdateButtonVisibility();

    @Invoker("appendPageToBook")
    void invokeAppendPageToBook();

    @Invoker("saveChanges")
    void invokeSaveChanges();

    /** 右上角页码文字（"第 x 页，共 y 页"） */
    @Invoker("getPageNumberMessage")
    Component invokeGetPageNumberMessage();

    /** 页码缓存：原版只在 updatePageContent 里重算（BookEditScreen 156 行） */
    @Accessor("numberOfPages")
    void setNumberOfPages(Component message);
}
