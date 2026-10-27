上一回合出错结束，请求 {{requestId}} 还没有提交。错误：

```text
{{error}}
```

请重新用 `{{submitTool}}` 提交（`requestId: "{{requestId}}"`），或用 `bt_abort_task` 放弃并写明理由。

这次出错算作一次不合法尝试，还剩 {{attemptsLeft}} 次。

如果错误是工具参数的 JSON 不完整 / 不合法：多半是一次提交太长。把代码草稿写短（只写这一段要用的、去掉注释与兜底分支），或者把一部分节点改成 `expand`，留到以后再写。
