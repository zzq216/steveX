# 死亡恢复请求 {{requestId}}（任务 {{taskId}}，树 v{{version}}）

任务：{{taskGoal}}

你在执行任务时死了。执行器已经中止任务树、自动重生，任务树现在挂起，等你决定怎么继续。死亡时身上的东西掉在了死亡地点。

## 目录

```text
{{directory}}
```

目录只列出有哪些东西可看，内容用 `bt_inspect` 取（`what` 与参数见工具说明；`death` 是死前最后一次读到的状态，`respawn` 是重生后的状态）。看哪些、看多少由你决定。

## 当前树

```text
{{tree}}
```

本任务的代码草稿：{{drafts}}

请按下面的「慢树恢复」决定怎么继续，用 `bt_submit_patch` 提交（`requestId: "{{requestId}}"`；`ops: []` = 原树继续），或用 `bt_abort_task` 放弃。不合法时工具会返回逐条错误，请在本回合内修正后重交；同一请求最多 {{maxAttempts}} 次。

{{skill}}
