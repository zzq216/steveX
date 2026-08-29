# Minecraft 1.21.11 按键 API 实现状态

> 基于 `Options.java` 中定义的全部 KeyMapping（共 45 个），对照 `AgentInput.java` 和 `AgentHttpServer.java` 的实现情况。

---

## MOVEMENT（移动）—— 7/7 ✅

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| ✅ | `keyUp` | W | `POST /api/key/up` | 前进 |
| ✅ | `keyDown` | S | `POST /api/key/down` | 后退 |
| ✅ | `keyLeft` | A | `POST /api/key/left` | 左移 |
| ✅ | `keyRight` | D | `POST /api/key/right` | 右移 |
| ✅ | `keyJump` | Space | `POST /api/key/jump` | 跳跃 |
| ✅ | `keyShift` | L-Shift | `POST /api/key/sneak` | 潜行 |
| ✅ | `keySprint` | L-Ctrl | `POST /api/key/sprint` | 疾跑 |

---

## GAMEPLAY（玩法操作）—— 3/3 ✅

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| ✅ | `keyAttack` | 鼠标左键 | `POST /api/key/attack` + `/attack-once` | 攻击/挖掘（持续+单击） |
| ✅ | `keyUse` | 鼠标右键 | `POST /api/key/use` + `/use-once` | 使用/放置（持续+单击） |
| ✅ | `keyPickItem` | 鼠标中键 | `POST /api/key/pick-item` | 选取方块 |

---

## INVENTORY（物品栏）—— 12/12 ✅

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| ✅ | `keyInventory` | E | `POST /api/key/inventory` | 打开/关闭物品栏 |
| ✅ | `keySwapOffhand` | F | `POST /api/key/swap-hands` | 主副手互换 |
| ✅ | `keyDrop` | Q | `POST /api/key/drop` | 丢弃物品 |
| ✅ | `keyHotbarSlots[0]` | 1 | `POST /api/key/hotbar {"slot":0}` | 热键栏第1格 |
| ✅ | `keyHotbarSlots[1]` | 2 | `POST /api/key/hotbar {"slot":1}` | 热键栏第2格 |
| ✅ | `keyHotbarSlots[2]` | 3 | `POST /api/key/hotbar {"slot":2}` | 热键栏第3格 |
| ✅ | `keyHotbarSlots[3]` | 4 | `POST /api/key/hotbar {"slot":3}` | 热键栏第4格 |
| ✅ | `keyHotbarSlots[4]` | 5 | `POST /api/key/hotbar {"slot":4}` | 热键栏第5格 |
| ✅ | `keyHotbarSlots[5]` | 6 | `POST /api/key/hotbar {"slot":5}` | 热键栏第6格 |
| ✅ | `keyHotbarSlots[6]` | 7 | `POST /api/key/hotbar {"slot":6}` | 热键栏第7格 |
| ✅ | `keyHotbarSlots[7]` | 8 | `POST /api/key/hotbar {"slot":7}` | 热键栏第8格 |
| ✅ | `keyHotbarSlots[8]` | 9 | `POST /api/key/hotbar {"slot":8}` | 热键栏第9格 |

---

## MULTIPLAYER（多人游戏）—— 2/4

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| ✅ | `keyChat` | T | `POST /api/key/chat` | 打开聊天框 |
| ✅ | `keyCommand` | `/` | `POST /api/key/command` | 打开命令输入框 |
| ⬜ | `keyPlayerList` | Tab | `GET /api/tablist` | 显示玩家列表（已通过 API 提取数据，非按键模拟） |
| 暂无需求 | `keySocialInteractions` | P | — | 社交交互界面 |

---

## MISC（杂项）—— 2/8

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| ✅ | `keyTogglePerspective` | F5 | `POST /api/key/perspective` | 切换第一/二/三人称视角 |
| ⬜ | `keyDebugOverlay` | F3 | `GET /api/f3` | 调试屏幕（已通过 API 提取数据，非按键模拟） |
| 暂无需求 | `keyScreenshot` | F2 | — | 截图 |
| 暂无需求 | `keySmoothCamera` | 未绑定 | — | 电影视角 |
| 暂无需求 | `keyFullscreen` | F11 | — | 全屏切换 |
| ❌ | `keyAdvancements` | L | — | 进度/成就界面 |
| ✅ | `keyQuickActions` | G | `POST /api/key/quick-actions` | 快速操作（1.21 新增） |
| 暂无需求 | `keyToggleGui` | F1 | — | 隐藏/显示 HUD |
| 暂无需求 | `keyToggleSpectatorShaderEffects` | F4 | — | 旁观者着色器效果开关 |

---

## CREATIVE（创造模式）—— 0/2

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| 暂无需求 | `keySaveHotbarActivator` | C | — | 保存快捷栏配置 |
| 暂无需求 | `keyLoadHotbarActivator` | X | — | 加载快捷栏配置 |

---

## SPECTATOR（旁观者模式）—— 0/2

| 状态 | Options 字段 | 默认键 | HTTP 端点 | 说明 |
|:---:|---|---|---|---|
| 暂无需求 | `keySpectatorOutlines` | 未绑定 | — | 旁观者实体轮廓高亮 |
| 暂无需求 | `keySpectatorHotbar` | 鼠标中键 | — | 旁观者传送菜单 |

---

## DEBUG（调试）—— 0/19

> 注意：大部分调试键都是 F3 + 字母的组合键，通过 `keyDebugModifier`（F3 修饰键）区分。

| 状态 | Options 字段 | 默认键 | 说明 |
|:---:|---|---|---|
| ⬜ | `keyDebugOverlay` | F3 | 调试覆盖层（已通过 `/api/f3` 提取了大部分有用数据） |
| ⬜ | `keyDebugModifier` | F3 | 调试修饰键（与上面共用 F3，通过 duration 区分） |
| 暂无需求 | `keyDebugReloadChunk` | F3+A | 重载所有区块 |
| 暂无需求 | `keyDebugShowHitboxes` | F3+B | 显示实体碰撞箱 |
| 暂无需求 | `keyDebugClearChat` | F3+D | 清除聊天记录 |
| 暂无需求 | `keyDebugCrash` | F3+C | 手动触发崩溃 |
| 暂无需求 | `keyDebugShowChunkBorders` | F3+G | 显示区块边界 |
| 暂无需求 | `keyDebugShowAdvancedTooltips` | F3+H | 显示物品高级提示（NBT/耐久数字） |
| 暂无需求 | `keyDebugCopyRecreateCommand` | F3+I | 复制 `/fill` 等重建命令 |
| 暂无需求 | `keyDebugSpectate` | F3+N | 传送至准星指向的实体 |
| 暂无需求 | `keyDebugSwitchGameMode` | F3+F4 | 快速切换游戏模式 |
| 暂无需求 | `keyDebugDebugOptions` | F3+F6 | 调试选项菜单 |
| 暂无需求 | `keyDebugFocusPause` | F3+P | 失焦时暂停开关 |
| 暂无需求 | `keyDebugDumpDynamicTextures` | F3+S | 导出动态纹理 |
| 暂无需求 | `keyDebugReloadResourcePacks` | F3+T | 重载资源包 |
| 暂无需求 | `keyDebugProfiling` | F3+L | 性能分析 |
| 暂无需求 | `keyDebugCopyLocation` | F3+C | 复制当前位置坐标 |
| 暂无需求 | `keyDebugDumpVersion` | F3+V | 导出版本信息 |
| ⬜ | `keyDebugPofilingChart` | F3+1 | `GET /api/profiler` | 性能分析饼图（已通过 API 提取递归树数据） |
| 暂无需求 | `keyDebugFpsCharts` | F3+2 | FPS 图表 |
| 暂无需求 | `keyDebugNetworkCharts` | F3+3 | 网络图表 |

> 注：`keyDebugOverlay` 和 `keyDebugModifier` 都是 F3 键，区别在于短按 vs 长按。`/api/f3` 已通过直接读取游戏数据的方式实现了调试屏幕中 RL Agent 关心的信息提取（坐标、TPS、光照、实体统计等），无需模拟按键。

---

## 汇总

| 分类 | 总数 | 已实现 | 部分实现 | 未实现 |
|---|---|---|---|---|
| MOVEMENT | 7 | 7 | 0 | 0 |
| GAMEPLAY | 3 | 3 | 0 | 0 |
| INVENTORY | 12 | 12 | 0 | 0 |
| MULTIPLAYER | 4 | 2 | 0 | 2 |
| MISC | 8 | 1 | 1 | 6 |
| CREATIVE | 2 | 0 | 0 | 2 |
| SPECTATOR | 2 | 0 | 0 | 2 |
| DEBUG | 19 | 0 | 1 | 18 |
| **合计** | **~45** | **25** | **2** | **~28** |

### 图例

| 标记 | 含义 |
|:---:|---|
| ✅ | 已完整实现（有 AgentInput 方法 + HTTP 端点） |
| ⬜ | 部分实现（功能已通过 API 数据方式覆盖，非按键模拟） |
| ❌ | 未实现 |
| 暂无需求 | 经评估无需实现（纯视觉/社交/特殊模式功能，不影响 Agent gameplay） |
