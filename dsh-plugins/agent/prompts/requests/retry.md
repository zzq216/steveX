上一回合出错结束，请求 {{requestId}} 还没有提交。错误：

```text
{{error}}
```

{{detail}}请重新用 `{{submitTool}}` 提交（`requestId: "{{requestId}}"`），或用 `bt_abort_task` 放弃并写明理由。

{{charge}}

出错那一步的工具调用都没有执行（同一条消息里的其他调用也一样）；在那之前已经执行的调用照常有效。已经写下的代码草稿还在：{{drafts}}。
