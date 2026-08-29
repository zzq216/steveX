package name.modid.api;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.mixin.BookEditScreenAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.BookEditScreen;

/**
 * 书与笔 API —— 读取/编辑书页文字，翻页，保存并关闭。
 * 工作流: book/get → book/set (逐页编辑) → book/close
 */
public class BookApi {

    public static void register(Map<String, WsHandler> handlers) {
        handlers.put("book/get",   BookApi::getBook);
        handlers.put("book/set",   BookApi::setText);
        handlers.put("book/page",  BookApi::goToPage);
        handlers.put("book/close", params -> close());
    }

    // ==================== 获取书本内容 ====================

    @SuppressWarnings("unchecked")
    private static Map<String, Object> getBook(Map<String, Object> params) {
        Map<String, Object>[] box = new Map[1];
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                var acc = (BookEditScreenAccessor) bookScreen;
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("pages",       List.copyOf(acc.getPages()));
                data.put("currentPage", acc.getCurrentPage());
                data.put("totalPages",  acc.getPages().size());
                box[0] = data;
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (box[0] == null) return Map.of("status", "error", "message", "book editor not open");
        return box[0];
    }

    // ==================== 设置文字 ====================

    private static Map<String, Object> setText(Map<String, Object> params) {
        int targetPage = params.containsKey("page") ? ((Number) params.get("page")).intValue() : -1;
        String text = (String) params.getOrDefault("text", "");
        var result = new Object(){ boolean ok = false; String error = null; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                var acc = (BookEditScreenAccessor) bookScreen;
                List<String> pages = acc.getPages();
                int pageIdx;

                if (targetPage >= 0 && targetPage <= pages.size()) {
                    // targetPage == pages.size() → 追加新页（最多 100 页）
                    if (targetPage == pages.size()) {
                        if (pages.size() >= 100) {
                            result.error = "max 100 pages reached";
                            latch.countDown();
                            return;
                        }
                        acc.invokeAppendPageToBook();
                    }
                    pageIdx = targetPage;
                } else if (targetPage > pages.size()) {
                    result.error = "page " + targetPage + " out of range (max " + pages.size() + ")";
                    latch.countDown();
                    return;
                } else {
                    pageIdx = acc.getCurrentPage();
                }

                pages.set(pageIdx, text);
                acc.invokeUpdateLocalCopy();

                // 如果在当前页，刷新编辑器显示
                if (pageIdx == acc.getCurrentPage()) {
                    acc.invokeUpdatePageContent();
                }
                result.ok = true;
            } else {
                result.error = "book editor not open";
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (!result.ok) return Map.of("status", "error", "message", result.error);
        return Map.of("status", "ok");
    }

    // ==================== 翻页 ====================

    private static Map<String, Object> goToPage(Map<String, Object> params) {
        int target = ((Number) params.getOrDefault("page", 0)).intValue();
        var result = new Object(){ boolean ok = false; String error = null; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                var acc = (BookEditScreenAccessor) bookScreen;
                if (target < 0 || target >= acc.getPages().size()) {
                    result.error = "page " + target + " out of range (0–" + (acc.getPages().size() - 1) + ")";
                } else {
                    acc.setCurrentPage(target);
                    acc.invokeUpdatePageContent();
                    acc.invokeUpdateButtonVisibility();
                    result.ok = true;
                }
            } else {
                result.error = "book editor not open";
            }
            latch.countDown();
        });
        try { latch.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (!result.ok) return Map.of("status", "error", "message", result.error);
        return Map.of("status", "ok");
    }

    // ==================== 保存并关闭 ====================

    private static Map<String, Object> close() {
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                var acc = (BookEditScreenAccessor) bookScreen;
                acc.invokeSaveChanges();
                mc.setScreen(null);
            }
        });
        return Map.of("status", "ok");
    }
}
