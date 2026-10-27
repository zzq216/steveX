# 规划请求 {{requestId}}（任务 {{taskId}}）

指令：**{{instruction}}**

本回合不能调用 `mod_query` / `nbt_query` / `json_query` / `bt_inspect`：树要用的数据由树自己读（`read`、`code/core.nbt.query`、`code/core.json.query`）；数据的字段结构与取值用 `data_shapes` 查。

请按下面的「慢树大纲」写出这个任务的大纲树，用 `bt_submit_tree` 提交（`requestId: "{{requestId}}"`）。树不合法时工具会返回逐条错误，请在本回合内修正后重交；同一请求最多 {{maxAttempts}} 次。

{{skill}}
