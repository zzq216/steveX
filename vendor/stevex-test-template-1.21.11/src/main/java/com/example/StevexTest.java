package com.example;

import com.example.memworld.MemoryWorldManager;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.permissions.Permission;
import net.minecraft.server.permissions.PermissionLevel;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class StevexTest implements ModInitializer {
	public static final String MOD_ID = "stevex-test";

	// This logger is used to write text to the console and the log file.
	// It is considered best practice to use your mod id as the logger's name.
	// That way, it's clear which mod wrote info, warnings, and errors.
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		// This code runs as soon as Minecraft is in a mod-load-ready state.
		// However, some things (like resources) may still be uninitialized.
		// Proceed with mild caution.

		LOGGER.info("Hello Fabric world!");

		// 每个服务器 tick 驱动记忆世界复原引擎
		ServerTickEvents.END_SERVER_TICK.register(MemoryWorldManager::onServerTick);

		// 手动强制重新读取源 NBT 文件并同步世界
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
				dispatcher.register(Commands.literal("memrestore")
						.requires(src -> src.permissions().hasPermission(new Permission.HasCommandLevel(PermissionLevel.GAMEMASTERS)))
						.executes(ctx -> {
							MemoryWorldManager.forceRestore(ctx.getSource().getServer());
							ctx.getSource().sendSuccess(() -> Component.literal("Memory world restore triggered"), true);
							return 1;
						}))
		);
	}

	public static Identifier id(String path) {
		return Identifier.fromNamespaceAndPath(MOD_ID, path);
	}
}
