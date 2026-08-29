package name.modid;

import net.fabricmc.api.ClientModInitializer;

public class SteveXClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        AgentWebSocketServer.launch();
    }
}
