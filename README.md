# steveX

一个**自包含**的 Minecraft LLM Agent 系统：单个文件夹内包含全部代码，可在另一台机器重建整条链路（含 Minecraft 客户端）。

底层感知/动作**不再用 mineflayer**，而是透传采集端 mod（`stevex-template-1.21.11`，跑在 Minecraft 客户端内）的 **WebSocket JSON-RPC API（48 个方法，端口 25550）**——"一个客户端 = 一个 agent 的身体 + 眼睛"。

---

## 架构

```
LLM / Web 面板
   ↓ POST /api/mod/:method（结构化透传 48 方法）
ModWSClient（steveX 侧 WS 客户端）
   ↓ ws://127.0.0.1:25550  {id, method, params} → {id, ok, data | error}
采集端 mod（真实世界客户端，vendor/stevex-template-1.21.11）
   ↓ 写 <gameDir>/stevex/vision/*.nbt + memory_cells.bin
记忆世界 mod（vendor/stevex-test-template-1.21.11，文件驱动、按 mtime 门控）
```

**三个进程**（各自独立窗口）：

| 进程 | 启动 | 作用 |
|---|---|---|
| 采集端（真实世界） | `npm run mc:capture` | 进入真实 MC 世界，客户端内开 WS 25550，采集深度/对象 → 写 `.nbt` |
| steveX（脑） | `npm start` | Web 面板 8090，`ModWSClient` 透传 48 方法给 LLM/面板 |
| 记忆世界 | `npm run mc:memory` | 读取采集端落盘的 `.nbt`，复现"冻结的瞬间" |

> 记忆世界是**文件驱动、独立进程**，不依赖 steveX；steveX 只是编排者。

## 项目结构

```
steveX/
  src/                 # steveX 本体（Node）
    mod/               #   ModWSClient + 48 方法清单（methods.js）
    web/               #   Express 8090 + 透传路由 /api/mod/* + WS 广播 + 前端
    agent/             #   AgentManager / SteveXAgent（每 agent = 一条 mod 连接）
  vendor/              # 自包含：两个 Fabric mod（源码 + gradle wrapper，无构建产物）
    stevex-template-1.21.11/      # 采集端（真实世界）
    stevex-test-template-1.21.11/ # 记忆世界 restorer
  scripts/             # 启动/引导脚本（PowerShell）
  control_panel.html   # 浏览器调试面板（直连 mod WS 25550）
  configs/             # defaults + environments（agents 的 mod: host/port）
```

> `vendor/` 内的两个 mod **保持原名且同级**——记忆端 `MemoryConfig.java` 靠这个相对布局自动探测采集端数据（`../..` → `stevex-template-1.21.11/run/stevex/vision`）。**改名会断开数据流**，此时需在记忆端 `run/config/stevex-test/memory.json` 显式配置 `sourceFile/terrainFile/entityFile/memoryCellsFile`。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| JDK | **21+**（21–25 均可） | mod 构建/运行 |
| Node.js | ≥18 | steveX 本体 |
| 网络 | 首次构建需要 | gradle 自动下载 Gradle 9.5.1、Fabric 依赖与 **Minecraft 客户端 jar** |

无需预装 Minecraft：`gradlew runClient` 会自动完成客户端重建。

## 快速开始

```bash
# 首次：环境引导（校验 JDK 21+，安装 node 依赖）
npm run bootstrap

# 一键启动整条链路（采集端 → steveX → 记忆端，各开独立窗口）
npm run start:all
```

或手动分步（按推荐顺序）：

```bash
npm run mc:capture   # 1) 采集端进入真实世界（首次下载依赖耗时较长）
npm start            # 2) steveX，Web 面板 http://localhost:8090
npm run mc:memory    # 3) 记忆世界
```

## 端口

| 端口 | 用途 |
|---|---|
| **8090** | steveX Web 面板 / REST API |
| **25550** | 采集端 mod WebSocket API（写死在 mod 内） |

单机单客户端 = 1 个 agent（端口约束详见 `steveX_改进方案.md` §八）。

## 调试

浏览器直接打开 `control_panel.html`（**直连**采集端 mod WS 25550，无需 steveX 运行）：

- 实时显示玩家坐标与连接状态
- 批量 JSON 调用：每行一条 `{"method":"...","params":{...}}`，支持 `delay:毫秒` 前缀做时序序列
- 内置 48 方法 API 参考，示例一键复制
- 前提：采集端 mod 已启动并**进入世界**（25550 才有监听）

steveX 透传层（8090）可另用 curl 验证：

```bash
curl -s http://localhost:8090/api/mod/status                          # mod 连接状态 + 48 方法
curl -s -X POST http://localhost:8090/api/mod/player -H 'Content-Type: application/json' -d '{}'
curl -s -X POST http://localhost:8090/api/mod -H 'Content-Type: application/json' -d '{"method":"f3","params":{}}'
```

## 配置

`configs/environments/app.json`：agents 数组，每项 `{ name, mod: { host, port }, llm }`。缺省 `llm.apiKey` 为空——填上后可通过面板下发结构化方法调用（`POST /api/mod/:method`）。


