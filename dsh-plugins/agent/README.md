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
| **任务历史** | 成本画像（纯执行时间、mod 调用、按胶囊 / 节点分布）进复盘；`task_assess` 评估这次的树；`task_search` / `task_get` 查做过的同类任务，下一次复盘核对上一次记下的问题；胶囊的已知问题；`npm run history-gc` | **已实现**，单元测试通过；待游戏内验收（[任务历史与复盘评估设计方案.md](../../docs/任务历史与复盘评估设计方案.md) §6） |
| **胶囊版本说明** | 替换同名胶囊时记下改动与"哪一版在什么情况下更好"（`versions.json`）；`capsule_search` / `capsule_get` 显示版本数、未执行、版本链；用到的任务复盘时核对（`task_assess.claims`）；整理清单计数；GC 保留旧版更好的版本 | **已实现**，单元测试通过；待游戏内验收（[胶囊版本说明设计方案.md](../../docs/胶囊版本说明设计方案.md) §6） |
| **训练场** | `/bt train`：2×2 合成专项训练（每轮重置、随机配方发 1 份材料、发任务、按 `crafted` 统计判定、记回合与 token）；mod 侧 `arena/*`（不给 agent）与游戏内 `/arena`；`npm run training-report` | **已实现**；游戏内验收通过（[训练场设计方案.md](../../docs/训练场设计方案.md) §7） |
| **工作台训练场** | `/bt train craft3x3`：场内放工作台、准星对准它，只抽 3×3 配方（按形状分组），记打开工作台的时刻与工作台是否被挖；报告按形状汇总、列出引用的旧胶囊 | **已实现**，单元测试通过；待游戏内验收（[工作台训练场设计方案.md](../../docs/工作台训练场设计方案.md) §6） |
| **切石机训练场** | `/bt train stonecutter`：场内放切石机，每轮把 1–3 种材料各切成指定数量的几种样式，不多不少；同一家族最多一种材料，目标是单次产出的整数倍；按物品栏、光标、输入格、地上的计数判定，多切、切错、丢失各自记 | **已实现**，单元测试通过；待游戏内验收（[切石机训练场设计方案.md](../../docs/切石机训练场设计方案.md) §6） |
| **熔炉训练场** | `/bt train furnace`：场内放熔炉、高炉或烟熏炉（每轮随机），把 n 个原料放进原料格、m 个燃料放进燃料格，然后关掉炉子界面；炉子按原版速度工作，不要求等它烧完、不要求拿产物；按物品栏少了多少判定放料，放多、放错、丢失各自记；`prepare` 时和服务器端的真实数值核对数据 | **已实现**，单元测试通过；待游戏内验收（[熔炉训练场设计方案.md](../../docs/熔炉训练场设计方案.md) §6） |
| **信标训练场** | `/bt train beacon`：信标下的铁块底座埋在地板下，层数每轮随机；每轮给一格付款物品，要求让信标提供指定的效果（含 II 级；再生题另要求一个主效果）后关掉界面；等信标数出底座等级再发任务；判定要求设置是原版界面能设出来的，多付、设错过、越界各自记 | **已实现**，单元测试通过；待游戏内验收（[信标训练场设计方案.md](../../docs/信标训练场设计方案.md) §7） |
| **织布机训练场** | `/bt train loom`：正前方一台织布机，物品栏里有 1–3 种底色的素旗和按目标发的染料（`itemPatterns=on` 时还有图案物），把它们做成指定图案、指定颜色的旗帜，每种恰好指定的面数；素旗、染料各多发 0–3 个。题目来源由 mod 从注册表读出（`arena/loom-catalog`）；物品按"id + 图案层"的签名计数；判定多出"多做""做错"，另记 2×2 复制旗帜的面数 | **已实现**，单元测试通过；待游戏内验收（[织布机训练场设计方案.md](../../docs/织布机训练场设计方案.md) §6） |
| **制图台训练场** | `/bt train cartography`：正前方一台制图台，每轮只考一种操作（`task=zoom|lock|clone|mix`，缺省三种等概率）：放大、锁定题开局 1–3 张同编号的地图、只处理其中几张，复制题做到总共 2–5 张；只发用到的那一种辅料，按最省用量加 0–3 个余量。`task=chain` 是随机 1–4 步的连续操作，不放进 `mix`。物品描述给地图加 `map{ id, scale, locked }`；地图按"缩放等级 + 是否锁定 + 是不是从开局地图做出来的"签名计数；判定多出"多做""做错"，另记 2×2 复制地图的张数 | **已实现**，单元测试通过；待游戏内验收（[制图台训练场设计方案.md](../../docs/制图台训练场设计方案.md) §6） |
| **书与笔训练场** | `/bt train book`：没有工作站，物品栏里有 1–3 本写了字的书与笔（放在随机格子，选中的快捷栏格也随机），把指定的页改成指定的文字或清空，没提到的页保持原样。开局每本 1–6 页，改 1–3 页，可能要写到还没有的页；目标按原版保存规则删掉末尾空页；判定是玩家身上只有书与笔、页列表和目标作为多重集合相等、光标为空 | **已实现**，单元测试通过；待游戏内验收（[书与笔训练场设计方案.md](../../docs/书与笔训练场设计方案.md) §7） |
| **告示牌训练场** | `/bt train sign`：正前方一块立着的告示牌，三种题型各考一件事——`text` 逐行改写或清空正面文字，`color` 用染料把正面文字改成指定颜色（发 32–64 个目标颜色的染料），`wax` 用蜜脾给告示牌涂蜡（发 32–64 个蜜脾）。开局每行一半概率有字、颜色随机、手上是空的；判定是正面 4 行、颜色、是否涂蜡等于目标，背面空着，编辑已提交，光标为空；`wax` 题改了字再涂蜡就提前结束（改不回来） | **已实现**，单元测试通过；待游戏内验收（[告示牌训练场设计方案.md](../../docs/告示牌训练场设计方案.md) §7） |
| **砂轮训练场** | `/bt train grindstone`：正前方一个砂轮，物品栏里有 1–4 件带附魔的物品（有耐久的物品或附魔书，可能带诅咒），用砂轮给它们祛魔、产物放回物品栏，不要求关界面。文案不写磨完的样子；目标按原版规则算（诅咒留着，附魔书磨光变成书），prepare 时 mod 用临时砂轮菜单逐件核对；判定是玩家身上按签名恰好是全部目标、光标为空 | **已实现**，单元测试通过；待游戏内验收（[砂轮训练场设计方案.md](../../docs/砂轮训练场设计方案.md) §7） |
| **村民交易训练场** | `/bt train villager`：正前方一只村民（随机职业、1–5 级，不会动、打不坏，每轮换新），物品栏里有交易用的付款物，在指定的 1–4 笔交易上各交易指定次数、不做别的交易，然后关掉交易界面。交易项按原版算法从 1 级逐级生成（不出藏宝图），出题前预览、prepare 时逐笔核对；判定按村民每笔交易的次数，多换、换错一发现就结束本轮 | **已实现**，单元测试通过；待游戏内验收（[村民交易训练场设计方案.md](../../docs/村民交易训练场设计方案.md) §7） |
| **合成器训练场** | `/bt train crafter`：正前方一台合成器（每轮换新），物品栏里有某条配方 n 份的材料（每种另外多发 0–16 个），把材料放进合成器，让它预览出目标、材料正好够合成 n 次，没放材料的格子全部禁用，然后关掉界面；合成器不通电，不会真的合成。配方是全部配方，按形状分组抽；判定按原版配方匹配（平移、镜像都认），mod 用服务器配方核对题目；没成功时记失败原因 | **已实现**，单元测试通过；待游戏内验收（[合成器训练场设计方案.md](../../docs/合成器训练场设计方案.md) §6） |
| **酿造台训练场** | `/bt train brewing`：正前方一台酿造台（每轮换新），物品栏里有 1 格烈焰粉、1 格酿造材料和 1–3 瓶同一种药水，把指定数量放进燃料格、材料格、药水格，然后关掉界面，不要求酿完。配方从 `data/brewing.json`（源码提取，也开放给 agent 查 `json.brewing`）先抽材料再抽配方，mod 用服务器的酿造配方核对；判定看物品栏少了多少，守恒查药水、烈焰粉、材料和酿造次数 | **已实现**，单元测试通过；待游戏内验收（[酿造台训练场设计方案.md](../../docs/酿造台训练场设计方案.md) §6） |
| **坐骑训练场** | `/bt train mount`：正前方一只已驯服、不会动的动物（马、僵尸马、驴、骡、骆驼、骆驼尸壳、羊驼、行商羊驼、鹦鹉螺、僵尸鹦鹉螺），装上或卸下鞍 / 马铠 / 地毯 / 鹦鹉螺铠，驴骡羊驼另往它的箱子里放、取恰好 k 个物品。先抽组再抽动物；只写目标，不写怎么打开；判定看动物身上和玩家物品栏，放多、放错、骑上过、不开界面装备各自记。`container/get` 新支持坐骑界面（`type: "mount"`） | **已实现**，单元测试通过；待游戏内验收（[坐骑训练场设计方案.md](../../docs/坐骑训练场设计方案.md) §7） |
| **锻造台训练场** | `/bt train smithing`：一轮 1–4 道题，每道在"升级成下界合金 / 给盔甲加纹饰"里等概率选；纹饰的样式、盔甲、材料各自等概率。出题前用服务器的锻造配方预览；只写目标物品和纹饰，不列材料；判定看每道题都有各自的一件，物品 id 和纹饰都对上，多做、配错、部分完成各自记。物品信息新增 `trim` / `trimMaterial`，新数据源 `json.smithing` | **已实现**，单元测试通过；待游戏内验收（[锻造台训练场设计方案.md](../../docs/锻造台训练场设计方案.md) §7） |
| **铁砧训练场** | `/bt train anvil`：三种任务等概率——合并附魔、改名、合并加改名。出题前用原版铁砧算法预览，保证做得出来、产物分得清；只写目标物品，不说放哪一格；判定看物品类型、附魔、名字三项，多次取出、多花经验、名字错各自记 | **已实现**，单元测试通过；待游戏内验收（[铁砧训练场设计方案.md](../../docs/铁砧训练场设计方案.md) §7） |
| **附魔台训练场** | `/bt train enchanting`：场内放附魔台和 15 个书架，每轮给一件可附魔物品和青金石，要求附魔成带有指定附魔的物品后关掉界面；出题前用原版算法预览三档、选唯一的提示附魔作为目标，`prepare` 时用真实菜单核对；附错、丢失各自记 | **已实现**，单元测试通过；待游戏内验收（[附魔台训练场设计方案.md](../../docs/附魔台训练场设计方案.md) §6） |
| **箱子训练场** | `/bt train chest`：场内放小箱子或大箱子，每轮"从箱子取 k 个"或"往箱子放 k 个"，k 与实有数量的关系可控（lt / eq / gt）；按两边的计数判定，多拿、动了别的、丢失各自记；mod 在 tick 里记恰好搬完的时刻 | **已实现**，单元测试通过；待游戏内验收（[箱子训练场设计方案.md](../../docs/箱子训练场设计方案.md) §6） |
| **胶囊换引用** | 复盘工具 `capsule_repin { tree, refs }`：把库里子树最新版中指定的引用换成最新版、存成新版本（版本说明自动生成，照常校验，不自动往上换）；`capsule_save` 存同名新版时列出还钉着旧版的子树 | **已实现**，单元测试通过（[胶囊换引用设计方案.md](../../docs/胶囊换引用设计方案.md)） |
| **整理** | 胶囊库整理：使用统计（`stats.json`，`capsule_search` / `capsule_get` 展示）、`/bt curate [all]` 整理回合（`capsule_retire` / `capsule_describe` / `bt_curate_done`；缺省按范围，见[胶囊库整理范围设计方案.md](../../docs/胶囊库整理范围设计方案.md)）、`curate.everyTasks` 自动触发（默认 0）、离线 GC 与脚本 | **已实现**，单元测试通过；待 DSH 内验收（[胶囊库整理设计方案.md](../../docs/胶囊库整理设计方案.md) §10.3） |

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
  extract-recipes.js  从 MC jar 生成 data/recipes.json（JSON 查询的默认数据源）、data/stonecutting.json（切石配方）和 data/cooking.json（烹饪配方）
  extract-item-props.js  从 1.21.11 源码生成 data/item-props.json（堆叠上限、合成剩余物、燃料时长、可附魔程度；训练器用）和 data/items.json（同样内容的数组形式，json.items）
  lib/jar.js          读 jar、展开物品标签的共用代码
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

事件日志与树版本写在 `steveX/runtime/tasks/<taskId>/`：`node` 事件是节点进出，`observe` 事件是每个 `Steps` / `Action` 前后的状态差异。"执行后"要等状态稳定再读（`observe.settle`：隔 `intervalMs` 再读 inventory / container，连续两次一样为止，最多 `maxReads` 次，`maxReads: 0` = 不等），这些读取记在 `calls.settle`，不算进成本画像的 mod 调用。前后读哪些来源由 `observe.sources` 决定，`observe.byCommand` 按命令缩小：叶子里的命令都在表里时只读表里的来源（默认 `container/slot` 只读 `container`——界面的 slots 已含玩家背包格）。观察读取记在 `calls.observe`，同样不算进成本画像的 mod 调用：成本画像衡量的是 agent 写的树，执行器留证据的读取不是它的成本，画像里单列"执行器的观察读取 / 等稳定读取"。旧任务的数字用 `node scripts/reprofile-history.js [--write]` 按这个口径重算（写回前先停掉 DSH）。

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

> **空白会话里的 `/bt` 查看命令看不到结果**：DSH Web 只在会话开过回合（`turn/start`）后才渲染命令行；只执行过命令的会话仍算空白，DSH 0.2.1-rc.5 的"新建会话"还会复用它，看起来像卡死。`/bt task` / `fact` / `reflect` / `curate` 用 `followup` 自己开回合，不受影响；`status` / `nodes` / `capsules` / `facts` / `fast status | log` 等要先在会话里说一句话。见根目录 README「常见问题」。

| 工具 | 作用 |
|---|---|
| `mod_query` | 透传 mod 的只读方法（`player` / `inventory` / `f3` / `container/get` …），有作用的方法一律拒绝 |
| `nbt_query` / `json_query` | 记忆世界 NBT / 白名单 JSON（配方）；参数与树里 `code/core.*.query` 相同，按任务钉数据快照 |
| `command_docs` | 命令注册表：名字、说明、参数 schema |
| `capsule_search` / `capsule_get` | 胶囊库（含本任务草稿）。`capsule_search` 只给名字与种类，分页（`limit` 默认 30、最多 100，`offset`）；说明、契约、正文、统计、已知问题、版本信息都在 `capsule_get` 里（2026-11-21） |
| `bt_view` | 当前树（id + 返回码）、黑板、在飞请求、草稿 |
| `bt_submit_tree` / `bt_submit_expansion` | 提交大纲 / 展开；可带 `code`：任务内代码草稿，树里用 `task/<名字>` 引用 |
| `bt_abort_task` | 放弃规划或任务 |

- 绑定了请求的回合只放行该请求的工具（规划：`command_docs` / `data_shapes` / `capsule_*` + `bt_submit_tree`；展开：再加 `bt_view`，提交换成 `bt_submit_expansion`）。由守卫执行，工具清单整个会话不变（回合级 `restrict` 晚一步才生效、还会断 KV 缓存）
- `data_shapes`：树能读的数据长什么样——`state.*`（此刻的结构 + 静态词表 `game/vocab.js`）、`json.*`（全量结构 + 统计词表）、`nbt.*`（只给结构）。给结构与词表，不给实例值；写处理数据的代码前查，不要猜字段名和取值
- 回合出错 → `agent/error` 接住并 `followup` 重试：
  - 网络、API 故障不计次，每个请求最多重试 5 次；
  - 模型返回坏的工具参数 JSON 不计次，每个请求最多重试 2 次；
  - 其余错误计一次不合法尝试，次数用完则规划作废或任务失败；
  - 重试提示说明出错那一步的调用都没有执行，并列出已写的代码草稿（[代码草稿单独提交设计方案](../../docs/代码草稿单独提交设计方案.md)）
- `bt_write_code`（规划、展开、修复回合）：单独写一条任务内代码草稿，不随树一起提交；写错不计次，写下后本任务内的提交都能用 `task/名字` 引用
- **工具守卫**：`ctx.tools.guard` 拒绝不在名单里的调用（会话名单 = steveX 工具 + `extraTools`；绑定了请求的回合 = 该请求的名单）。会话级 `restrict` 只管看得见，挡不住 agent 层自己注册的工具
- `/bt` 声明了 `input`，DSH Web 输入框才会把带参数的 `/bt task …` 当命令执行
- **产出树的回合不给数据（I13）**：`mod_query` / `nbt_query` / `json_query` 只在普通问答回合可用；请求与 `bt_view` 里的黑板只给形状（类型、结构、列表长度），不给值；例外是展开请求：小值（≤ 200 字节）直接给，并附前面没做成的分支与所在子树的黑板，记忆世界查询结果和大块数据仍只给形状。树要用的数据由树自己读（`read`、`code/core.nbt.query`、`code/core.json.query`），这样产出的子树才能参数化、提取成胶囊
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
   普通问答、事实确认、快树复盘回合用了 `mc_source_*` 却没成功 `fact_write` → 回合要结束时 `steer` 一次「完善事实库」；有请求没交时先只提醒请求。
   规划 / 展开 / 修复回合不提醒、也不能 `fact_write`：查过的源码位置记到任务名下，复盘目录列出"源码：查过 N 处"（`bt_inspect what: sources`），复盘回合末尾没写事实就提醒一次；查过源码的任务即使例行重复也会复盘（`reflect.enabled = false` 时照旧在任务回合提醒）（[事实库写入挪到复盘设计方案](../../docs/事实库写入挪到复盘设计方案.md)）

| 工具（所有回合） | 作用 |
|---|---|
| `fact_search` | `{ query?, tags?, limit?, offset? }`：多词任一命中；只给名字、标签，引用失效的标 `stale`；一页默认 30 条、最多 100，`next` 是下一页的 `offset`（2026-11-21） |
| `fact_get` | `{ names }`（1–10 个）：陈述、源码引用（失效的标 `stale`）、标签、修订号；合并掉的旧名字也认 |
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
| `capsule_save` | `{ requestId, folder, name, description, from?, signature?, body?, preconditions?, replaces?, keepLiterals?, versionNote? }`（带 `replaces` 时 `versionNote` 必填，见 [胶囊版本说明设计方案.md](../../docs/胶囊版本说明设计方案.md)） |
| `bt_reflect_done` | `{ requestId, summary }` |

- `/bt reflect`：对最近结束、任务对象还在内存里的任务手动复盘
- 配置：`reflect.enabled`（false = 只发结束通知）、`reflect.onFailed`、`reflect.onDone`（`changed` = 缺省：done 的任务参考过做成的同类任务、mod 调用次数和其中最少的一样、没有展开 / 修补 / 执行中请求、没有节点报错、没执行新草稿、没有第一次执行的胶囊版本时不复盘，只写任务历史，事件记 `reflect/skipped`；`always` = 每次都复盘）、`reflect.literalCheck`、`reflect.session`（`new` = 自动复盘另开会话，默认；`same` = 留在任务会话）
- 提示词正文都在 `prompts/`，改内容不改代码；缺文件 / 空文件 / 带 `TODO(内容层)` 装载即报错

## 胶囊库整理

设计见 [胶囊库整理设计方案.md](../../docs/胶囊库整理设计方案.md)。原则：只补证据与能力，不写"什么时候该下架"的规则。

1. **统计**（`capsules/stats.js`）：节点退出事件带 `ref`；执行器事件流边跑边累计到本任务，`task/done | failed` 时并进 `<capsulesDir>/stats.json`（同一任务只并一次）。按完整引用记：调用次数、条件的判真 / 判假 / 报错、Compute / 子树的成败、用过它的任务数与成败、最近 3 条错误；草稿转正时带上草稿时期的数字。快树里的使用不计入。`capsule_search` 每条带 `usage`（同名各版本加总，**不影响排序**），`capsule_get` 带明细
2. **整理回合**（`bridge.startCurate`）：`/bt curate`，或每结束 `curate.everyTasks` 个任务自动发（默认 0 = 只手动；只在空闲时发，复盘没结束就等它）。有任务 / 规划 / 复盘 / 整理没结束时直接拒绝、不排队。消息缺省给整理范围：上次完成的整理（`curate.jsonl` 里最后一行 `done`）之后用过的条目（统计的 `lastUsed`）、新存的条目（manifest 的 `savedAt`）是核心，和它们有引用关系的条目（一层）是相关，同领域的其余条目只列名字；范围是空的不发。从没完成过整理时、或 `/bt curate all`，给全库在用条目的清单（按名字排序；在用的超过 `curate.listLimit` 只给目录）。两种都不列已下架的条目。没结束就提醒一次、再结束按 `abandoned` 关闭；回合出错（含人取消）直接关闭、不重发。每次整理在 `<capsulesDir>/curate.jsonl` 记一行（带 `mode`、`since`、`scope` 各类条数）
3. **下架**：manifest 该名字加 `retired: { at, reason, supersededBy?, by }`，条目文件不动。`capsule_search` 默认不返回（`includeRetired: true` 才返回）；带哈希的引用照常装载；新提交的树引用下架的名字 → 提交结果里给警告，不拦。同名存新版本时标记自动清掉。内置与 `locked` 条目不能下架
4. **GC**（`capsules/gc.js`，离线）：保留当前版本、`locked`、三处树（库里 `trees/`、`runtime/tasks/*/trees/`、快树版本库）引用的版本及子树传递闭包、最近 `--keep-days` 天用过的；其余移到 `archive/<日期>/`，`archive/index.jsonl` 记一行。装载已归档的引用时报错写明"已归档"

| 工具（只在整理回合） | 作用 |
|---|---|
| `capsule_retire` | `{ requestId, ref, reason, supersededBy?, undo? }`，`reason` 必填 |
| `capsule_describe` | `{ requestId, ref, description }`，不换哈希 |
| `bt_curate_done` | `{ requestId, reason }` |

- 脚本：`npm run capsule-stats [-- --rebuild]`、`npm run capsule-gc [-- --apply] [--keep-days n]`、`npm run capsule-retire -- <文件夹/名字> --reason … [--superseded-by …] [--undo]`
- 配置：`curate.everyTasks`（默认 0）、`curate.listLimit`（默认 150）

## 训练场

设计见 [训练场设计方案.md](../../docs/训练场设计方案.md)。插件是主控，mod 只提供场地原语；判定只看事实，不靠 agent 自己报告。

1. **开始**：`/bt train craft2x2 [item=stick] [runs=20] [seed=7]`（要在会话里用）。一组在后台跑，同时只有一组；训练进行中 `/bt task` 拒绝。执行命令的会话只当控制台：**每轮新建一个会话**（模型跟随控制台会话当前的模型），本轮的规划、执行、复盘都在那里，轮与轮之间不共享上下文；控制台每轮收到开始、结束两条通知（不开回合）。用完的会话保留，记录里的 `sessionId` 对应它；控制台会话关掉后不再开新的一轮
2. **每轮**：等会话空闲（复盘、整理结束）→ `arena/prepare`（关界面、清物品栏、传送进场、清场、回满状态、白天晴天、重置配方书、按种子随机槽位发 1 份材料）→ `startPlanning` 发任务（计时起点）→ 每秒查 `arena/status` → 任务结束、规划作废或超时（`training.timeoutSec` 默认 600，不算等 LLM 回合的时间；含 LLM 回合的总上限 `training.wallTimeoutSec` 默认 2400；超时时也取消在跑的回合）→ `arena/finish`（传送出场）→ 等复盘结束 → 记一行
3. **判定**：`success`（任务 done 且目标 `crafted` 增加）、`false_success`（done 但没合成）、`crafted_but_failed`、`failed`、`timeout`、`aborted`。合成成功不打断 agent，只记时刻
4. **记录**：`runtime/training/<场地>.jsonl`（不进 git）：本轮会话 `sessionId`、目标、配方、材料与槽位、种子、结果、合成 / 任务用时、规划次数、树版本、节点调用次数、用到的胶囊、回合数与 token（DSH `deriveTurnTokenUsage`，算不出记 null）、有没有用 `chat/send`
5. **mod 侧**：`arena/build | prepare | status | finish` 只给训练器用，`raw_commands.js` 不登记给 agent；需要单人世界。游戏内 `/arena <场地>` 不要求作弊权限，只传送到场外平台，训练进行中拒绝。世界要**关闭作弊**，agent 的 `/give` 才会失败

6. **工作台场地 craft3x3**（[工作台训练场设计方案.md](../../docs/工作台训练场设计方案.md)）：`prepare` 在场内正前方补回工作台、把准星对准它（服务器射线自检 `aimOk`，不为真则本轮 `aborted` 并停止整组）；只抽放不进 2×2 的配方，先等概率抽形状再抽配方；超过堆叠上限的材料（如牛奶桶）由 mod 按 seed 拆到空槽；记录多 `shape`、`openedMs`（第一次打开工作台）、`stationIntact`
7. **多份材料、指定产物个数**（[训练场设计方案.md](../../docs/训练场设计方案.md) T14）：`n=` 发几份材料、`m=` 要合成几次，写 `k` 或 `a-b`（1–64）。文案写产物个数（m × 单次产量）并要求"不要多做"；做多了判 `overshoot`（失败），恰好做够才算 `success`。**不写 n、m 时 n 在 1–64 里随机**、m 在 1…n−1 里随机；要复现旧轮次写 `n=1 m=1`（单次模式：原模板、原随机数序列、原判定）。n 还要满足"材料 + 全部做光的产物 + 合成剩余物 ≤ 36 格"，放不下就在能放下的范围里重抽，固定的 n 放不下直接报错。用到 `data/item-props.json`（堆叠上限与剩余物，随仓库提交；重新生成用 `npm run extract-item-props`，读 `1.21.11_src`）。记录多 `single`、`portions`、`crafts`、`yield`、`wanted`、`made`、`overshoot`、`reachedMs`（做够的时刻，精度同 `pollMs`）、`nMax`

8. **箱子场地 chest**（[箱子训练场设计方案.md](../../docs/箱子训练场设计方案.md)）：场地配置 `type: 'storage'`，题型代码在 `src/training/storage.js`（合成题在 `craft.js`，训练器按 `type` 选）。
   - 每轮按种子出题：取 / 放（`kind`）、容器（`chest`：小箱子、大箱子、漏斗、发射器；`mix` 只抽大小箱子，`all` 四种都抽；漏斗由下方的红石块锁住）、目标物品的堆叠上限（`stack`）、每格数量随机还是取满（`fill`，默认随机）、每轮几种目标物品（`targets`，默认 1，多目标时文案逐项列出）、物品种类数（`types`，含全部目标）、要求数量与实有数量的关系（`rel`：lt / eq / gt）。来源方占不超过一半的格子，目标方开局为空
   - `prepare` 按本轮大小放箱子（大箱子两半显式连接），清空后放进 `chestItems`，并登记目标计数 `expect`；自检 `aimOk` 和 `chestSlots`（27 / 54），不对就本轮 `aborted` 并停止整组
   - 判定看任务结束时的计数：`success`（物品栏、箱子都恰好如此，光标为空）、`overshoot`（多搬了）、`disturbed`（动了干扰物品）、`lost`（地上有掉落物、总数变少或箱子被挖）、`false_success`、`failed`、`timeout`、`aborted`
   - 记录多 `kind`、`rel`、`chest`、`n`、`k`、`want`、`layout`、`final`、`moved`、`disturbed`、`reachedMs`（mod 在 tick 里记的恰好搬完的时刻）
9. **切石机场地 stonecutter**（[切石机训练场设计方案.md](../../docs/切石机训练场设计方案.md)）：场地配置 `type: 'stonecut'`，题型代码在 `src/training/stonecut.js`，出题用 `data/stonecutting.json`（同时是 agent 能查的 `json.stonecutting`）。
   - 每轮按种子出题：材料种数（`materials`，1–3）、每种材料占的格数（`slots`，1–9）、每格数量随机还是取满（`fill`）、每种材料切几种样式（`styles`，1–3）。先按家族抽材料，同一家族最多一种；铜的各氧化阶段、打蜡版本算一个家族
   - 每种样式的目标 = 消耗份数 × 单次产出，消耗份数不超过平均分到的材料数；材料格加全部产物格不超过 36
   - `bypass=exclude`（默认）时，物品栏 2×2 用同一种材料就能直接做出的产物不出题；`material=` 固定第一种材料
   - `prepare` 补回切石机、对准准星（`aimOk` 自检），登记只看目标的 `expect { targets, allowed }`
   - 判定：`success`（目标恰好都在物品栏里，光标为空，没有多余产物）、`overshoot`、`miscut`（出现题目没要的产物，包括没用完的中间产物）、`lost`（切石机被挖、地上有掉落物）、`false_success`、`failed`、`timeout`、`aborted`；剩多少材料不判
   - 记录多 `materialCount`、`targetCount`、`materials`（每种材料的家族、格数、数量和各样式的 `yield` / `uses` / `want` / `made`）、`layout`、`extra`、`final`（含 `cutterInput`）、`reachedMs`
10. **熔炉场地 furnace**（[熔炉训练场设计方案.md](../../docs/熔炉训练场设计方案.md)）：场地配置 `type: 'cook'`，题型代码在 `src/training/cook.js`，出题用 `data/cooking.json` 和 `data/item-props.json`。
   - 每轮按种子出题：炉子（`station`）→ 原料（按产物分组抽，16 种带釉陶瓦算一组）→ 燃料（按燃烧时长分档抽，不等于产物）→ 原料、燃料的总数和分格（`raw` / `fuel`、`rawSlots` / `fuelSlots`）→ n、m（不超过发下去的总数）；`input=` / `fuelItem=` 固定原料、燃料
   - `prepare` 清空并重放炉子、对准准星，登记 `expect { cook }`；返回的服务器端数值和数据文件对不上时本轮 `aborted` 并停止整组（数据过期，重跑两个提取脚本）
   - 判定：`success`（炉子界面已关闭，物品栏里原料、燃料恰好剩 R − n、F − m，原料格、燃料格里没有别的东西；产物拿不拿、炉子烧没烧完都不看）、`overshoot`（烧掉的原料或燃料超过要求）、`misplaced`（原料格 / 燃料格里有别的东西，或出现了额外物品）、`lost`（炉子被挖、地上有掉落物、产物数对不上）、`false_success`、`failed`、`timeout`、`aborted`；炉子里剩多少不判
   - 记录多 `station`、`raw`、`fuel`（含 `burnTicks`、`band`）、`product`、`cookTicks`、`n`、`m`、`placedRaw` / `placedFuel` / `smelted` / `burned` / `produced`、`extra`、`final`（含 `furnace`、`containerOpen`）、`reachedMs`
- 脚本：`npm run training-report -- [场地] [--by target|shape|portions|task|chest|stack|fill|targets|materials|styles|yield|family|station|band|kind|slot|enchantment|effect|level|payment|item|second|tasks|pattern|material|group|animal|banners|color|ops|scale|spare|ingredient|bottle|cells] [--last N] [--batch <批次>]`；切石机场地缺省按 `family`（材料家族）分组，多一列"切错"；熔炉场地缺省按 `station`（炉子）分组，多"放多""放错"两列；附魔台场地缺省按 `kind`（物品类别）分组，多"附错""预览不一致"两列；信标场地缺省按 `effect`（目标效果）分组，多"多付""设错过""越界"三列；铁砧场地缺省按 `task`（任务）分组，也可按 `item`、`second`，多"多次取出""多花经验""名字错"三列；锻造台场地缺省按 `kind`（升级 / 纹饰 / 混合）分组，也可按 `tasks`、`pattern`、`material`，多"多做""配错""部分完成"三列；坐骑场地缺省按 `group`（马 / 驴 / 骆驼 / 羊驼 / 鹦鹉螺）分组，也可按 `animal`、`task`，多"放多""放错""骑上过""不开界面装备"四列；织布机场地缺省按 `styles` 分组，也可按 `banners`、`pattern`、`color`、`item`（用没用图案物），多"多做""做错""复制"三列；酿造台场地缺省按 `ingredient`（材料）分组，也可按 `bottle`、`kind`（药水配方 / 换瓶子配方），多"放多""放错""酿起来了"三列；合成器场地缺省按 `cells`（配方占几格）分组，也可按 `shape`、`portions`（n），各失败原因（产物不对、份数不对、空格没禁用、物品栏剩余不对、没关界面、出现别的物品）各占一列；制图台场地缺省按 `task`（放大 / 锁定 / 复制 / 连续操作）分组，也可按 `scale`、`spare`、`ops`（`chain` 题），多"多做""做错""复制"三列；带工作站的场地另列"打开工作台中位""工作台被挖"，以及每轮引用了哪些在该场地第一轮之前就有的胶囊；有多份轮次时另列"超量""做够中位"；箱子场地缺省按 `task`（取放 / 关系）分组，换一套列（超量、动了别的、丢失、打开箱子中位、达成中位、箱子被挖）
- 配置：`training.timeoutSec`（600）、`training.wallTimeoutSec`（2400）、`training.pollMs`（1000）、`training.itemProps`、`training.arenas.<场地>.{origin, mode: named|hidden, exclude, grid: 2|3, station: crafting_table|null, timeoutSec?, wallTimeoutSec?, portions?, crafts?}`；craft3x3 缺省 `grid: 3, station: crafting_table, timeoutSec: 900`。箱子场地 `{type: 'storage', origin, kind, rel, chest, stack, fill, types, targets, dest: 'empty', exclude, timeoutSec?}`，chest 缺省 kind / rel / chest / stack 为 `mix`、`fill: 'random'`、`types: '1-4'`、`targets: '1'`。切石机场地 `{type: 'stonecut', origin, materials, slots, fill, styles, bypass, exclude, timeoutSec?}`，stonecutter 缺省 `materials: '1-3'`、`slots: '1-9'`、`fill: 'random'`、`styles: '1-3'`、`bypass: 'exclude'`、`timeoutSec: 900`；`training.stonecutting` 指向切石配方文件。熔炉场地 `{type: 'cook', origin, station, raw, fuel, rawSlots, fuelSlots, n, m, exclude, timeoutSec?}`，furnace 缺省 `station: 'random'`、`raw` / `fuel` 为 `'64-128'`、`rawSlots` / `fuelSlots` 为 2、`n` / `m` 为 `'1-64'`、`timeoutSec: 600`；`training.cooking` 指向烹饪配方文件。附魔台场地 `{type: 'enchant', origin, bookshelves, xpLevel, exclude, timeoutSec?}`，enchanting 缺省 `bookshelves: 15`、`xpLevel: 30`、`timeoutSec: 600`。信标场地 `{type: 'beacon', origin, amplifier, count, exclude, timeoutSec?}`，beacon 缺省 `origin: [10100, 120, 10000]`、`amplifier: 'mix'`、`count: '32-64'`、`timeoutSec: 600`。铁砧场地 `{type: 'anvil', origin, xpLevel, enchants, curses, exclude, timeoutSec?}`，anvil 缺省 `origin: [10000, 120, 10180]`、`xpLevel: 216`、`enchants: '1-3'`、`curses: false`、`timeoutSec: 600`、排除 `minecraft:bundle`。锻造台场地 `{type: 'smithing', origin, tasks, exclude, timeoutSec?}`，smithing 缺省 `origin: [10000, 120, 10210]`、`tasks: '1-4'`、`timeoutSec: 600`。坐骑场地 `{type: 'mount', origin, groups, total, move, exclude, timeoutSec?}`，mount 缺省 `origin: [10000, 120, 10240]`、五组都出、`total: '64-128'`、`move: '1-64'`、排除 `minecraft:bundle`、`timeoutSec: 600`。织布机场地 `{type: 'loom', origin, banners, slots, fill, styles, spare, itemPatterns, exclude, timeoutSec?}`，loom 缺省 `origin: [10000, 120, 10270]`、`banners: '1-3'`、`slots: '1-3'`、`styles: '1-3'`、`spare: '0-3'`、`itemPatterns: 'off'`、`timeoutSec: 900`。制图台场地 `{type: 'cartography', origin, task, scale, maps, copies, ops, spare, timeoutSec?}`，cartography 缺省 `origin: [10000, 120, 10300]`、`task: 'mix'`、`scale: '0-3'`、`maps: '1-3'`、`copies: '2-5'`、`ops: '1-4'`、`spare: '0-3'`、`timeoutSec: 600`。酿造台场地 `{type: 'brew', origin, fuel, raw, bottles, m, n, exclude, timeoutSec?}`，brewing 缺省 `origin: [10000, 120, 10330]`、`fuel` / `raw` 为 `'32-64'`、`bottles: '1-3'`、`m` / `n` 为 `'1-32'`、`timeoutSec: 600`；`training.brewing` 指向酿造配方文件。合成器场地 `{type: 'crafter', origin, portions, extra, exclude, timeoutSec?}`，crafter 缺省 `origin: [10000, 120, 10360]`、`portions: '1-16'`、`extra: '0-16'`、`timeoutSec: 900`。村民交易场地 `{type: 'trade', origin, level, tasks, portions, extra, exclude: { professions, items }, timeoutSec?}`，villager 缺省 `origin: [10000, 120, 10390]`、`level: '1-5'`、`tasks: '1-4'`、`portions: '1-64'`、`extra: '0-16'`、`timeoutSec: 900`
