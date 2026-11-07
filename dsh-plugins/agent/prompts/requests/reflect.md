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

## 成本画像

这次的树实际花了多少、花在哪（系统按事件统计；只是事实，哪里该改由你判断）：

```text
{{profile}}
```

## 和参考过的同类任务比

{{compare}}

## 涉及这次所用版本的待核对判断

以前替换胶囊时记下的"哪一版在什么情况下更好"，这次用到了其中一侧的版本、还没核对过的：

{{versionClaims}}

## 以往任务里待验证的问题

这次规划 / 展开 / 修补时用 `task_get` 参考过的任务，复盘时记下、还没核对的问题：

{{review}}

请按下面的「任务复盘」评估这次的树（`task_assess`），并决定要不要把这次任务里的子树 / 代码存进胶囊库：用 `capsule_save` 保存（可以多次），最后用 `bt_reflect_done` 结束（`requestId: "{{requestId}}"`）。什么都不存也要用 `bt_reflect_done` 结束，并写明理由。

{{skill}}
