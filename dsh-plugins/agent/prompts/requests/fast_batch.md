# 快树反思批次 {{batchId}}（{{count}} 条事件，当前快树 v{{version}}）

## 当前快树 v{{version}}（{{armCount}} 个 arm）

```text
{{arms}}
```

完整的树：

```text
{{tree}}
```

## 事件

```text
{{events}}
```

这里只有每条事件的一行摘要。前后状态、每次掉血的细节、arm 统计、历史版本都用 `fast_inspect` 取（`what` 与参数见工具说明）。看哪些、看多少由你决定。

请按下面的「快树反思」决定怎么改，用 `fast_submit_patch` 提交（`batchId: "{{batchId}}"`，`base: {{version}}`），或用 `fast_skip` 说明为什么不改。不合法时工具会返回逐条错误，请在本回合内修正后重交；同一批次最多 {{maxAttempts}} 次。

{{skill}}
