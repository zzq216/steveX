上一回合出错结束，复盘请求 {{requestId}} 还没有结束。错误：

```text
{{error}}
```

请继续复盘：用 `capsule_save` 保存，最后用 `{{submitTool}}` 结束（`requestId: "{{requestId}}"`）。已经存进库的胶囊不用重存。

还能再出错 {{attemptsLeft}} 次，用完复盘按放弃关闭。如果错误是工具参数的 JSON 不完整 / 不合法：多半是一次提交太长，把子树或代码写短一些。
