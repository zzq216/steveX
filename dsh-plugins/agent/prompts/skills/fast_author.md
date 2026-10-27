# skill：快树生成

## arm 的格式

```json
{ "when": <条件>, "then": <子树> }
```

- `then` 用编写格式写（与任务树相同）。它的**根节点必须有名字**（`seq` / `steps` 的名字，或 `name` 字段），arm 靠这个名字寻址，名字在一棵快树里唯一
- `when` 是一个条件，通常是条件代码：`{ "cond": "code/fast.<名字>", "read": ["player"], "params": { … } }`

## `when` 的限制

- 每 tick 都要算：只能读**轮询缓存**里的状态来源（`player` / `inventory` / `f3` / `container`，写在 `read` 里），不能查记忆、不能读黑板
- 条件代码的 `main(params, state)` 返回 `true` / `false`，单次求值超过 50 ms 会被判为不成立。字段名不确定就用 `data_shapes` 查 `state.player` 等的结构
- 新的条件代码放在提交的 `code` 字段里：`{ "fast.<名字>": { "signature": { "inputs": { … }, "returns": "bool" }, "body": "function main(params, state) { … }" } }`，名字必须以 `fast.` 开头。补丁被接受时它会存进胶囊库；已有的条件代码用 `capsule_search` / `capsule_get` 找
- 读不到某个来源（还没轮询到）时，条件按不成立处理

## `then` 的限制

- 没有黑板：不能用 `$键`、`writes`、`compute`、`use`、`expand`
- 情节必须能结束：一个情节最长 30 秒，超时按失败收场。`repeat` 要有次数或 `until`
- 情节开始前，执行器会先中止正在做的任务、松开所有按键、关掉打开的界面；情节结束后任务会收到恢复请求，由任务会话决定怎么继续
- 快树每个 arm 的 `then` 最多 15 个节点

## 优先级

快树从上到下检查，第一个成立的 `when` 赢。用 `add` 的 `before` / `after` 或 `move` 决定位置。
