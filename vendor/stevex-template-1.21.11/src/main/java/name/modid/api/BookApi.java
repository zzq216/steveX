package name.modid.api;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import name.modid.AgentWebSocketServer.WsHandler;
import name.modid.mixin.BookEditScreenAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.MultilineTextField;
import net.minecraft.client.gui.screens.inventory.BookEditScreen;
import net.minecraft.util.StringUtil;

/**
 * 书与笔 API —— 读取/编辑书页文字，翻页，保存并关闭。
 * 工作流: book/get → book/set (逐页编辑) → book/close
 *
 * <p>book/set 按书的编辑框同样的规则查文字（书与笔训练场设计方案 J3 做法 A）：不能有编辑框打不出来的字符（§、控制字符、DEL；换行可以），
 * 最多 1024 个字符，按 114 像素宽折行最多 14 行（BookEditScreen 87–88 行）。不符合就报错、页不变、不截断。
 */
public class BookApi {

    /** 书的编辑框：每页最多 1024 个字符、14 行，文字区宽 114 像素（BookEditScreen 30、87–88 行） */
    private static final int PAGE_CHARS = 1024;
    private static final int PAGE_LINES = 126 / 9;
    private static final int PAGE_WIDTH = 114;
    /** 1 秒内客户端线程没做完（Map.of 不收 null，所以给一句明确的话） */
    private static final String TIMEOUT = "timed out waiting for the client thread";

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
        // J3：编辑框打不出来的字符（StringUtil.filterText 会删掉的）直接报错
        String filtered = StringUtil.filterText(text, true);
        if (!filtered.equals(text)) {
            int at = 0;
            while (at < filtered.length() && filtered.charAt(at) == text.charAt(at)) at++;
            return Map.of("status", "error", "message", String.format("text has a character the book editor rejects at index %d (U+%04X); § , control characters and DEL are not allowed, line breaks are", at, (int) text.charAt(at)));
        }
        if (text.length() > PAGE_CHARS) return Map.of("status", "error", "message", "text has " + text.length() + " characters, a page holds at most " + PAGE_CHARS);
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                // J3：用和编辑框一样的文字区（同样的折行）查行数；setValue 超出行数时不改值
                MultilineTextField probe = new MultilineTextField(mc.font, PAGE_WIDTH);
                probe.setCharacterLimit(PAGE_CHARS);
                probe.setLineLimit(PAGE_LINES);
                probe.setValue(text);
                if (!probe.value().equals(text)) {
                    result.error = "text needs more than " + PAGE_LINES + " lines at the book's " + PAGE_WIDTH + " px width";
                    latch.countDown();
                    return;
                }
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

                // 如果在当前页，刷新编辑器显示（updatePageContent 同时重算页码）
                if (pageIdx == acc.getCurrentPage()) {
                    acc.invokeUpdatePageContent();
                } else {
                    // 改的不是当前页（比如在后面追加了一页）：编辑框不动，只重算右上角的页码缓存（BookEditScreen 53、156、216 行），
                    // 否则屏幕上的"共 y 页"要等翻页才更新
                    acc.setNumberOfPages(acc.invokeGetPageNumberMessage());
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
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
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

    /** 保存并关闭：等客户端线程做完再返回；当前不是书的编辑界面时报错（和 book/set、book/page 一致）。 */
    private static Map<String, Object> close() {
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                var acc = (BookEditScreenAccessor) bookScreen;
                acc.invokeSaveChanges();
                mc.setScreen(null);
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
}
