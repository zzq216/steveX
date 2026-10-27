# skill：慢树大纲

把一条指令写成一棵**马上可以开始执行**的树。

## 步骤

1. **看有什么可用**：`capsule_search` 看有没有做过的同类子树或代码；`command_docs` 查原始命令的名字与参数。要写处理数据的条件代码 / Compute，先用 `data_shapes` 查数据长什么样：`state.*`（玩家状态、背包、F3、容器界面）、`json.recipes`（配方）、`nbt.*`（记忆世界）的字段结构与词表（枚举型字段的全部取值，如 `container.type` 的工作台是 `"crafting"`）。字段含义用 `command_docs` 查对应的读取命令（`inventory`、`container/get`……）。**不要猜字段名**——猜错了，条件代码要么永远不成立，要么像"找不到字段就返回 true"那样形同虚设。你看不到当前状态的值——它们由树去读（见下面"先读后展开"）。
2. **拆任务**：把指令拆成几个子任务（按先后顺序）。
3. **只沿第一条路径拆到底**：只拆**第一个**子任务，得到它的几个子子任务；再只拆其中**第一个**……直到第一个可以直接写成具体节点（`steps` / `act` / `compute` / `cond` / `forEach`）为止。
4. **其余全部留成 `expand`**：同一层的后续兄弟、上面各层的后续子任务，都写成 `{ "expand": 目标 }`。目标写清楚"要达成什么"，不写"怎么做"——展开时你能看到那时的状态，会比现在想得更准。
5. **一次提交**：用 `bt_submit_tree` 交回，`requestId` 用请求里的那个。被拒绝就按错误原文修正后重交。

形状：

```
seq 任务
├─ seq 子任务1
│   ├─ 子子任务1          ← 具体节点
│   ├─ expand 子子任务2
│   └─ expand 子子任务3
├─ expand 子任务2
└─ expand 子任务3
```

## 先读后展开

你写大纲时不知道现状（背包里有什么、配方是什么、附近有什么）。不要猜，**把"读"写成第一条路径上的具体节点**，把依赖读取结果的部分留成 `expand`：

```
seq 做木镐
├─ compute code/core.json.query → recipe.pickaxe   ← 具体节点：查配方
├─ expand 按 $recipe.pickaxe 准备材料              ← 展开时黑板里已有 recipe.pickaxe
└─ expand 合成木镐
```

- 读状态：条件代码 / Compute 的 `read`（`player` / `inventory` / `f3` / `container`）；查记忆：`code/core.nbt.query`；查配方等数据：`code/core.json.query`
- 读到的结论写进黑板（带前缀的键名），后面用 `$键` 引用，**不要把值抄成字面量**
- 需要按情况分支（有工作台 / 没有），就写成 `sel` + `cond`，让树在执行时判断

## 注意

- 具体节点要有验收：关键的 `steps` / `act` 写 `expect`，让失败有证据。
- 需要算东西（点击计划、坐标、计数）就写 Compute 代码，放在提交的 `code` 字段里。
- 指令不清楚、或者当前做不到（缺前置条件又无从获取）：用 `ask_user_question` 问人，或 `bt_abort_task` 放弃并说明原因。
