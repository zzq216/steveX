# JSON 查询 API 设计方案

> 让 agent 写的树能从**白名单里的 JSON 文件**查数据（第一个用途：查合成配方），照 [nbt查询api设计方案.md](nbt查询api设计方案.md) 的形状：宿主装载 → 筛选 → 投影 → 截断，只出短列表。
> 状态：**已实现（2026-10-24）**——`src/json/`（宿主侧）+ `dsh-plugins/agent/src/capsules/builtins.js`（内置条目 `code/core.json.query`）；测试 `test/json/api.test.js`、`dsh-plugins/agent/test/features.test.js`。
> 最后更新：2026-10-24

---

## 0. 前置决策（引用）

| 来源 | 决策 | 本方案怎么用 |
|---|---|---|
| [nbt查询api设计方案.md](nbt查询api设计方案.md) 全文 | 筛选语法、投影、截断、任务级快照、读一致性、错误码 | **全部沿用**，筛选 / 投影 / 截断直接复用 `src/nbt/query.js` |
| [行为树](行为树节点设计方案.md) B10（2026-10-24） | 撤销人写的配方表（`recipes.js`），agent 自己写 Compute 解析配方 | 本 API 是 agent 拿到配方数据的唯一途径 |
| 用户要求（2026-10-24） | 限定 agent 可以读取的文件目录，加入配方这个 JSON 文件；开放**处理好的** `recipes.json` | §4 白名单 |
| [算法层](算法层与执行层设计方案.md) §3.2 / §6.1 | 参数传句柄不传集合；大数据进缓冲区、黑板只放短结果 | 文件整体留在宿主缓存，只有命中的几条进黑板 |

---

## 1. 定位

```
name:    core.json.query
folder:  code/              ← 树里用 Compute 调用：{ "compute": "code/core.json.query", ... }
locked:  true
body:    { host: 'json.query', literalParams: true }   ← 宿主实现（要读盘），不是沙箱代码
```

和 `core.nbt.query` 一样是**内置条目**：由宿主代码定义，只在内存里，不落盘；`/bt capsules` 能看到它。

**`cost` = `local_scan`**：读本地文件 + 扫描。只能出现在任务树的 `Compute` 里，快树里不能有 Compute。

---

## 2. 接口

### 2.1 输入（5 个，全部只许字面量）

| 名 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `path` | string | 是 | 数据源标识，或 `<目录源>/<相对路径>.json`（§4）。**不接受文件路径** |
| `records` | string | 否 | 记录数组在文件里的点分路径（如 `"recipes"`）；文件根就是数组时省略 |
| `filters` | object | 否 | 同 NBT：键 = 记录内点分路径，值 = 字面量 / `{min,max}` 区间 / 数组 = 并集；多键 AND |
| `fields` | string[] | 是 | 投影：输出哪些路径。没有"全字段"默认值 |
| `limit` | int | 否 | 1..512，默认 64 |

比 NBT 多一个 `records`：NBT 的记录集由数据源定义死，JSON 文件的结构各不相同，需要指出"哪个数组是记录"。

**为什么只许字面量**：`path` 字面量 → 白名单在**装载期**静态可判（树装载时就拒绝越界路径，不用等运行）；其余三个字面量 → 语义可静态检查、便于审阅（同 NBT §3.1）。

### 2.2 输出

| 键 | 类型 | 说明 |
|---|---|---|
| `result` | list | 命中并投影后的记录（键 = `fields` 里的路径字符串本身） |
| `matchedCount` | number | 截断前的命中总数 |
| `sourceVersion` | string | 文件快照版本戳（mtime + 尺寸） |

### 2.3 调用点示例

```json
{ "compute": "code/core.json.query",
  "params": { "path": "recipes", "records": "recipes",
              "filters": { "result": "minecraft:wooden_pickaxe" },
              "fields": ["type", "pattern", "key", "count"], "limit": 4 },
  "writes": { "recipe": "result.0", "recipe.matched": "matchedCount" } }
```

`writes` 的值可以是输出里的路径（`result.0` = 第一条命中）。之后由 agent 写的 Compute 读 `$recipe` 算点击计划。

---

## 3. 语义

- **筛选 / 投影 / 截断**：与 NBT 查询完全相同（同一份代码）。字段缺失 / 类型不符 = 该记录不匹配，不报错；投影缺字段 = 该键缺席；超 `limit` 或超字节上限 = 截断，`matchedCount` 如实
- **坐标糖**沿用：数组后面的 `.x` / `.y` / `.z` 取第 0 / 1 / 2 个元素；**没有数字下标**（`pattern.0` 不行，整列投影 `pattern` 后在 Compute 里处理）
- **记录不是对象**（如字符串数组）：路径一律视为缺失
- **快照**：~~首次查询时读盘、按 `(taskId, path)` 钉住；同一任务内文件被改也看同一份；任务结束释放~~ **2026-10-25 改（与 NBT 统一，[P2实施细则.md](P2实施细则.md) §6.3）**：缓存按 `(path, 版本戳)`，每次查询先 stat，版本没变复用、变了重读；`releaseTask` 保留为空操作；另有只 stat 的 `version(path)`

---

## 4. 白名单（安全）

配置项 `jsonSources`（`dsh-plugins/agent/src/config.js`）：`{ 标识: 文件或目录 }`，路径相对 `steveX/`。**默认只有一项**：

```js
jsonSources: { recipes: 'dsh-plugins/agent/data/recipes.json' }
```

`path` 参数的规则：

| 形态 | 条件 |
|---|---|
| `<标识>` | 标识指向一个文件 |
| `<标识>/<相对路径>` | 标识指向一个目录；每段只允许 `[A-Za-z0-9._-]`、不得是 `.` / `..`；以 `.json` 结尾 |

- 反斜杠、`/` 开头、盘符开头一律拒绝；未知标识拒绝并列出可用标识
- 运行时对目录源再做一次 `realpath`，确认文件真的在目录里——**符号链接逃逸**在这一步拦下
- 单文件大小上限 64 MB（`SOURCE_TOO_LARGE`）

**为什么要白名单**：写树的是大模型。`steveX/configs/environments/` 里是 API 密钥，任意路径 = 任意文件读取（同 NBT §6.1）。要开放新文件，改配置里的 `jsonSources`，不改代码。

---

## 5. 失败模式

| 情形 | 结果 |
|---|---|
| 没有命中 | **SUCCESS**，`result: []`、`matchedCount: 0` |
| `path` 越界 / 未知标识 / 参数形态错 / 用了 `$` 引用 | **装载错误**：树校验不通过（`LOAD_ERROR`） |
| `records` 指向的不是数组 | FAILURE（`LOAD_ERROR`），错误里列出文件顶层有哪些数组键 |
| 文件不存在 | FAILURE（`SOURCE_MISSING`） |
| 不是合法 JSON | FAILURE（`SOURCE_CORRUPT`） |
| 读的过程中文件一直在变 | FAILURE（`SOURCE_UNSTABLE`，重读一次仍变） |
| 文件超过大小上限 | FAILURE（`SOURCE_TOO_LARGE`） |

---

## 6. 配方数据

`data/recipes.json` 由 `dsh-plugins/agent/scripts/extract-recipes.js` 从 MC jar 生成（不进 git）：

```json
{ "source": "minecraft-merged-….jar",
  "recipes": [
    { "name": "stick", "result": "minecraft:stick", "count": 4, "type": "shaped",
      "pattern": ["#", "#"], "key": { "#": ["minecraft:oak_planks", "…11 种木板"] } },
    { "name": "oak_planks", "result": "minecraft:oak_planks", "count": 4, "type": "shapeless",
      "ingredients": [["minecraft:oak_log", "minecraft:oak_wood", "…"]] } ] }
```

"处理好的"指：只保留 `crafting_shaped` / `crafting_shapeless`（1026 条），**标签已展开**成具体物品列表。原始的 `#minecraft:planks` 标签与熔炉 / 切石机等配方不开放（用户 2026-10-24 选择）；要开放，在 `jsonSources` 里加目录源即可。

---

## 7. 待定

| # | 问题 | 现状 |
|---|---|---|
| 1 | 字节上限 / 超时的具体值 | 沿用 NBT 的占位值（256 KB / 5 s），实测后回填 |
| 2 | 数组"包含"条件（如"ingredients 里有某物品"） | 不做；整列投影后在 Compute 里判断（同 NBT 审阅点 4） |
| 3 | `records` 能否指向数组里的数组 | 只支持对象键路径 |
