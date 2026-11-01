# 训练报告：craft2x2（物品栏 2×2 合成）第 1–20 轮

> 训练日期：2026-11-01。共 4 批 × 5 轮 = 20 轮，每批之后做一次胶囊库整理。
>
> 数据来源：`runtime/training/craft2x2.jsonl`（每轮一行）、`runtime/tasks/<taskId>/events.jsonl`（执行器事件）、`src/capsules/`（胶囊库、使用统计、整理记录）、`D:\Code(py)\MC_agent\dsh-session`（第 12–20 轮中 9 个会话的完整日志）。训练场设计见 [训练场设计方案.md](训练场设计方案.md)。

## 1. 结论

- **能力已学会**：20/20 成功，没有虚报成功（`false_success`），没有用 `chat/send` 作弊，每轮规划都是一次就交出合格的大纲。
- **效率在第四批明显提升**：平均合成用时从 104 秒降到 71 秒，平均回合数从 4.4 降到 1.6，平均 token 从 55 万降到 37 万；第四批 5 轮里有 3 轮只用 1 个回合。
- **提升主要来自两处修正，而不是多跑**：前三批的平均用时几乎不变（104 / 104 / 92 秒）。第三批之后查出两个系统问题：MC 失去焦点自动暂停（环境），以及大纲提示词规定了固定的树形状（提示词）。修正之后，第四批才出现明显下降。
- **胶囊库已收敛**：有效条目 20 条，2×2 合成只剩一个推荐入口 `trees/craft.once-2x2-from-recipes`。四次整理一共下架 10 条重复或从没用过的条目，全部写明了取代者。
- **判断**：2×2 合成不需要继续专项训练，建议转向下一个高层动作（工作台 3×3 合成）。

## 2. 训练内容

### 2.1 任务

每轮从 `recipes.json` 里能放进 2×2 合成格的 427 条配方中随机抽一条，把 1 份材料随机放进物品栏，再给 agent 发一条任务：

> 你的物品栏里有合成 minecraft:<目标> 所需的 1 份材料。请用这些材料合成 1 次 minecraft:<目标>。

任务描述说出目标物品（named 模式），但不提示怎么做。

### 2.2 每轮流程

1. 新建一个 DSH 会话（每轮互不共享上下文）。
2. mod 以服务器身份重置：关界面、清物品栏、传送进训练场、清掉落物和敌对生物、回满状态、白天晴天、重置配方书、发放材料，并记下合成统计（`minecraft.crafted`）的基线。
3. 在新会话里发任务，开始计时。agent 规划、执行行为树、遇到失败时修补，任务结束后复盘、把值得留下的子树或代码存进胶囊库。
4. 合成统计第一次增加的时刻记为合成用时，任务结束后传送出场，追加一条记录。

**判定只看事实**：成功要求任务报告完成，并且目标物品的合成统计确实增加了。只有从合成结果槽取出物品才会计数，`/give` 或捡拾都不算。训练世界关闭了作弊。

### 2.3 训练安排

| 批次 | 轮次 | 本批之前的变更 | 本批之后的整理 |
|---|---|---|---|
| 第一批 | 1–5 | 胶囊库清空，从零开始 | 整理 #1：下架 0 条，改说明 4 条 |
| 第二批 | 6–10 | — | 整理 #2：下架 5 条，改说明 5 条 |
| 第三批 | 11–15 | — | 整理 #3：下架 3 条，改说明 3 条 |
| 第四批 | 16–20 | ① 关闭 MC 失去焦点自动暂停；② 重写大纲、展开两个提示词（删掉固定的树形状） | 整理 #4：下架 2 条，改说明 4 条 |

## 3. 20 轮数据

- **合成用时**：从发任务到目标物品第一次被合成出来。
- **任务用时**：从发任务到任务结束，不含复盘。
- **回合**：规划、展开、修复这几类大模型回合的数量，不含复盘、整理。
- **token**：这些回合的 token 总量，含缓存命中。缓存命中平均约占 91%。

| 轮 | 批 | 目标 | 材料 | 结果 | 合成用时 | 任务用时 | 回合 | token（万） | 节点调用 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 一 | waxed_chiseled_copper | chiseled_copper×1 + honeycomb×1 | 成功 | 143.0 秒 | 155.7 秒 | 4 | 35.9 | 25 | 库为空，从零写；复盘存了 8 条 |
| 2 | 一 | chiseled_nether_bricks | nether_brick_slab×2 | 成功 | 142.8 秒 | 153.0 秒 | 6 | 68.5 | 63 | 摆料代码报"配方数据里没有目标"×2：配方列表没按产物过滤 |
| 3 | 一 | polished_blackstone | blackstone×4 | 成功 | 126.0 秒 | 161.8 秒 | 3 | 92.8 | 42 | |
| 4 | 一 | chiseled_resin_bricks | resin_brick_slab×2 | 成功 | 73.1 秒 | 122.8 秒 | 7 | 65.2 | 45 | |
| 5 | 一 | yellow_carpet | yellow_wool×2 | 成功 | 37.2 秒 | 38.5 秒 | 2 | 13.8 | 34 | 第一次只用 2 个回合 |
| 6 | 二 | purple_harness | purple_dye×1 + gray_harness×1 | 成功 | 77.3 秒 | 91.2 秒 | 4 | 48.6 | 35 | |
| 7 | 二 | waxed_oxidized_copper | oxidized_copper×1 + honeycomb×1 | 成功 | 182.2 秒 | 214.3 秒 | 6 | 149.3 | 60 | 同第 2 轮的配方过滤问题 |
| 8 | 二 | waxed_weathered_copper_grate | weathered_copper_grate×1 + honeycomb×1 | 成功 | 111.6 秒 | 149.2 秒 | 5 | 94.9 | 83 | 复盘存了"按 E 最多重试 4 次"的守卫（后查明是暂停造成的假问题） |
| 9 | 二 | ender_eye | ender_pearl×1 + blaze_powder×1 | 成功 | 51.3 秒 | 52.9 秒 | 2 | 16.4 | 42 | 复盘时想下架重复子树，被拒（只有整理回合能下架），改为留下建议 |
| 10 | 二 | waxed_cut_copper_slab | cut_copper_slab×1 + honeycomb×1 | 成功 | 99.3 秒 | 100.5 秒 | 3 | 33.1 | 39 | |
| 11 | 三 | pale_moss_carpet | pale_moss_block×2 | 成功 | 186.7 秒 | 188.6 秒 | 2 | 67.7 | 69 | **MC 失去焦点暂停**：按 4 次 E 都没反应，补救展开等了 148 秒 |
| 12 | 三 | waxed_oxidized_cut_copper_slab | oxidized_cut_copper_slab×1 + honeycomb×1 | 成功 | 98.2 秒 | 99.5 秒 | 4 | 61.9 | 46 | 规划时凭记忆以为要用工作台，留了 `expand` |
| 13 | 三 | oak_planks | oak_log×1 | 成功 | **24.1 秒** | 25.5 秒 | **1** | **7.4** | 43 | 大纲直接 `use` 核心子树，20 轮中最快 |
| 14 | 三 | end_stone_bricks | end_stone×4 | 成功 | 42.8 秒 | 106.4 秒 | 3 | 49.9 | 55 | 合成后终验时黑板键 `check.before` 缺失，修补 |
| 15 | 三 | light_gray_carpet | light_gray_wool×2 | 成功 | 107.9 秒 | 128.7 秒 | 8 | 97.1 | 61 | 照提示词的形状留了 3 个 `expand`，层层展开共 6 次 |
| 16 | 四 | exposed_cut_copper | exposed_copper×4 | 成功 | 89.6 秒 | 91.0 秒 | 1 | 68.6 | 37 | 规划时查了约 60 秒 MC 源码确认配方，写进 2 条事实 |
| 17 | 四 | waxed_copper_chest | copper_chest×1 + honeycomb×1 | 成功 | 82.1 秒 | 83.4 秒 | 2 | 30.4 | 44 | 新写的选路代码有 bug（`miss is not defined`），修复 1 次 |
| 18 | 四 | chiseled_tuff | tuff_slab×2 | 成功 | 102.9 秒 | 104.4 秒 | 3 | 61.3 | 58 | 摆料后约 50ms 就查产物格，太早；复盘用同名替换修好了两棵核心子树 |
| 19 | 四 | light_gray_dye | oxeye_daisy×1 | 成功 | 38.9 秒 | 39.9 秒 | 1 | 13.6 | 39 | 用修好的新版子树 |
| 20 | 四 | skull_banner_pattern | paper×1 + wither_skeleton_skull×1 | 成功 | 41.8 秒 | 42.8 秒 | 1 | 10.1 | 41 | 用修好的新版子树 |

## 4. 四批对比

| | 第一批（1–5） | 第二批（6–10） | 第三批（11–15） | 第四批（16–20） | 全部 20 轮 |
|---|---|---|---|---|---|
| 成功 | 5/5 | 5/5 | 5/5 | 5/5 | 20/20 |
| 合成用时：平均 | 104.4 秒 | 104.3 秒 | 91.9 秒 | **71.1 秒** | 92.9 秒 |
| 合成用时：中位数 | 126.0 秒 | 99.3 秒 | 98.2 秒 | **82.1 秒** | 93.9 秒 |
| 合成用时：最快 / 最慢 | 37.2 / 143.0 秒 | 51.3 / 182.2 秒 | 24.1 / 186.7 秒 | 38.9 / 102.9 秒 | 24.1 / 186.7 秒 |
| 任务用时：平均 | 126.4 秒 | 121.6 秒 | 109.7 秒 | **72.3 秒** | 107.5 秒 |
| 回合：平均 | 4.4 | 4.0 | 3.6 | **1.6** | 3.4 |
| 只用 1 个回合的轮数 | 0 | 0 | 1 | **3** | 4 |
| token：平均 | 55.3 万 | 68.5 万 | 56.8 万 | **36.8 万** | 54.3 万 |
| token：合计 | 276 万 | 342 万 | 284 万 | 184 万 | 1087 万 |
| 节点调用：平均 | 41.8 | 51.8 | 54.8 | 43.8 | 48.0 |
| 整理后有效胶囊数 | 15 | 17 | 19 | 20 | — |

### 解读

- **第一到第三批**：用时没有收敛，波动很大。每轮多花的时间几乎都来自额外的大模型回合，也就是展开和修复。只用 2 个回合的轮次（第 5、9 轮）都在 40～50 秒，用 5～8 个回合的轮次都在 100～180 秒。
- **第三批之后查出的两个原因**（详见会话日志分析）：
  1. **MC 失去焦点自动暂停**：mod 运行目录里 `pauseOnLostFocus` 是 `true`。人切到浏览器看 DSH 时，MC 弹出暂停菜单，按键不再被处理，单人世界也停了下来。第 11 轮因此白等了 148 秒。第 8 轮学到的"按 E 不可靠，要重试"也是这个原因造成的。修正：mod 每次启动强制关闭这项设置。
  2. **大纲提示词规定了固定形状**："只沿第一条路径拆到底，其余全部留成 `expand`"。第 14、15 轮的 agent 找到了能覆盖全流程的核心子树，却因为这条规定改写成 `expand`。第 15 轮的推理原文是 "graders likely check structure: seq with concrete first node + expands"。修正：删掉这条规定，只说明具体节点和 `expand` 各是什么，怎么拆由 agent 决定。
- **第四批**：5 轮的规划都是一个回合就交出完整的树，全部直接 `use` 核心子树，再没有层层展开。剩下的多余回合来自新写代码的 bug（第 17 轮）和产物格检查过早（第 18 轮），后者已被 agent 在复盘中修好。

## 5. 训练产物

### 5.1 胶囊库（`src/capsules/`）

训练中一共存过 30 个名字（37 个版本文件，259 KB），现在有效 20 条（代码 15 条、子树 5 条），已下架 10 条。以下使用次数截至第 20 轮，第 11 轮还没有从统计里剔除（见第 6 节）。

**2×2 合成的推荐调用链：**

```
trees/craft.once-2x2-from-recipes          ← 唯一推荐入口（给已按产物过滤的配方列表 + 目标）
├─ code/inv.count-items                    记合成前背包基线
├─ code/craft.check-fit-2x2                挑一条放得进 2×2、材料够的配方（不行就带原因抛错）
├─ trees/container.ensure-inventory-open   确保背包界面打开
├─ trees/craft.once-in-inventory-2x2       摆料 → 等服务端回包 → 确认产物格 → 快捷移出
│   ├─ code/craft.plan-place-2x2-clicks    按现场格下标算摆料点击
│   ├─ code/cond.container-has-item        产物格出现了目标
│   └─ code/craft.plan-take-result-click   算取产物的点击
└─ trees/craft.verify-and-close            终验：产物 +1 且材料恰好少计划用量，然后关界面
    └─ code/cond.craft-consumed
```

规划时通常在前面接 `code/core.json.query`（查配方）和 `code/recipe.has-result`（自检）。

**有效条目：**

| 条目 | 类型 | 作用 | 使用情况 |
|---|---|---|---|
| `trees/craft.once-2x2-from-recipes` | 子树 | 2×2 合成一次的唯一推荐入口 | 8 个任务 |
| `trees/craft.once-in-inventory-2x2` | 子树 | 摆料、确认产物格、取走产物（由入口调用，不单独用） | 16 个任务 |
| `trees/craft.verify-and-close` | 子树 | 合成后终验并关界面 | 12 个任务 |
| `trees/container.ensure-inventory-open` | 子树 | 确保背包界面打开 | 12 个任务 |
| `trees/container.ensure-closed` | 子树 | 确保没有开着的界面 | 1 个任务 |
| `code/inv.count-items` | Compute | 背包按物品 id 汇总，作基线 | 19 个任务 |
| `code/craft.plan-place-2x2-clicks` | Compute | 算摆料点击序列 | 19 个任务 |
| `code/craft.plan-take-result-click` | Compute | 算取产物点击 | 19 个任务 |
| `code/cond.container-has-item` | 条件 | 界面里有目标物品（产物格已出现） | 19 个任务 |
| `code/cond.inventory-menu-open` | 条件 | 当前是背包界面 | 18 个任务 |
| `code/cond.craft-consumed` | 条件 | 产物 +1 且材料恰好少计划用量 | 17 个任务 |
| `code/craft.check-fit-2x2` | Compute | 挑一条放得进 2×2 且材料够的配方 | 17 个任务 |
| `code/recipe.has-result` | 条件 | 配方列表里确有该产物 | 13 个任务 |
| `code/craft.grid-empty` | 条件 | 2×2 合成格和产物格都空 | 4 个任务 |
| `code/inv.has-at-least` | 条件 | 某物品总数 ≥ min | 4 个任务 |
| `code/craft.pick-route` | Compute | 按库存选合成路线（2×2 / 需要工作台） | 3 个任务 |
| `code/container-closed` | 条件 | 当前没有开着的界面 | 2 个任务 |
| `code/cond.bag-gained-item` | 条件 | 某物品比基线至少多 1 | 1 个任务 |
| `code/craft.clear-2x2-grid` | Compute | 清空合成格里的残留 | 只在草稿期用过 1 次 |
| `code/inv.assert-materials` | Compute | 摆料前核对材料够不够 | 只在草稿期用过 1 次 |

**已下架（10 条，都写明了取代者）：**

| 整理 | 下架条目 | 取代者 |
|---|---|---|
| #2 | `trees/craft.once-and-verify-inventory-2x2`、`trees/craft.once-2x2-guarded-verified`、`trees/craft.once-2x2-inventory-robust` | `trees/craft.once-2x2-from-recipes` |
| #2 | `code/craft.plan-route` | `code/craft.check-fit-2x2` |
| #2 | `code/inv.gained-vs-baseline` | `code/cond.bag-gained-item` |
| #3 | `trees/craft.once-2x2-by-target`、`trees/craft.once-2x2-product-and-close`、`trees/craft.retry-2x2-after-failed-attempt` | `trees/craft.once-2x2-from-recipes` |
| #4 | `trees/craft.take-result-and-verify`、`trees/craft.once-by-route` | `trees/craft.once-2x2-from-recipes` |

下架的 10 条几乎都是"把同一串子胶囊重新包一层"的入口，存下来之后从没被执行过，或者很少执行。复盘时容易存成新名字，整理时再根据跨任务的使用统计淘汰，这个分工在四次整理中都起了作用。第 18 轮复盘第一次用同名替换（`replaces`）直接更新核心子树，没有另起新名字。

### 5.2 事实库（`facts/`，只留本地，不进 git）

训练中新增 5 条，都带 MC 源码引用：

| 事实 | 内容 |
|---|---|
| `client.inventory-key-opens-only-with-no-screen` | 只有没打开任何界面时，按 E 才会打开背包（`Minecraft.tick` 只在 `screen == null` 时处理按键） |
| `client.inventory-key-closes-open-container-screen` | 容器界面开着时按物理键 E 会关闭界面 |
| `inventory.closing-returns-crafting-grid-items` | 关闭背包界面时，2×2 合成格里的物品会退回背包 |
| `crafting.cut-copper-2x2-from-copper-block` | 4 个铜块在 2×2 里合成 4 个切制铜块 |
| `stonecutting.cut-copper-from-copper-block` | 切石机里 1 个铜块切成 4 个切制铜块 |

注意：`client.inventory-key-closes-open-container-screen` 对玩家按物理键是对的。但 mod 的 `key/inventory` 是用 `KeyMapping.click` 模拟按键，界面开着时并不会走 `Screen.keyPressed` 这条路径，所以通过 mod 按 E 不会关闭界面。目前这条事实只让 agent 避免重复按 E，没有造成错误。

### 5.3 训练中对系统的修正

| 修正 | 位置 | 起因 |
|---|---|---|
| mod 每次启动强制关闭"失去焦点自动暂停" | `ClientDefaults.java` | 第 11 轮暂停 148 秒 |
| 大纲、展开两个提示词删掉"只沿第一条路径拆到底、其余全部留成 `expand`"的固定形状 | `prompts/skills/outline.md`、`expand.md` | 第 14、15 轮放着核心子树不用，照形状写 `expand` |
| `capsule-stats --rebuild` 新增 `--exclude`；修复重算时会改掉整理计数的 bug | `scripts/capsule-stats.js`、`src/capsules/stats.js` | 要从统计里剔除第 11 轮 |
| 训练场：每轮一个新会话、控制台通知、记录 `sessionId` | `src/training/trainer.js`、`src/index.js` | 各轮共用一个会话会造成上下文污染 |

### 5.4 数据与日志（本地，不进 git）

| 内容 | 位置 |
|---|---|
| 20 轮训练记录 | `runtime/training/craft2x2.jsonl` |
| 每个任务的执行事件、树版本、代码草稿 | `runtime/tasks/task-20261101*/`（20 个） |
| 胶囊使用统计 / 整理记录 | `src/capsules/stats.json` / `src/capsules/curate.jsonl`（4 次整理） |
| 每轮会话的完整日志 | DSH 数据目录；第 12–20 轮中 9 个会话的副本在 `D:\Code(py)\MC_agent\dsh-session` |

## 6. 遗留问题

1. **第 11 轮还在胶囊统计里**。重算命令已经准备好（`capsule-stats --rebuild --exclude …`），要在 DSH 停止时执行。剔除后，`trees/container.ensure-inventory-open` 等条目的失败次数会去掉暂停造成的那部分。
2. **规划回合的固定成本**：每轮都是新会话，agent 要重新搜胶囊、读命令说明、查数据结构，规划回合要 40～60 秒，已经超过执行本身（3～5 秒）。等 3×3 训练跑起来，再看是否值得优化，比如让 `capsule_search` 的结果直接带上子树的输入输出说明，省掉几次 `capsule_get`。
3. **"按 E 最多重试 4 次"的守卫**：`trees/container.ensure-inventory-open` 是在暂停问题下学到的绕法。暂停修好以后它是多余的，但不影响正确性，留给之后的整理按统计判断。
4. **产物格时序的修正只有 2 轮证据**（第 19、20 轮）。下一个任务里继续观察。

## 7. 下一步

停止 2×2 合成的专项训练，转向工作台 3×3 合成。它会复用开关界面、清点物品、摆料、终验这些胶囊，正好检验它们是否通用。之后每改一次核心机制，就跑 3～5 轮 craft2x2 做回归。
