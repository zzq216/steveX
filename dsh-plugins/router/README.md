# @stevex/dsh-router

槽位式解构路由的**框架**（设计文档：[路由系统设计方案.md](../../docs/路由系统设计方案.md) §17）。

本包遵守两条边界：

- **领域逻辑零 DSH 依赖**：`src/domain/` 不 import 任何 `@deepseek-ai/*`，可直接用 `node --test` 单测。
- **DSH 适配层只有 `src/index.js`**：它把 domain 挂到 `ctx.router`、监听 `agent/pre-step` 与 `agent/turn-stopping`。DSH 升级时只改这一层。

## 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| A（当前） | 槽位契约、编排器、turn scope、桩 provider、五个 handler 桩、提示词占位 | 已实现 |
| agent P1（2026-10-24） | `task` handler 真实化：经 `ctx.stevexBt.planInTurn` 登记规划请求，返回的正文作为 `stevex-router` 来源的消息追加进本 step；只对含人类消息（`source.kind === 'user'`）的 step 填槽，执行器的 `stevex-bt` 请求不经路由 | 已实现 |
| B（后续） | 真实路由提示词、LLM provider | 未实现（`task` handler 已在 P1、`fact` handler 已在 P5 真实化：分别调 steveX agent 插件的 `planInTurn` / `factInTurn`） |

`provider.mode=stub` 现在即可跑通；`mode=llm` 需要一个 `fillSlots` 函数（程序化注入，用于 B 阶段或集成测试），否则插件加载时明确报错。

## 安装（DSH profile）

本包位于 npm 安装的 DSH **之外**（`steveX/dsh-plugins/router/`），DSH 升级不会覆盖它。

1. 将本包打包/链接为本地包（或在 profile 的 workspace 中引用）。
2. 用 `dsh plugin --profile <profile> add <package>` 安装，或将该包的条目插入 profile 的 `cordis.yml`（见 `cordis.patch.yml`）。
3. 配置项（`cordis.yml` 的 `config`）：

```yaml
- id: stevex-router
  name: '@stevex/dsh-router'
  config:
    confidenceThreshold: 0.7
    clarifyMaxTurns: 2
    enabledHandlers: [fact, task, default, unsupported, clarify]
    provider:
      mode: stub            # stub | llm
      # stubSlots: { ... }  # 可选：脚本化槽位（测试/演示）
      # promptsDir: ./prompts  # llm 模式必填（B 阶段）
```

## 测试与演示

```bash
cd steveX/dsh-plugins/router
npm test
npm run demo
```

`npm test` 覆盖：槽位校验、处理器选择/软依赖排序/失败策略、turn scope 的 LIFO/幂等/异常隔离、插件适配层的回合触发与清理。

## 提示词占位

`prompts/` 下所有文件都带 `TODO(内容层)` 标记。`mode=llm` 时加载器会把缺失/空/仍带标记的文件视为**不可上线**并报错（设计文档 §6 / §16）。
