package name.modid;

import com.mojang.blaze3d.platform.InputConstants;
import name.modid.mixin.KeyMappingAccessor;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;

/**
 * 底层按键操作 —— 直接封装 KeyMapping.set / KeyMapping.click。
 * 通过 KeyMappingAccessor(Mixin) 访问 KeyMapping.key 字段。
 */
public class AgentInput {

    private static final Minecraft mc = Minecraft.getInstance();

    private static InputConstants.Key keyOf(KeyMapping km) {
        return ((KeyMappingAccessor) km).getKey();
    }

    // ==================== 持续性动作 ====================

    public static void forward(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyUp), pressed));
    }

    public static void backward(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyDown), pressed));
    }

    public static void left(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyLeft), pressed));
    }

    public static void right(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyRight), pressed));
    }

    public static void jump(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyJump), pressed));
    }

    public static void sneak(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyShift), pressed));
    }

    public static void sprint(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keySprint), pressed));
    }

    /** 按住左键 —— 持续攻击 / 挖矿 */
    public static void attack(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyAttack), pressed));
    }

    /** 按住右键 —— 持续使用物品（吃、拉弓、举盾） */
    public static void use(boolean pressed) {
        mc.execute(() -> KeyMapping.set(keyOf(mc.options.keyUse), pressed));
    }

    // ==================== 一次性动作 ====================

    /** 单击左键 —— 空挥 / 瞬击 */
    public static void attackOnce() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyAttack)));
    }

    /** 单击右键 —— 放置方块 / 瞬间使用物品 */
    public static void useOnce() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyUse)));
    }

    public static void pickItem() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyPickItem)));
    }

    public static void drop() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyDrop)));
    }

    public static void openInventory() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyInventory)));
    }

    public static void swapHands() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keySwapOffhand)));
    }

    public static void hotbarSlot(int slot) {
        if (slot >= 0 && slot <= 8) {
            mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyHotbarSlots[slot])));
        }
    }

    public static void chat() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyChat)));
    }

    public static void command() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyCommand)));
    }

    public static void togglePerspective() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyTogglePerspective)));
    }

    public static void quickActions() {
        mc.execute(() -> KeyMapping.click(keyOf(mc.options.keyQuickActions)));
    }
}
