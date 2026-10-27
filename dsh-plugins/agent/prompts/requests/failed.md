# 修复请求 {{requestId}}（任务 {{taskId}}，树 v{{version}}）

任务：{{taskGoal}}

任务树的根返回了 FAILURE。执行器已经让失败的那一步原地重试过一次，仍然失败。任务树现在挂起，等你修复。

## 目录

```text
{{directory}}
```

目录只列出有哪些东西可看，内容用 `bt_inspect` 取（`what` 与参数见工具说明）。看哪些、看多少由你决定。

## 当前树

```text
{{tree}}
```

本任务的代码草稿：{{drafts}}

请按下面的「慢树反思」找出原因并修复，用 `bt_submit_patch` 提交（`requestId: "{{requestId}}"`），或用 `bt_abort_task` 放弃。不合法时工具会返回逐条错误，请在本回合内修正后重交；同一请求最多 {{maxAttempts}} 次。

{{skill}}
