package name.modid.arena;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.network.Filterable;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.WritableBookContent;
import net.minecraft.world.item.component.WrittenBookContent;
import net.minecraft.world.phys.AABB;

/**
 * 书与笔训练场（docs/书与笔训练场设计方案.md）的计算部分：发带内容的书与笔（J11）、读书的页、到达检测（J10）。
 * 全部在服务器线程上调用（同 {@link ArenaManager}）。
 *
 * <p>页一律读原文（{@link Filterable#raw}，单人世界不开文字过滤，F8）。
 */
public final class BookArena {

    /** expect.book：每本书的目标页列表（J6、J10），按多重集合比，不比哪本在哪一格。 */
    public record Spec(List<List<String>> goals) {}

    public static final String WRITABLE = "minecraft:writable_book";
    public static final String WRITTEN = "minecraft:written_book";

    private BookArena() {}

    /** 新建一本书与笔（J11）：数量 1，最多 100 页、每页最多 1024 个字符（WritableBookContent 14–15 行，F2）。 */
    public static ItemStack stack(String id, int count, List<String> pages) {
        if (!WRITABLE.equals(id)) throw new IllegalArgumentException("items[].pages needs " + WRITABLE + ", got " + id);
        if (count != 1) throw new IllegalArgumentException("a writable book with pages must have count 1, got " + count);
        if (pages.size() > WritableBookContent.MAX_PAGES) throw new IllegalArgumentException("at most " + WritableBookContent.MAX_PAGES + " pages, got " + pages.size());
        for (String page : pages) {
            if (page.length() > WritableBookContent.PAGE_EDIT_LENGTH) throw new IllegalArgumentException("a page has " + page.length() + " characters, the limit is " + WritableBookContent.PAGE_EDIT_LENGTH);
        }
        ItemStack stack = new ItemStack(Items.WRITABLE_BOOK);
        stack.set(DataComponents.WRITABLE_BOOK_CONTENT, new WritableBookContent(pages.stream().map(Filterable::passThrough).toList()));
        return stack;
    }

    /** 书与笔的页（原文）；不是书与笔 → null。 */
    public static List<String> pages(ItemStack stack) {
        WritableBookContent content = stack.get(DataComponents.WRITABLE_BOOK_CONTENT);
        if (!stack.is(Items.WRITABLE_BOOK) || content == null) return null;
        return content.pages().stream().map(Filterable::raw).toList();
    }

    /** 一件物品的摘要：{ id, count, pages?, title? }；书与笔带页，成书带页（纯文字）和标题；空 → null。 */
    public static Map<String, Object> describe(ItemStack stack) {
        if (stack == null || stack.isEmpty()) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        out.put("count", stack.getCount());
        List<String> pages = pages(stack);
        if (pages != null) out.put("pages", pages);
        WrittenBookContent written = stack.get(DataComponents.WRITTEN_BOOK_CONTENT);
        if (stack.is(Items.WRITTEN_BOOK) && written != null) {
            out.put("pages", written.pages().stream().map(p -> p.raw().getString()).toList());
            out.put("title", written.title().raw());
        }
        return out;
    }

    /** 玩家身上（不含光标）的每一件物品：[{ slot, id, count, pages?, title? }]。 */
    public static List<Map<String, Object>> items(Inventory inv) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            Map<String, Object> d = describe(inv.getItem(i));
            if (d == null) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("slot", i);
            row.putAll(d);
            out.add(row);
        }
        return out;
    }

    /** 场内地上的每一件物品（摘要同 {@link #describe}）。 */
    public static List<Map<String, Object>> dropped(ServerLevel level, AABB box) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) {
            Map<String, Object> d = describe(e.getItem());
            if (d != null) out.add(d);
        }
        return out;
    }

    /**
     * J10（光标为空由调用方检查）：玩家身上（主物品栏、快捷栏、盔甲、副手）只有书与笔，恰好 goals.size() 本，
     * 页列表（逐字）和目标作为多重集合相等。不比哪本在哪一格。
     */
    public static boolean reached(Inventory inv, Spec spec) {
        Map<List<String>, Integer> have = new HashMap<>();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (s.isEmpty()) continue;
            List<String> pages = pages(s);
            if (pages == null || s.getCount() != 1) return false;
            have.merge(pages, 1, Integer::sum);
        }
        Map<List<String>, Integer> want = new HashMap<>();
        for (List<String> g : spec.goals()) want.merge(List.copyOf(g), 1, Integer::sum);
        return have.equals(want);
    }
}
