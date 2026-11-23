/**
 * 采集端 mod（stevex-template-1.21.11）WebSocket API 方法清单。
 *
 * 共 56 个方法，分组与参数 schema 已按 mod Java 源码逐条核实
 * （见 steveX_改进方案.md 附录 §十一；websocket 分发在 AgentWebSocketServer /
 * api\*Api.java 各 handler 内，方法名注册与参数读取是两套并存的 ad hoc 逻辑）。
 * 上层通过 POST /api/mod/:method 原样透传，mod 侧对未知方法会返回
 * { ok:false, error:'unknown method: …' }。
 *
 * 条目字段：
 *   method    方法名（含斜杠，透传路径用）
 *   category  分组键（稳定）：continuous / one-shot / camera / query / system /
 *             container / chat / sign / book / vision / arena
 *   description  英文短描述（/api/skills 语义，历史兼容）
 *   zh        中文说明（Mod API 查询器展示 + 搜索用）。带参方法自带
 *             "params 填 {…}" 枚举可填键（? 表示可省略）；无参方法无可填。
 *   paramDefs 参数 schema 数组（权威，供查询器填参与 hints、未来 LLM 工具 schema）：
 *             { name, type: 'bool'|'int'|'double'|'string'|'json', required?, def?, hint, sample? }
 *             json = 数组或对象（只有 arena/* 用到）
 *             sample = 查询器预填的示例值（可与 def 不同以示可改）；无参数则 []。
 *
 * 参数读取语义（来自 mod 源码，直接影响填写建议）：
 *   - num()/bool() 读取的键：缺省或类型不符时静默回落默认值（def）。
 *   - (String)/(Number) 强转读取的键：缺省用默认值；类型不符会报错。
 *   - vision/entity.uuid 是唯一硬性必填（缺/空/非 UUID 都报错）。
 *   - 无参方法不读任何键，params 填 {} 或省略均可（mod 侧自动按 {} 处理）。
 */

const METHODS = [
  // ── 持续按键（9）── 按住需显式 pressed:false 松开；序列结束时服务端也会兜底松开
  { method: 'key/up', category: 'continuous', description: 'Hold forward',
    zh: '按住 W 前进；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/down', category: 'continuous', description: 'Hold back',
    zh: '按住 S 后退；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/left', category: 'continuous', description: 'Strafe left',
    zh: '按住 A 向左平移；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/right', category: 'continuous', description: 'Strafe right',
    zh: '按住 D 向右平移；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/jump', category: 'continuous', description: 'Hold jump',
    zh: '按住空格 跳跃；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/sprint', category: 'continuous', description: 'Hold sprint',
    zh: '按住 Ctrl 疾跑；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/sneak', category: 'continuous', description: 'Hold sneak',
    zh: '按住 Shift 潜行；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/attack', category: 'continuous', description: 'Hold attack',
    zh: '按住左键 挖掘/攻击；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },
  { method: 'key/use', category: 'continuous', description: 'Hold use item',
    zh: '按住右键 使用/进食/拉弓；params 填 { pressed }：true=按下持续 / false=松开',
    paramDefs: [{ name: 'pressed', type: 'bool', def: true, hint: 'true=按下并持续 / false=松开', sample: true }] },

  // ── 一次性按键 / 杂项（12）── 无参方法：params 填 {} 即可
  { method: 'key/attack-once', category: 'one-shot', description: 'Attack once',
    zh: '左键单击一次（空挥/攻击目标），无参数', paramDefs: [] },
  { method: 'key/use-once', category: 'one-shot', description: 'Use item once',
    zh: '右键单击一次（放置方块/使用物品），无参数', paramDefs: [] },
  { method: 'key/drop', category: 'one-shot', description: 'Drop held item',
    zh: '丢弃手持物品（Q），无参数', paramDefs: [] },
  { method: 'key/pick-item', category: 'one-shot', description: 'Pick block/item',
    zh: '拾取准星所指方块/物品（中键），无参数', paramDefs: [] },
  { method: 'key/inventory', category: 'one-shot', description: 'Open inventory',
    zh: '打开物品栏（E），无参数', paramDefs: [] },
  { method: 'key/swap-hands', category: 'one-shot', description: 'Swap hands',
    zh: '主副手互换（F），无参数', paramDefs: [] },
  { method: 'key/chat', category: 'one-shot', description: 'Open chat input',
    zh: '打开聊天输入框（T），无参数', paramDefs: [] },
  { method: 'key/command', category: 'one-shot', description: 'Open command input',
    zh: '打开命令输入框（/），无参数', paramDefs: [] },
  { method: 'key/perspective', category: 'one-shot', description: 'Toggle camera perspective',
    zh: '切换视角（F5），无参数', paramDefs: [] },
  { method: 'key/quick-actions', category: 'one-shot', description: 'Toggle quick actions',
    zh: '切换快速动作面板（F3+F），无参数', paramDefs: [] },
  { method: 'key/hotbar', category: 'one-shot', description: 'Select hotbar slot (0-8)',
    zh: '选择热键栏格子；params 填 { slot }：格子下标 0-8（越界静默忽略）',
    paramDefs: [{ name: 'slot', type: 'int', def: 0, hint: '热键栏下标 0-8，越界静默忽略', sample: 3 }] },
  { method: 'tablist', category: 'one-shot', description: 'Online players + scoreboard objective',
    zh: '读取 Tab 在线玩家列表（名字/延迟/队伍）+ 计分板目标，无参数', paramDefs: [] },

  // ── 视角（2）──
  { method: 'camera/turn', category: 'camera', description: 'Turn camera by deltas (yaw, pitch)',
    zh: '按增量旋转视角；params 填 { dx, dy }：dx=左右（偏航）、dy=上下（俯仰），单位度，自动取最短路径',
    paramDefs: [
      { name: 'dx', type: 'double', def: 0, hint: '左右旋转角度（度）', sample: 90 },
      { name: 'dy', type: 'double', def: 0, hint: '上下俯仰角度（度）', sample: -10 }
    ] },
  { method: 'camera/look-at', category: 'camera', description: 'Look at a world coordinate',
    zh: '注视世界坐标；params 填 { x, y, z }：目标坐标（建议三个都填，基于眼睛高度）',
    paramDefs: [
      { name: 'x', type: 'double', def: 0, hint: '目标 X 坐标', sample: 100 },
      { name: 'y', type: 'double', def: 0, hint: '目标 Y 坐标', sample: 70 },
      { name: 'z', type: 'double', def: 0, hint: '目标 Z 坐标', sample: 200 }
    ] },

  // ── 感知 / 查询（5）── 无参方法：params 填 {} 即可
  { method: 'player', category: 'query', description: 'Player state (vitals/flags/effects/attributes)',
    zh: '玩家状态：生命/食物/经验/护甲/空气/状态标志/药水效果/**属性表**，无参数。**attributes** 是以**属性注册名**为键的表（如 minecraft:attack_damage），每项 {base, value, modifiers?}：**base**＝不含任何修饰符的基础值＝"玩家自身"的贡献，**value**＝此刻**实际生效**的最终值（已含装备与药水效果，且已 clamp 到该属性的上下限），**modifiers** 仅非空时给、每项 {id, amount, operation}——与 inventory/container/get 的 slots[].attributeModifiers **同名同义**（那个多一个 slot＝生效装备槽），可直接对照。三者都是**字符串**（两位小数），与 container/get 的进度类字段同一口径。**算例（铁剑）**：主手铁剑时 attributes["minecraft:attack_damage"] = {base:"1.00", value:"6.00", modifiers:[{id:"minecraft:base_attack_damage", amount:"5.00", operation:"add_value"}]}，而物品自己那一半读 slots[].attributeModifiers 的 amount＝"5.00" ⇒ 5.00 + base 1.00 = 6.00（＝界面上的"攻击伤害"）。**易错**：物品**已在主手**时 value 里**已经含**它，别再叠加一次；base + 物品修饰符只用于"这物品还没上手，想知道拿上会是多少"。**modifiers[].id 的来源**：minecraft:base_attack_damage/base_attack_speed＝**主手物品**；minecraft:effect.*＝**药水效果**（力量就是 attack_damage 上的 minecraft:effect.strength，+3/级，故它已体现在 value 里）；随机 UUID 形＝/attribute 或插件。modifier 只有 id/amount/operation、**不带来源对象**，只能解读到 id 这一层。**⚠️ 属性 ≠ 伤害**：Player.attack 里属性值只是**第一行**，之后还有锋利等附魔、攻击冷却、暴击 ×1.5——"这一剑砍多少"要自己叠。属性表是**完整已知集合**：没有的属性直接不出现（不是"未知"）；**非同步属性**（attack_damage/attack_knockback/follow_range/tempt_range）在服务端用 /attribute 改过 base 时客户端收不到更新。注意 **vitals.armor** = floor(attributes["minecraft:armor"].value)、**vitals.armorToughness** 与 attributes["minecraft:armor_toughness"].value 同值（精度差一位：前者 1 位、后者 2 位）。**dead**＝是否已死亡（生命值 ≤ 0，死亡动画期间就为真）；**deathMessage**＝当前界面是死亡界面时的死亡信息文本，否则 null。**flags.onFire**＝身上着火（displayFireAnimation，与 vision 实体摘要的 onFire 同一判据）、**flags.inLava**＝在岩浆里、**flags.inPowderSnow**＝在细雪里、**vitals.frozenTicks**＝冻结计时（≥140 开始冻伤）。**lastDamage**＝最近 2 秒内的受伤 {type（伤害类型注册名，如 minecraft:drown / minecraft:lava / minecraft:on_fire / minecraft:fall / minecraft:mob_attack）, ticksAgo, attacker?（造成伤害的实体类型，如 minecraft:zombie）}，没有则 null。', paramDefs: [] },
  { method: 'player/respawn', category: 'player', description: 'Respawn after death (same as the death screen button)',
    zh: '死亡后重生：与死亡界面"重生"按钮完全相同（LocalPlayer.respawn）。没死 / 极限模式（按钮是"旁观"）时报错。由执行器在检测到死亡后自动调用，不出现在树里', paramDefs: [] },
  { method: 'inventory', category: 'query', description: 'Inventory contents',
    zh: '背包内容：主手/副手/护甲/36 格物品及其组件（附魔/耐久/药水的 potionContents、旗帜的 bannerPatterns、已绘制地图的 map{ id, scale, locked } 等；加了纹饰的盔甲带 trim{ pattern, material }，能当纹饰材料的物品带 trimMaterial，都是注册名），无参数', paramDefs: [] },
  { method: 'f3', category: 'query', description: 'F3 debug screen data',
    zh: 'F3 调试数据：坐标/区块/环境(光照/生态/TPS)/准星目标(方块/实体)，无参数', paramDefs: [] },
  { method: 'sound', category: 'query', description: 'Sound environment',
    zh: '当前正在播放的所有声音快照（id/来源/音量/衰减等），无参数', paramDefs: [] },
  { method: 'profiler', category: 'query', description: 'Performance profiler',
    zh: '性能分析饼图递归树（% / 次数 / 子节点；需先 F3+1 采集），无参数', paramDefs: [] },

  // ── 系统（3）──
  { method: 'status', category: 'system', description: '{ busy:bool, error:string } — true when a non-status method is running',
    zh: '系统状态 {busy, error}：busy=是否正有非 status 方法在执行，error=最近一次错误，无参数', paramDefs: [] },
  { method: 'settings/get', category: 'system', description: 'Read settings',
    zh: '读取设置：renderDistance / simulationDistance / fov，无参数', paramDefs: [] },
  { method: 'settings/set', category: 'system', description: 'Write settings',
    zh: '修改设置并保存；params 填 { renderDistance?, simulationDistance?, fov? }：提供哪些就改哪些，返回改后三值',
    paramDefs: [
      { name: 'renderDistance', type: 'int', def: 12, hint: '渲染距离（出现才改）', sample: 12 },
      { name: 'simulationDistance', type: 'int', def: 12, hint: '模拟距离（出现才改）', sample: 12 },
      { name: 'fov', type: 'int', def: 70, hint: '视野（出现才改）', sample: 80 }
    ] },

  // ── 容器（8）──
  { method: 'container/get', category: 'container', description: 'Get open container contents',
    zh: '读取当前打开的容器：类型/槽位物品/携带物品，及熔炉/附魔台/切石机/织布机/信标/酿造台/箱子等专用字段，无参数。**坐骑**（马、驴、骡、羊驼、骆驼、鹦鹉螺等动物的物品栏）type 为 "mount"，额外给 mount{ entity（动物的注册名）, uuid, saddle{slot:0, active}, body{slot:1, active}, chest{from:2, count} }——active＝这一格对这只动物能不能用（羊驼没有鞍槽、驴骡没有身体槽……），count＝动物箱子的格数（0＝没有箱子，箱子格从 2 号起）。**附魔台**额外给 costs/enchantClue/enchantName/levelClue/goldCount/bookshelves，三个选项按同一套下标对齐（enchantName 是附魔注册名如 "minecraft:sharpness"，选项不可用时为 null；enchantClue 是原始注册表数字 id，仅供排查）；bookshelves=有效书架数，是**世界状态**——靠准星所指方块定位附魔台，界面开着时用 camera/turn 转视角会让它失效，该键**缺席＝未知**（不是 0），且给的是原始计数（vanilla 算附魔等级时会 clamp 到 15）。**切石机**额外给 selectedRecipe/visibleRecipes/recipes——recipes 是方案列表的具体内容（每项是该方案在 GUI 上显示的图标物品，**下标与 container/button 的 button 号一一对应**，条目数应恒等于 visibleRecipes；输入物不是合法切割材料时为空数组）。**织布机**额外给 selectedPattern/patterns——patterns 是全部织布方案（**下标与 container/button 的 button 号一一对应**，1.21.11 图案槽为空时有 32 项）；每项是一面"选它就会得到"的旗（旗帜槽的旗＋该图案＋染料槽的颜色，与产物格算式一致），图案本身读该项的 bannerPatterns 字段（[{pattern:"minecraft:border",color:"red"}]），**不是**界面上那面灰底预览旗；旗帜或染料缺一时为空数组。**注意织布机的按钮号是全局下标**——界面 4×4 一次只显示 16 个、要滚动才看得全，但 patterns[] 给的是全量，点按钮**不需要先滚动**。织布机菜单的格子编号与切石机不同：4–30 = 背包 9–35、31–39 = 快捷栏 0–8（换算 s≤8 ? 31+s : s-5），且 0=旗帜 1=染料 2=图案 3=产物。**信标**额外给 levels/effects/primaryEffect/secondaryEffect——effects 是**全部可选效果**（不是"当前等级能选的"，而是界面上存在的那 6 个），每项 {effect,tier,canBePrimary,canBeSecondary,canUpgrade}：effect 是效果注册名，tier 0–3 对应 speed,haste / resistance,jump_boost / strength / regeneration；canBePrimary 复刻主效果列的可点状态（**界面主效果列只放 tier 0–2**，可点 ⟺ tier < levels；regeneration 永远不能当主效果），canBeSecondary 表示界面能否把它设成副效果（levels ≥ 4 时 6 个效果都是 true：regeneration 在副效果列里直接点；tier 0–2 没有自己的副效果按钮，要经副效果列里的"主效果 II 级"按钮设上——点过之后再换主效果，副效果不跟着变），canUpgrade 复刻那个"主效果 II 级"按钮：这个效果当主效果时，能否再把副效果设成它自己、升到 II 级（tier 0–2 且 levels ≥ 4）。信标实际给的效果：主效果为空时什么都不给；levels ≥ 4 且主副相同时给主效果 II 级；levels ≥ 4 且主副不同时各给 I 级；levels < 4 时副效果不生效。primaryEffect/secondaryEffect 是**当前选中**，没选时是 **null**（不是缺席：vanilla 用 0 编码"没选效果"，那是"已知为空"）。**注意这些只是界面门禁、服务端不过滤**——container/beacon 能设出界面上设不出的组合，判断"界面允不允许"只能看这几个布尔。effects 是静态常量（每个信标、每个存档都一样），**不依赖 mc.level、不需要服务端回读**（与切石机的 recipes、织布机的 patterns 不同）。**酿造台**额外给 fuel/maxFuel/brewingTicks——**fuel 是"剩余可酿造次数"（0–20，maxFuel=20 是它的分母），不是燃料槽里烈焰粉的个数**；两者是两件事：fuel 归零时才会从燃料槽消耗 1 个烈焰粉并补满 20，烈焰粉本身的数量读 slots[] 里的 slot 4。brewingTicks 是**剩余**酿造 tick 数，从 **400**（＝20 秒）递减到 0，0=当前没在酿（400 在 vanilla 是字面量、无公开常量，故不作字段发出）。酿造台菜单格：0/1/2=三个药水格、3=原料格、4=燃料格、5–31=背包 9–35、32–40=快捷栏 0–8。**药水格（以及任何位置的药水）要读 id 之外的"这是哪瓶药"，看该物品的 potionContents 字段**：potion 是药水注册名（如 minecraft:strength），effects 是这瓶药**实际会给**的效果 [{effect,level,duration,visible}]——level 与 `player` 的 effects[].level 同为 1 起（"力量 II"＝level 2），duration 单位是 tick 且**已按 durationScale 折算**（滞留药水的该组件是 0.25，故会多一个 durationScale:0.25；不折算会把时长夸大 4 倍——酿造台的药水格是接受滞留药水的）。没有该组件的物品（玻璃瓶、绝大多数物品）不带此键。另：bannerPatterns 字段对任何位置的旗帜都生效（inventory 也读得到）；**potionContents 同理，对任何位置的药水生效**（背包里的药水也读得到）。**已绘制地图**（任何位置）带 map{ id（地图编号）, scale（缩放等级 0–4）, locked }，scale / locked 来自客户端已同步的地图数据，刚做出来还没同步到时只有 id；**制图台**结果格里的预览带 mapPostProcessing（"scale" / "lock"＝取出后才放大 / 锁定，预览上的 map 仍是原图的）。制图台菜单格：0＝地图 1＝辅料（纸 / 空地图 / 玻璃板）2＝产物、3–29＝背包 9–35、30–38＝快捷栏 0–8。**合成器**额外给 disabledSlots/powered/result——disabledSlots 是**被禁用**的合成格下标数组（合成格＝菜单下标 0–8，行优先即界面上第 1–9 格；禁用位来自菜单数据槽 0–8，开界面时服务端**全量**下发，故客户端持有权威副本、空数组是断言"当前没有禁用格"而非未知）；**禁用/解禁某格用 container/slot 对该格做一次 PICKUP 点击**（细节见 container/slot）。powered＝合成器是否被红石触发（界面右上那枚红石图标读的就是它）——合成器**只在被触发时才真的合成并吐料**。result＝合成预期产物（**配方不匹配时为 null＝"已知为无"**，不是缺席）；产物格不可交互（拿不走也放不进），它只是预览。合成器菜单格：0–8＝合成格、9–35＝背包 9–35、**36–44＝快捷栏 0–8**，产物格在 36 格玩家槽**之后**（当前下标 45，按类型定位、不写死）。**村民交易**额外给 traderLevel/traderXp/trades[]——trades 每项 { inputA, inputB, result, priceA, uses, maxUses, xp }，下标与 container/select-trade 的 index 一致：inputA 是 A 物品的**基础价**（原版 getBaseCostA）；**priceA 是实际要付的 A 物品个数**（基础价按需求、口碑、村庄英雄效果调整后的值，截到 1 和堆叠上限之间；界面上原价被划掉时显示的就是它）；inputB 是第二种付款物（没有为 null，不受价格调整影响）；uses / maxUses 是已交易次数和上限（uses ≥ maxUses 时这笔暂时换不了）。交易界面菜单格：0、1＝支付格，2＝结算格，3–29＝背包 9–35，30–38＝快捷栏 0–8。注意 slots[] 只列非空格', paramDefs: [] },
  { method: 'container/slot', category: 'container', description: 'Interact with a container slot',
    zh: '点击容器格；params 填 { slot, button?, clickType? }：slot=格下标（先 container/get 看布局），button=0左键/1右键，clickType 与 vanilla ClickType 一一对应、全部可用：0=PICKUP 拾取/放下（左右键）、1=QUICK_MOVE 快捷移动（Shift 点击）、2=SWAP 与快捷栏交换（button=快捷栏 0–8，40=副手）、3=CLONE 克隆（创造模式）、4=THROW 丢出（button 0=1 个 / 1=整叠）、5=QUICK_CRAFT 拖拽的单个相位（用 container/drag 发）、6=PICKUP_ALL 双击收拢（光标有物品时对格子发，button=0）；每种点击在服务端的效果见 vanilla AbstractContainerMenu.clicked。**合成器专属**：对合成格（下标 0–8）里的**空格**做一次 PICKUP 点击＝切换该格的"禁用"开关（被禁用的格子收不了料；当前禁用位读 container/get 的 disabledSlots）。vanilla 在这里**不看左右键**（左键右键都切），真正的门禁是**光标必须为空**——所以**禁用必须排在拿起任何物品之前**，一旦光标上拿着物品，右键就退化成"放 1 个"。服务端对**非空格**的禁用请求静默忽略（不报错）',
    paramDefs: [
      { name: 'slot', type: 'int', def: 0, hint: '容器格下标（先 container/get 查看布局）', sample: 1 },
      { name: 'button', type: 'int', def: 0, hint: '0=左键 / 1=右键', sample: 0 },
      { name: 'clickType', type: 'int', def: 0, hint: '0=PICKUP 1=QUICK_MOVE 2=SWAP 3=CLONE 4=THROW 5=QUICK_CRAFT 6=PICKUP_ALL', sample: 0 }
    ] },
  { method: 'container/button', category: 'container', description: 'Click a container button',
    zh: '点击容器界面按钮（如附魔台的第 N 个附魔选项、切石机/织布机的第 N 个方案，N 从 0 起）；params 填 { button }：按钮序号。返回 {status, accepted}——accepted 只表示本地预检通过且已发包，**不是执行结果**（服务端无论成功失败都不回包），是否真的生效须用 container/get 观察（附魔台看附魔位物品是否长出 enchantments、青金石是否被扣；切石机/织布机看 selectedRecipe/selectedPattern 是否变成该下标，注意它只能证明"选中了几号"，不能证明"几号是什么"——后者要读 recipes[]/patterns[]）。**织布机**的按钮号是**全局下标**（与 patterns[] 下标同一套）：界面 4×4 一次只显示 16 个、要滚动才看得全 32 个，但**点按钮不需要先滚动**；原因为 vanilla 已把滚动偏移 startRow 折进 index（LoomScreen:193-194）。越界（button ≥ 方案数）时预检不过，accepted:false 且不发包',
    paramDefs: [{ name: 'button', type: 'int', def: 0, hint: '界面按钮序号（从 0 起）', sample: 0 }] },
  { method: 'container/close', category: 'container', description: 'Close container screen',
    zh: '关闭打开的容器界面，无参数', paramDefs: [] },
  { method: 'container/text', category: 'container', description: 'Type into a container text field',
    zh: '向当前聚焦的输入框写入文字（任意界面，含告示牌/书的输入框）；params 填 { text }：要填入的内容',
    paramDefs: [{ name: 'text', type: 'string', def: '', hint: '要填入的文字', sample: 'hello' }] },
  { method: 'container/drag', category: 'container', description: 'Send one QuickCraft drag phase',
    zh: '发送一次拖拽的单个相位包（QuickCraft，纯原语不取物）。params 填 { phase, slot?, type? }：phase 0=begin 1=add 2=finish，add 必带 slot=container/get 的真实格 index（begin/finish 省略 slot），type 0=均分(默认) 1=每格放1 2=创造克隆。整段手势=先 container/slot clickType:0 拾取源格→phase 0→对每格 phase:1→phase:2，每条隔≥1 tick(waitMs≥50)，期间不得夹其它点击；返回 {status}',
    paramDefs: [
      { name: 'phase', type: 'int', def: 0, hint: '0=begin 1=add 2=finish', sample: 0 },
      { name: 'slot', type: 'int', def: -999, hint: '目标格真实 index（container/get 的 slot）；仅 add 需要', sample: 9 },
      { name: 'type', type: 'int', def: 0, hint: '0=均分(默认) 1=每格放1 2=创造克隆', sample: 0 }
    ] },
  { method: 'container/beacon', category: 'container', description: 'Set beacon effect & consume payment',
    zh: '设置/切换信标效果并扣支付物（等价信标 GUI 的点效果图标+点√，直接发 SetBeacon 包）。params 填 { primary?, secondary? }：效果注册 id 如 "minecraft:haste"，缺省/空串=**把该槽清空为"无效果"**（不是"保持原样"）。前置：信标界面已开，支付物已用 container/slot 放入支付槽（menu slot 0），服务端无支付物时为空操作。**有哪些效果可选、哪些在当前等级下界面上能点，读 container/get 的 effects[]**（每项带 tier 与 canBePrimary/canBeSecondary/canUpgrade）。**注意服务端不过滤界面的限制**——1 级信标设 regeneration、把 regeneration 设成主效果都会被接受并生效，这个包只管"界面允不允许"之外的事。与界面上的确认按钮不同，这个包**不会关掉信标界面**',
    paramDefs: [
      { name: 'primary', type: 'string', def: '', hint: '主效果注册 id，如 minecraft:strength（缺省/空=把该槽清空）', sample: 'minecraft:strength' },
      { name: 'secondary', type: 'string', def: '', hint: '副效果注册 id（界面副效果列只给 regeneration，但服务端不过滤；缺省/空=把该槽清空）', sample: 'minecraft:regeneration' }
    ] },
  { method: 'container/select-trade', category: 'container', description: 'Select a villager trade (fills payment slot)',
    zh: '选中村民交易列表第 index 笔（等价点交易界面第 index 行，直接发 SelectTrade 包）。只选中、不消耗物品；服务端会顺手把付款物从背包搬进支付格（填到满叠），随后用 container/slot { slot:2 } 点结算格完成交易（可连点，结算格自动补货）。params 填 { index }：交易下标，与 container/get 的 trades[] 同一套编号（0 起，越界报错并返回 size）。前置：交易界面已开；村民失效时服务端只写日志，表现为包发了但支付格没变',
    paramDefs: [
      { name: 'index', type: 'int', def: -1, hint: '交易下标（container/get 的 trades[] 序号，0 起）', sample: 1 }
    ] },

  // ── 聊天（3）──
  { method: 'chat/text', category: 'chat', description: 'Type into the open chat box (no send)',
    zh: '把文字填入已打开的聊天输入框，不发送（需先 key/chat）；params 填 { text }：要填入的内容',
    paramDefs: [{ name: 'text', type: 'string', def: '', hint: '填入聊天框的文字（不发送）', sample: 'hello' }] },
  { method: 'chat/send', category: 'chat', description: 'Send a chat message / run a command',
    zh: '发送聊天消息，/ 开头作为命令执行；params 填 { text }：内容，聊天框已开则填入发送，未开则直发（空文本且未开框会报错）',
    paramDefs: [{ name: 'text', type: 'string', def: '', hint: '聊天内容；未开聊天框时必填（空会报错），/ 开头=命令', sample: 'hello' }] },
  { method: 'chat/close', category: 'chat', description: 'Close chat screen',
    zh: '关闭聊天输入框（Esc），无参数', paramDefs: [] },

  // ── 告示牌（3）──
  { method: 'sign/get', category: 'sign', description: 'Read sign text',
    zh: '读取告示牌编辑器：4 行文字与当前编辑行（需先编辑告示牌），无参数', paramDefs: [] },
  { method: 'sign/set', category: 'sign', description: 'Write sign text',
    zh: '设置告示牌某行文字；params 填 { line?, text }：line=行号 0-3（省略=当前编辑行），text=新文字',
    paramDefs: [
      { name: 'line', type: 'int', def: -1, hint: '行号 0-3；省略=当前编辑行', sample: 0 },
      { name: 'text', type: 'string', def: '', hint: '要写入该行的文字', sample: 'hello' }
    ] },
  { method: 'sign/close', category: 'sign', description: 'Close sign editor',
    zh: '保存并关闭告示牌编辑，无参数', paramDefs: [] },

  // ── 书与笔（4）──
  { method: 'book/get', category: 'book', description: 'Read book content',
    zh: '读取书的全部页与当前页（需先编辑书），无参数', paramDefs: [] },
  { method: 'book/set', category: 'book', description: 'Write book content',
    zh: '覆写某页文字；params 填 { page?, text }：page=页号（省略=当前页，==总页数=追加一页，上限 100），text=新文字。文字按书的编辑框同样的规则查：不能有编辑框打不出来的字符（§、控制字符、DEL；换行可以），最多 1024 个字符，按书页宽 114 像素折行最多 14 行；不符合就报错，页不变、不截断',
    paramDefs: [
      { name: 'page', type: 'int', def: -1, hint: '页号；省略=当前页；==总页数=追加一页', sample: 0 },
      { name: 'text', type: 'string', def: '', hint: '该页的新文字（不能有 §、控制字符、DEL；最多 1024 个字符、14 行）', sample: 'hello' }
    ] },
  { method: 'book/page', category: 'book', description: 'Turn book page',
    zh: '翻到指定页；params 填 { page }：页号（0 起，越界报错）',
    paramDefs: [{ name: 'page', type: 'int', def: 0, hint: '要翻到的页号（0 起）', sample: 1 }] },
  { method: 'book/close', category: 'book', description: 'Close book screen',
    zh: '保存并关闭书（把全部页发给服务端，等客户端做完才返回）；当前不是书的编辑界面时报错 book editor not open，无参数', paramDefs: [] },

  // ── 视觉（2，对应视觉系统方案 §6.2）──
  { method: 'vision/snapshot', category: 'vision', description: 'Depth capture + visible blocks/entities + store stats',
    zh: '深度采集 + 可见方块/方块实体/实体快照并落盘 NBT（首次最久约 15s），无参数；掉落物实体带 item{id,count,enchanted?}（enchanted 仅真附魔时出现）；活体实体（生物/玩家）另带 equipment{槽:{id,count?,enchanted?}}（槽 mainhand/offhand/feet/legs/chest/head/body/saddle）、name（仅名字牌可见时）、effects（效果种类 id，不含持续/等级；过滤不可见粒子的效果；数据源为单机集成服务器——连真实服务器时该键恒缺席，此时"缺席"是**未知**而非"没有效果"，须看顶层 effectsSource）、baby（仅幼年）、maxHealth、pose、onFire（仅着火）',
    paramDefs: [] },
  { method: 'vision/entity', category: 'vision', description: 'Stored entity entry by uuid (from last capture frame)',
    zh: '按 uuid 查询本会话最近一次采集帧中的实体薄投影（非实时直读；首次采集前、切维后尚未重新采集、不在该帧可见范围时均报错）；params 填 { uuid(必填) }：uuid=实体 UUID（来自 vision/snapshot）。只返回物理态及可见摘要：掉落物 item{id,count,enchanted?}、展示实体 content、活体 living；不会返回复原侧完整物品组件、payload 或隐藏效果。响应带 effectsSource，unavailable 时效果缺席表示未知',
    paramDefs: [
      { name: 'uuid', type: 'string', required: true, hint: '实体 UUID（来自 f3 准星目标或 vision/snapshot）', sample: '00000000-0000-0000-0000-000000000000' }
    ] },

  // ── 训练场（7，docs/训练场设计方案.md）：只供 DSH 训练器调用，不登记给 agent（raw_commands.js 跳过）；需要单人世界 ──
  { method: 'arena/build', category: 'arena', description: 'Build a training arena (idempotent)',
    zh: '幂等搭建训练场（场内地板 + 屏障墙、可选的工作站、场外平台 + 告示牌）并登记位置；params 填 { arena, origin?, station? }：arena=场地名，origin=[x,y,z] 场内地板中心（已登记的场地可省略），station=工作站（"crafting_table" / "chest" / "large_chest" / "hopper" / "dispenser" / "stonecutter" / "furnace" / "blast_furnace" / "smoker" / "enchanting_table" / "beacon" / "anvil" / "smithing_table" / "mount" 或 null；省略时用已登记的。mount 是坐骑场地：工作站是一只动物，方块位置上是空气，鹦鹉螺组（上一次 prepare 设的）下面那格地板是水坑。附魔台在同层外圈摆书架（缺省 15 个）；铁砧朝东，开裂、损坏的铁砧会换回完好的。大箱子多占 origin 前方 +z 两格再往 +x 一格；漏斗正下方的地板换成红石块把它锁住，不推送、不吸掉落物）',
    paramDefs: [
      { name: 'arena', type: 'string', required: true, hint: '场地名（[a-z0-9_]）', sample: 'craft2x2' },
      { name: 'origin', type: 'json', hint: '[x, y, z]，场内地板中心方块', sample: [10000, 120, 10000] },
      { name: 'station', type: 'string', hint: '工作站：crafting_table / chest / large_chest / hopper / dispenser / stonecutter（放在 origin 前方 +z 两格，箱子、发射器、切石机朝向玩家）；省略 = 已登记的', sample: 'crafting_table' }
    ] },
  { method: 'arena/prepare', category: 'arena', description: 'Reset the player and start a training run',
    zh: '开始一轮：关界面、清空物品栏与光标、补回工作站、传送进场（有工作站时俯角对准它）、清场内掉落物与敌对生物、回满状态、白天晴天、重置配方书、发放材料（超过堆叠上限的堆按 seed 拆到空槽），并开始监测 watch 中物品的 crafted 统计；容器工作站（箱子、大箱子、漏斗、发射器）另外先清空容器再放进 chestItems（不拆堆，超过堆叠上限报错），给了 expect 就在每个 tick 检测是否恰好达到目标计数；切石机工作站的 expect 是"只看目标"的写法（见 expect 参数）；炉子工作站（熔炉、高炉、烟熏炉）先清空并拆掉上一轮的炉子再放新的（按原版速度工作），expect 是"炉子"写法；信标工作站拆掉旧信标再放新的（效果清空），按 beaconLevel 铺埋在地板下的铁块底座、拆掉多余的层，expect 是"信标"写法；附魔台工作站按 bookshelves 摆书架，给了 xpLevel / enchantSeed 就把玩家的经验等级（进度清零）、附魔种子设成它，expect 是"附魔"写法；铁砧工作站每轮都是完好的新铁砧，给了 xpLevel 就设经验等级，items 的每一项可以带 enchantments（附魔书写进存储的附魔），expect 是"铁砧"写法；锻造台工作站的 expect 是"锻造"写法；坐骑工作站先让玩家下坐骑、清掉场内的马类 / 骆驼 / 羊驼 / 鹦鹉螺，再按 mount 生成本轮的动物（成年、已驯服且主人是玩家、NoAI、无敌、不会消失；驴骡羊驼挂箱子），俯角对准动物、准星按实体射线检测，expect 是"坐骑"写法；已有进行中的一轮时报错；params 填 { arena, origin?, station?, items, chestItems?, seed?, watch?, expect?, dayTime?, bookshelves?, xpLevel?, enchantSeed?, beaconLevel?, selectedSlot? }（items 与 chestItems 不能都为空）。返回 { arena, startedAtMs, baseline, given[{slot,id,count}]＝实际发放, inventory }，有工作站时另有 { station, pitch, aimOk }（aimOk＝服务器射线检测准星命中工作站），容器工作站另有 { chestSlots（容器格数：27/54/5/9，大箱子没连上时是 27）, chest{id:n} }，给了 expect.cook 时另有 cook{ burnTicks（这台炉子里燃料的燃烧时长，高炉、烟熏炉减半）, cookTicks, product, productCount, rawMaxStack, fuelMaxStack }（服务器端的真实数值；这台炉子烧不了原料或燃料不是燃料时报错）；附魔台工作站另有 enchant{ bookshelves（实际数到的有效书架数）, xpLevel, enchantSeed, offers?[{slot, cost, clue:{enchantment, level}|null}]（给了 expect.enchant 时，用真实的附魔台菜单算出的三档） }；信标工作站另有 beacon{ baseLevel（本轮底座层数）, state{ levels, primary, secondary } }（新放的信标 levels 是 0，要过几秒才数底座，见 arena/status）；铁砧工作站另有 anvil{ state（anvil / chipped_anvil / damaged_anvil / missing）, xpLevel, items[{slot, id, count, enchantments{id:level}, name}]（发放后玩家身上的每一件） }；锻造台工作站另有 smithing{ items[{slot, id, count, enchantments, name, trim?, trimMaterial?}]（发放后玩家身上的每一件） }；坐骑工作站另有 mount{ id, uuid, saddle, body, chest{id:n}, chestSize, strength?（羊驼）, items[...]（发放后玩家身上的每一件） }；items 里带 map 的那项（制图台工作站）另有 map{ id, scale, center[x, z] }（mod 现做的开局地图）；酿造台工作站（brewing_stand）每轮先清空再换一台新的（燃料值、酿造进度清掉），给了 expect.brew 就用服务器的酿造配方核对 potion + ingredient 能酿、产物在 products 里（不对就报错 brewing data out of date），另返回 brew{ product }（服务器算出的产物签名）；合成器工作站（crafter）每轮先清空再换一台新的（格子里的东西、禁用状态清掉），给了 expect.crafter 就把 layout 摆进 3×3 用服务器配方算产物、核对是 target（不对就报错 crafting data out of date or conflicting recipe），另返回 crafter{ product }；村民工作站（villager）清掉场内的村民，按 villager 生成本轮的村民（成年、NoAI、无敌、不会消失；交易项按原版每级抽 2 笔的算法从 1 级逐级生成到 level 级，随机数由 offerSeed 决定，藏宝图不出），俯角对准村民、准星按实体射线检测，expect 是"交易"写法（uses 的个数要等于村民的交易项数），另返回 villager{ uuid, profession, type, level, offers[...] }（同 arena/trade-preview 的 offers，插件拿来和预览逐笔比对）；砂轮工作站（grindstone）落地朝东，没有方块实体，不用清空，items 的每一项可以带 enchantments，给了 expect.grindstone 就把每件物品单独放进临时砂轮菜单、核对产物和 goals 对应项的签名一致（不对就报错 grindstone data out of date），另返回 grindstone{ items[{slot, id, count, enchantments, name, damage?}]（发放后玩家身上的每一件） }；items 的每一项可以带 pages（字符串列表），发带这些页的书与笔（id 必须是 minecraft:writable_book、count 为 1，最多 100 页、每页最多 1024 个字符）；给了 selectedSlot 就把当前选中的快捷栏格设成它并同步给客户端；给了 expect.book 另返回 book{ items[{slot, id, count, pages?, title?}]（发放后玩家身上的每一件）, selectedSlot }',
    paramDefs: [
      { name: 'arena', type: 'string', required: true, hint: '场地名', sample: 'craft2x2' },
      { name: 'origin', type: 'json', hint: '[x, y, z]（已登记的场地可省略）', sample: [10000, 120, 10000] },
      { name: 'station', type: 'string', hint: '工作站：crafting_table / chest / large_chest / hopper / dispenser / stonecutter / furnace / blast_furnace / smoker / enchanting_table / beacon / anvil / smithing_table / mount / loom / cartography / brewing_stand / crafter / villager；省略 = 已登记的', sample: 'crafting_table' },
      { name: 'items', type: 'json', required: true, hint: '[{ slot: 0-35, id, count, enchantments?: {附魔id: 级数}, map?: { scale } }]，可以为空列表；enchantments 的级数要在 1 到最高级之间，普通物品上的附魔要能附到它上面；map 只用于制图台工作站：id 为 minecraft:filled_map、count 1–64，mod 在离场地很远处现做一张这个缩放等级（0–4）的空白地图，复制成 count 张同编号的一叠，一轮最多一项；potion 只用于药水（minecraft:potion / splash_potion / lingering_potion），值是药水注册名（如 minecraft:awkward），发出带这种药水内容的药水', sample: [{ slot: 4, id: 'minecraft:oak_planks', count: 2 }] },
      { name: 'chestItems', type: 'json', hint: '容器工作站：[{ slot: 0 到格数−1（小箱子 27、大箱子 54（合并容器的格号，与界面一致）、漏斗 5、发射器 9）, id, count ≤ 堆叠上限 }]', sample: [{ slot: 3, id: 'minecraft:cobblestone', count: 20 }] },
      { name: 'seed', type: 'int', def: 0, hint: '兜底拆堆选空槽用的种子', sample: 81723 },
      { name: 'watch', type: 'json', hint: '要监测 crafted 统计的物品 id 列表；省略 = 不监测', sample: ['minecraft:stick'] },
      { name: 'villager', type: 'json', hint: '村民工作站本轮的村民：{ profession（职业注册名，不能是 none / nitwit）, type（村民类型：plains / desert / jungle / savanna / snow / swamp / taiga）, level（1–5）, offerSeed（交易项种子） }', sample: { profession: 'minecraft:librarian', type: 'minecraft:plains', level: 3, offerSeed: 42 } },
      { name: 'mount', type: 'json', hint: '坐骑工作站本轮的动物：{ animal（注册名，10 种之一）, saddle?, body?（一开始装着的物品 id）, chest?: [{ slot（箱子格号，从 0 起）, id, count }], strength?（羊驼的力量 1–5） }', sample: { animal: 'minecraft:donkey', saddle: 'minecraft:saddle' } },
      { name: 'expect', type: 'json', hint: '本轮的目标计数，到达的第一个 tick 记为 reachedAtMs。容器工作站：{ inventory: {id:n}, container: {id:n} }，物品栏（不含光标）与容器恰好如此、光标为空；切石机：{ targets: {id:n}, allowed: [id] }（allowed 要含全部目标），每个目标在物品栏里恰好 n 个、光标和切石机输入格里没有，光标为空，物品栏 / 光标 / 输入格里没有 allowed 以外的物品，材料剩多少不比较；附魔台：{ enchant: { item, result, enchantment, level } }（result 是附魔后的物品 id，书是 minecraft:enchanted_book），容器界面已关闭，物品栏里恰好一件 result 且带有 enchantment、等级 level，除了它和青金石没有别的东西；炉子：{ cook: { raw, rawLeft, fuel, fuelLeft, product } }（三种物品互不相同），容器界面已关闭，光标为空，物品栏里 raw 恰好 rawLeft 个、fuel 恰好 fuelLeft 个且没有这三种以外的物品，原料格空或只有 raw，燃料格空或只有 fuel（产物格、炉子还在不在烧都不看，物品栏里可以有 product）；信标：{ beacon: { payment, effects: [{ effect, amplifier: 1|2 }] } }，容器界面已关闭，光标为空，场内地上没有物品，物品栏里除了 payment 没有别的东西，信标的主副效果是界面能设出来的组合，且实际给的效果（按原版 applyEffects 算）里有 effects 的每一项；铁砧：{ anvil: { item, enchantments: {id:level}, name: string|null } }，光标为空，玩家身上（主物品栏、快捷栏、盔甲、副手）有一件物品类型是 item、附魔恰好是 enchantments（附魔书读存储的附魔）、自定义名字逐字是 name（null = 没有自定义名字），不要求关界面；锻造台：{ smithing: [{ item, trim: { pattern, material } | null }] }（可以有多个目标），玩家身上（不含光标）能给每个目标配上各不相同的一件物品：类型是 item、纹饰恰好是 trim（null = 没有纹饰），光标上有没有东西不影响，不要求关界面；坐骑：{ mount: { saddle?: id|null, body?: id|null, chest: {id:n}, inventory: {id:n} } }，本轮的动物还在，写了 saddle / body 的槽里恰好是它（null = 空着），动物箱子按 id 合计恰好是 chest，玩家身上（不含光标）按 id 合计恰好是 inventory，光标为空，不要求关界面、不要求下坐骑；织布机：{ loom: { goals: [{ banner, pattern, color, count }], allowed: [id] } }，物品按签名计数（素的物品是 id，带图案的旗帜是 id#图案/颜色，多层用 + 连），每个目标（banner#pattern/color）在物品栏里恰好 count 面、在光标和织布机输入格里没有，光标为空，物品栏 / 输入格里没有 allowed 以外的 id、也没有目标以外的带图案旗帜，剩多少素旗和染料不比较；制图台：{ cartography: { goals: [{ scale, locked, count }], allowed: [id] } }，地图按签名计数（由开局地图做出来的是 minecraft:filled_map#scale=N，锁定的加 ,locked；其他地图是 minecraft:filled_map#foreign），每个目标在物品栏里恰好 count 张、在制图台输入格里没有，光标为空，物品栏 / 输入格里没有目标以外的地图签名、也没有 allowed 以外的 id，剩多少纸、玻璃板、空地图不比较；酿造台：{ brew: { fuel, fuelLeft, ingredient, ingredientLeft, potion, potionLeft, placed, products: [签名] } }，物品按签名计数（带药水内容的是 瓶子id#药水注册名，如 minecraft:splash_potion#minecraft:awkward，其余是 id），容器界面已关闭，光标为空，物品栏恰好是 fuel ×fuelLeft、ingredient ×ingredientLeft、potion ×potionLeft（0 的不出现）且没有别的东西，燃料格空或只有 fuel，材料格空、只有 ingredient 或只有它的剩余物（龙息的玻璃瓶），药水格恰好 placed 瓶且每瓶是 potion 或 products 之一（酿造台里的数量、酿没酿完都不看）；合成器：{ crafter: { target, portions, held: {id:n}, layout: [id|null ×9] } }（layout 只用于 prepare 核对的规范摆法），容器界面已关闭，光标为空，物品栏按 id 恰好是 held 且没有别的东西，合成器每个非空格正好 portions 个、每个空格都已禁用，按原版配方匹配（平移、镜像都认）算出的产物是 target；交易：{ trade: { uses: [n...], held: {id:n} } }，容器界面已关闭，光标为空，本轮村民每笔交易的已交易次数恰好是 uses（按交易下标，个数 = 交易项数），物品栏按 id 恰好是 held 且没有别的东西；砂轮：{ grindstone: { goals: [{ id, enchantments: {id:level}, damage }] } }（goals 的顺序和 items 一致），光标为空，玩家身上（主物品栏、快捷栏、盔甲、副手）按签名（id + 附魔（附魔书读存储的附魔）+ 损坏值 + 自定义名字，不看 repair_cost）恰好是全部 goals、没有别的东西，goals 没有自定义名字，不要求关界面；书：{ book: { goals: [[页文字...], ...] } }，光标为空，玩家身上（主物品栏、快捷栏、盔甲、副手）只有书与笔、恰好 goals 那么多本，每本的页列表（逐字）和 goals 作为多重集合相等（不比哪本在哪一格）', sample: { inventory: { 'minecraft:cobblestone': 20 }, container: {} } },
      { name: 'dayTime', type: 'int', def: 1000, hint: '本轮开始时设置的时间（tick）', sample: 1000 },
      { name: 'bookshelves', type: 'int', def: 15, hint: '附魔台工作站：同层外圈摆几个书架（0–15）；其他工作站忽略', sample: 15 },
      { name: 'xpLevel', type: 'int', hint: '附魔台、铁砧工作站：把玩家经验等级设成多少（进度清零）；省略 = 不动', sample: 30 },
      { name: 'enchantSeed', type: 'int', hint: '附魔台工作站：把玩家的附魔种子设成多少；省略 = 不动', sample: 123456 },
      { name: 'beaconLevel', type: 'int', def: 4, hint: '信标工作站：底座层数 1–4；其他工作站忽略', sample: 4 },
      { name: 'selectedSlot', type: 'int', hint: '把当前选中的快捷栏格设成多少（0–8）；省略 = 不动（书与笔场地用）', sample: 0 }
    ] },
  { method: 'arena/enchant-preview', category: 'arena', description: 'Preview the three enchanting table offers',
    zh: '附魔台三档预览（只读、不碰世界）：按原版 EnchantmentMenu 的算法，用给定的物品（默认组件）、附魔种子、书架数算出三档。返回 { item, enchantSeed, bookshelves, enchantable, offers[{ slot（1–3）, cost（门槛等级，0 = 这一档不可用）, clue:{enchantment, level}|null（界面上露出的提示）, result[{enchantment, level}]（选这一档实际会得到的全部附魔） }] }；params 填 { item, enchantSeed, bookshelves? }',
    paramDefs: [
      { name: 'item', type: 'string', required: true, hint: '物品 id', sample: 'minecraft:iron_sword' },
      { name: 'enchantSeed', type: 'int', required: true, hint: '附魔种子', sample: 123456 },
      { name: 'bookshelves', type: 'int', def: 15, hint: '书架数 0–15', sample: 15 }
    ] },
  { method: 'arena/trade-preview', category: 'arena', description: 'Preview the trades of an arena villager',
    zh: '村民交易预览（只读、不碰世界）：按 arena/prepare 的同一套算法临时生成一只村民（不放进世界），返回 { profession, type, level, offers[{ index, level（在第几级生成的）, costA{ id, count（实际价）, base（基础价）, maxStack }, costB{ id, count, maxStack }|null, result{ id, count, maxStack, components（带不带组件）, enchantments{id:level}, name }, uses, maxUses, xp, encoded（MerchantOffer 的 NBT 文本，用来逐笔比对） }] }；同一组参数永远生成同一组交易；params 填 { profession, type, level, offerSeed }',
    paramDefs: [
      { name: 'profession', type: 'string', required: true, hint: '职业注册名（不能是 none / nitwit）', sample: 'minecraft:librarian' },
      { name: 'type', type: 'string', required: true, hint: '村民类型', sample: 'minecraft:plains' },
      { name: 'level', type: 'int', required: true, hint: '等级 1–5', sample: 3 },
      { name: 'offerSeed', type: 'int', required: true, hint: '交易项种子', sample: 42 }
    ] },
  { method: 'arena/trade-catalog', category: 'arena', description: 'List villager professions that have trades',
    zh: '村民交易训练场的职业池（只读）：返回 { professions[职业注册名] }（有交易表的职业，不含 none / nitwit），按注册名排序，无参数',
    paramDefs: [] },
  { method: 'arena/mount-catalog', category: 'arena', description: 'List what each mount of the mount arena can wear',
    zh: '坐骑训练场的装备池（只读，从游戏里试出来）：10 种动物各临时建一只，对全部物品逐个试能不能放进鞍槽 / 身体槽（和界面一致）。返回 { animals[{ id, group（horse / donkey / camel / llama / nautilus）, saddle[item], body[item], chest（0 / 15 / "strength"＝3×力量） }] }，无参数',
    paramDefs: [] },
  { method: 'arena/loom-catalog', category: 'arena', description: 'List banners, dyes and banner patterns for the loom arena',
    zh: '织布机训练场的题目来源（只读，从游戏注册表读出）：返回 { banners[{ id, color }]（16 种素旗）, dyes[{ id, color }]（16 种染料）, patterns[图案注册名]（no_item_required 标签，顺序同织布机按钮）, patternItems[{ item, patterns[图案注册名] }]（带 provides_banner_patterns 组件的物品） }，旗帜、染料、图案物按 id 排序，无参数',
    paramDefs: [] },
  { method: 'arena/smithing-catalog', category: 'arena', description: 'List smithing recipes, trimmable armor and trim materials',
    zh: '锻造台训练场的题目来源（只读，从游戏里实际读出）：返回 { upgrades[{ template, base, addition[id], result }]（升级配方，一件底材一条）, trims[{ template, pattern }]（纹饰配方：模板 → 纹饰样式注册名）, armors[id]（trimmable_armor 标签）, materials[{ item, material }]（带 provides_trim_material 组件的物品 → 纹饰材料注册名） }，全部按 id 排序，无参数',
    paramDefs: [] },
  { method: 'arena/smithing-preview', category: 'arena', description: 'Preview a smithing result',
    zh: '锻造预览（只读、不碰世界）：三件物品各 1 个，交给服务器的配方管理器找锻造配方并 assemble（和锻造台界面算产物同一条路）。返回 { result:{ id, count, trim{ pattern, material }|null }|null }（null = 没有产物）；params 填 { template, base, addition }（物品 id）',
    paramDefs: [
      { name: 'template', type: 'string', required: true, hint: '模板物品 id', sample: 'minecraft:sentry_armor_trim_smithing_template' },
      { name: 'base', type: 'string', required: true, hint: '底材物品 id', sample: 'minecraft:iron_chestplate' },
      { name: 'addition', type: 'string', required: true, hint: '材料物品 id', sample: 'minecraft:gold_ingot' }
    ] },
  { method: 'arena/anvil-catalog', category: 'arena', description: 'List items and enchantments for the anvil arena',
    zh: '铁砧训练场的物品池（只读）：enchantable/durability 标签里的全部物品（按 id 排序），每件带能附到它上面的附魔（按原版 Enchantment.canEnchant，和铁砧的判断一致）。返回 { items[{ id, enchantments[{ id, maxLevel, curse（是不是诅咒）, exclusive[id]（这件物品上和它冲突的附魔） }] }], book{ id: minecraft:enchanted_book, enchantments[...]（注册表里的全部附魔，冲突关系在全部附魔之间算；砂轮训练场用） } }，无参数',
    paramDefs: [] },
  { method: 'arena/anvil-preview', category: 'arena', description: 'Preview an anvil result and cost',
    zh: '铁砧预览（只读、不碰世界）：在服务器上临时建一个铁砧菜单，放进两件物品，有名字就设名字，按原版 AnvilMenu.createResult 算出产物和花费；算之前会把玩家设成生存模式（创造模式下任何附魔都能附上去、也没有"过于昂贵"）。返回 { result:{ id, count, enchantments{id:level}, name }|null（null = 没有产物，含花费 ≥ 40 的"过于昂贵"）, cost }；params 填 { left, right?, name? }：left / right = { id, enchantments?: {附魔id: 级数} }（right 省略 = 右格空着），name = 要改成的名字（省略 = 不改名）',
    paramDefs: [
      { name: 'left', type: 'json', required: true, hint: '左格：{ id, enchantments?: {附魔id: 级数} }', sample: { id: 'minecraft:diamond_sword', enchantments: { 'minecraft:unbreaking': 3 } } },
      { name: 'right', type: 'json', hint: '右格：{ id, enchantments? }；省略 = 空着', sample: { id: 'minecraft:enchanted_book', enchantments: { 'minecraft:sharpness': 4 } } },
      { name: 'name', type: 'string', hint: '要改成的名字；省略 = 不改名', sample: '风a雪Bc林dE' }
    ] },
  { method: 'arena/status', category: 'arena', description: 'Current training run state',
    zh: '当前一轮的状态：{ active, arena, startedAtMs, craftedAtMs, craftedItem, craftedDelta{id:n}, inventory{id:n}, insideArena, playerOnline }，有工作站时另有 { openedAtMs（第一次打开工作站界面的时刻，没打开过为 null）, stationIntact（大箱子要两半都在，漏斗下面的红石块也要在） }；给过 expect 时另有 reachedAtMs；容器工作站另有 { chestSlots, chest{id:n}（容器不在了为 null）, held{id:n}（物品栏，不含光标）, carried{id:n}（光标）, dropped{id:n}（场内地上的掉落物） }；切石机工作站另有 { held, carried, cutterInput{id:n}（切石机界面开着时输入格里的物品，界面没开为 {}）, dropped }；炉子工作站另有 { held, carried, furnace{ input{id:n}, fuel{id:n}, output{id:n}, lit }（炉子不在了为 null）, dropped, containerOpen（玩家是否还开着容器界面；客户端按 E 开的背包不算） }；附魔台工作站另有 { held, carried, table{ item{id:n}, lapis{id:n} }（附魔台界面开着时两格里的东西）, dropped, containerOpen, xpLevel, enchantments[{enchantment, level}]（本轮那件物品现在的附魔；附魔书读存储的附魔） }；信标工作站另有 { held, carried, slot{id:n}（信标界面开着时付款格里的东西）, dropped, containerOpen, beacon{ levels, primary, secondary }（信标不在了为 null）, paid（本轮付了几次）, sets[{ primary, secondary, atMs }]（每次付款时设的效果） }；铁砧工作站另有 { held, items[{slot, id, count, enchantments{id:level}, name}]（玩家身上每一件的附魔和自定义名字，不含光标）, carried, carriedItem（光标上那件的摘要，空为 null）, slots{ left, right }（铁砧界面开着时两个输入格的摘要，界面没开为 null）, dropped, containerOpen, anvilState（anvil / chipped_anvil / damaged_anvil / missing）, xpLevel, takes[{ cost, enchantments, name, atMs }]（每次取出产物时的花费和产物） }；锻造台工作站另有 { held, items（同铁砧，每件另带 trim / trimMaterial）, carried, carriedItem, slots{ template, base, addition }（锻造台界面开着时三个输入格的摘要 { id, count, trim }，界面没开为 null）, dropped, droppedItems[{ id, count, trim }]（场内地上的每一件）, containerOpen, takes[{ result{ id, count, trim }, atMs }]（每次取出的产物；Shift 点击取出的也记得到） }；坐骑工作站另有 { mount{ id, uuid, saddle, body, chest{id:n}, chestSize, strength? }（动物不在了为 null）, held, carried, dropped, containerOpen, riding（玩家是否骑在这只动物上）, rodeAtMs（第一次骑上）, equippedWithoutMenu（鞍槽 / 身体槽变了而当时没开着它的物品栏） }；织布机工作站另有 { held, carried, loomInput（织布机界面开着时三个输入格；界面没开为 {}）, dropped, containerOpen }，前四项都按签名计数（同 expect.loom）；制图台工作站另有 { held, carried, tableInput（制图台界面开着时 0、1 两格；界面没开为 {}）, dropped, containerOpen, map（开局地图 { id, scale, center }） }，前四项都按签名计数（同 expect.cartography）；酿造台工作站另有 { held, carried, dropped（按签名计数，同 expect.brew）, stand{ potions[签名|null ×3], ingredient{签名:n}, fuel{签名:n}, fuelCharges（燃料值＝剩余可酿造次数）, brewTicks（剩余酿造 tick，0＝没在酿） }, containerOpen, brews（本轮这台酿造台酿完的次数） }；合成器工作站另有 { held, carried, dropped（按 id 计数）, crafter{ grid[{id,count}|null ×9], disabled[格号], result（按原版配方算出的产物 id，没有为 null）, powered }（合成器不在了为 null）, containerOpen }；村民工作站另有 { villager{ uuid, profession, level, uses[每笔交易的已交易次数], trading }（村民不在了为 null）, held, carried, payment{id:n}（交易界面开着时两个支付格里的东西，界面没开为 {}）, dropped（都按 id 计数）, containerOpen }；砂轮工作站另有 { held{id:n}, items[{slot, id, count, enchantments, name, damage?}]（玩家身上，不含光标）, carried{id:n}, carriedItem（光标上的物品，同 items 的一项，空为 null）, slots{ input0, input1 }（界面开着时两个输入格，各是物品或 null；不是砂轮界面为 null）, dropped{id:n}, droppedItems[{id, count, enchantments, name, damage?}]（场内地上）, containerOpen }；给过 expect.book 时另有 { held{id:n}, books[{slot, id, count, pages?, title?}]（玩家身上，不含光标；书与笔带页，成书带页和标题）, carriedItem（光标上的物品，同 books 的一项，空为 null）, dropped{id:n}, droppedBooks[{id, count, pages?, title?}]（场内地上）, selectedSlot }；没有进行中的一轮时只有 active:false，无参数',
    paramDefs: [] },
  { method: 'arena/finish', category: 'arena', description: 'End the training run and teleport outside',
    zh: '结束本轮：返回与 arena/status 相同的最终状态后关界面、传送到场外平台；信标工作站另外拆掉信标重放（清空效果）、清掉玩家身上的效果；没有进行中的一轮时只传送；params 填 { arena, origin? }',
    paramDefs: [
      { name: 'arena', type: 'string', required: true, hint: '场地名（无进行中的一轮时用它定位场外平台）', sample: 'craft2x2' },
      { name: 'origin', type: 'json', hint: '[x, y, z]（已登记的场地可省略）', sample: [10000, 120, 10000] }
    ] },
]

/** 纯方法名数组（48），供前端 /api/skills 与状态页复用。 */
const METHOD_NAMES = METHODS.map(m => m.method)

/** 按 category 分组的 Map，便于展示。 */
function methodsByCategory() {
  const map = new Map()
  for (const m of METHODS) {
    if (!map.has(m.category)) map.set(m.category, [])
    map.get(m.category).push(m)
  }
  return map
}

module.exports = { METHODS, METHOD_NAMES, methodsByCategory }
