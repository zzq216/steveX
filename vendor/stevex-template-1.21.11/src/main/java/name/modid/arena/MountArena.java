package name.modid.arena;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.mixin.AbstractHorseAccessor;
import name.modid.mixin.LlamaAccessor;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.EntityTypeTags;
import net.minecraft.world.Container;
import net.minecraft.world.entity.AgeableMob;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.animal.equine.AbstractChestedHorse;
import net.minecraft.world.entity.animal.equine.AbstractHorse;
import net.minecraft.world.entity.animal.equine.Llama;
import net.minecraft.world.entity.animal.nautilus.AbstractNautilus;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

/**
 * 坐骑训练场（docs/坐骑训练场设计方案.md）的计算部分：每种动物能装什么（H10）、生成本轮的动物（H2）、读出它身上的东西（H5、H6）。
 * 全部在服务器线程上调用（同 {@link ArenaManager}）。
 *
 * <p>"能用的格"和原版界面一致（HorseInventoryMenu 22–34 行、NautilusInventoryMenu 16–28 行）：
 * 马类的鞍槽要 canUseSlot(SADDLE) 且在 can_equip_saddle 里，身体槽要 canUseSlot(BODY) 且在 can_wear_horse_armor 里或是羊驼；
 * 鹦鹉螺两格都只看 canUseSlot。能放哪些物品再看 isEquippableInSlot（ArmorSlot.mayPlace 用的就是它）。
 */
public final class MountArena {

    /** 动物 → 组（H3） */
    public static final Map<String, String> GROUPS = new LinkedHashMap<>();
    static {
        GROUPS.put("minecraft:horse", "horse");
        GROUPS.put("minecraft:zombie_horse", "horse");
        GROUPS.put("minecraft:donkey", "donkey");
        GROUPS.put("minecraft:mule", "donkey");
        GROUPS.put("minecraft:camel", "camel");
        GROUPS.put("minecraft:camel_husk", "camel");
        GROUPS.put("minecraft:llama", "llama");
        GROUPS.put("minecraft:trader_llama", "llama");
        GROUPS.put("minecraft:nautilus", "nautilus");
        GROUPS.put("minecraft:zombie_nautilus", "nautilus");
    }

    public static final int MAX_STRENGTH = 5;

    private MountArena() {}

    /** 动物的注册名 → 实体类型；不是这 10 种之一 → 报错。 */
    public static EntityType<?> type(String id) {
        if (!GROUPS.containsKey(id)) throw new IllegalArgumentException("not a mount of the arena: " + id + " (known: " + String.join(", ", GROUPS.keySet()) + ")");
        return BuiltInRegistries.ENTITY_TYPE.getValue(Identifier.parse(id));
    }

    /** 鹦鹉螺组站在水坑里（H1，F8） */
    public static boolean needsWater(String id) {
        return "nautilus".equals(GROUPS.get(id));
    }

    /** 新建一只（不放进世界）：成年、已驯服。主人在生成时才设（catalog 不需要）。 */
    static Mob create(ServerLevel level, String id) {
        Entity entity = type(id).create(level, EntitySpawnReason.COMMAND);
        if (!(entity instanceof Mob mob)) throw new IllegalStateException("cannot create " + id);
        if (mob instanceof AgeableMob ageable) ageable.setAge(0);
        if (mob instanceof AbstractHorse horse) horse.setTamed(true);
        if (mob instanceof AbstractNautilus nautilus) nautilus.setTame(true, false);
        return mob;
    }

    /** 鞍槽对这只动物能不能用（和界面的 isActive 一致） */
    public static boolean saddleUsable(LivingEntity mob) {
        if (mob instanceof AbstractNautilus) return mob.canUseSlot(EquipmentSlot.SADDLE);
        return mob instanceof AbstractHorse && mob.canUseSlot(EquipmentSlot.SADDLE) && mob.getType().is(EntityTypeTags.CAN_EQUIP_SADDLE);
    }

    /** 身体槽对这只动物能不能用（和界面的 isActive 一致） */
    public static boolean bodyUsable(LivingEntity mob) {
        if (mob instanceof AbstractNautilus) return mob.canUseSlot(EquipmentSlot.BODY);
        return mob instanceof AbstractHorse && mob.canUseSlot(EquipmentSlot.BODY) && (mob.getType().is(EntityTypeTags.CAN_WEAR_HORSE_ARMOR) || mob instanceof Llama);
    }

    /**
     * H10：{ animals: [{ id, group, saddle: [item…], body: [item…], chest: 0 | 15 | "strength" }] }，物品按 id 排序。
     * 每种动物临时建一只（不放进世界），对全部物品逐个试能不能放进鞍槽 / 身体槽。
     */
    public static Map<String, Object> catalog(ServerLevel level) {
        List<Item> items = new ArrayList<>();
        for (Item item : BuiltInRegistries.ITEM) items.add(item);
        items.sort(Comparator.comparing(i -> BuiltInRegistries.ITEM.getKey(i).toString()));
        List<Map<String, Object>> animals = new ArrayList<>();
        for (Map.Entry<String, String> e : GROUPS.entrySet()) {
            Mob mob = create(level, e.getKey());
            List<String> saddle = new ArrayList<>();
            List<String> body = new ArrayList<>();
            boolean saddleOk = saddleUsable(mob);
            boolean bodyOk = bodyUsable(mob);
            for (Item item : items) {
                ItemStack stack = new ItemStack(item);
                if (saddleOk && mob.isEquippableInSlot(stack, EquipmentSlot.SADDLE)) saddle.add(BuiltInRegistries.ITEM.getKey(item).toString());
                if (bodyOk && mob.isEquippableInSlot(stack, EquipmentSlot.BODY)) body.add(BuiltInRegistries.ITEM.getKey(item).toString());
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", e.getKey());
            row.put("group", e.getValue());
            row.put("saddle", saddle);
            row.put("body", body);
            row.put("chest", mob instanceof Llama ? "strength" : mob instanceof AbstractChestedHorse ? 15 : 0);
            mob.discard();
            animals.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("animals", animals);
        return out;
    }

    /**
     * H2：生成本轮的动物——成年、已驯服（主人是玩家）、不能移动（NoAI）、无敌、不会消失；驴、骡、羊驼挂上箱子（羊驼按 strength 设力量）；
     * 装上 saddle / body，箱子按 chest 放好。位置 (x, y, z)，朝 yaw。参数不合法（这只动物没有这一格、物品放不进、格号越界）→ 报错，不生成。
     */
    public static Mob spawn(ServerLevel level, ServerPlayer player, ArenaManager.MountSetup setup, double x, double y, double z, float yaw) {
        Mob mob = create(level, setup.animal());
        if (mob instanceof AbstractHorse horse) horse.setOwner(player);
        if (mob instanceof AbstractNautilus nautilus) nautilus.setOwner(player);
        if (setup.strength() != null) {
            if (!(mob instanceof Llama llama)) throw new IllegalArgumentException("strength is only for llamas");
            if (setup.strength() < 1 || setup.strength() > MAX_STRENGTH) throw new IllegalArgumentException("strength must be within 1-" + MAX_STRENGTH + ": " + setup.strength());
            ((LlamaAccessor) llama).stevex$setStrength(setup.strength());
        }
        if (mob instanceof AbstractChestedHorse chested) {
            chested.setChest(true);
            ((AbstractHorseAccessor) chested).stevex$createInventory();
        }
        equip(mob, EquipmentSlot.SADDLE, setup.saddle(), saddleUsable(mob));
        equip(mob, EquipmentSlot.BODY, setup.body(), bodyUsable(mob));
        Container chest = chest(mob);
        for (ArenaManager.Give g : setup.chest()) {
            if (chest == null) throw new IllegalArgumentException(setup.animal() + " has no chest");
            if (g.slot() < 0 || g.slot() >= chest.getContainerSize()) throw new IllegalArgumentException("mount chest slot out of range [0, " + (chest.getContainerSize() - 1) + "]: " + g.slot());
            Item item = item(g.id());
            if (g.count() < 1 || g.count() > item.getDefaultMaxStackSize()) throw new IllegalArgumentException("bad count for " + g.id() + " in the mount chest: " + g.count());
            chest.setItem(g.slot(), new ItemStack(item, g.count()));
        }
        mob.setNoAi(true);
        mob.setInvulnerable(true);
        mob.setPersistenceRequired();
        mob.snapTo(x, y, z, yaw, 0f);
        mob.setYHeadRot(yaw);
        mob.setYBodyRot(yaw);
        level.addFreshEntity(mob);
        return mob;
    }

    private static void equip(Mob mob, EquipmentSlot slot, String id, boolean usable) {
        if (id == null) return;
        String name = slot == EquipmentSlot.SADDLE ? "saddle" : "body";
        if (!usable) throw new IllegalArgumentException(BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()) + " has no usable " + name + " slot");
        ItemStack stack = new ItemStack(item(id));
        if (!mob.isEquippableInSlot(stack, slot)) throw new IllegalArgumentException(id + " cannot go into the " + name + " slot of " + BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()));
        mob.setItemSlot(slot, stack);
    }

    /** 动物身上的箱子；没有（不是驴、骡、羊驼，或者没挂箱子）→ null */
    public static Container chest(LivingEntity mob) {
        if (mob instanceof AbstractChestedHorse chested && chested.hasChest()) return ((AbstractHorseAccessor) chested).stevex$inventory();
        return null;
    }

    /** 鞍槽 / 身体槽里的物品 id；空 → null */
    public static String worn(LivingEntity mob, EquipmentSlot slot) {
        ItemStack stack = mob.getItemBySlot(slot);
        return stack.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    /** 箱子里按物品 id 合计；没有箱子 → {} */
    public static Map<String, Integer> chestCounts(LivingEntity mob) {
        Map<String, Integer> out = new LinkedHashMap<>();
        Container chest = chest(mob);
        if (chest == null) return out;
        for (int i = 0; i < chest.getContainerSize(); i++) {
            ItemStack stack = chest.getItem(i);
            if (!stack.isEmpty()) out.merge(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), stack.getCount(), Integer::sum);
        }
        return out;
    }

    /** 状态摘要（H5、H11 的 final）：{ id, uuid, saddle, body, chest: { id: n }, chestSize, strength? } */
    public static Map<String, Object> describe(LivingEntity mob) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString());
        out.put("uuid", mob.getUUID().toString());
        out.put("saddle", worn(mob, EquipmentSlot.SADDLE));
        out.put("body", worn(mob, EquipmentSlot.BODY));
        out.put("chest", chestCounts(mob));
        Container chest = chest(mob);
        out.put("chestSize", chest == null ? 0 : chest.getContainerSize());
        if (mob instanceof Llama llama) out.put("strength", llama.getStrength());
        return out;
    }

    /** H5 的第 1–3 条：动物的鞍槽、身体槽（要检查的才比）、箱子都对上目标 */
    public static boolean matches(LivingEntity mob, ArenaManager.MountGoal goal) {
        if (goal.checkSaddle() && !java.util.Objects.equals(worn(mob, EquipmentSlot.SADDLE), goal.saddle())) return false;
        if (goal.checkBody() && !java.util.Objects.equals(worn(mob, EquipmentSlot.BODY), goal.body())) return false;
        return chestCounts(mob).equals(goal.chest());
    }

    private static Item item(String id) {
        Identifier key = Identifier.tryParse(id);
        if (key == null || !BuiltInRegistries.ITEM.containsKey(key)) throw new IllegalArgumentException("unknown item: " + id);
        return BuiltInRegistries.ITEM.getValue(key);
    }
}
