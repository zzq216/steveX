package com.example;

import com.example.memworld.MemoryWorldManager;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;

public class StevexTestClient implements ClientModInitializer {

	@Override
	public void onInitializeClient() {
		// 启动后自动创建 / 进入记忆世界
		ClientTickEvents.END_CLIENT_TICK.register(MemoryWorldManager::onClientTick);
	}
}
