package name.modid.mixin;

import java.util.List;
import net.minecraft.client.gui.screens.inventory.BookEditScreen;
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
}
