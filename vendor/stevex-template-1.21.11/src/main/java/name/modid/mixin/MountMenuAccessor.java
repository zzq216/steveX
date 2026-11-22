package name.modid.mixin;

import net.minecraft.world.Container;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.inventory.AbstractMountInventoryMenu;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 坐骑界面（马、驴、羊驼、骆驼、鹦鹉螺……）对应的动物和它的箱子（坐骑训练场设计方案 H6、H7）：两个字段都是 protected。
 * container/get 用它报出是哪只动物、箱子有几格；训练场用它判断当前界面是不是本轮这只动物的。客户端、服务端都用。
 */
@Mixin(AbstractMountInventoryMenu.class)
public interface MountMenuAccessor {

    @Accessor("mount")
    LivingEntity stevex$mount();

    @Accessor("mountContainer")
    Container stevex$mountContainer();
}
