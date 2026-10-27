上一回合出错结束，快树批次 {{batchId}} 还没有结束。错误：

```text
{{error}}
```

请重新用 `fast_submit_patch` 提交（`batchId: "{{batchId}}"`），或用 `fast_skip` 写明为什么不改。

这次出错算作一次不合法尝试，还剩 {{attemptsLeft}} 次。

如果错误是工具参数的 JSON 不完整 / 不合法：多半是一次提交太长。把条件代码写短（去掉注释与兜底分支），或者把补丁拆成几次提交。
