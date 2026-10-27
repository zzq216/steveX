# 复盘请求 {{requestId}}（任务 {{taskId}}，已结束：{{state}}，{{by}}，用时 {{seconds}} s）

{{manual}}任务：{{goal}}
结果：{{result}}

## 目录

```text
{{directory}}
```

目录只列出有哪些东西可看，内容用 `bt_inspect` 取（任务已结束：没有 `live`，`eval` 要给 `at`）。看哪些、看多少由你决定。

## 最终的树

```text
{{tree}}
```

请按下面的「任务复盘」决定要不要把这次任务里的子树 / 代码存进胶囊库：用 `capsule_save` 保存（可以多次），最后用 `bt_reflect_done` 结束（`requestId: "{{requestId}}"`）。什么都不存也要用 `bt_reflect_done` 结束，并写明理由。

{{skill}}
