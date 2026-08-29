package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.world.inventory.*;

/**
 * 容器 API —— 读取/操作当前打开的容器 GUI。
 * 包含 4 个方法：get / slot / button / close
 */
public class ContainerApi {

    private static final Map<Integer, ClickType> CLICK_TYPES = Map.of(
        0, ClickType.PICKUP,
        1, ClickType.QUICK_MOVE,
        2, ClickType.SWAP,
        3, ClickType.CLONE,
        4, ClickType.THROW,
        5, ClickType.QUICK_CRAFT,
        6, ClickType.PICKUP_ALL
    );

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("container/get",    params -> getContainer());
        handlers.put("container/slot",   params -> slotClick(params));
        handlers.put("container/button", params -> buttonClick(params));
        handlers.put("container/close",  params -> closeContainer());
        handlers.put("container/text",   params -> setText(params));
    }

    // ==================== get ====================

    private static Map<String, Object> getContainer() {
        Map<String, Object> container = AgentWebSocketServer.runOnClient(2_000, "Container query", ref -> {
            var mc = Minecraft.getInstance();
            var p = mc.player;
            if (p == null) return;
            var menu = p.containerMenu;

            Map<String, Object> data = new LinkedHashMap<>();
            var screen = mc.screen;
            if (!(screen instanceof net.minecraft.client.gui.screens.inventory.AbstractContainerScreen<?>)) {
                data.put("type", "none");
                data.put("slots", List.of());
            } else {
                String type;
                if (menu instanceof InventoryMenu) {
                    type = "inventory";
                } else {
                    type = net.minecraft.core.registries.BuiltInRegistries.MENU.getKey(menu.getType()).getPath();
                }
                data.put("type", type);
                data.put("containerId", menu.containerId);
                data.put("stateId", menu.getStateId());

                // slots
                List<Map<String, Object>> slots = new ArrayList<>();
                for (Slot slot : menu.slots) {
                    if (slot.hasItem()) {
                        slots.add(InventoryApi.slotItem(slot.index, slot.getItem()));
                    }
                }
                data.put("slots", slots);

                // carried item
                if (!menu.getCarried().isEmpty()) {
                    data.put("carriedItem", InventoryApi.slotItem(-2, menu.getCarried()));
                }

                // type-specific data
                switch (menu) {
                    case AbstractFurnaceMenu fm -> {
                        data.put("burnProgress", AgentWebSocketServer.f2(fm.getBurnProgress()));
                        data.put("litProgress",  AgentWebSocketServer.f2(fm.getLitProgress()));
                    }
                    case EnchantmentMenu em -> {
                        List<Integer> costs = new ArrayList<>();
                        List<Integer> clues = new ArrayList<>();
                        List<Integer> levels = new ArrayList<>();
                        for (int i = 0; i < 3; i++) {
                            costs.add(em.costs[i]);
                            clues.add(em.enchantClue[i]);
                            levels.add(em.levelClue[i]);
                        }
                        data.put("costs",        costs);
                        data.put("enchantClue",  clues);
                        data.put("levelClue",    levels);
                        data.put("goldCount",    em.getGoldCount());
                        data.put("enchantSeed",  em.getEnchantmentSeed());
                    }
                    case BeaconMenu bm -> {
                        data.put("levels", bm.getLevels());
                    }
                    case BrewingStandMenu bsm -> {
                        data.put("fuel",         bsm.getFuel());
                        data.put("brewingTicks", bsm.getBrewingTicks());
                    }
                    case AnvilMenu am -> data.put("cost", am.getCost());
                    case MerchantMenu mm -> {
                        data.put("traderLevel", mm.getTraderLevel());
                        data.put("traderXp",    mm.getTraderXp());
                        data.put("selectedTrade", 0);
                        List<Map<String, Object>> trades = new ArrayList<>();
                        for (var offer : mm.getOffers()) {
                            Map<String, Object> trade = new LinkedHashMap<>();
                            trade.put("inputA",  InventoryApi.slotItem(-1, offer.getBaseCostA()));
                            trade.put("inputB",  InventoryApi.slotItem(-1, offer.getCostB()));
                            trade.put("result",  InventoryApi.slotItem(-1, offer.getResult()));
                            trade.put("uses",    offer.getUses());
                            trade.put("maxUses", offer.getMaxUses());
                            trade.put("xp",      offer.getXp());
                            trades.add(trade);
                        }
                        data.put("trades", trades);
                    }
                    case LecternMenu lm -> {
                        data.put("page", lm.getPage());
                    }
                    case LoomMenu lom -> {
                        data.put("selectedPattern", lom.getSelectedBannerPatternIndex());
                    }
                    case StonecutterMenu sm -> {
                        data.put("selectedRecipe", sm.getSelectedRecipeIndex());
                        data.put("visibleRecipes", sm.getNumberOfVisibleRecipes());
                    }
                    default -> {}
                }
            }
            ref.value = data;
        });
        return container != null ? container : Map.of("type", "none", "slots", List.of());
    }

    // ==================== slot click ====================

    private static Map<String, Object> slotClick(Map<String, Object> params) {
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            var p = mc.player;
            if (!(mc.screen instanceof net.minecraft.client.gui.screens.inventory.AbstractContainerScreen)) return;

            int slotId   = AgentWebSocketServer.num(params, "slot", 0);
            int button   = AgentWebSocketServer.num(params, "button", 0);    // 0=left, 1=right
            int clickIdx = AgentWebSocketServer.num(params, "clickType", 0); // 0=PICKUP, 1=QUICK_MOVE, ...
            var clickType = CLICK_TYPES.getOrDefault(clickIdx, ClickType.PICKUP);

            mc.gameMode.handleInventoryMouseClick(p.containerMenu.containerId, slotId, button, clickType, p);
        });
        return Map.of("status", "ok");
    }

    // ==================== button click ====================

    private static Map<String, Object> buttonClick(Map<String, Object> params) {
        Boolean accepted = AgentWebSocketServer.runOnClient(1_000, "Container button", ref -> {
            var mc = Minecraft.getInstance();
            var p = mc.player;
            if (!(mc.screen instanceof net.minecraft.client.gui.screens.inventory.AbstractContainerScreen)) return;
            var menu = p.containerMenu;
            int btn = AgentWebSocketServer.num(params, "button", 0);
            ref.value = menu.clickMenuButton(p, btn);
        });
        return Map.of("status", "ok", "accepted", Boolean.TRUE.equals(accepted));
    }

    // ==================== close ====================

    // ==================== text input ====================

    private static Map<String, Object> setText(Map<String, Object> params) {
        String text = (String) params.getOrDefault("text", "");
        Minecraft.getInstance().execute(() -> {
            var screen = Minecraft.getInstance().screen;
            if (screen != null) {
                for (var child : screen.children()) {
                    if (child instanceof EditBox eb && eb.isFocused()) {
                        eb.setValue(text);
                        break;
                    }
                }
            }
        });
        return Map.of("status", "ok");
    }

    // ==================== close ====================

    private static Map<String, Object> closeContainer() {
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof net.minecraft.client.gui.screens.inventory.AbstractContainerScreen) {
                mc.player.closeContainer();
            }
        });
        return Map.of("status", "ok");
    }

}
