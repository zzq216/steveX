# @stevex/dsh-router

槽位式解构路由（设计文档：[路由系统设计方案.md](../../docs/路由系统设计方案.md) §17；阶段 B：[路由阶段B实施细则.md](../../docs/路由阶段B实施细则.md)）。

人每说一句话，路由先用模型填四个槽位（`domain` / `knowledge` / `action` / `artifact`），再选中对应的 handler，把它们给出的正文作为一条 `stevex-router` 来源的消息追加进本 step：

| 槽位 | handler | 做什么 |
|---|---|---|
| `action=execute` | `task` | 经 `ctx.stevexBt.planInTurn` 开任务（P1） |
| `knowledge=fact` | `fact` | 经 `ctx.stevexBt.factInTurn` 对照源码确认事实（P5） |
| `artifact≠none` | `unsupported` | 告诉主模型"直接改快树暂不支持" |
| 拿不准 | `clarify`（独占） | 让主模型只问一句；连续 2 次后不再追问，按 none 走 |
| 都没有 | `default` | 普通对话，不注入 |

路由调用失败（超时 / 模型不可用 / 两次输出都不合法）→ 按普通对话处理，并注入一句说明提醒用 `/bt task`。执行器发来的请求（`stevex-bt` 等来源）不经路由。

本包遵守两条边界：

- **领域逻辑零 DSH 依赖**：`src/domain/`、`src/llm_slots.js`、`src/handlers.js` 不 import 任何 `@deepseek-ai/*`，可直接用 `node --test` 单测。
- **DSH 适配层只有 `src/index.js`**：挂 `ctx.router`、监听 `agent/pre-step` 与 `agent/turn-stopping`、用 `ctx.llm` 发填槽调用。DSH 升级时只改这一层。

## 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | 槽位契约、编排器、turn scope、桩 provider、五个 handler 桩、提示词占位 | 已实现 |
| agent P1 / P5 | `task` / `fact` handler 真实化 | 已实现 |
| B（2026-10-27） | llm 填槽、提示词正文、clarify / unsupported / 降级说明、路由日志、评测集 | 代码完成，待 DSH 内验收 |

## 配置（`cordis.yml` 的 `config`）

```yaml
- id: stevex-router
  name: '@stevex/dsh-router'
  config:
    confidenceThreshold: 0.7     # 决定性槽位低于它 → 追问
    clarifyMaxTurns: 2           # 连续追问上限
    enabledHandlers: [fact, task, default, unsupported, clarify]
    # logDir: null               # 默认 steveX/runtime/router/；null = 不写路由日志
    provider:
      mode: llm                  # llm（默认）| stub（不判断，全按普通对话；离线调试用）
      # route: { provider: deepseek, model: deepseek-chat }  # 默认 = 跟会话同一个模型
      # reasoningEffort: low     # 默认 = 该模型支持的最低档
      maxTokens: 1024
      timeoutMs: 15000
      contextMessages: 6         # 带给路由的最近几条人 / steveX 文本
      contextChars: 400          # 每条截到多少字
      # promptsDir: ...          # 默认本包 prompts/
```

`stub` 模式可以用 `stubSlots` 给一份固定槽位（测试 / 演示）。程序化使用时可以直接传 `provider.fillSlots` 函数代替模型调用。

## 安装（DSH profile）

本包位于 npm 安装的 DSH **之外**（`steveX/dsh-plugins/router/`），DSH 升级不会覆盖它。通常经 [`@stevex/dsh-profile`](../profile/) 与 agent 插件一起装（见仓库根 README）。

## 测试、评测与演示

```bash
cd steveX/dsh-plugins/router
npm test                 # 离线：槽位 / 编排 / turn scope / 提示词组装与解析 / 插件适配层（假 ctx.llm）
npm run demo
ROUTER_EVAL_API_KEY=sk-... npm run eval   # 真模型跑 test/router-eval/cases.jsonl（30 条），只在本机手动跑
```

`npm run eval -- --base-url <OpenAI 兼容地址> --model <模型> --only fact` 可换模型、只跑某一类。key 只从环境变量读。

## 提示词

| 文件 | 内容 |
|---|---|
| `prompts/router/slot_defs.md` | 四个槽位的判定问题与 payload |
| `prompts/router/rules.md` | 正交、不对称成本、停止 / 换任务、追问规则 |
| `prompts/router/few_shot.md` | 示例（与评测集不重叠） |
| `prompts/handlers/clarify.md` | 追问的注入正文（`## instruction`）与按槽位的问句 |
| `prompts/handlers/default.md` | 降级（`## degraded`）/ 追问上限（`## clarify-limit`）的说明 |
| `prompts/handlers/unsupported.md` | "暂不支持改快树"的说明 |

`[OUTPUT]` 块由代码按槽位词表生成。文件缺失、为空、仍带 `TODO(内容层)` 或缺必需小节 → 插件加载时报错（拒绝上线）。
`task` / `fact` 的 skill 正文在 agent 插件的 `prompts/skills/`，这里不留副本。
