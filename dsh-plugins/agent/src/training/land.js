import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { parseDistSpec } from './bow.js'

/**
 * 陆地寻路训练场（docs/陆地寻路训练场设计方案.md）：题型 route（按顺序经过几个点再到终点）、goal（只给起点终点，尽快走到）。
 *
 * 一轮：
 *   sample —— 定地形种类、记忆模式、场地大小；模拟起伏先生成高度图（Q2b），真实世界排好要试的源窗口（Q3）
 *   preview —— arena/land-build 放好场地、拿回格子信息；在格子信息上建可走性图，出题（Q4、Q5），算参照路线和参照用时
 *   prepare —— 起点、中间点、终点、开局偏航角、观察标记、记忆模式（Q6、Q4b、Q11）
 *   doomed —— 掉出场地、死亡（Q10）
 *   finish / debrief —— 判定（Q10）、判定说明（Q14）、记录（Q15）
 *
 * 可走性（Q5，F1、F2）：一格能站 = mod 给的"面"（有碰撞顶面、往上留 1.8 格、不危险）；相邻 8 格之间移动，
 * 上 ≤ 0.6 走上去、≤ 1 要跳（出发点头顶要留 dy + 1.8），走下 ≤ 3（落点那一列要留 drop + 1.8）；
 * 斜着走只在高差 ≤ 0.6 时，而且两个侧面的格子也要有高差 ≤ 0.6 的面。移动是有方向的（走得下去不一定走得上来）。
 */

export const LAND_TYPES = ['route', 'goal']
export const GROUND_CHOICES = { route: ['flat', 'synthetic', 'terrain'], goal: ['synthetic', 'terrain'] }
export const MEMORY_CHOICES = ['prefill', 'none']
export const LAND_ORIGIN = [10496, 100, 9984]
export const SIZE_MIN = 2
export const SIZE_MAX = 4
export const POINTS_MAX = 8
export const LAND_DIST_MAX = 88
/** 疾跑速度（格/tick，F3；常用值，实施时用模拟核对） */
export const SPRINT_SPEED = 0.2806
/** 走上去 / 跳上去 / 走下来的上限（F1、F2） */
export const STEP_UP = 0.6
export const JUMP_UP = 1.0
export const SAFE_DROP = 3.0
export const HEADROOM = 1.8
/** 离场地边缘至少几格（Q4、Q5） */
export const EDGE_MARGIN = 2
/** 中间点彼此、和起点终点之间至少隔几格（Q4） */
export const POINT_GAP = 4
/** 本轮场地在整块场地（5 × 5 区块）里最多偏移几格（第四稿 Q19）：边长 4 区块 + 16 = 80 */
export const OFFSET_MAX = 16
/** 开局偏航角不对着第一个目标：差至少这么多度（Q6） */
const YAW_AWAY = 45
/** 真实世界最多试几个窗口、模拟起伏最多重新生成几次（Q3、Q2b） */
const TERRAIN_TRIES = 20
const SYNTH_TRIES = 5
/** 同一块场地上最多抽几次题 */
const SAMPLE_TRIES = 300
export const DEFAULT_TERRAIN_SOURCES = [[2500, 2500, 16], [-2516, 2500, 16], [2500, -2516, 16], [-2516, -2516, 16]]
const DEFAULTS = {
  route: { ground: 'flat', size: 2, points: '2-4', dist: '12-28', edge: '0-2', offset: '0-16' },
  goal: { ground: 'synthetic', size: 4, dist: '24-56', offset: '0-16' }
}
const RELIEF_DEFAULT = { synthetic: '4-12', terrain: '4-24' }

export const DOOMED_FELL = 'fell'
export const DOOMED_DIED = 'died'

// ── 选项（§5.2）──────────────────────────────────────────────────────────

const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

/** "k" 或 "a-b"，在 [min, max] 里（整数） */
export function parseIntRange(name, min, max, text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= min && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（${min}–${max}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

export const parseSizeSpec = (text) => parseIntRange('size', SIZE_MIN, SIZE_MAX, text)
export const parsePointsSpec = (text) => parseIntRange('points', 1, POINTS_MAX, text)
/** 第四稿：边缘点数（Q20）、场地偏移（Q19） */
export const parseEdgeSpec = (text) => parseIntRange('edge', 0, POINTS_MAX, text)
export const parseOffsetSpec = (text) => parseIntRange('offset', 0, OFFSET_MAX, text)

/** ground=flat|synthetic|terrain|any：命令行这一层只查是不是其中之一，题型自己的 setup 再查本题型收不收 */
export function parseGroundSpec(text) {
  const all = [...new Set([...GROUND_CHOICES.route, ...GROUND_CHOICES.goal]), 'any']
  if (!all.includes(String(text))) throw new Error(`ground 只能是 ${all.join(' / ')}，收到 "${text}"`)
  return String(text)
}

export function parseMemorySpec(text) {
  const all = [...MEMORY_CHOICES, 'any']
  if (!all.includes(String(text))) throw new Error(`memory 只能是 ${all.join(' / ')}，收到 "${text}"`)
  return String(text)
}

/** 场地配置里按地形种类分开写的值（{ synthetic, terrain }）或者一个值 */
const byGround = (v, ground, fallback) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v[ground] ?? fallback) : (v ?? fallback))

/**
 * 题型选项（§5.2）：命令行的优先，没写的用场地配置。返回解析好的选项；不合法抛错。
 * size、dist 在场地配置里可以按地形种类分开写（§6 的配置）。
 */
export function landOptions(type, args = {}, config = {}) {
  if (!LAND_TYPES.includes(type)) throw new Error(`unknown land type ${type}`)
  const d = DEFAULTS[type]
  const ground = parseGroundSpec(args.ground ?? config.ground ?? d.ground)
  if (ground !== 'any' && !GROUND_CHOICES[type].includes(ground)) throw new Error(`${type === 'route' ? '路线题' : '寻路题'}的 ground 只能是 ${GROUND_CHOICES[type].join(' / ')} / any，收到 "${ground}"`)
  const memory = parseMemorySpec(args.memory ?? config.memory ?? 'prefill')
  const grounds = ground === 'any' ? GROUND_CHOICES[type] : [ground]
  const size = {}
  const dist = {}
  const relief = {}
  for (const g of grounds) {
    size[g] = parseSizeSpec(args.size ?? byGround(config.size, g, d.size))
    dist[g] = parseDistSpec(args.dist ?? byGround(config.dist, g, d.dist), LAND_DIST_MAX)
    if (g !== 'flat') relief[g] = parseIntRange(`relief（${g}）`, 0, g === 'terrain' ? 34 : 40, byGround(config.relief, g, RELIEF_DEFAULT[g]))
  }
  const cliffs = parseIntRange('cliffs', 0, 8, config.cliffs ?? '1-3')
  const maxWater = config.maxWater ?? 0.25
  if (!(typeof maxWater === 'number' && maxWater >= 0 && maxWater <= 1)) throw new Error(`maxWater 要是 0–1 的数，收到 ${JSON.stringify(maxWater)}`)
  const sources = config.terrainSources ?? DEFAULT_TERRAIN_SOURCES
  if (!Array.isArray(sources) || !sources.length || !sources.every((s) => Array.isArray(s) && s.length === 3 && s.every(Number.isInteger) && s[2] >= SIZE_MAX)) {
    throw new Error('terrainSources 要是 [[cx, cz, 区块数], …]（区块数至少 4）')
  }
  const out = {
    type, ground, grounds, memory, size, dist, relief, cliffs, maxWater, terrainSources: sources,
    markers: config.markers !== false, origin: config.origin ?? LAND_ORIGIN,
    offset: parseOffsetSpec(args.offset ?? config.offset ?? d.offset)
  }
  if (type === 'route') {
    out.points = parsePointsSpec(args.points ?? config.points ?? d.points)
    out.edge = parseEdgeSpec(args.edge ?? config.edge ?? d.edge)
  }
  return out
}

// ── 模拟起伏（Q2b）──────────────────────────────────────────────────────

const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const smooth = (t) => t * t * (3 - 2 * t)

/** 一层值噪声：每隔 cell 格一个随机值，双线性加平滑插值 */
function valueNoise(random, w, cell) {
  const n = Math.ceil(w / cell) + 2
  const grid = Array.from({ length: n * n }, () => random())
  const out = new Float64Array(w * w)
  for (let z = 0; z < w; z++) {
    for (let x = 0; x < w; x++) {
      const gx = x / cell, gz = z / cell
      const ix = Math.floor(gx), iz = Math.floor(gz)
      const fx = smooth(gx - ix), fz = smooth(gz - iz)
      const v = (i, j) => grid[(iz + j) * n + (ix + i)]
      const a = v(0, 0) * (1 - fx) + v(1, 0) * fx
      const b = v(0, 1) * (1 - fx) + v(1, 1) * fx
      out[z * w + x] = a * (1 - fz) + b * fz
    }
  }
  return out
}

/** 相邻两列（4 邻）的高差压到最多 1 格：只往下压（削峰），直到稳定 */
export function clampSlopes(h, w) {
  let changed = true
  while (changed) {
    changed = false
    for (let z = 0; z < w; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x
        let m = h[i]
        if (x > 0) m = Math.min(m, h[i - 1] + 1)
        if (x < w - 1) m = Math.min(m, h[i + 1] + 1)
        if (z > 0) m = Math.min(m, h[i - w] + 1)
        if (z < w - 1) m = Math.min(m, h[i + w] + 1)
        if (m < h[i]) {
          h[i] = m
          changed = true
        }
      }
    }
  }
  return h
}

/**
 * 生成一张模拟起伏的高度图（Q2b）：
 *   1. 几层噪声叠加，缩放到 0–relief、取整；2. 相邻两列高差压到 ≤ 1；
 *   3. cliffs 处随机形状的区域整块抬高（台地，一部分留坡道）或压低（坑，都留坡道）4–6 格；4. 最低处对齐到 0。
 * @returns {{ heights: number[], relief: number, cliffs: { kind, center, delta, ramp }[] }}
 */
export function syntheticHeights(seed, w, reliefRange, cliffRange) {
  const random = rng(seed)
  const relief = between(random, reliefRange.lo, reliefRange.hi)
  const layers = [[16, 1], [8, 0.5], [4, 0.25]].map(([cell, weight]) => [valueNoise(random, w, cell), weight])
  const total = layers.reduce((s, [, weight]) => s + weight, 0)
  let h = new Array(w * w)
  let lo = Infinity, hi = -Infinity
  const raw = new Float64Array(w * w)
  for (let i = 0; i < w * w; i++) {
    raw[i] = layers.reduce((s, [layer, weight]) => s + layer[i] * weight, 0) / total
    lo = Math.min(lo, raw[i])
    hi = Math.max(hi, raw[i])
  }
  for (let i = 0; i < w * w; i++) h[i] = Math.round(((raw[i] - lo) / Math.max(1e-9, hi - lo)) * relief)
  clampSlopes(h, w)
  const cliffs = []
  const count = between(random, cliffRange.lo, cliffRange.hi)
  for (let c = 0; c < count; c++) {
    const kind = random() < 0.5 ? 'plateau' : 'pit'
    const cx = between(random, 8, w - 9), cz = between(random, 8, w - 9)
    const radius = between(random, 4, Math.max(4, Math.min(9, Math.floor(w / 5))))
    const delta = between(random, 4, 6)
    const wobble = Array.from({ length: 8 }, () => 0.75 + random() * 0.5)
    const inside = (x, z) => {
      const dx = x - cx, dz = z - cz
      const ang = (Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI) * 8
      const k = Math.floor(ang) % 8, f = ang - Math.floor(ang)
      const r = radius * (wobble[k] * (1 - f) + wobble[(k + 1) % 8] * f)
      return dx * dx + dz * dz < r * r
    }
    const region = []
    for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) if (inside(x, z)) region.push(z * w + x)
    if (!region.length) continue
    for (const i of region) h[i] += kind === 'plateau' ? delta : -delta
    // 坡道（Q2b 第 3 步）：坑都留一条，台地一半留；沿一个方向从边缘一格一级，宽 2 格
    const ramp = kind === 'pit' || random() < 0.5
    // 坡道朝场地中间（左右偏 60° 以内），免得伸到场地外面去
    const inward = Math.atan2(w / 2 - cz, w / 2 - cx) + (random() - 0.5) * (2 * Math.PI / 3)
    if (ramp) carveRamp(h, w, cx, cz, inward, delta, kind, inside)
    cliffs.push({ kind, center: [cx, cz], delta, ramp, region })
  }
  // 兜底：坑一定要走得出来（被后来的悬崖挡住了坡道就把这个坑填平）
  for (const c of cliffs) {
    if (c.kind !== 'pit') continue
    if (!escapes(h, w, c.center[1] * w + c.center[0], c.region)) {
      for (const i of c.region) h[i] += c.delta
      c.filled = true
    }
  }
  for (const c of cliffs) delete c.region
  const min = Math.min(...h)
  h = h.map((v) => v - min)
  return { heights: h, relief: Math.max(...h), cliffs }
}

/** 按高度图粗查：从 from 出发（上 ≤ 1、下 ≤ 3，4 邻）能不能走出 region */
function escapes(h, w, from, region) {
  const inside = new Set(region)
  const seen = new Uint8Array(w * w)
  const queue = [from]
  seen[from] = 1
  while (queue.length) {
    const i = queue.shift()
    if (!inside.has(i)) return true
    const x = i % w, z = Math.floor(i / w)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (nx < 0 || nz < 0 || nx >= w || nz >= w) continue
      const j = nz * w + nx
      const dy = h[j] - h[i]
      if (seen[j] || dy > 1 || dy < -3) continue
      seen[j] = 1
      queue.push(j)
    }
  }
  return false
}

function carveRamp(h, w, cx, cz, angle, delta, kind, inside) {
  const ux = Math.cos(angle), uz = Math.sin(angle)
  const px = -uz, pz = ux
  const cellAt = (t, side) => {
    const x = Math.round(cx + ux * t + px * side), z = Math.round(cz + uz * t + pz * side)
    return x >= 0 && z >= 0 && x < w && z < w ? z * w + x : -1
  }
  let edge = 0
  while (edge < w && inside(Math.round(cx + ux * edge), Math.round(cz + uz * edge))) edge++
  for (const side of [0, 1]) {
    if (kind === 'pit') {
      // 坑：边缘里面那几格从外面的高度一级一级往下
      const outside = cellAt(edge, side)
      if (outside < 0) continue
      for (let k = 1; k <= delta; k++) {
        const i = cellAt(edge - k, side)
        if (i >= 0) h[i] = Math.max(h[i], h[outside] - k)
      }
    } else {
      // 台地：边缘外面那几格从台地的高度一级一级往下
      const top = cellAt(edge - 1, side)
      if (top < 0) continue
      for (let k = 0; k < delta; k++) {
        const i = cellAt(edge + k, side)
        if (i >= 0) h[i] = Math.max(h[i], h[top] - (k + 1))
      }
    }
  }
}

// ── 可走性（Q5）──────────────────────────────────────────────────────────

/**
 * mod 的格子信息 → 可走性图。节点 = 某一列的某一面；地表那一面能出题的列另记 top。
 * @returns {{ w, x0, z0, nodes: { col, x, z, feet, clear, hazard }[], top: (number|-1)[], edges: [to, cost][][] }}
 */
export function buildGraph(grid, field) {
  const w = grid.width
  const nodes = []
  const byCol = []
  const top = new Array(w * w).fill(-1)
  for (let c = 0; c < w * w; c++) {
    const col = grid.columns[c]
    const n = col[1]
    const ids = []
    for (let s = 0; s < n; s++) {
      const id = nodes.length
      nodes.push({ col: c, x: c % w, z: Math.floor(c / w), feet: col[2 + 3 * s], clear: col[3 + 3 * s], hazard: col[4 + 3 * s] === 1 })
      ids.push(id)
      if (col[0] === s) top[c] = id
    }
    byCol.push(ids)
  }
  const edges = nodes.map(() => [])
  const legal = (a, b) => moveOk(nodes[a], nodes[b])
  const near = (ids, f, tol) => ids.some((i) => !nodes[i].hazard && Math.abs(nodes[i].feet - f) <= tol && nodes[i].clear >= HEADROOM)
  for (let a = 0; a < nodes.length; a++) {
    const na = nodes[a]
    if (na.hazard) continue
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const x = na.x + dx, z = na.z + dz
        if (x < 0 || z < 0 || x >= w || z >= w) continue
        for (const b of byCol[z * w + x]) {
          if (!legal(a, b)) continue
          if (dx && dz) {
            const fb = nodes[b].feet
            if (Math.abs(fb - na.feet) > STEP_UP) continue
            const s1 = byCol[na.z * w + x], s2 = byCol[z * w + na.x]
            if (!near(s1, na.feet, STEP_UP) || !near(s1, fb, STEP_UP) || !near(s2, na.feet, STEP_UP) || !near(s2, fb, STEP_UP)) continue
          }
          edges[a].push([b, dx && dz ? Math.SQRT2 : 1])
        }
      }
    }
  }
  return { w, x0: field.x0, z0: field.z0, nodes, top, edges }
}

/** 从 a 走到相邻一列的 b（Q5，F1、F2） */
export function moveOk(a, b) {
  if (a.hazard || b.hazard || b.clear < HEADROOM) return false
  const dy = b.feet - a.feet
  if (dy > JUMP_UP + 1e-6) return false
  if (dy > STEP_UP + 1e-6) return a.clear >= dy + HEADROOM - 1e-6
  if (dy < -(SAFE_DROP + 1e-6)) return false
  if (dy < 0) return b.clear >= -dy + HEADROOM - 1e-6
  return true
}

/** 有向图上的最短路（Dijkstra，斜走 √2）：返回 { length, path: 节点序列 }；到不了 → null */
export function shortestPath(graph, from, to) {
  const n = graph.nodes.length
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  dist[from] = 0
  // 节点不多（几千个），用二叉堆
  const heap = [[0, from]]
  const push = (item) => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  while (heap.length) {
    const [d, u] = pop()
    if (done[u]) continue
    done[u] = 1
    if (u === to) break
    for (const [v, cost] of graph.edges[u]) {
      const nd = d + cost
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        push([nd, v])
      }
    }
  }
  if (!Number.isFinite(dist[to])) return null
  const path = []
  for (let v = to; v !== -1; v = prev[v]) path.push(v)
  path.reverse()
  return { length: dist[to], path }
}

/** 节点 → 脚的位置 [x, y, z]（格子中心，y 是脚的高度） */
export const nodePos = (graph, id) => [graph.x0 + graph.nodes[id].x + 0.5, graph.nodes[id].feet, graph.z0 + graph.nodes[id].z + 0.5]
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2])

/** 能出题的点：地表那一面、不危险、离边缘至少 2 格、有路可走 */
export function eligible(graph) {
  const out = []
  for (let c = 0; c < graph.top.length; c++) {
    const id = graph.top[c]
    if (id < 0) continue
    const n = graph.nodes[id]
    if (n.x < EDGE_MARGIN || n.z < EDGE_MARGIN || n.x >= graph.w - EDGE_MARGIN || n.z >= graph.w - EDGE_MARGIN) continue
    if (!graph.edges[id].length) continue
    out.push(id)
  }
  return out
}

/** 能放边缘点的格子（第四稿 Q20）：本轮场地最外一圈上、地表那一面、不危险、有路可走 */
export function eligibleEdge(graph) {
  const out = []
  for (let c = 0; c < graph.top.length; c++) {
    const id = graph.top[c]
    if (id < 0) continue
    const n = graph.nodes[id]
    if (!(n.x === 0 || n.z === 0 || n.x === graph.w - 1 || n.z === graph.w - 1)) continue
    if (!graph.edges[id].length) continue
    out.push(id)
  }
  return out
}

/** 参照用时（Q5）：路线长度 ÷ 疾跑速度，取整到 tick */
export const referenceTicks = (length) => Math.ceil(length / SPRINT_SPEED)

/** MC 的偏航角：0 朝 +z、90 朝 −x */
export const yawToward = (from, to) => (Math.atan2(-(to[0] - from[0]), to[2] - from[2]) * 180) / Math.PI
const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

/** 开局偏航角（Q6）：随机，但不对着第一个目标（差至少 45°） */
export function startYaw(random, from, first) {
  const toward = yawToward(from, first)
  for (let i = 0; i < 50; i++) {
    const yaw = Math.round(random() * 3600) / 10 - 180
    if (angleDiff(yaw, toward) >= YAW_AWAY) return yaw
  }
  return ((toward + 180 + 540) % 360) - 180
}

/**
 * 在一块场地上出题（Q4、Q5）：起点终点的直线距离在 dist 里；路线题再抽 n 个中间点（彼此、和起点终点隔 ≥ 4 格），
 * 每一段都要有一条不用掉血的路（有向图上的最短路）。出不了 → null。
 * 第四稿（Q20）：edge 给了就抽本轮的边缘点数 k = min(抽到的值, n)，随机挑 k 个序号放在最外一圈，其余照旧离边缘 ≥ 2 格。
 */
export function sampleOnGraph(graph, random, { type, dist, points = null, edge = null }) {
  const pool = eligible(graph)
  if (pool.length < 2) return null
  const pick = () => pool[Math.floor(random() * pool.length)]
  const edgePool = edge && edge.hi > 0 ? eligibleEdge(graph) : []
  const pickEdge = () => edgePool[Math.floor(random() * edgePool.length)]
  for (let attempt = 0; attempt < SAMPLE_TRIES; attempt++) {
    const start = pick()
    const goal = pick()
    const sp = nodePos(graph, start), gp = nodePos(graph, goal)
    const d = hdist(sp, gp)
    if (start === goal || d < dist.lo || d > dist.hi) continue
    const mids = []
    let edgeIdx = []
    if (type === 'route') {
      const n = between(random, points.lo, points.hi)
      // 边缘点（Q20）：先定数量和序号；没给 edge 或上限是 0 时不动随机数，出题和第三稿一样
      if (edge && edge.hi > 0) {
        const k = Math.min(between(random, edge.lo, edge.hi), n)
        const order = Array.from({ length: n }, (_, i) => i)
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1))
          ;[order[i], order[j]] = [order[j], order[i]]
        }
        edgeIdx = order.slice(0, k).sort((a, b) => a - b)
        if (k > 0 && !edgePool.length) return null
      }
      for (let t = 0; t < n * 20 && mids.length < n; t++) {
        const c = edgeIdx.includes(mids.length) ? pickEdge() : pick()
        const cp = nodePos(graph, c)
        if ([start, goal, ...mids].every((o) => hdist(nodePos(graph, o), cp) >= POINT_GAP)) mids.push(c)
      }
      if (mids.length < n) continue
    }
    const stops = [start, ...mids, goal]
    const legs = []
    let ok = true
    for (let i = 0; i + 1 < stops.length && ok; i++) {
      const leg = shortestPath(graph, stops[i], stops[i + 1])
      if (!leg) ok = false
      else legs.push(leg)
    }
    if (!ok) continue
    const length = Math.round(legs.reduce((s, l) => s + l.length, 0) * 100) / 100
    const path = legs.flatMap((l, i) => (i ? l.path.slice(1) : l.path)).map((id) => nodePos(graph, id))
    return {
      start: sp,
      goal: gp,
      points: mids.map((id) => nodePos(graph, id)),
      ...(type === 'route' ? { edgePoints: edgeIdx } : {}),
      dist: Math.round(d * 10) / 10,
      yaw: startYaw(random, sp, mids.length ? nodePos(graph, mids[0]) : gp),
      reference: { length, ticks: referenceTicks(length), path: thinPath(path) }
    }
  }
  return null
}

/** 参照路线只留拐点（记录用） */
function thinPath(path) {
  if (path.length <= 2) return path
  const out = [path[0]]
  for (let i = 1; i + 1 < path.length; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1]
    const same = b[0] - a[0] === c[0] - b[0] && b[2] - a[2] === c[2] - b[2] && b[1] === a[1] && c[1] === b[1]
    if (!same) out.push(b)
  }
  out.push(path[path.length - 1])
  return out
}

// ── 出题（sample + preview）──────────────────────────────────────────────

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const pickRange = (random, r) => between(random, r.lo, r.hi)

/** 第一步（同步）：地形种类、记忆模式、场地大小；模拟起伏的高度图；真实世界要试的源窗口 */
export function sampleLandRound(seed, options) {
  const random = rng(seed)
  const ground = pickOne(random, options.grounds)
  const memory = options.memory === 'any' ? pickOne(random, MEMORY_CHOICES) : options.memory
  const size = pickRange(random, options.size[ground])
  const w = 16 * size
  const picked = { type: options.type, ground, memory, size, width: w, seed }
  if (ground === 'synthetic') {
    picked.synthSeeds = Array.from({ length: SYNTH_TRIES }, () => Math.floor(random() * 0x100000000))
  }
  if (ground === 'terrain') {
    picked.windows = Array.from({ length: TERRAIN_TRIES }, () => {
      const [cx, cz, chunks] = pickOne(random, options.terrainSources)
      return [cx + Math.floor(random() * (chunks - size + 1)), cz + Math.floor(random() * (chunks - size + 1))]
    })
  }
  picked.sampleSeed = Math.floor(random() * 0x100000000)
  // 第四稿 Q19：本轮场地的偏移，x、z 各抽一次（放在最后抽，前面的随机数和第三稿一样）
  const off = options.offset ?? { lo: 0, hi: 0 }
  picked.offset = [pickRange(random, off), pickRange(random, off)]
  return picked
}

/**
 * 第二步（问 mod）：放好场地、拿格子信息、出题。真实世界的窗口不合格或出不了题就换下一个，模拟起伏出不了题就换一张高度图。
 * @param call (method, params) → mod 的回复 { ok, data, error }
 */
export async function previewLandRound(picked, options, call) {
  const random = rng(picked.sampleSeed)
  const base = { arena: 'land', origin: options.origin, ground: picked.ground, size: picked.size, offset: picked.offset ?? [0, 0] }
  const tries = []
  const attempts = picked.ground === 'terrain' ? picked.windows.map((win) => ({ window: { cx: win[0], cz: win[1] } }))
    : picked.ground === 'synthetic' ? picked.synthSeeds.map((s) => ({ synth: syntheticHeights(s, picked.width, options.relief.synthetic, options.cliffs) }))
      : [{}]
  for (const attempt of attempts) {
    const params = { ...base }
    if (attempt.window) Object.assign(params, { window: attempt.window, maxWater: options.maxWater, relief: [options.relief.terrain.lo, options.relief.terrain.hi] })
    if (attempt.synth) params.heights = attempt.synth.heights
    const res = await call('arena/land-build', params)
    if (!res?.ok) throw new Error(`arena/land-build: ${res?.error ?? 'no response'}`)
    const data = res.data
    if (!data.accepted) {
      tries.push({ window: attempt.window, reason: data.reason, scan: data.scan })
      continue
    }
    const graph = buildGraph(data.grid, data.field)
    const task = sampleOnGraph(graph, random, { type: picked.type, dist: options.dist[picked.ground], points: options.points, edge: options.edge ?? null })
    if (!task) {
      tries.push({ window: attempt.window, reason: 'no-task' })
      continue
    }
    const info = { field: data.field, tries: tries.length }
    if (attempt.window) Object.assign(info, { window: [attempt.window.cx, attempt.window.cz], scan: data.scan })
    if (attempt.synth) Object.assign(info, { relief: attempt.synth.relief, cliffs: attempt.synth.cliffs.map(({ kind, delta, ramp }) => ({ kind, delta, ramp })) })
    if (picked.ground === 'terrain') info.relief = data.scan?.relief ?? null
    return { ...picked, ...task, ...info, rejected: tries }
  }
  throw new Error(`${attempts.length} 次都没放成能出题的场地（ground=${picked.ground}，${tries.map((t) => t.reason).join('、')}）`)
}

// ── 判定（Q10）───────────────────────────────────────────────────────────

const passedAll = (land) => Array.isArray(land?.route?.passed) && land.route.passed.every((t) => t !== null && t !== undefined)

/** 掉出场地、死亡 → 原因文字（训练器据此中止本轮）；否则 null */
export function doomedReason(status) {
  const land = status?.land
  if (!land) return null
  if (land.fell) return '掉出了场地，本轮结束'
  if (land.dead) return '死亡，本轮结束'
  return null
}

export function judgeLand({ stopped, timedOut, taskState, final, picked, doomed = null }) {
  const land = final?.land
  const reached = land?.reachedTick !== null && land?.reachedTick !== undefined
  if (stopped && !doomed) return { outcome: 'aborted', reached, faults: [] }
  const faults = []
  if (!reached) faults.push('unreached')
  if (picked.type === 'route' && !reached && taskState === 'done' && !passedAll(land)) faults.push('skipped')
  if (land?.fell) faults.push(DOOMED_FELL)
  if (land?.dead) faults.push(DOOMED_DIED)
  let outcome
  if (doomed) outcome = 'failed'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, faults: outcome === 'success' ? [] : faults }
}

// ── 判定说明（Q14）──────────────────────────────────────────────────────

const OUTCOME_TEXT = { success: '到达', false_success: '报了完成，但没有到达', failed: '失败', timeout: '超时', aborted: '中止' }
const SOURCE_TEXT = { 'minecraft:fall': '摔落', 'minecraft:cactus': '仙人掌', 'minecraft:lava': '岩浆', 'minecraft:in_fire': '火', 'minecraft:on_fire': '着火', 'minecraft:hot_floor': '岩浆块', 'minecraft:sweet_berry_bush': '甜浆果丛', 'minecraft:freeze': '细雪冻伤', 'minecraft:in_wall': '卡在方块里窒息', 'minecraft:wither': '凋零', 'minecraft:stalagmite': '石笋' }
const num = (v, digits = 1) => (typeof v === 'number' ? v.toFixed(digits) : '?')
const pos = (v, digits = 1) => (Array.isArray(v) ? `(${v.map((c) => num(c, digits)).join(', ')})` : '?')
const sec = (ticks) => (typeof ticks === 'number' ? `${ticks} tick（${(ticks / 20).toFixed(1)} 秒）` : '?')

/** 轨迹：每秒一个点，外加经过中间点的点（Q14） */
function traceLines(record) {
  const trace = record.trace ?? []
  if (!trace.length) return ['（没有轨迹）']
  const passTicks = new Set((record.route?.passed ?? []).filter((t) => typeof t === 'number'))
  const lines = []
  let last = -Infinity
  for (const [t, x, y, z, flags] of trace) {
    if (t - last < 20 && !passTicks.has(t) && t !== trace[trace.length - 1][0]) continue
    last = t
    lines.push(`  - 第 ${t} tick：${pos([x, y, z])}${flags & 1 ? '' : '，在空中'}${flags & 2 ? '，疾跑' : ''}`)
  }
  return lines
}

/** 一轮的判定说明：只列事实，不给建议，不给参照路线（Q14） */
export function debriefText(record) {
  const lines = []
  const kind = record.type === 'route' ? '路线题' : '寻路题'
  lines.push(`本轮：${kind}，${GROUND_TEXT[record.ground] ?? record.ground}，${record.size} × ${record.size} 区块，记忆${record.memory === 'prefill' ? '预填' : '不预填'}。`)
  lines.push(`本轮结果：${record.outcome}（${OUTCOME_TEXT[record.outcome] ?? record.outcome}）。`)
  if (record.doomed === DOOMED_FELL) lines.push('本轮提前结束：掉出了场地。')
  if (record.doomed === DOOMED_DIED) lines.push('本轮提前结束：死亡。')
  lines.push(`起点 ${pos(record.start)}，终点 ${pos(record.goal)}。`)
  if (record.thinkMs !== null && record.thinkMs !== undefined) lines.push(`从发布任务到开始移动：${(record.thinkMs / 1000).toFixed(1)} 秒。`)
  else lines.push('没有开始移动。')
  if (record.moveTicks !== null && record.moveTicks !== undefined) lines.push(`从开始移动到到达：${sec(record.moveTicks)}。`)
  if (record.reference?.ticks) lines.push(`参照用时：${record.reference.ticks} tick（按一条不掉血的最短路线、全程疾跑估算）。`)
  if (record.type === 'route') {
    lines.push('中间点（按要求的顺序）：')
    const passed = record.route?.passed ?? []
    const early = record.route?.early ?? []
    record.points.forEach((p, i) => {
      const t = passed[i]
      const before = early.filter((e) => e.point === i).map((e) => `第 ${e.tick} tick`)
      lines.push(`  ${i + 1}. ${pos(p)}：${typeof t === 'number' ? `第 ${t} tick 按顺序经过` : '没有按顺序经过'}${before.length ? `；顺序不对时到过（${before.join('、')}）` : ''}`)
    })
  }
  const hurts = record.damageEvents ?? []
  if (!hurts.length) lines.push('受伤：全程没有受伤。')
  else {
    lines.push(`受伤：${hurts.length} 次，一共掉了 ${num(record.damage, 1)} 点生命值：`)
    for (const h of hurts) {
      lines.push(`  - 第 ${h.tick} tick，${SOURCE_TEXT[h.source] ?? h.source}（${h.source}），掉 ${num(h.amount, 1)} 点，剩 ${num(h.health, 1)} 点，位置 ${pos(h.pos)}${typeof h.fallDistance === 'number' ? `，摔落距离 ${num(h.fallDistance, 2)} 格` : ''}`)
    }
  }
  if (record.fell) lines.push(`掉出场地：第 ${record.fell.edgeTick} tick 在 ${pos(record.fell.edge)} 离开场地边缘，第 ${record.fell.tick} tick 掉到 ${pos(record.fell.pos)}。`)
  if (record.dead) lines.push(`死亡：第 ${record.dead.tick} tick，${SOURCE_TEXT[record.dead.source] ?? record.dead.source}（${record.dead.source}），位置 ${pos(record.dead.pos)}。`)
  lines.push('你走过的路（每秒一个点；没写"在空中"的就是站在地上）：')
  lines.push(...traceLines(record))
  return lines.join('\n')
}

const GROUND_TEXT = { flat: '平地', synthetic: '模拟起伏地形', terrain: '真实世界地形' }

// ── 文案（Q7）───────────────────────────────────────────────────────────

const coord = (p) => `(${p[0].toFixed(1)}, ${Number.isInteger(p[1]) ? p[1] : p[1].toFixed(1)}, ${p[2].toFixed(1)})`
export const pointsText = (picked) => picked.points.map((p, i) => `${i + 1}. ${coord(p)}`).join('\n')

// ── 题型 ─────────────────────────────────────────────────────────────────

function makeTask(type) {
  return {
    type,
    options: type === 'route' ? ['ground', 'memory', 'size', 'points', 'edge', 'dist', 'offset'] : ['ground', 'memory', 'size', 'dist', 'offset'],

    setup(trainer, arena, arenaConfig, args) {
      if (args.item) throw new Error(`${type === 'route' ? '路线题' : '寻路题'}没有 item= 选项`)
      return { arena, arenaConfig, options: landOptions(type, args, arenaConfig) }
    },

    startText(ctx) {
      const o = ctx.options
      const parts = [`ground=${o.ground}`, `memory=${o.memory}`, `size=${o.grounds.map((g) => rangeText(o.size[g])).join('/')}`]
      if (type === 'route') parts.push(`points=${rangeText(o.points)}`, `edge=${rangeText(o.edge)}`)
      parts.push(`dist=${o.grounds.map((g) => `${o.dist[g].lo}-${o.dist[g].hi}`).join('/')}`)
      parts.push(`offset=${rangeText(o.offset)}`)
      return parts.join('，')
    },

    batchFields() {
      return {}
    },

    sample(ctx, seed) {
      return sampleLandRound(seed, ctx.options)
    },

    preview(ctx, picked, seed, call) {
      return previewLandRound(picked, ctx.options, call)
    },

    label(ctx, picked, seed) {
      const g = GROUND_TEXT[picked.ground] ?? picked.ground
      // 题目说明只给控制台和训练日志看，不进 agent 的会话（第四稿 Q20 的"几个靠边"可以写）
      const edges = picked.edgePoints?.length ? `（${picked.edgePoints.length} 个靠边）` : ''
      const what = type === 'route' ? `路线：${g} ${picked.size}×${picked.size}，${picked.points.length} 个点${edges}，${Math.round(picked.dist)} 格` : `寻路：${g} ${picked.size}×${picked.size}，${Math.round(picked.dist)} 格`
      return `${what}，${picked.memory === 'prefill' ? '预填' : '不预填'}（seed=${seed}）`
    },

    record(ctx, picked) {
      return {
        target: `${type}:${picked.ground}`,
        type, ground: picked.ground, memory: picked.memory, size: picked.size,
        offset: picked.offset ?? null, edgePoints: type === 'route' ? (picked.edgePoints ?? []) : null,
        window: picked.window ?? null, relief: picked.relief ?? null, cliffs: picked.cliffs ?? null, scan: picked.scan ?? null, rejected: picked.rejected ?? [],
        start: picked.start, points: picked.points, goal: picked.goal, yaw: picked.yaw, dist: picked.dist,
        reference: picked.reference,
        thinkMs: null, moveTicks: null, ratio: null, route: null,
        hurt: false, damage: 0, damageEvents: [], fell: null, dead: null, trace: [], memoryInfo: null,
        doomed: null, doomedMs: null, faults: [], final: null, reached: false, reachedMs: null
      }
    },

    prepareParams(ctx, picked, seed) {
      return {
        station: 'land', seed, watch: [], dayTime: 1000, items: [],
        land: { kind: type, start: picked.start, yaw: picked.yaw, points: picked.points, goal: picked.goal, markers: ctx.options.markers, memory: picked.memory }
      }
    },

    afterPrepare(ctx, picked, data) {
      const info = data?.land
      if (!info) return { error: 'arena/prepare: no land info (mod 版本太旧？)', fields: {} }
      const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
      if (!same(info.start, picked.start) || !same(info.goal, picked.goal) || info.points?.length !== picked.points.length || !picked.points.every((p, i) => same(info.points[i], p))) {
        return { error: `arena/prepare: 起点、中间点、终点和题目不一致（${JSON.stringify({ start: info.start, points: info.points, goal: info.goal })}）`, fields: {} }
      }
      const memory = data.memory
      if (!memory || memory.error) return { error: `arena/prepare: 记忆没有清除 / 预填好（${memory?.error ?? 'no memory info'}）`, fields: { memoryInfo: memory ?? null } }
      return { fields: { memoryInfo: { mode: memory.mode, cleared: memory.cleared, prefilled: memory.prefilled } } }
    },

    instruction(ctx, picked, prompts) {
      // Q7：写目标和规则；不说怎么走、怎么查记忆、怎么规划，不说场地多大、掉下去会怎样、记忆里有没有预填
      return renderTemplate(prompts.training[type], { start: coord(picked.start), goal: coord(picked.goal), n: picked.points.length, points: pointsText(picked) })
    },

    doomed(ctx, picked, status) {
      return doomedReason(status)
    },

    finish(ctx, picked, { final, stopped, timedOut, taskState, t0, doomed }) {
      const judged = judgeLand({ stopped, timedOut, taskState, final, picked, doomed })
      const land = final?.land ?? null
      const moveTicks = land?.reachedTick !== null && land?.reachedTick !== undefined && typeof land?.started === 'number' ? land.reachedTick - land.started : null
      const reachedAtMs = final?.reachedAtMs ?? land?.reachedAtMs ?? null
      const damageEvents = land?.damage ?? []
      return {
        outcome: judged.outcome, reached: judged.reached, faults: judged.faults,
        thinkMs: typeof land?.startedAtMs === 'number' ? land.startedAtMs - t0 : null,
        moveTicks,
        ratio: moveTicks !== null && picked.reference?.ticks ? Math.round((moveTicks / picked.reference.ticks) * 1000) / 1000 : null,
        route: land?.route ?? null,
        hurt: damageEvents.length > 0,
        damage: land?.hurt?.total ?? 0,
        damageEvents,
        fell: land?.fell ?? null,
        dead: land?.dead ?? null,
        trace: land?.trace ?? [],
        doomed: doomed ? (land?.dead ? DOOMED_DIED : DOOMED_FELL) : null,
        doomedMs: doomed ? doomed.at - t0 : null,
        reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
        final: land ? { started: land.started ?? null, reachedTick: land.reachedTick ?? null, pos: land.pos ?? null, tick: land.tick ?? null } : null
      }
    },

    timings(record) {
      return [['到达用时', record.reachedMs]]
    },

    debrief(record) {
      return debriefText(record)
    },

    annotate(record) {
      return { type, ground: record.ground, memory: record.memory, moveTicks: record.moveTicks ?? null, ratio: record.ratio ?? null, hurt: record.hurt ?? null, debrief: record.outcome ? debriefText(record) : null }
    }
  }
}

export const route = makeTask('route')
export const goal = makeTask('goal')
