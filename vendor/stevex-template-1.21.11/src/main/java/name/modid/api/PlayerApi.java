package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import net.minecraft.client.Minecraft;

/** player API —— 生命值/饱食度/药水效果/状态标志 */
public class PlayerApi {

    private record PlayerData(
        double health, double maxHealth,
        int food, float saturation,
        int armor, float armorToughness, int air,
        int xpLevel, float xpProgress,
        boolean onGround, boolean inWater,
        boolean sprinting, boolean sneaking,
        List<Map<String, Object>> effects
    ) {}

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("player", params -> {
            PlayerData d = take();
            if (d == null) throw new RuntimeException("player not connected");

            Map<String, Object> vitals = new LinkedHashMap<>();
            vitals.put("health",    AgentWebSocketServer.f1(d.health));
            vitals.put("maxHealth", AgentWebSocketServer.f1(d.maxHealth));
            vitals.put("food",      d.food);
            vitals.put("saturation", AgentWebSocketServer.f1(d.saturation));
            vitals.put("xpLevel",   d.xpLevel);
            vitals.put("xpProgress", AgentWebSocketServer.f2(d.xpProgress));
            vitals.put("armor",     d.armor);
            vitals.put("armorToughness", AgentWebSocketServer.f1(d.armorToughness));
            vitals.put("air",       d.air);

            Map<String, Boolean> flags = new LinkedHashMap<>();
            flags.put("onGround",   d.onGround);
            flags.put("inWater",    d.inWater);
            flags.put("sprinting",  d.sprinting);
            flags.put("sneaking",   d.sneaking);

            Map<String, Object> map = new LinkedHashMap<>();
            map.put("vitals",  vitals);
            map.put("flags",   flags);
            map.put("effects", d.effects);
            return map;
        });
    }

    private static PlayerData take() {
        return AgentWebSocketServer.runOnClient(2_000, "Player query", ref -> {
            var p = Minecraft.getInstance().player;
            if (p == null) return;
            var fd = p.getFoodData();

            List<Map<String, Object>> effects = new ArrayList<>();
            for (var e : p.getActiveEffects()) {
                Map<String, Object> ef = new LinkedHashMap<>();
                ef.put("id",      net.minecraft.core.registries.BuiltInRegistries.MOB_EFFECT.getKey(e.getEffect().value()).toString());
                ef.put("level",   e.getAmplifier() + 1);
                ef.put("seconds", e.getDuration() / 20);
                ef.put("visible", e.isVisible());
                effects.add(ef);
            }

            ref.value = new PlayerData(
                p.getHealth(), p.getMaxHealth(),
                fd.getFoodLevel(), fd.getSaturationLevel(),
                p.getArmorValue(),
                (float)(p.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.ARMOR_TOUGHNESS) != null
                    ? p.getAttributeValue(net.minecraft.world.entity.ai.attributes.Attributes.ARMOR_TOUGHNESS) : 0.0),
                p.getAirSupply(),
                p.experienceLevel, p.experienceProgress,
                p.onGround(), p.isInWater(),
                p.isSprinting(), p.isCrouching(),
                effects
            );
        });
    }
}
