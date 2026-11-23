上一回合出错结束，复盘请求 {{requestId}} 还没有结束。错误：

```text
{{error}}
```

请继续复盘：用 `capsule_save` 保存，最后用 `{{submitTool}}` 结束（`requestId: "{{requestId}}"`）。已经存进库的胶囊不用重存。

{{charge}}出错那一步的工具调用都没有执行（同一条消息里的其他调用也一样）；在那之前已经执行的调用照常有效。
