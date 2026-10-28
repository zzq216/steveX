# 路由阶段 B 实施细则

> **依据**：[路由系统设计方案.md](路由系统设计方案.md) §14 阶段 B、§16 占位清单；[Agent系统与DSH集成设计方案.md](Agent系统与DSH集成设计方案.md) §6.1。
> **目标**：把路由从 `provider.mode=stub`（全 none，人说的话永远走 default）换成**真的用大模型填槽**，并补齐 `clarify` / `default` / `unsupported` 三个 handler 的内容。做完后，人在对话框里直接说"做一把木镐"就能开任务，不必再敲 `/bt task`。
> **不动**：槽位词表、编排器、turn scope、`task` / `fact` handler（P1 / P5 已真实化）、agent 插件。
> **状态**：2026-10-27 D1–D12 按推荐通过；**代码完成、离线测试通过，待 DSH 内验收**（实现说明见 §13）。

---

## 1. 现状与缺口

| 部分 | 现状 | 缺口 |
|---|---|---|
| provider | `stub`：永远返回全 none → 只命中 `default` | 没有 `llm` 实现（`mode=llm` 需要程序化注入 `fillSlots`，否则加载报错） |
| 提示词 | `prompts/router/*.md`、`prompts/handlers/*.md` 全是 `TODO(内容层)` 占位 | 槽位定义、规则、few-shot、追问 / 不支持 / 降级话术 |
| `clarify` | 只返回日志文本，**不往回合里注入任何东西**——主模型不知道要追问 | 让主模型把追问问出来；追问上限 |
| `default` | 桩 | 正常对话不需要注入；只在"降级"时补一句说明 |
| `unsupported` | 桩，不注入 | 告诉主模型"这项能力暂不支持"，让它转告用户 |
| 日志 | 只有一行 `logger.info` | §10 的结构化记录 |

---

## 2. DSH 侧的事实（决定了实现方式）

已查 `@deepseek-ai/dsh-llm` / `dsh-agent` / `dsh-session` 0.2.1-rc.2 的类型声明：

1. **插件可以发起一次独立的模型调用**：`ctx.llm.prepareCall({ provider, model, maxTokens }, signal, configure?)` → `call.stream({ ...call.config, system, messages, sessionId, purpose, signal })`，用 `BlockAssembler` 拼出文本。DSH 自带的会话标题插件（`dsh-session-title-llm`）就是这么做的。
2. **当前会话用的模型**在 `agent.options.provider` / `agent.options.model`。
3. **历史对话**：`agent.session.deriveMessages()` 返回冻结的消息数组（user / assistant / tool）。
4. **`agent/pre-step` 只能 `enter` 或 `reject`**，不能"不调主模型、直接回一句话"。所以追问只能通过**注入提示词让主模型代为发问**（本 step 仍然走一次主模型）。
5. `/bt task`、`/bt fact` 用 `followup` 开回合，消息来源是 `stevex-bt` / `stevex-fact`，现有代码已经跳过它们，不会被路由二次处理。

---

## 3. 一次路由的流程

```
人发消息 → agent/pre-step（step 1，本 step 含 kind=user 的消息）
  → 组装路由输入（§4）
  → ctx.llm 独立调用（低推理、短输出、硬超时）
  → 解析 JSON → validateSlotJson
       失败 → 带着错误重试 1 次 → 仍失败 → 降级（§7）
  → 追问上限检查（§6）
  → router.run：选择 / 独占 / 排序 / 执行 handler
  → handler 的 prompt 合成一条 stevex-router 消息追加进本 step
  → 写一行路由日志（§9）
主模型照常处理本 step（看得到人说的话 + 路由注入的正文）
```

路由调用**不进会话历史**（不是 assistant 消息），只在路由日志里留记录；注入的 handler 正文作为 `stevex-router` 来源的用户消息进历史（现有机制），可回放。

---

## 4. 路由输入（提示词组装）

系统提示词 = 设计方案 §6 的块，按顺序拼接：

| 块 | 来源 |
|---|---|
| `[SYSTEM]` | 代码内固定一段："你是 steveX 的输入路由器，只输出 JSON，不回答问题、不调用工具" |
| `[SLOT_DEFS]` | `prompts/router/slot_defs.md` |
| `[RULES]` | `prompts/router/rules.md` |
| `[FEW_SHOT]` | `prompts/router/few_shot.md` |
| `[OUTPUT]` | 代码内固定（§7 的 JSON schema，由 `SLOT_VALUES` 生成，词表改了自动跟上） |

用户消息 = `[CONTEXT]` + `[USER]`：

- `[CONTEXT]`：`deriveMessages()` 里最近 **N=6** 条 user / assistant 的**文本**（丢掉工具调用与工具结果、丢掉 `stevex-*` 来源的系统请求正文；每条截到 400 字）；若上一轮是追问，附"上一轮你追问了：…；用户当时的原话：…"。
- `[USER]`：本 step 里人说的话（`userText(messages)`）。

### 4.1 槽位语义（写进 `slot_defs.md`，D3）

| 槽位 | 判定问题 | payload |
|---|---|---|
| `domain` | 说的是不是 Minecraft / 这个游戏里的 agent？ | `null` |
| `knowledge=fact` | 用户是不是在**陈述 / 教给 agent 一条 MC 规则或事实**，希望它记住？（"熔炉烧一个物品要 10 秒"） | `{ "statement": "…" }`：抽出的那条陈述 |
| `action=execute` | 用户是不是要 agent **在游戏里动手做事**？（"做一把木镐""去砍 5 个木头"） | `{ "instruction": "…" }`：去掉寒暄的指令原文 |
| `artifact=fast_tree` | 用户是不是要**直接修改快树 / 反应规则**？ | `{ "intent": "…" }` |

**问问题不是 `fact`**："钻石在第几层？"→ `knowledge=none`、`action=none` → `default`，主模型用查询工具正常回答。`fact` 只对应事实库的"确认并写入"流程（P5），与现有 `factInTurn` 的语义一致。

`fact` handler 改用 `payload.statement`（有就用，没有退回人说的整句），与 `task` 用 `payload.instruction` 对称。

### 4.2 规则块（`rules.md`）要点

- 槽位正交，可以同时非 none（"熔炉 10 秒一个，帮我烧 8 个铁" → fact + execute）；
- **不对称成本**：对 `execute` 保守（拿不准就 `unknown`），对 `fact` 宽松；
- 闲聊、问状态、问"你会什么"、评价上一步做得怎样 → 全 none；
- "停下 / 别做了 / 换个任务" → `action=none`（放弃任务由主模型用 `bt_abort_task` 处理，不是新任务）；
- 只输出 JSON。

### 4.3 few-shot（`few_shot.md`）

覆盖设计方案 §6 的要求：纯事实、纯任务、事实 + 任务、寒暄 + 事实、问问题（全 none）、`unknown`、`artifact=fast_tree`、停止 / 换任务、带追问上下文的二次填槽。约 12 条，每条一行输入 + 一行 JSON。

---

## 5. 模型调用（provider llm 模式）

```yaml
provider:
  mode: llm
  promptsDir: null      # null = 本包自带的 prompts/
  route: null           # null = 跟当前会话同一个 provider/model；或 { provider, model }
  reasoningEffort: null # null = 该模型支持的最低档；或显式档位
  maxTokens: 600
  timeoutMs: 15000
  contextMessages: 6
```

- **D1 用哪个模型**：默认跟会话同一个模型（不用另配 key、不会选到不存在的路由）；可配置覆盖成更快更便宜的模型。
- **D2 推理档位**：路由是短分类，默认取模型支持的**最低**推理档（`configure` 回调里根据 model info 选）。
- 硬超时 15 s，用 `AbortSignal.any([turnSignal, timeout])`：人中途取消回合，路由调用也一起停。
- 解析：取回复里第一个完整的 `{…}`（容忍 ```json 围栏）；`JSON.parse` → `validateSlotJson`。
- **重试 1 次**（设计方案 §7）：把校验错误附在对话末尾再问一次；仍不合法 → 降级（§7）。

---

## 6. 追问（clarify）

触发条件：决定性槽位是 `unknown`（2026-10-28 修订，见 §14）。

- **D4 怎么问出来**：`clarify` handler 返回 `prompt`，注入主模型：
  > （steveX 路由）没能确定你要我做什么。请只用一两句话向用户确认：「{问题}」。本回合不要调用任何工具，也不要回答问题本身。
  
  `{问题}` 优先用路由给的 `clarification`；没给就按哪个槽位不确定套模板（`clarify.md` 里按槽位写好二选一句式：`action` → "是要我现在去游戏里做这件事，还是只是问问？"）。
- **D5 追问状态**：按会话保存 `{ question, userText, slots }`；下一条人说的话路由时放进 `[CONTEXT]`（§4）。任何非追问的结果都清掉它。
- **D6 上限**：连续追问达到 `clarifyMaxTurns`（2）后，第 3 次仍判不出 → **不再追问**：把仍不确定的决定性槽位按 `none` 处理（保守：不开任务、不写事实），走正常编排，并注入降级说明："如果用户是要你动手做，请告诉他可以用 `/bt task <指令>` 明确下达。"

---

## 7. 降级（路由调用失败）

现状：路由抛错 → `clarifyFallback`，但它不注入任何东西，等于静默吞掉。

- **D7 降级策略**：模型不可用 / 超时 / 两次输出都不合法 → 按**全 none** 走 `default`，`default` 注入一句：
  > （steveX 路由）这条消息没能自动判断意图（{原因}），按普通对话处理。如果用户是要你在游戏里做事，请提醒他用 `/bt task <指令>`。

  理由：设计方案 §11 要求"不猜、不默认执行任务"——全 none 恰好满足；比"追问"好在不会让人把话重说一遍却得到同样的失败。人取消回合导致的中止不降级、不注入。

---

## 8. `default` 与 `unsupported`

- **`default`**：正常对话**不注入任何东西**（主模型照常回答，已有查询工具）。只在 §6 上限 / §7 降级时注入说明（正文在 `default.md`，按场景分段）。
- **`unsupported`**（`artifact != none`）：注入 `unsupported.md`：
  > （steveX 路由）用户想直接修改快树 / 反应规则，这项能力目前不支持；请如实告诉用户，不要尝试用任何工具去改。快树会在任务后的反思里自动进化。
  
  若同时 `action=execute`，任务照跑（设计方案 §9 部分支持）。

---

## 9. 路由日志（D8）

每次路由写一行 JSON 到 `steveX/runtime/router/<sessionId>.jsonl`（`runtime/` 已在 .gitignore 中）：

```json
{ "at": "…", "session": "…", "turn": 3, "provider": "llm", "model": "…", "latencyMs": 1830, "attempts": 1,
  "slots": { "domain": "minecraft", "knowledge": "none", "action": "execute", "artifact": "none" },
  "payload": { "action": 12 }, "reason": "…", "clarification": null,
  "handlers": ["task"], "outcomes": { "task": "ok" }, "degraded": null }
```

- payload **只记长度**（设计方案 §3.2）；人说的原话不落这份日志（它已经在会话日志里）。
- `userCorrected` 本阶段不实现（没有可靠信号），字段先不写。
- 写失败只打 warn，不影响回合。

---

## 10. 部署切换（D9）

- `normalizeConfig` 的默认 `mode` 改成 `llm`，默认 `promptsDir` = 本包 `prompts/`；`cordis.patch.yml` 同步改成 `mode: llm`。
- 测试与离线开发显式写 `mode: stub`。
- **已安装的 stevex profile 里如果写着 `mode: stub`，需要你在 DSH 设置 → 插件 → stevex-router 的配置里改成 `llm`**（或删掉该项用默认值）。profile 配置文件在 `~/.dsh` 下，我不读取它。
- llm 模式启动时仍校验提示词：缺失 / 为空 / 仍有 `TODO(内容层)` → 拒绝上线（现有机制）。`fact.md` / `task.md` 从必需列表里去掉——这两个 handler 的 skill 正文在 agent 插件的 `prompts/skills/`，路由这边留一份只会漂移（单一真相，设计方案 §12）。

---

## 11. 测试（D10）

全部离线、不调真模型（注入假的 `llm` 服务）：

1. 提示词组装：块顺序、`[OUTPUT]` 随词表生成、上下文截断与过滤、追问上下文；
2. 解析：围栏、前后多余文字、非法 JSON → 重试 1 次 → 降级；
3. 超时 / 模型报错 → 降级注入；人取消 → 不注入；
4. 追问：注入正文、状态保存与清除、上限后按 none 处理；
5. `unsupported` 注入、与 `task` 并存；`fact` 用 `payload.statement`；
6. 路由日志：字段齐全、payload 只记长度；
7. 默认配置 = llm、`stub` 仍可用。

**评测集**（设计方案 §16 #10）：`test/router-eval/cases.jsonl`（输入 → 期望槽位值）+ `npm run eval` 脚本，需要真模型，只在你本机手动跑，不进 `npm test`。第一版约 30 条，与 few-shot **不重叠**。

**延迟代价**：每条人说的话多一次短模型调用（DeepSeek 低推理档预计 1–3 s）。觉得慢可以随时切回 `stub`。

---

## 12. 决策点与推荐

| # | 问题 | 推荐 |
|---|---|---|
| D1 | 路由用哪个模型 | 默认跟会话同一 provider/model；配置可覆盖 |
| D2 | 推理档位 | 默认取该模型支持的最低档；配置可覆盖 |
| D3 | `knowledge=fact` 的含义 | **只指"用户陈述一条 MC 事实要 agent 记住"**；问问题算 none，走正常回答；`fact` handler 改用 `payload.statement` |
| D4 | 追问怎么问出来 | 注入提示词让主模型只问一句、本回合不调工具 |
| D5 | 追问上下文 | 按会话保存上一次追问，下一条消息路由时放进 `[CONTEXT]` |
| D6 | 追问上限后 | 不再追问；不确定的决定性槽位按 none 处理，并提示可用 `/bt task` |
| D7 | 路由调用失败 | 按全 none 走 default，注入一句说明并提示 `/bt task`；不追问、不开任务 |
| D8 | 日志 sink | `runtime/router/<sessionId>.jsonl`，payload 只记长度，不记原话 |
| D9 | 默认模式 | 默认 `llm`；测试显式 `stub`；`fact.md` / `task.md` 移出必需列表并删除 |
| D10 | 评测集 | 离线单测进 `npm test`；真模型评测 30 条，手动 `npm run eval` |
| D11 | 路由是否感知 agent 状态（有没有任务在跑） | **不感知**（设计方案 #9）；任务冲突仍由 `task` handler 拒绝并让主模型确认 |
| D12 | 上下文条数 / 截断 | 最近 6 条 user/assistant 文本，每条 400 字 |

---

## 13. 实施说明（2026-10-27）

### 13.1 文件

| 文件 | 内容 |
|---|---|
| `src/llm_slots.js`（新） | 提示词组装（`[OUTPUT]` 由 `SLOT_VALUES` 生成）、历史过滤截断、回复解析（容忍围栏 / 前后文字，字符串内花括号不打断配平）、`createLlmFillSlots`（不合法重试 1 次）。零 DSH 依赖 |
| `src/router_log.js`（新） | 路由日志：`<logDir>/<sessionId>.jsonl`，payload 只记长度 |
| `src/index.js` | `complete()` 用 `ctx.get('llm').prepareCall` + `BlockAssembler`；追问状态与上限；降级；notice 注入；写日志 |
| `src/handlers.js` | `clarify` / `unsupported` 注入正文；`fact` 改用 `statementOf`（`payload.statement` 优先）；`clarifyQuestion` |
| `src/domain/slots.js` | `resolveUnsure`：追问上限后把拿不准的决定性槽位改成 none |
| `src/prompts.js` / `src/config.js` | 默认提示词目录、带小节的文件校验、`renderTemplate`；新配置项，默认 `mode: llm` |
| `prompts/` | 六个文件填好正文；`handlers/fact.md`、`handlers/task.md` 已删除 |
| `cordis.patch.yml`、`dsh-plugins/profile/cordis.patch.yml` | `mode: llm` |
| `test/llm_slots.test.js`（新）、`test/plugin.test.js`、`test/domain_slots.test.js` | 见 §13.3 |
| `test/router-eval/cases.jsonl` + `scripts/router-eval.js`（`npm run eval`） | 真模型评测，30 条 |

### 13.2 与草案的出入

- **`maxTokens` 默认 1024**（草案写 600）：会话模型若是推理模型，思考内容也占输出额度，600 容易截断 → 每次都降级。可配置。
- **降级 / 追问上限的说明由 index.js 作为 notice 注入**，不放在 `default` handler 里：追问上限后可能命中的是 `fact` 而不是 `default`，说明也要送到。正文仍在 `default.md` 的两个小节里。注入消息的 `source` 多一个 `notice` 字段。
- **stub 模式也加载提示词**（`clarify` / `unsupported` 的正文要用）；`promptsDir` 不再允许 null，默认本包 `prompts/`。
- 本 step 没有人说的文字（比如只发了图片）→ 不调模型，直接按普通对话。
- 追问状态的"原话"跨多次追问累积（原话 + 每次回答）。
- 路由调用不传 `purpose`（DSH 只接受 `compaction` / `session-title`），用 `sessionId` 关联会话。

### 13.3 测试

路由包 5 个测试文件全部通过（domain_router 11、domain_slots 9、domain_turn_scope 5、llm_slots 6、plugin 29）。plugin 里用假的 `ctx.llm`（真 `BlockAssembler` 拼流）覆盖：会话模型与最低推理档、配置覆盖、普通对话不注入、`payload.statement`、unsupported 与 task 并存、追问注入 / 上下文 / 清除、追问上限、两次不合法 / 模型报错 / 超时降级、人取消不注入、路由日志字段且不含原话。测试一律 `logDir: null`，不往 `runtime/` 写东西。

### 13.4 待 DSH 内验收

1. 重启 DSH，新建会话。确认 `stevex-router` 配置里 `provider.mode` 不是 `stub`（是 `stub` 就改成 `llm` 或删掉）。
2. 直接说"做一把木镐" → 开任务（`runtime/router/<会话>.jsonl` 里 `handlers: ["task"]`）。
3. "钻石在第几层？" → 正常回答，不开任务。
4. "要不要去挖点铁呢" → 主模型只问一句；回答"现在就去"→ 开任务。
5. "以后看到苦力怕就跑" → 告知暂不支持。
6. 看路由日志里的 `latencyMs`，判断延迟能否接受。
7. 可选：`npm run eval` 跑评测集，看准确率。

---

## 14. 修订：删除 confidence（2026-10-28）

**决定**（用户确认两点）：
1. 删除槽位的 `confidence` 与配置项 `confidenceThreshold`；
2. 追问**只看决定性槽位是不是 `unknown`**，`clarification` 非空不再单独触发追问——它只是追问时用的那句话。

**理由**：模型自报的置信度不是真实概率，0.7 阈值比的是编出来的数；"拿不准"同时有 `unknown` / 低置信 / `clarification` 三条通道，会出现 `execute` 配 0.5 这类矛盾组合，还多一类校验失败。真要置信度应看 API 的 logprobs，与自报数字是两回事，现阶段不做。

**改动**：
- `domain/slots.js`：槽位形状 `{ value, payload }`；模型多给的 `confidence` 校验时忽略（不报错、不保留）；`needsClarification` / `resolveUnsure` 只看 `unknown`；
- `domain/router.js`、`index.js`、`handlers.js`（`clarifyQuestion` 按 `unknown` 选问句）、`config.js`（旧 profile 里残留的 `confidenceThreshold` 直接忽略，不报错）；
- `llm_slots.js` 的 `[OUTPUT]`、`slot_defs.md`、`rules.md`（规则 2：拿不准就 `unknown`；规则 7：给了 `unknown` 就写 `clarification`，否则 null）、`few_shot.md`（12 个示例去掉 confidence，`unknown` 与 `clarification` 一一对应）；
- 路由日志 `slots` 改为只记取值；
- 两个 `cordis.patch.yml` 去掉 `confidenceThreshold`；
- 测试：路由包 62 个全部通过（新增"多给的 confidence 被忽略""只有 clarification 不追问"）。
