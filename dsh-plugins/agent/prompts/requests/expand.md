# 展开请求 {{requestId}}（任务 {{taskId}}，树 v{{version}}）

任务：{{taskGoal}}

需要展开：**{{nodeId}}** — {{goal}}
所在位置：{{path}}

本回合不能调用 `mod_query` / `nbt_query` / `json_query` / `bt_inspect`：树要用的数据由树自己读；数据的字段结构与取值用 `data_shapes` 查。

## 当前树

```text
{{tree}}
```

## 黑板（只给形状，不给值；用 `$键` 引用）

```text
{{blackboard}}
```

本任务的代码草稿：{{drafts}}

请按下面的「慢树展开」写出替换 {{nodeId}} 的子树，用 `bt_submit_expansion` 提交（`requestId: "{{requestId}}"`）。不合法时工具会返回逐条错误，请在本回合内修正后重交；同一请求最多 {{maxAttempts}} 次。

{{skill}}
