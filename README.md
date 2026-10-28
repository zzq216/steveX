# steveX

在真实 Minecraft 客户端里行动的 LLM Agent。

- **身体和眼睛**：采集端 Fabric mod（`vendor/stevex-template-1.21.11`）运行在 Minecraft 客户端里，通过 WebSocket JSON-RPC（端口 25550，51 个方法）提供按键、视角、背包、容器、视觉快照等原始能力。不使用 mineflayer。
- **大脑**：[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 加上本仓库的两个插件（`dsh-plugins/`）。大模型不直接操作游戏，而是写**行为树**交给执行器运行；用得好的子树和代码存进**胶囊库**，从 MC 源码确认过的结论存进**事实库**。
- **记忆**：采集端把看到的方块、实体、容器、群系写成 NBT 文件；记忆世界 mod（`vendor/stevex-test-template-1.21.11`）读这些文件，在另一个客户端里复现"agent 记得的世界"。agent 也能直接查询这些文件。

---

## 架构

```
DSH Web 界面（会话里直接说「做一把木镐」，或 /bt task 做一把木镐）
   ↓
DSH + dsh-plugins/profile
   ├─ @stevex/dsh-router   回合路由：用会话的模型判断每条消息的意图（task / fact / 闲聊 …）
   └─ @stevex/dsh-agent    行为树执行器、胶囊库、复盘、事实库、给大模型的工具
          ↓ ws://127.0.0.1:25550   {id, method, params} → {id, ok, data | error}
采集端 mod（真实世界客户端）
          ↓ 写 <gameDir>/stevex/vision/worlds/<worldKey>/*.nbt（current.json 指向当前世界）
记忆世界 mod（另一个客户端，按文件 mtime 复原）

另有：steveX Web 面板（npm start，8090）——透传 mod 方法的调试面板与批量时序 API，不参与 agent 决策
```

**会用到的进程**（各自一个窗口）：

| 进程 | 启动命令 | 必需？ | 作用 |
|---|---|---|---|
| 采集端（真实世界） | `npm run mc:capture` | 必需 | 主菜单加载后开 WS 25550；进入世界后才能采集与行动 |
| DSH（大脑） | `.\start-dsh.bat`（默认 `stevex` profile） | 跑 agent 时必需 | 浏览器里的会话界面；agent 插件直连 25550 |
| 记忆世界 | `npm run mc:memory` | 可选 | 复现采集到的世界；agent 的 NBT 查询读的是采集端文件，不依赖它运行 |
| steveX Web 面板 | `npm start` | 可选 | http://localhost:8090，手动调 mod 方法、跑批量时序 |

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 | 启动脚本是 PowerShell / `.bat` |
| JDK | **21+**（21–25 均可） | 构建、运行两个 mod |
| Node.js | **22.19+** | DSH 与两个插件的 `engines` 要求（steveX 根目录本身 ≥18 即可） |
| 网络 | 首次需要 | Gradle 自动下载 Gradle 9.5.1、Fabric 依赖与 **Minecraft 客户端**；npm 安装 DSH |
| LLM API 密钥 | DeepSeek 等 | 在 DSH 的设置页填写（见下文） |

不需要预装 Minecraft 启动器：`gradlew runClient` 会自己下载并启动客户端（离线账号）。

---

## 首次准备（只做一次）

以下命令都在 `steveX/` 根目录执行。

### 1. 安装依赖

```powershell
npm run bootstrap      # 校验 JDK 21+；node_modules 不存在时执行 npm install（含 DSH）
```

### 2. 首次启动采集端，下载 Minecraft

```powershell
npm run mc:capture
```

第一次要下载 Minecraft 与 Fabric 依赖，耗时较长。看到主菜单后可以先关掉，这一步是为了让 loom 缓存里有 MC jar（下一步要用）。

### 3. 生成配方数据

```powershell
cd dsh-plugins/agent
npm run extract-recipes    # 从 loom 缓存里的 MC jar 提取 → dsh-plugins/agent/data/recipes.json
cd ../..
```

`recipes.json` 是 Mojang 数据，不进 git，每台机器自己生成。缺了它 agent 查不到配方。

### 4. 准备源码基准 `1.21.11_src/`（可选）

事实库的 `mc_source_search` / `mc_source_read` 只读 `steveX/1.21.11_src/`：MC 1.21.11 客户端 + 服务端合一的反编译 `.java` 源码（约 6600 个文件）。它是 Mojang 代码，不进 git，需要自己放进来。

- 缺了它，这两个工具不可用，其余功能不受影响。
- `facts/` 里已有事实的行号引用对应的是项目作者机器上的那一份反编译结果。用别的反编译器或参数生成的版本，行号可能对不上，`/bt facts check` 会报告失效引用。要复用已有事实，请向项目维护者获取同一份基准。

### 5. 建 `stevex` profile 并装插件

steveX 的插件装在一个单独的 DSH profile 里，名字叫 **`stevex`**。DSH 自带的 `web` profile 保持原样，不装插件。

**① 以 Web 模板新建 `stevex` profile**（只在第一次做）：

```powershell
npm run dsh -- --profile stevex --from-default-profile web
```

这条命令会从 Web 模板建出 `stevex` profile 并启动它，看到启动成功后关掉即可。**不要对已经装好插件的 profile 再跑这条命令**：`--from-default-profile` 会把 profile 重置成模板，已装的插件会丢失。

**② 把三个插件装进去**。插件必须以 **`link:`（链接到本仓库目录）** 的方式安装，不能复制。插件配置里的相对路径（胶囊库、配方、记忆目录、事实库）都是相对 `steveX/` 根目录解析的。

```powershell
# 把 <steveX> 换成本仓库的绝对路径，例如 D:/Code/MC_agent/steveX
npm run dsh -- plugin --profile stevex add link:<steveX>/dsh-plugins/router link:<steveX>/dsh-plugins/agent link:<steveX>/dsh-plugins/profile
```

- `dsh plugin` 把参数转发给 profile 目录里的 pnpm，所以路径要写**绝对路径**。也可以启动 `stevex` profile 后，在 DSH Web 的「插件」页里安装。
- 生效的应该是 `@stevex/dsh-profile` 这个组合包：它一次装好路由和 agent，换成 steveX 人设，并去掉 DSH 自带的 shell、文件读写、web 等编程工具。
- 装完用下面的命令确认：输出里 `stevex-agent`、`stevex-router` 各出现**一次**，并且 `agent-preset-registry` 的 `default` 是 `stevex`。如果出现两次，说明 agent 或 router 自己的组合包也被启用了，到「插件」页把它们的组合包开关关掉，只保留 `@stevex/dsh-profile`。

  ```powershell
  npm run dsh -- --profile stevex --dump-config
  ```

插件的配置项、工具与命令见 [dsh-plugins/agent/README.md](dsh-plugins/agent/README.md)、[dsh-plugins/router/README.md](dsh-plugins/router/README.md)、[dsh-plugins/profile/README.md](dsh-plugins/profile/README.md)。DSH 版本与改动边界见 [integrations/dsh/README.md](integrations/dsh/README.md)。

### 6. 填写 LLM API 密钥

启动 DSH（下一节第 2 步）后，在 DSH Web 的**设置 → 模型**里填 API 密钥。密钥存进 DSH 的凭据存储，不写进 profile 配置文件，也不在本仓库里。也可以在启动前设环境变量，例如 `DEEPSEEK_API_KEY`。

> 根目录的 `configs/environments/app.json` 只给可选的 steveX Web 面板用（`npm start`），与 DSH 无关。

---

## 每次启动

### 1. 启动采集端并进入世界

```powershell
npm run mc:capture
```

在打开的 Minecraft 里进入一个单人存档或服务器。主菜单阶段 25550 就已经在监听，但 `player`、`f3`、`vision/*` 这些方法要进了世界才可用。

### 2. 启动 DSH（`stevex` profile）

在 `steveX/` 根目录执行：

```powershell
.\start-dsh.bat             # 双击也可以；不带参数时默认 = dsh --profile stevex
# 等价于
npm run dsh -- stevex
```

- `start-dsh.bat` 不带参数时自动启动 `stevex` profile；带参数时原样转给 dsh，例如 `.\start-dsh.bat web` 启动 DSH 自带、不含 steveX 插件的 `web` profile。
- 直接用 `npm run dsh` 时要自己带上 `stevex`：`npm run dsh -- web` 进的是不带插件的 `web` profile，`/bt` 命令不存在。
- 要在 `steveX/` 根目录启动：DSH 把启动目录当作默认 workspace。`start-dsh.bat` 会自己切到它所在的目录。

按提示在浏览器打开 DSH Web。

### 3. 新建会话并下达任务

steveX 人设只对**新建**的会话生效，旧会话保留它创建时的预设。在新会话里直接说：

```
做一把木镐
```

路由会先用当前会话的模型判断这条消息的意图（要做事 / 教它一条事实 / 普通聊天 / 想改快树），要做事就开任务；拿不准时会先问你一句。想跳过判断、明确下指令就用 `/bt task 做一把木镐`。每次判断记在 `runtime/router/<会话 id>.jsonl`。

agent 先写大纲，再逐个展开，执行器在游戏里执行。任务结束后自动复盘，用得好的子树和代码存进胶囊库。

### 4.（可选）启动记忆世界

```powershell
npm run mc:memory
```

它会自动建一个名为 `MemoryWorld` 的存档并进入，读取采集端当前世界的记忆文件来复原。采集端在快照时才写记忆文件：可以在 steveX Web 面板或 `control_panel.html` 里调一次 `vision/snapshot`，agent 执行任务时也会自己调用。

### 一键启动（采集端 + Web 面板 + 记忆世界）

```powershell
npm run start:all
```

会开三个窗口：采集端、steveX Web 面板（`npm start`）、记忆世界。**不包含 DSH**，跑 agent 还要另外执行 `.\start-dsh.bat`。

---

## 常用 `/bt` 命令（DSH 会话里）

| 命令 | 作用 |
|---|---|
| `/bt task <指令>` | 开一个新任务：规划 → 展开 → 执行 |
| `/bt status` / `/bt nodes` | 当前任务状态 / 节点树 |
| `/bt pause` / `/bt resume` / `/bt abort` | 暂停 / 继续 / 放弃当前任务 |
| `/bt run <file>` | 跑一棵手写树（如 `dsh-plugins/agent/examples/*.json`） |
| `/bt reflect` | 手动对上一个任务发起复盘 |
| `/bt capsules` | 列出胶囊库 |
| `/bt fact <陈述>` | 让 agent 查 MC 源码核实一句话，并写进事实库 |
| `/bt facts [词]` / `/bt facts check` | 查事实库 / 重算引用、列出失效的事实 |
| `/bt fast status \| log \| rollback <版本> \| reflect \| load <file>` | 快树（反射层）的状态、日志、回滚、反思 |

不启动 DSH 也能跑手写树：`cd dsh-plugins/agent && node scripts/bt-run.js examples/recipe_query.json`。

运行产物写在 `runtime/tasks/<taskId>/`（事件日志 `events.jsonl`、树版本 `trees/v<N>.json`），不进 git。

---

## 记忆数据目录（多世界）

采集端按世界分目录保存记忆（v2.55，设计见 [docs/多世界记忆隔离设计方案.md](docs/多世界记忆隔离设计方案.md)）：

```
<采集端 gameDir>/stevex/vision/        # 开发时 = vendor/stevex-template-1.21.11/run/stevex/vision
  current.json                         # 指向当前（或最近）世界：worldKey / dir / inWorld
  worlds/
    sp-<存档文件夹名>-<uuid8>/          # 单人存档（存档内 stevex/world_id.json 记 uuid）
    mp-<host>_<port>/                  # 多人服务器（lan- / realm- 前缀同理）
      world.json                       # 元数据（显示名、首次/最近进入时间）
      terrain.nbt  entities.nbt  entities_union.nbt
      terrain_union/  block_entities/  containers/  biomes/
      memory_cells.bin  memory_sprites.bin
    _legacy/                           # v2.55 之前根目录里的旧数据（不自动使用）
```

- 进入世界时切换到该世界的目录，退出世界时存盘（`current.json` 保留 worldKey、标 `inWorld: false`）；同一存档内换维度不算换世界。
- 记忆世界发现 worldKey 变了，会退出、删档并按新世界的数据重建（记忆世界本身是派生数据，重建不丢信息）。
- agent 的 `core.nbt.query` / `nbt_query` 只读当前世界，结果里带 `world` 字段；插件配置 `visionRoot` 指向 `stevex/vision` 根目录，不用改。
- 删档后用同名新建、或复制存档，会得到新的 worldKey，不继承旧记忆。
- 已知限制：同一服务器地址重置地图、一个地址背后挂多个子服时会共用记忆；LAN 每次开放的端口不同，会被当成不同世界。
- 想继续使用 `_legacy` 里的旧数据：把它改名为对应的 worldKey 目录。

> `vendor/` 内的两个 mod **保持原名且同级**：记忆端靠相对布局自动找到采集端数据（`../..` → `stevex-template-1.21.11/run/stevex/vision`，再经 `current.json` 找到当前世界目录）。改名会断开数据流，此时需在记忆端 `run/config/stevex-test/memory.json` 显式配置 `sourceFile` / `terrainFile` / `entityFile` / `containerFile` / `biomeFile` / `memoryCellsFile`；显式配置的路径固定不变，**不会跟随采集端换世界**。

---

## 项目结构

```
steveX/
  dsh-plugins/         # steveX 自有的 DSH 插件（不修改 DSH 本体）
    agent/             #   行为树执行器、胶囊库、复盘、事实库、给大模型的工具
    router/            #   回合路由
    profile/           #   组合包：一次装好上面两个插件 + steveX 预设
  src/
    capsules/          #   胶囊库（code/ + trees/ + manifest.json，进 git）
    bt/trees/fast/     #   快树版本链（进 git）
    nbt/  json/        #   NBT / JSON 查询 API 的宿主侧（agent 插件调用）
    mod/  web/  agent/ #   steveX Web 面板：mod WS 客户端、Express 8090、51 方法清单
  facts/               # 事实库（进 git）
  vendor/
    stevex-template-1.21.11/       # 采集端 mod（源码 + gradle wrapper）
    stevex-test-template-1.21.11/  # 记忆世界 mod
  scripts/             # bootstrap / run-capture / run-memory / start-all（PowerShell）
  integrations/dsh/    # DSH 版本、边界与历史补丁说明
  configs/             # Web 面板配置：defaults/ 进 git；environments/ 放本机覆盖与密钥，不进 git
  docs/                # 设计文档与实施细则（已实现内容见 docs/已实现内容.md）
  test/                # 根目录测试（NBT / JSON 查询、mod 批处理）
  tools/               # 离线分析脚本（Python）
  control_panel.html   # 直连 mod 25550 的浏览器调试页
  runtime/             # 任务日志（不进 git）
  1.21.11_src/         # MC 反编译源码基准（不进 git，见首次准备第 4 步）
```

---

## 端口

| 端口 | 用途 |
|---|---|
| **25550** | 采集端 mod WebSocket API（写死在 mod 内，可同时接多个客户端） |
| **8090** | steveX Web 面板 / REST API（可选） |
| DSH Web | 由 DSH 决定，启动时打印 |

一台机器一个采集端客户端 = 一个 agent。

---

## 测试

```powershell
npm test                               # 根目录主要测试集
cd dsh-plugins/agent  && npm test      # agent 插件
cd dsh-plugins/router && npm test      # 路由插件
```

整套一起跑偶尔会卡住，可以逐个文件跑：`node --test test/nbt/loader.test.js`。

mod 冒烟测试（采集端已进入世界）：

```powershell
node test_mod_api.js            # 直连 25550
node test_mod_api.js --stevex   # 另测 Web 面板透传层（需先 npm start）
```

两个 mod 的编译检查：在各自目录执行 `.\gradlew.bat compileJava`。

---

## 调试

### control_panel.html

浏览器直接打开，**直连**采集端 25550，不需要 steveX 或 DSH：

- 实时显示玩家坐标与连接状态
- 批量 JSON 调用：每行一条 `{"method":"...","params":{...}}`，支持 `delay:毫秒` 前缀做时序序列（遗留语法）
- 内置 51 方法 API 参考，示例一键复制

### steveX Web 面板（8090）

```powershell
npm start      # http://localhost:8090
```

```bash
curl -s http://localhost:8090/api/mod/status                          # mod 连接状态 + 51 方法
curl -s -X POST http://localhost:8090/api/mod/player -H 'Content-Type: application/json' -d '{}'
curl -s -X POST http://localhost:8090/api/mod -H 'Content-Type: application/json' -d '{"method":"f3","params":{}}'
```

**批量时序 API**（面板 Agents → Mod Batch 用的也是它，设计见 [docs/批量时序API设计方案.md](docs/批量时序API设计方案.md)）：每行一个 step——调用步 `{method, params?, waitMs?}`（`waitMs` = 执行本步前先等，毫秒），纯等待步 `{waitMs}`。

```bash
# 等 3s → 按住前进 2s → 松开（后台执行，立即返回 batchId）
curl -s -X POST http://localhost:8090/api/mod/batch -H 'Content-Type: application/json' -d '{
  "steps": [
    {"waitMs":3000},
    {"method":"key/up","params":{"pressed":true}},
    {"waitMs":2000},
    {"method":"key/up","params":{"pressed":false}}
  ]
}'
curl -s http://localhost:8090/api/mod/batch/<batchId>                  # 轮询进度
curl -s -X POST http://localhost:8090/api/mod/batch/<batchId>/stop     # 中止（自动松开仍按住的键）
```

同时只跑一个 batch（第二个返回 409 + `runningId`）；单步出错默认继续（`stopOnError: true` 可失败即停）。每个 agent 卡另带 **Mod API 查询器**：按分组选方法，显示参数模板，可复制或追加到 Mod Batch（只助写，不执行）。

面板配置：`configs/defaults/app.json`，本机覆盖写在 `configs/environments/app.json`（不进 git）。字段 `agents[]`：`{ name, mod: { host, port }, llm }`。

### 日志与数据

- 任务事件与树版本：`runtime/tasks/<taskId>/`
- 路由判断记录：`runtime/router/<会话 id>.jsonl`（槽位、命中的 handler、耗时；不记原话）
- 记忆文件：`vendor/stevex-template-1.21.11/run/stevex/vision/`
- 两个 mod 的游戏日志：各自 `run/logs/latest.log`

---

## 常见问题

- **`/bt task …` 被当成普通消息发给了模型**：多半是进了不带插件的 `web` profile（例如用了 `npm run dsh -- web` 或 `.\start-dsh.bat web`），或者会话不是新建的。用 `npm run dsh -- --profile stevex --dump-config` 确认插件在，再新建会话。
- **直接说"做一把木镐"没有开任务，只当成聊天**：看 `runtime/router/` 里这条的记录。`degraded` 有值 = 路由调用失败（超时 / 模型出错），模型会提示你改用 `/bt task`；没有这个目录 = 路由可能还在 `stub` 模式（不判断，全按聊天）——看 DSH 设置 → 插件 → `stevex-router` 的配置，`provider.mode` 是 `stub` 就改成 `llm` 或删掉这一项（默认就是 `llm`）。
- **agent 说查不到配方**：没生成 `dsh-plugins/agent/data/recipes.json`（首次准备第 3 步）。
- **`mc_source_*` 不可用**：没有 `1.21.11_src/`（首次准备第 4 步）。
- **NBT 查询报 `SOURCE_MISSING`**：采集端还没在当前世界做过快照，或从没进入过世界。
- **两个 mod 一起启动时报 `mappings.jar` 被占用 / 编译报 `net.minecraft` 不存在**：两个 mod 共用 loom 缓存，等一个客户端完全起来后再启动另一个；缓存损坏时删掉对应 mod 的 `.gradle/loom-cache` 重来。

---

## 文档

- [docs/已实现内容.md](docs/已实现内容.md)：按版本列出已实现的功能
- [docs/Agent系统与DSH集成设计方案.md](docs/Agent系统与DSH集成设计方案.md)：agent 总体设计（P0–P5）
- [docs/视觉api设计方案.md](docs/视觉api设计方案.md)：采集与记忆世界
- [docs/PR11-人工测试指南.md](docs/PR11-人工测试指南.md)：mod 链路的人工验收步骤
