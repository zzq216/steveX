package name.modid.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import name.modid.AgentWebSocketServer;
import name.modid.AgentWebSocketServer.WsHandler;
import net.minecraft.client.Minecraft;

/** f3 API —— 坐标/环境/实体统计/准星目标 */
public class F3Api {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("f3", params -> {
            Map<String, Object> data = debug();
            if (data == null) throw new RuntimeException("player not connected");
            return data;
        });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> debug() {
        return AgentWebSocketServer.runOnClient(3_000, "Debug query", ref -> {
            var mc = Minecraft.getInstance();
            var player = mc.player;
            var level = mc.level;
            if (player == null || level == null) return;

            Map<String, Object> data = new LinkedHashMap<>();

            // === position ===
            var entity = mc.getCameraEntity();
            var feetPos = entity.blockPosition();
            var chunkPos = new net.minecraft.world.level.ChunkPos(feetPos);
            var direction = entity.getDirection();

            Map<String, Object> pos = new LinkedHashMap<>();
            pos.put("xyz", List.of(f3(entity.getX()), f3(entity.getY()), f3(entity.getZ())));
            pos.put("block", List.of(feetPos.getX(), feetPos.getY(), feetPos.getZ()));
            pos.put("chunk", List.of(chunkPos.x, net.minecraft.core.SectionPos.blockToSectionCoord(feetPos.getY()), chunkPos.z,
                chunkPos.getRegionLocalX(), chunkPos.getRegionLocalZ(), chunkPos.getRegionX(), chunkPos.getRegionZ()));
            Map<String, Object> facing = new LinkedHashMap<>();
            facing.put("direction", direction.getName());
            facing.put("yaw",   f1(net.minecraft.util.Mth.wrapDegrees(entity.getYRot())));
            facing.put("pitch", f1(net.minecraft.util.Mth.wrapDegrees(entity.getXRot())));
            pos.put("facing", facing);
            pos.put("dimension", level.dimension().identifier().toString());
            data.put("position", pos);

            // === chunk stats ===
            Map<String, Object> chunk = new LinkedHashMap<>();
            String renderStats = mc.levelRenderer.getSectionStatistics();
            if (renderStats != null) chunk.put("render", renderStats);
            chunk.put("clientSource", level.gatherChunkSourceStats());
            var serverLevel = mc.hasSingleplayerServer() ? mc.getSingleplayerServer().getLevel(level.dimension()) : null;
            if (serverLevel != null) chunk.put("serverSource", serverLevel.gatherChunkSourceStats());
            data.put("chunk", chunk);

            // === entities ===
            Map<String, Object> ents = new LinkedHashMap<>();
            String entityStats = mc.levelRenderer.getEntityStatistics();
            if (entityStats != null) ents.put("render", entityStats);
            if (serverLevel != null) {
                var spawnState = serverLevel.getChunkSource().getLastSpawnState();
                if (spawnState != null) {
                    Map<String, Integer> spawns = new LinkedHashMap<>();
                    spawns.put("chunks", spawnState.getSpawnableChunkCount());
                    for (var cat : net.minecraft.world.entity.MobCategory.values())
                        spawns.put(cat.getName(), spawnState.getMobCategoryCounts().getInt(cat));
                    ents.put("spawns", spawns);
                }
            }
            if (!ents.isEmpty()) data.put("entities", ents);

            // === environment ===
            Map<String, Object> env = new LinkedHashMap<>();
            if (level.isInsideBuildHeight(feetPos.getY()))
                env.put("biome", level.getBiome(feetPos).unwrap().map(k -> k.identifier().toString(), l -> "[unregistered " + l + "]"));
            env.put("particles", mc.particleEngine.countParticles());

            var clientChunkForHm = level.getChunkAt(feetPos);
            Map<String, Integer> hmClient = new LinkedHashMap<>();
            Map<String, Integer> hmServer = new LinkedHashMap<>();
            for (var ht : net.minecraft.world.level.levelgen.Heightmap.Types.values()) {
                if (ht.sendToClient()) hmClient.put(ht.getSerializedName(), clientChunkForHm.getHeight(ht, feetPos.getX(), feetPos.getZ()));
                if (ht.keepAfterWorldgen()) {
                    var sc = serverLevel != null ? serverLevel.getChunk(feetPos) : null;
                    hmServer.put(ht.getSerializedName(), sc != null ? sc.getHeight(ht, feetPos.getX(), feetPos.getZ()) : -1);
                }
            }
            Map<String, Object> hm = new LinkedHashMap<>();
            hm.put("client", hmClient);
            if (!hmServer.isEmpty()) hm.put("server", hmServer);
            env.put("heightmap", hm);

            var connection = mc.getConnection();
            if (connection != null) {
                var conn = connection.getConnection();
                var tickMgr = level.tickRateManager();
                String runStatus = tickMgr.isSteppingForward() ? " (frozen - stepping)" : tickMgr.isFrozen() ? " (frozen)" : "";
                float tx = conn.getAverageSentPackets();
                float rx = conn.getAverageReceivedPackets();
                String tpsStr;
                if (serverLevel != null) {
                    var serverTickMgr = mc.getSingleplayerServer().tickRateManager();
                    boolean sprinting = serverTickMgr.isSprinting();
                    if (sprinting) runStatus = " (sprinting)";
                    tpsStr = String.format(java.util.Locale.ROOT, "Integrated server @ %.1f/%s ms%s, %.0f tx, %.0f rx",
                        mc.getSingleplayerServer().getCurrentSmoothedTickTime(),
                        sprinting ? "-" : String.format(java.util.Locale.ROOT, "%.1f", tickMgr.millisecondsPerTick()),
                        runStatus, tx, rx);
                } else {
                    tpsStr = String.format(java.util.Locale.ROOT, "\"%s\" server%s, %.0f tx, %.0f rx", connection.serverBrand(), runStatus, tx, rx);
                }
                env.put("tps", tpsStr);
            }

            int rawBright = level.getChunkSource().getLightEngine().getRawBrightness(feetPos, 0);
            Map<String, Object> light = new LinkedHashMap<>();
            light.put("raw", rawBright);
            light.put("sky", level.getBrightness(net.minecraft.world.level.LightLayer.SKY, feetPos));
            light.put("block", level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, feetPos));
            env.put("light", light);

            if (serverLevel != null && serverLevel.isInsideBuildHeight(feetPos.getY())) {
                var serverChunk = serverLevel.getChunk(feetPos);
                if (serverChunk != null) {
                    float moon = serverLevel.getMoonBrightness(feetPos);
                    var diff = new net.minecraft.world.DifficultyInstance(serverLevel.getDifficulty(), serverLevel.getDayTime(), serverChunk.getInhabitedTime(), moon);
                    Map<String, Object> ld = new LinkedHashMap<>();
                    ld.put("effective", f2(diff.getEffectiveDifficulty()));
                    ld.put("special", f2(diff.getSpecialMultiplier()));
                    ld.put("day", serverLevel.getDayCount());
                    env.put("localDifficulty", ld);
                }
            }
            Map<String, Object> sound = new LinkedHashMap<>();
            sound.put("mood", Math.round(player.getCurrentMood() * 100));
            env.put("sound", sound);
            data.put("environment", env);

            // === target ===
            Map<String, Object> target = new LinkedHashMap<>();
            target.put("block", null); target.put("fluid", null); target.put("entity", null);

            var blockHit = entity.pick(20.0, 0.0F, false);
            if (blockHit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK) {
                var bhr = (net.minecraft.world.phys.BlockHitResult) blockHit;
                var state = level.getBlockState(bhr.getBlockPos());
                Map<String, Object> tb = new LinkedHashMap<>();
                tb.put("id", net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                tb.put("x", bhr.getBlockPos().getX()); tb.put("y", bhr.getBlockPos().getY()); tb.put("z", bhr.getBlockPos().getZ());
                Map<String, String> props = new LinkedHashMap<>();
                for (var e : state.getValues().entrySet())
                    props.put(e.getKey().getName(), net.minecraft.util.Util.getPropertyName(e.getKey(), e.getValue()));
                if (!props.isEmpty()) tb.put("properties", props);
                state.getTags().map(t -> "#" + t.location().toString()).forEach(t -> {
                    List<String> tags = (List<String>) tb.computeIfAbsent("tags", k -> new ArrayList<>());
                    tags.add(t);
                });
                target.put("block", tb);
            }

            var fluidHit = entity.pick(20.0, 0.0F, true);
            if (fluidHit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK) {
                var bhr = (net.minecraft.world.phys.BlockHitResult) fluidHit;
                var fState = level.getFluidState(bhr.getBlockPos());
                if (!fState.isEmpty()) {
                    Map<String, Object> tf = new LinkedHashMap<>();
                    tf.put("id", net.minecraft.core.registries.BuiltInRegistries.FLUID.getKey(fState.getType()).toString());
                    tf.put("x", bhr.getBlockPos().getX()); tf.put("y", bhr.getBlockPos().getY()); tf.put("z", bhr.getBlockPos().getZ());
                    target.put("fluid", tf);
                }
            }

            if (mc.crosshairPickEntity != null) {
                var e = mc.crosshairPickEntity;
                Map<String, Object> te = new LinkedHashMap<>();
                te.put("id",   net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
                te.put("name", e.getName().getString());
                te.put("uuid", e.getUUID().toString());
                te.put("x", f3(e.getX())); te.put("y", f3(e.getY())); te.put("z", f3(e.getZ()));

                var bb = e.getBoundingBox();
                Map<String, String> hitbox = new LinkedHashMap<>();
                hitbox.put("minX", f3(bb.minX)); hitbox.put("minY", f3(bb.minY)); hitbox.put("minZ", f3(bb.minZ));
                hitbox.put("maxX", f3(bb.maxX)); hitbox.put("maxY", f3(bb.maxY)); hitbox.put("maxZ", f3(bb.maxZ));
                te.put("hitbox", hitbox);

                if (e instanceof net.minecraft.world.entity.LivingEntity le) {
                    te.put("health", f1(le.getHealth()));
                    te.put("maxHealth", f1(le.getMaxHealth()));
                    te.put("armor", le.getArmorValue());
                    var tough = le.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.ARMOR_TOUGHNESS);
                    te.put("armorToughness", tough != null ? f1(tough.getValue()) : "0.0");

                    List<String> effNames = new ArrayList<>();
                    for (var eff : le.getActiveEffects())
                        effNames.add(net.minecraft.core.registries.BuiltInRegistries.MOB_EFFECT.getKey(eff.getEffect().value()).toString());
                    te.put("effects", effNames);

                    Map<String, Object> equip = new LinkedHashMap<>();
                    for (var slot : net.minecraft.world.entity.EquipmentSlot.VALUES) {
                        var stack = le.getItemBySlot(slot);
                        if (!stack.isEmpty()) {
                            Map<String, Object> eq = new LinkedHashMap<>();
                            eq.put("id", net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
                            eq.put("enchanted", stack.has(net.minecraft.core.component.DataComponents.ENCHANTMENTS));
                            equip.put(slot.getName(), eq);
                        }
                    }
                    if (!equip.isEmpty()) te.put("equipment", equip);
                }
                target.put("entity", te);
            }

            data.put("target", target);
            ref.value = data;
        });
    }

    private static String f1(double v) { return AgentWebSocketServer.f1(v); }
    private static String f2(double v) { return AgentWebSocketServer.f2(v); }
    private static String f3(double v) { return AgentWebSocketServer.f3(v); }
}
