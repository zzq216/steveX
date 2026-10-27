# @stevex/dsh-profile

一个只有 `cordis.patch.yml` 的 DSH bundle：把 [@stevex/dsh-router](../router/) 和 [@stevex/dsh-agent](../agent/) 一起装进一个 profile（集成方案 §2.2）。

- **steveX 预设**（`preset-stevex`，设为默认）：只装人设、`ask_user_question`、`todo_write`、上下文压缩；不装 shell、文件读写、web、subagent、workflow、`skill`、plan-mode。人设换成 steveX。**只对新建会话生效**
- **工具限制**（§5.4）另有两层在 agent 插件里：`planner.exclusiveTools` 让每个会话只看得见 steveX 工具与 `planner.extraTools`；工具守卫拒绝一切不在名单里的调用（兜住漏过可见性限制的工具，比如 `standard` 预设的 `subagent`）
- **路由 provider 仍是 `stub`**（槽位全 none → `default` handler）：路由阶段 B（LLM 填槽与提示词内容）完成前，开新任务用 `/bt task <指令>`；`task` handler 已经真实化，阶段 B 接上后"一句话指令"会自动走它

## 安装

与两个插件包相同：把三个目录链接 / 打包为本地包后，用 `dsh plugin --profile <profile> add @stevex/dsh-profile`，或把本目录 `cordis.patch.yml` 里的两个条目插进 profile 的 `cordis.yml`。
