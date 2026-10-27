# 树的编写格式

提交的树是 JSON。你只写**编写格式**；`id` 由编译器补（根是 `n1`，孩子是 `<父 id>.<序号>`），`mode` 缺省是记住游标的 `memory`。

| 写法 | 含义 |
|---|---|
| `{ "seq": 名字, "do": [...] }` | 顺序：逐个执行，任一失败即失败。**记住游标**，已完成的步骤不会重跑 |
| `{ "seq": 名字, "mode": "reactive", "every"?: 毫秒, "do": [...] }` | 反应式顺序：最后一个孩子在跑时，每隔 `every`（缺省 1000，至少 200）把它前面的孩子重新求值一遍，有一个不成立 → 中止正在跑的孩子、整个序列失败。最后一个孩子之前只能是 `cond` / `compute`（或只由它们组成的 seq / sel） |
| `{ "sel": 名字, "do": [...] }` | 选择：逐个尝试，第一个成功即成功（任务树里不能用 `reactive`） |
| `{ "steps": 名字, "do": [[命令, 参数?], ...], "expect"?: 条件 }` | 一段**无读取、无分支**的原始命令；`["wait", 毫秒]` 是等待。被打断时整段从头重跑 |
| `{ "act": 命令, "params"?: {...} 或 "$键", "writes"?: {...}, "expect"?: 条件 }` | 单条原始命令 |
| `{ "cond": "blackboard/compare" 或 "blackboard/has", "params": {...} }` | 读黑板的条件 |
| `{ "cond": "code/名字" 或 "task/名字", "read": [来源], "params"?: {...} }` | 条件代码：读 `read` 里的状态，返回真 / 假 |
| `{ "compute": "code/名字" 或 "task/名字", "read"?: [来源], "params"?: {...}, "writes"?: {...} }` | 调一段纯函数代码（或内置查询），结果写黑板 |
| `{ "use": "trees/名字", "params"?: {...} }` | 调用一棵可复用子树 |
| `{ "expand": 目标 }` | 占位：执行到这里时再叫你展开 |
| `{ "repeat": 名字, "n": 次数, "do": 节点 }` 或 `{ "repeat": 名字, "until": 条件, "maxIterations": 上限, "do": 节点 }` | 循环 |
| `{ "forEach": "$列表键", "as": 键, "indexAs"?: 键, "maxIterations"?: 上限, "do": 节点 }` | 逐项遍历黑板上的列表 |
| `{ "invert": 节点 }` / `{ "retry": n, "delayMs"?: 毫秒, "do": 节点 }` / `{ "timeout": 毫秒, "do": 节点 }` | 装饰器 |

所有节点都可以带 `"name"`（给人读，不影响执行）。

## 规则

- **命令**：`steps` / `act` 里只能用 mod 原始命令里**有作用**的那些（`command_docs` 查名字与参数）。`read=true` 的读取命令（`inventory`、`container/get`……）不能出现在 `steps` / `act` 里——读状态用条件代码或 Compute 的 `read`。
- **状态来源** `read` ⊆ `player` / `inventory` / `f3` / `container`：执行到那个节点时现场读一次，作为 `main(params, state)` 的第二个参数（`state.inventory` 等）。字段结构与词表用 `data_shapes` 查（给结构和枚举取值，不给此刻的值），字段含义用 `command_docs` 查对应的读取命令。内置查询 `core.json.query` / `core.nbt.query` 返回的记录格式同样用 `data_shapes`（`json.<源>` / `nbt.<源>`）查。**世界状态不进黑板**，进黑板的只有你算出来的结论。
- **黑板**：`params` 里的 `"$键"` 或 `"$键.字段"` 读黑板；读的键必须有来源（初始黑板、前面某个节点的 `writes`、Compute 的输出、`forEach` 的 `as`）。`writes` 是映射 `{ 黑板键: 结果里的路径 }`（`"."` = 整个结果）；Compute 不写 `writes` 时每个输出写进同名键。跨节点用的键带前缀（`plan.clicks`、`wood.count`）。
- **不要把读到 / 算出的值写成字面量**：用到的数据要么来自初始指令，要么由树读取后经黑板 `$键` 传递。写死某一次的格子号、坐标、物品名，这棵树就提取不成可复用的技能。
- **胶囊引用**可以省略 `@hash`，执行器装载时钉到最新版。内置查询 `code/core.json.query` / `code/core.nbt.query` 的参数只许字面量。
- **`expect`**：挂在 `steps` / `act` 上的验收条件，命令发完后求值，不成立 → 该节点失败，错误里附带"实际发生了什么"（背包 / 界面 / 坐标的前后差异）。关键步骤都写 `expect`。
- **规模**：单次提交编译后至多 **15** 个节点；超了就把后面的部分改成 `expand`。

## 代码（`code` 字段）

提交工具可以附带**任务内代码草稿**：`{ 名字: { signature, body, description? } }`，树里用 `task/名字` 引用，只在本任务内有效。

- `signature`：`{ inputs: { 名: { type, required?, item? } }, outputs: { 名: { type } } }`（Compute），或 `{ inputs, returns: "bool" }`（条件代码）。类型：`any` `string` `number` `int` `bool` `list` `object` `vec3`
- `body`：TS 或 JS 源码，定义同步函数 `function main(params, state) { … }`。Compute 返回一个对象（键 = outputs）；条件返回 `true` / `false`
- 沙箱里没有 `require` / 文件 / 网络 / 定时器 / `Date` / `Math.random` / `eval`；进出都是 JSON；Compute 硬超时 1 秒、条件 50 毫秒

## 例子

```json
{
  "requestId": "p1",
  "tree": {
    "seq": "合成木板",
    "do": [
      { "compute": "code/core.json.query", "name": "查配方",
        "params": { "path": "recipes", "records": "recipes", "filters": { "result": "minecraft:oak_planks" }, "fields": ["type", "ingredients", "count"], "limit": 2 },
        "writes": { "planks.recipes": "result" } },
      { "steps": "打开背包", "do": [["key/inventory"], ["wait", 200]] },
      { "compute": "task/plan-clicks", "read": ["container"], "params": { "recipes": "$planks.recipes" }, "writes": { "plan.clicks": "clicks" } },
      { "forEach": "$plan.clicks", "as": "click", "maxIterations": 32, "do": { "act": "container/slot", "params": "$click" } },
      { "expand": "确认木板进了背包，关掉界面" }
    ]
  },
  "code": {
    "plan-clicks": {
      "description": "按当前界面里原木所在的格子，算出把它放进合成格并取出产物的点击序列",
      "signature": { "inputs": { "recipes": { "type": "list", "required": true } }, "outputs": { "clicks": { "type": "list" } } },
      "body": "function main(p, state) { const clicks = []; /* 读 state.container 的格子布局… */ return { clicks } }"
    }
  }
}
```
