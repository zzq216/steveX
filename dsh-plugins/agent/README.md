# @stevex/dsh-agent

steveX 的行为树执行器、胶囊库与 Compute 沙箱，以及让大模型写树的工具与请求通道，打包成 DSH / Cordis 插件。设计见
[Agent系统与DSH集成设计方案.md](../../docs/Agent系统与DSH集成设计方案.md)、
[行为树节点设计方案.md](../../docs/行为树节点设计方案.md)、
[算法层与执行层设计方案.md](../../docs/算法层与执行层设计方案.md) §3 / §8、
[json查询api设计方案.md](../../docs/json查询api设计方案.md)。

## 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 执行器、编译器、校验器、黑板、事件日志；`/bt` 命令与独立脚本；本地应答器顶替大模型 | **已实现**；游戏内验收通过（快树抢占与恢复，2026-10-24） |
| **P0+** | 训练的基础设施：Compute 沙箱、胶囊库、`SubTree`、条件代码、Compute 读状态、`ForEach`、`expect` 与状态差异、JSON / NBT 查询 | **已实现**，单元测试通过 |
| **P1** | 大模型写树：十一个工具、`/bt task` 与路由 `task` handler 开规划、`followup` 叫醒展开、没提交就 `steer` 提醒、按请求限制工具、任务内代码草稿 `task/…`、profile bundle | **已实现**；DSH 内验收通过（木镐任务端到端、校验—修正、提交提醒，2026-10-24） |
| **P2** | 恢复与失效：`recover` / `escalate` / `failed` / `died` 请求、`bt_submit_patch`、`bt_inspect`、请求过期、reactive 复查间隔、查询读最新数据、死亡与重生 | **已实现**；游戏内部分验收（打断后续上、请求等待期间死亡），其余见 [P2待测场景.md](../../docs/P2待测场景.md) |
| **P3** | 快树进化：`player` 补着火 / 岩浆 / 细雪 / 最近受伤字段并一直轮询、没任务时的死亡与重生、快树事件流、批次与限流、快树反思会话、`fast_*` 工具、版本链与回滚、`/bt fast …` | **已实现**，单元测试通过；待游戏内验收（[P3实施细则.md](../../docs/P3实施细则.md) §11） |
| **P4** | 任务复盘与胶囊：`reflect` 请求、`bt_inspect tree`（树版本链）、`capsule_save`（草稿转正、写死的值检查、同名 `replaces`）、`bt_reflect_done`、`/bt reflect` | **已实现**；第一轮游戏内验收通过（存胶囊、下一次任务引用，[P4实施细则.md](../../docs/P4实施细则.md) §10.3），其余见 [P4待测场景.md](../../docs/P4待测场景.md) |
| **P5** | 事实库：`fact_search` / `fact_write`、`mc_source_search` / `mc_source_read`（只读源码基准）、`/bt fact` 与路由 `fact` handler、查了源码没写事实的提醒、`/bt facts` | **已实现**，单元测试通过；待 DSH 内验收（[P5实施细则.md](../../docs/P5实施细则.md) §11.2） |

**没有人写的技能**：读世界的条件、合成 / 挖掘这类高层动作、配方解析，都由 agent 在训练中写成胶囊。
插件只提供接口：mod 的原始命令、两条黑板条件、沙箱、胶囊库、查询 API。

## 结构

```
src/
  index.js          唯一接触 DSH 的文件：ctx.stevexBt、/bt 命令、卸载清理
  runtime.js        组装运行时（DSH 适配层与 scripts/ 共用）
  commands.js       默认命令注册表 = mod 原始命令 + 黑板条件
  config.js         配置与默认值
  bt/               零 DSH 依赖：节点、编译器、校验器、执行器、黑板、可观测性、事件日志、本地应答器、树概览
  fast/             零 DSH 依赖：快树事件流（monitor）、版本链与补丁（versions）、反思批次（reflector）、fast_inspect
  capsules/         零 DSH 依赖：胶囊库（含任务内草稿）、沙箱、契约（signature）、保存时校验、内置查询条目
  game/             零 DSH 依赖：mod 连接、状态读取 / 缓存、原始命令
  llm/              零 DSH 依赖：Bridge（请求 ↔ 会话、回合绑定、提醒、提交）、FastBridge（反思批次 ↔ 专用会话）、提示词装载、系统提示词清单
  tools/            零 DSH 依赖：给大模型的工具（defineTool 的选项对象；index.js 包装注册）
prompts/
  system/           常驻系统提示词：身份与边界、树的编写格式
  skills/           慢树大纲 / 慢树展开（由代码按请求放进消息，不让大模型自己挑）
  requests/         规划 / 展开 / 提醒 / 任务结束 的消息模板（{{变量}}）
scripts/
  extract-recipes.js  从 MC jar 生成 data/recipes.json（JSON 查询的默认数据源）
  capsule-save.js     把一个胶囊条目存进库（P4 的 capsule_save 工具走同一个 saveCapsule）
  bt-run.js           不启动 DSH、直连 mod 跑手写树
examples/           手写树与示例胶囊
test/               node --test；test/fake_mod.js 是内存里的假客户端
```

查询 API 的宿主侧在 steveX 根目录：[src/json/](../../src/json/)（新）、[src/nbt/](../../src/nbt/)。

## 准备

```bash
cd steveX/dsh-plugins/agent
npm run extract-recipes   # 需要先跑过一次 npm run mc:capture（loom 缓存里才有 MC jar）
npm test
```

## 胶囊

```bash
node scripts/capsule-save.js examples/capsules/example.air-below.json   # 存一个条目，打印 code/<name>@<hash>
node scripts/capsule-save.js --list                                     # 列出库里的条目（含内置查询）
```

条目格式：`{ "folder": "code" | "trees", "name", "description"?, "signature", "body" }`。

| 种类 | `signature` | `body` | 树里怎么用 |
|---|---|---|---|
| 条件代码 | `{ inputs, returns: "bool" }` | TS / JS：`function main(params, state): boolean` | `{ "cond": "code/x", "read": ["inventory"], "params": {…} }` |
| Compute | `{ inputs, outputs }` | TS / JS：`function main(params, state?) { return { 输出… } }` | `{ "compute": "code/x", "read"?: [...], "params": {…}, "writes"?: {…} }` |
| 子树 | `{ inputs, outputs }` | 一棵树（编写格式或执行格式） | `{ "use": "trees/x", "params": {…} }` |

- `read` 可选 `player` / `inventory` / `f3` / `container`，快照作为 `main` 的第二个参数（不进黑板）
- 沙箱里没有 `require` / `process` / 文件 / 网络 / 定时器 / `Date` / `Math.random` / `eval`；硬超时 Compute 1 s、条件 50 ms
- 引用可以省略 `@hash`，装载时钉到最新版；存进树文件的永远带 hash
- 内置：`code/core.json.query`（白名单 JSON，默认只有 `recipes`）、`code/core.nbt.query`（记忆世界 NBT），参数只许字面量

## 跑一棵手写树

前提：采集端已进入世界（`npm run mc:capture`）。

```bash
node scripts/bt-run.js examples/recipe_query.json                                   # 查配方写进黑板（结束时打印黑板）
node scripts/capsule-save.js examples/capsules/example.air-below.json
node scripts/bt-run.js examples/walk_loop.json --fast examples/fast_drowning.json   # 抢占与恢复
```

DSH 里：按 `cordis.patch.yml` 装进 profile 后用 `/bt run <file>`、`/bt status`、`/bt nodes`、`/bt pause | resume`、`/bt abort`、`/bt fast status | log | rollback <版本> | reflect | load <file>`、`/bt capsules`。

事件日志与树版本写在 `steveX/runtime/tasks/<taskId>/`：`node` 事件是节点进出，`observe` 事件是每个 `Steps` / `Action` 前后的状态差异。

## 树文件格式

编写格式见 [行为树节点设计方案.md](../../docs/行为树节点设计方案.md) §8.5。文件可以是树本身，也可以是
`{ "goal", "blackboard", "root" }`：`blackboard` 是初始黑板，树里用 `"$键名"` 读（`"$键.字段"` 取字段）。

常用写法：

```json
{ "forEach": "$clicks", "as": "click", "do": { "steps": "点", "do": [["container/slot", "$click"], ["wait", 80]] } }
{ "act": "container/slot", "params": { "slot": 0, "clickType": 1 },
  "expect": { "cond": "code/inv.has-item", "read": ["inventory"], "params": { "item": "oak_planks", "count": 4 } } }
```

## 还没有的

胶囊 GC / 淘汰；快树对实体的反射（快树读不到实体：实体只在记忆 NBT 里，P3-D3）；胶囊准入（多图验证，P6）；事实库的压缩机制（P5-D5）；路由 LLM 填槽（路由阶段 B）。

## 让大模型写树（P1）

装进 DSH（推荐用 [dsh-plugins/profile](../profile/) 这个 bundle，它同时装路由并关掉 DSH 内置工具）后，在会话里：

```
/bt task 做一把木镐
```

1. 插件开一个**规划请求** `pN`，用 `followup` 叫醒本会话；消息里是指令 +「慢树大纲」skill
2. 大模型用读 / 查工具了解现状，调 `bt_submit_tree` 交回大纲；不合法 → 工具结果里是逐条错误，同一回合修正后重交
3. 任务开始执行；跑到 `expand` → 执行器挂起任务、发**展开请求** `rN` 叫醒同一会话（附树概览、黑板、「慢树展开」skill）→ `bt_submit_expansion`
4. 回合要结束时请求还没被回答 → `steer` 提醒，算一次不合法尝试；同一请求 3 次 → 规划作废 / 任务失败
5. 任务结束 → `inject` 一条通知（不叫醒）

| 工具 | 作用 |
|---|---|
| `mod_query` | 透传 mod 的只读方法（`player` / `inventory` / `f3` / `container/get` …），有作用的方法一律拒绝 |
| `nbt_query` / `json_query` | 记忆世界 NBT / 白名单 JSON（配方）；参数与树里 `code/core.*.query` 相同，按任务钉数据快照 |
| `command_docs` | 命令注册表：名字、说明、参数 schema |
| `capsule_search` / `capsule_get` | 胶囊库（含本任务草稿）：契约与正文 |
| `bt_view` | 当前树（id + 返回码）、黑板、在飞请求、草稿 |
| `bt_submit_tree` / `bt_submit_expansion` | 提交大纲 / 展开；可带 `code`：任务内代码草稿，树里用 `task/<名字>` 引用 |
| `bt_abort_task` | 放弃规划或任务 |

- 绑定了请求的回合只放行该请求的工具（规划：`command_docs` / `data_shapes` / `capsule_*` + `bt_submit_tree`；展开：再加 `bt_view`，提交换成 `bt_submit_expansion`）。由守卫执行，工具清单整个会话不变（回合级 `restrict` 晚一步才生效、还会断 KV 缓存）
- `data_shapes`：树能读的数据长什么样——`state.*`（此刻的结构 + 静态词表 `game/vocab.js`）、`json.*`（全量结构 + 统计词表）、`nbt.*`（只给结构）。给结构与词表，不给实例值；写处理数据的代码前查，不要猜字段名和取值
- 回合出错（如模型返回坏 JSON）→ `agent/error` 接住：计一次不合法，`followup` 重试；用完 → 作废 / 失败
- **工具守卫**：`ctx.tools.guard` 拒绝不在名单里的调用（会话名单 = steveX 工具 + `extraTools`；绑定了请求的回合 = 该请求的名单）。会话级 `restrict` 只管看得见，挡不住 agent 层自己注册的工具
- `/bt` 声明了 `input`，DSH Web 输入框才会把带参数的 `/bt task …` 当命令执行
- **产出树的回合不给数据（I13）**：`mod_query` / `nbt_query` / `json_query` 只在普通问答回合可用；请求与 `bt_view` 里的黑板只给形状（类型、结构、列表长度），不给值。树要用的数据由树自己读（`read`、`code/core.nbt.query`、`code/core.json.query`），这样产出的子树才能参数化、提取成胶囊
- `recover` / `escalate` / `failed` / `died`（P2 起）：属于会话的任务交给大模型——消息只推目录，证据用 `bt_inspect` 自取，用 `bt_submit_patch` 回答；不属于会话的任务（`/bt run` 的手写树）仍由本地应答器回答（原树继续 / 放弃任务）
- 死亡（P2e）：任务存在期间轮询 `player`，`dead` 为真 → 中止、松键关容器 → 自动 `player/respawn` → 等到生命值回满 → `died` 请求；重生失败（极限模式、mod 未升级）→ 任务失败
- reactive 序列（P2d）：任务树里缺省每 `reactiveEveryMs`（1000）复查一次守卫，树里可写 `every`（≥ 200）；只能用在 seq 上，最后一个孩子之前只能是 cond / compute
- 查询（P2d）：`core.nbt.query` / `core.json.query` 每次读当前版本（版本没变不重复解析），不再按任务钉住
- 配置：`planner.enabled`（关掉 = 回到 P0 行为）、`planner.exclusiveTools`、`planner.extraTools`、`planner.maxOutputChars`、`promptsDir`

## 快树进化（P3）

设计见 [P3实施细则.md](../../docs/P3实施细则.md)。

1. `player` 一直轮询（200 ms）。**事件流**（`src/fast/monitor.js`）把执行器的情节记录与掉血合成事件，写进 `runtime/fast/events.jsonl`（`event: 'fast/event'`）：
   `unhandled-harm`（otherwise 下掉血，高）、`death`（高）、`arm-failed`（高）、`arm-harmed`（中；死了则高）、`arm-ok`（低，只计统计）。
   otherwise 下的掉血按事故合并（静默 `fast.incidentQuietMs` 才结束）；同一 arm 在 `fast.episodeMergeMs` 内的相邻情节并成一条。
   前后快照在 `runtime/fast/snapshots/<id>.json`
2. **批次**（`src/fast/reflector.js`）：待反思事件 ≥ `fast.batchSize`、任务结束、死亡（立即）、`/bt fast reflect` 时打批；快树在情节里不打批；同时在飞 ≤ `fast.reflectMaxParallel`
3. **反思会话**（`src/llm/fast_bridge.js`）：每批用 `ctx.agents.create` 开一个新会话（`fast.sessionPreset`），消息只推当前快树与每条事件一行；
   会话只准入 `fast_inspect` / `fast_submit_patch` / `fast_skip` 与接口知识工具。没提交就 `steer` 提醒；用完 `maxInvalidAttempts` → 批次 abandoned。批次结束后会话留着，日志可看
4. **版本链**（`src/fast/versions.js`）：`src/bt/trees/fast/v<N>.json` + `v<N>.meta.json`；版本 0 = 空快树。补丁按 arm 名字 `add` / `replace` / `remove` / `move`，
   附带的条件代码以 `fast.` 前缀在被接受时存进胶囊库；`base` 不是最新 → 拒绝并附差异。快树在情节里时新版本排队，情节结束再换上。回滚 = 把旧版另存为新的一版

| 工具（只在快树会话里） | 作用 |
|---|---|
| `fast_inspect` | `event` / `trace` / `snapshot`（`against` 给差异，含生命、氧气、状态标志）/ `arms` / `versions` / `live` / `eval`（用快照求一个 when，未提交的代码放 `code`） |
| `fast_submit_patch` | `{ batchId, base, ops, reason, code? }` |
| `fast_skip` | 这批不改，写理由 |

- 情节最长 `fast.maxEpisodeMs`（30 s），超时按 FAILURE 收场并松键
- 没有任务时死亡也自动重生；重生失败（极限模式）只记 `player/respawn-failed`，之后还死着就不再重试
- 配置：`fast.batchSize`、`fast.batchMaxEvents`、`fast.reflectMaxParallel`、`fast.incidentQuietMs`、`fast.episodeMergeMs`、`fast.snapshotKeep`、`fast.maxArms`、`fast.maxEpisodeMs`、`fast.reflect`（false = 只记事件）、`fast.sessionPreset`

## 事实库（P5）

设计见 [P5实施细则.md](../../docs/P5实施细则.md)。

1. **源码**（`src/facts/source.js`）：基准 `facts.sourceRoot`（缺省 `steveX/1.21.11_src`）。大模型给的路径一律相对基准；绝对路径、盘符、UNC、`..`、realpath 之后跳出基准、非 `.java` 都拒绝。
   搜索调 `@vscode/ripgrep` 的 `rg`（参数数组、不经 shell、`--no-config --no-follow --json --type java`，总是给搜索路径）
2. **事实库**（`src/facts/store.js`）：`facts.dir`（缺省 `steveX/facts/`）一条一个 JSON：`name`、`statement`、`refs[{file, lines, sha}]`、`tags`、`rev`、`source`。
   引用：基准内 `.java`、行号有效、单条 ≤ `facts.maxRefLines`、1–`facts.maxRefs` 条；`sha` 是所引行的内容哈希，`/bt facts check` 据此查失效。同名必须 `replaces`，旧版进 `history/`
3. **回合**（`src/llm/fact_turns.js`）：`/bt fact <陈述>` followup 开事实确认回合（来源 `stevex-fact`），路由 `fact` handler 走 `factInTurn`；事实确认不是请求，没有必交的工具。
   任何回合用了 `mc_source_*` 却没成功 `fact_write` → 回合要结束时 `steer` 一次「完善事实库」；有请求没交时先只提醒请求

| 工具（所有回合） | 作用 |
|---|---|
| `fact_search` | `{ query?, tags?, limit? }`：多词任一命中；只给引用，失效的标 `stale` |
| `fact_write` | `{ name, statement, refs, tags?, replaces? }`；写入后附至多 3 条相近事实 |
| `mc_source_search` | `{ pattern, fixed?, path?, glob?, context?, limit? }` |
| `mc_source_read` | `{ file, start?, end? }`，一次 ≤ `facts.readMaxLines` 行 |

- 配置：`facts.dir`、`facts.sourceRoot`、`facts.maxRefLines`、`facts.maxRefs`、`facts.readMaxLines`、`facts.searchLimit`、`facts.remind`

## 任务复盘（P4）

设计见 [P4实施细则.md](../../docs/P4实施细则.md)。

1. **触发**（`bridge.onTask`）：任务 `done`，或 `failed` 且不是人 `/bt abort` / 会话没了（`finishTask` 的 `by`）→ 在任务所属的会话里 `followup` 一个 `reflect` 请求（`c<N>`），代替原来的结束通知。
   复盘不是执行器状态，不挡新任务：请求持有结束的任务对象和草稿区的拷贝，复盘回合里 `bt_view` / `bt_inspect` / `capsule_get task/…` 看的都是它
2. **证据**：消息只推目录（`buildReflectDirectory`）。执行器给每个任务记树版本链（`task.versions`：`outline` / `expand <id>` / `patch <类型> @ <id>`），
   `bt_inspect` 的 `tree` 看版本表、某一版、两版之差（`bt/diff.js`，按 id 对齐）。复盘时没有 `live`，`eval` 要给 `at`
3. **保存**（`bridge.saveCapsule` → `capsules/save.js`）：同名必须 `replaces` 最新 hash，`locked` 不可替换；草稿转正；子树里已转正的 `task/` 引用改写成 `code/…@hash`；
   给了 `from` 的子树对照原节点查 `read`（少了就拒绝）；字面量检查（`capsules/literals.js`）和本次任务观察到的值比对（快照、初始黑板、`core.*` 查询写的键；代码只比字符串），命中即拒绝，`keepLiterals` 带理由保留。存不进去不计次数。每次保存记 `capsule/saved` 事件
4. **结束**：`bt_reflect_done`（`summary` 必填）；回合结束还没交 → 提醒一次，再没交按 `abandoned` 关闭，已存的胶囊保留；回合出错重试同 P1。进程重启时在飞的复盘直接丢弃

| 工具（只在复盘回合） | 作用 |
|---|---|
| `capsule_save` | `{ requestId, folder, name, description, from?, signature?, body?, preconditions?, replaces?, keepLiterals? }` |
| `bt_reflect_done` | `{ requestId, summary }` |

- `/bt reflect`：对最近结束、任务对象还在内存里的任务手动复盘
- 配置：`reflect.enabled`（false = 只发结束通知）、`reflect.onFailed`、`reflect.literalCheck`
- 提示词正文都在 `prompts/`，改内容不改代码；缺文件 / 空文件 / 带 `TODO(内容层)` 装载即报错
