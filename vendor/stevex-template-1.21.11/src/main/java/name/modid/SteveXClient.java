package name.modid;

import name.modid.vision.ContainerMemoryTracker;
import net.fabricmc.api.ClientModInitializer;
import name.modid.vision.VisionWorldContext;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;

public class SteveXClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        AgentWebSocketServer.launch();
        // 真实世界客户端首次启动：语言/音量/字幕/画质默认设置（标记文件守卫，仅一次）
        ClientTickEvents.END_CLIENT_TICK.register(ClientDefaults::onClientTick);
        // v2.30（§5.2.3）：容器内容记忆采集侧会话化状态机（屏幕转移绑定 / 菜单缓存 / 兜底提交）
        ClientTickEvents.END_CLIENT_TICK.register(ContainerMemoryTracker::onClientTick);
        // v2.55（多世界记忆隔离）：进入世界按 worldKey 切换记忆目录，退出世界落盘。换维度走 respawn，
        // 不触发 JOIN。两个回调都经 execute 落到客户端主线程（store 的写入都在主线程上）。
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) ->
                client.execute(() -> VisionWorldContext.onJoin(client)));
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) ->
                client.execute(VisionWorldContext::onDisconnect));
    }
}
