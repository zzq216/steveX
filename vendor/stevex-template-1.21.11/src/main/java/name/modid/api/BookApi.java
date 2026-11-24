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
 * 工作流: book/get → (book/page → book/set)… → book/close
 *
 * <p>和原版编辑框一致（告示牌训练场设计方案 Q9）：打字只改当前页，翻页是单独的操作（原版的翻页按钮）；
 * 在最后一页再往后翻会追加一张空页（BookEditScreen.pageForward 140–152 行）。
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
    /** 书最多 100 页（BookEditScreen.appendPageToBook 182–186 行） */
    private static final int MAX_PAGES = 100;

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

    /** 把当前页改成 text：只改当前页，翻页用 book/page（Q9）。 */
    private static Map<String, Object> setText(Map<String, Object> params) {
        if (params.containsKey("page")) {
            return Map.of("status", "error", "message", "book/set only edits the current page; turn pages with book/page first");
        }
        if (!(params.get("text") instanceof String text)) return Map.of("status", "error", "message", "text must be a string");
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
                acc.getPages().set(acc.getCurrentPage(), text);
                acc.invokeUpdateLocalCopy();
                // 刷新编辑框显示（updatePageContent 同时重算页码）
                acc.invokeUpdatePageContent();
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

    /**
     * 翻到第 page 页（0 起）：已有的页直接翻过去（等同于连点翻页按钮）；page 等于总页数时追加一张空页再翻过去，
     * 等同于在最后一页点"下一页"（pageForward 140–152 行），最多 100 页；再往后报错（Q9）。
     */
    private static Map<String, Object> goToPage(Map<String, Object> params) {
        if (!(params.get("page") instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())) {
            return Map.of("status", "error", "message", "page must be an integer");
        }
        int target = n.intValue();
        var result = new Object(){ boolean ok = false; String error = TIMEOUT; };
        CountDownLatch latch = new CountDownLatch(1);
        Minecraft.getInstance().execute(() -> {
            var mc = Minecraft.getInstance();
            if (mc.screen instanceof BookEditScreen bookScreen) {
                var acc = (BookEditScreenAccessor) bookScreen;
                int size = acc.getPages().size();
                if (target == size && size >= MAX_PAGES) {
                    result.error = "the book already has " + MAX_PAGES + " pages";
                } else if (target < 0 || target > size) {
                    result.error = "page " + target + " out of range (0–" + size + "; " + size + " appends a blank page)";
                } else {
                    if (target == size) acc.invokeAppendPageToBook();
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
