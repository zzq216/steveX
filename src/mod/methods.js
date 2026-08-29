/**
 * 采集端 mod（stevex-template-1.21.11）WebSocket API 方法清单。
 *
 * 共 48 个方法，分组与参数签名已按 mod 源码核实
 * （见 steveX_改进方案.md 附录 §十一）。上层通过 POST /api/mod/:method
 * 原样透传，mod 侧对未知方法会返回 { ok:false, error:'unknown method: …' }。
 */

const METHODS = [
  // ── 持续按键（9）── 参数 { pressed: true|false }
  { method: 'key/up',        category: 'continuous', params: { pressed: 'bool' },  description: 'Hold forward' },
  { method: 'key/down',      category: 'continuous', params: { pressed: 'bool' },  description: 'Hold back' },
  { method: 'key/left',      category: 'continuous', params: { pressed: 'bool' },  description: 'Strafe left' },
  { method: 'key/right',     category: 'continuous', params: { pressed: 'bool' },  description: 'Strafe right' },
  { method: 'key/jump',      category: 'continuous', params: { pressed: 'bool' },  description: 'Hold jump' },
  { method: 'key/sprint',    category: 'continuous', params: { pressed: 'bool' },  description: 'Hold sprint' },
  { method: 'key/sneak',     category: 'continuous', params: { pressed: 'bool' },  description: 'Hold sneak' },
  { method: 'key/attack',    category: 'continuous', params: { pressed: 'bool' },  description: 'Hold attack' },
  { method: 'key/use',       category: 'continuous', params: { pressed: 'bool' },  description: 'Hold use item' },

  // ── 一次性按键 / 杂项（12）──
  { method: 'key/attack-once',   category: 'one-shot',  params: {},              description: 'Attack once' },
  { method: 'key/use-once',      category: 'one-shot',  params: {},              description: 'Use item once' },
  { method: 'key/drop',          category: 'one-shot',  params: {},              description: 'Drop held item' },
  { method: 'key/pick-item',     category: 'one-shot',  params: {},              description: 'Pick block/item' },
  { method: 'key/inventory',     category: 'one-shot',  params: {},              description: 'Open inventory' },
  { method: 'key/swap-hands',    category: 'one-shot',  params: {},              description: 'Swap hands' },
  { method: 'key/chat',          category: 'one-shot',  params: {},              description: 'Open chat input' },
  { method: 'key/command',       category: 'one-shot',  params: {},              description: 'Open command input' },
  { method: 'key/perspective',   category: 'one-shot',  params: {},              description: 'Toggle camera perspective' },
  { method: 'key/quick-actions', category: 'one-shot',  params: {},              description: 'Toggle quick actions' },
  { method: 'key/hotbar',        category: 'one-shot',  params: { slot: 'int' }, description: 'Select hotbar slot (0-8)' },
  { method: 'tablist',           category: 'one-shot',  params: {},              description: 'Online players + scoreboard objective' },

  // ── 视角（2）──
  { method: 'camera/turn',    category: 'camera', params: { dx: 'double', dy: 'double' }, description: 'Turn camera by deltas (yaw, pitch)' },
  { method: 'camera/look-at', category: 'camera', params: { x: 'double', y: 'double', z: 'double' }, description: 'Look at a world coordinate' },

  // ── 感知 / 查询（5）──
  { method: 'player',    category: 'query', params: {}, description: 'Player state (position/health/facing…)' },
  { method: 'inventory', category: 'query', params: {}, description: 'Inventory contents' },
  { method: 'f3',        category: 'query', params: {}, description: 'F3 debug screen data' },
  { method: 'sound',     category: 'query', params: {}, description: 'Sound environment' },
  { method: 'profiler',  category: 'query', params: {}, description: 'Performance profiler' },

  // ── 系统（3）──
  { method: 'status',       category: 'system', params: {}, description: '{ busy:bool, error:string } — true when a non-status method is running' },
  { method: 'settings/get', category: 'system', params: {}, description: 'Read settings' },
  { method: 'settings/set', category: 'system', params: {}, description: 'Write settings' },

  // ── 容器（5）──
  { method: 'container/get',     category: 'container', params: {}, description: 'Get open container contents' },
  { method: 'container/slot',    category: 'container', params: {}, description: 'Interact with a container slot' },
  { method: 'container/button',  category: 'container', params: {}, description: 'Click a container button' },
  { method: 'container/close',   category: 'container', params: {}, description: 'Close container screen' },
  { method: 'container/text',    category: 'container', params: {}, description: 'Type into a container text field' },

  // ── 聊天（3）──
  { method: 'chat/text',  category: 'chat', params: {}, description: 'Get chat history' },
  { method: 'chat/send',  category: 'chat', params: {}, description: 'Send a chat message' },
  { method: 'chat/close', category: 'chat', params: {}, description: 'Close chat screen' },

  // ── 告示牌（3）──
  { method: 'sign/get',  category: 'sign', params: {}, description: 'Read sign text' },
  { method: 'sign/set',  category: 'sign', params: {}, description: 'Write sign text' },
  { method: 'sign/close', category: 'sign', params: {}, description: 'Close sign editor' },

  // ── 书本（4）──
  { method: 'book/get',   category: 'book', params: {}, description: 'Read book content' },
  { method: 'book/set',   category: 'book', params: {}, description: 'Write book content' },
  { method: 'book/page',  category: 'book', params: {}, description: 'Turn book page' },
  { method: 'book/close', category: 'book', params: {}, description: 'Close book screen' },

  // ── 视觉（2，对应视觉系统方案 §6.2）──
  { method: 'vision/snapshot', category: 'vision', params: {}, description: 'Depth capture + visible blocks/entities + store stats' },
  { method: 'vision/entity',   category: 'vision', params: { uuid: 'string', force: 'bool?' }, description: 'Full NBT of a single entity by uuid' },
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
