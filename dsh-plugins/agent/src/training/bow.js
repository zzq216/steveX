import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { parseRangeSpec } from './storage.js'

/**
 * 弓箭题型（docs/弓箭训练场设计方案.md）：站在射击平台上，前方 48 × 48 × 48 的空场地里有 1–4 个标靶，
 * 每个标靶指定一个面，要求拉满弓、用一支箭射中这个面（目标点是面的中点）。箭数等于标靶数，不给无限附魔。
 *
 * - 出题（Q3）：标靶位置在空场地里等概率抽，眼睛到方块中心的距离在 dist 里、互相间距至少 3 格；
 *   面要同时满足"看得到、射得到、从这一面进去、不太斜、路上没有阻挡"，用和原版一样的弹道逐 tick 模拟（F2–F4）
 * - 物品（Q4）：一把弓、n 支箭各在主物品栏随机的一格；开局手上是空的
 * - 判定（Q6、Q7）：mod 登记每一支箭；每个标靶都被一支拉满的箭射中过指定面算到达；
 *   离开平台、箭用完还没全中就提前结束（doomed）；aborted → lost → timeout → success / false_success / failed
 * - 判定说明（Q13）：每一箭的结果、射出时服务端的朝向、相对目标点的偏移，交给本轮的复盘
 * - 弩（第三稿，Q14–Q20）：选项 weapon=bow|crossbow|any，一轮只用一种武器；弩的初速 3.15、偏差和弓相同（F14、F15）；
 *   弩射出的箭都是暴击箭，不判 weak；装在弩里的箭（status 的 loaded）算进剩余箭数（Q17）
 * - 三叉戟（第四稿，Q21–Q26）：weapon=trident，any 在三种里抽；初速 2.5，掷出的三叉戟在原版里就是一种箭（F21）；
 *   发 n 把三叉戟、不发箭，剩余弹药数三叉戟（Q24）；只有弓判 weak
 */

export const INVENTORY_SLOTS = 36
export const MAX_TARGETS = 4
export const BOW = 'minecraft:bow'
export const CROSSBOW = 'minecraft:crossbow'
export const TRIDENT = 'minecraft:trident'
export const ARROW = 'minecraft:arrow'
/** 空场地相对原点的范围（含两端，Q1） */
export const FIELD = { x: [2, 49], y: [-21, 26], z: [-24, 23] }
/** dist= 的范围（§5.2） */
export const DIST_MIN = 2
export const DIST_MAX = 60
/** 标靶之间的最小间距（三个方向取最大的，Q3） */
export const MIN_SPACING = 3
/** Q3 第 4、5 条：到达时速度和法线的夹角上限、弹道离别的方块的余量 */
export const MAX_INCIDENCE_DEG = 70
export const CLEARANCE = 0.5
/** 弹道（F1–F4）：站立的眼睛高度、箭生成在眼睛下方 0.1、满蓄力初速、空气阻力、重力 */
export const EYE_HEIGHT = 1.62
export const SPAWN_DROP = 0.1
export const SPEED = 3
export const DRAG = 0.99
export const GRAVITY = 0.05
/** 弩的初速（F14，原版是 float 3.15F） */
export const CROSSBOW_SPEED = Math.fround(3.15)
/** 三叉戟的初速（F20，原版 2.5F，float 里没有误差） */
export const TRIDENT_SPEED = 2.5
/**
 * 武器（第三稿 Q14、第四稿 Q21）：物品、弹药、初速、任务文案模板、名字、label 前缀、
 * 判定说明里一件弹药的量词和动词（Q26）
 */
export const WEAPONS = {
  bow: { item: BOW, ammo: ARROW, speed: SPEED, template: 'bow', name: '弓', label: '弓箭', unit: '支', ammoName: '箭', shoot: '射' },
  crossbow: { item: CROSSBOW, ammo: ARROW, speed: CROSSBOW_SPEED, template: 'crossbow', name: '弩', label: '弩', unit: '支', ammoName: '箭', shoot: '射' },
  trident: { item: TRIDENT, ammo: TRIDENT, speed: TRIDENT_SPEED, template: 'trident', name: '三叉戟', label: '三叉戟', unit: '把', ammoName: '三叉戟', shoot: '掷' }
}
export const WEAPON_NAMES = Object.keys(WEAPONS)
/** weapon= 的取值：any 每轮在三种里等概率抽一种 */
export const WEAPON_CHOICES = [...WEAPON_NAMES, 'any']
/** 记录里的武器；旧记录没有这个字段，按弓算（Q20） */
export const weaponOf = (record) => record?.weapon ?? 'bow'
const MAX_TICKS = 400
const SAMPLE_ATTEMPTS = 200
const POSITION_TRIES = 3000
/** 没做好的原因（Q7） */
export const FAULTS = ['miss', 'weak', 'unshot', 'left-platform']
export const FAULT_NAMES = { miss: '有靶没中', weak: '没拉满', unshot: '箭没射完', 'left-platform': '离开平台' }
/** 提前结束的原因代号（Q7） */
export const DOOMED_LEFT = 'left-platform'
export const DOOMED_OUT = 'out-of-arrows'
/** 一支箭的结果（Q6）→ 判定说明里的写法 */
export const RESULT_NAMES = {
  hit: '射中指定面', repeat: '射中指定面，但这个标靶已经被射中过', wrong_face: '射中标靶，但不是指定的面',
  platform: '射中平台或护栏', out: '飞出场地', stuck: '发射后 10 秒还没有结果', weak: '没拉满，不算数'
}

/** 面 → 外法线 */
export const NORMALS = { west: [-1, 0, 0], east: [1, 0, 0], down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1] }
export const FACES = Object.keys(NORMALS)
const AXIS_FACES = [['west', 'east'], ['down', 'up'], ['north', 'south']]
const axisOf = (face) => NORMALS[face].findIndex((c) => c !== 0)

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)
const add = (a, b) => a.map((x, i) => x + b[i])
const sub = (a, b) => a.map((x, i) => x - b[i])
const scale = (a, k) => a.map((x) => x * k)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => Math.sqrt(dot(a, a))

/** dist=a-b（2–60，a < b）：眼睛到标靶方块中心的距离（Q3） */
export function parseDistSpec(text) {
  const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2]) : NaN
  if (!(lo >= DIST_MIN && hi <= DIST_MAX && lo < hi)) throw new Error(`dist 要写 a-b（${DIST_MIN}–${DIST_MAX}，a < b），收到 "${text}"`)
  return { lo, hi }
}

/** weapon=bow|crossbow|any（第三稿 Q14） */
export function parseWeaponSpec(text) {
  if (!WEAPON_CHOICES.includes(String(text))) throw new Error(`weapon 只能是 ${WEAPON_CHOICES.join(' / ')}，收到 "${text}"`)
  return String(text)
}

/** 选项（§5.2）：命令行的优先，没写的用场地配置 */
export function bowOptions(args = {}, config = {}) {
  return {
    targets: parseRangeSpec('targets', MAX_TARGETS, args.targets ?? config.targets ?? '1-4'),
    dist: parseDistSpec(args.dist ?? config.dist ?? '8-40'),
    weapon: parseWeaponSpec(args.weapon ?? config.weapon ?? 'bow')
  }
}

// ── 弹道（F2–F4）────────────────────────────────────────────────────────

/** 站在平台中心时箭的生成位置（F2） */
export function spawnPoint(origin) {
  return [origin[0] + 0.5, origin[1] + 1 + EYE_HEIGHT - SPAWN_DROP, origin[2] + 0.5]
}

/** 站在平台中心时的眼睛位置 */
export function eyePoint(origin) {
  return [origin[0] + 0.5, origin[1] + 1 + EYE_HEIGHT, origin[2] + 0.5]
}

/**
 * 仰角 theta（弧度）、以初速 speed（缺省弓满蓄力）射出后，水平走到 d 时的高度（相对出发点）；走不到 → null。
 * 每 tick 先按当前速度移动，再乘阻力，再减重力（F4）。
 */
export function heightAt(theta, d, speed = SPEED) {
  let vx = speed * Math.cos(theta)
  let vy = speed * Math.sin(theta)
  let x = 0
  let y = 0
  for (let t = 0; t < MAX_TICKS; t++) {
    const nx = x + vx
    const ny = y + vy
    if (nx >= d) return y + ((d - x) / (nx - x)) * (ny - y)
    x = nx
    y = ny
    vx *= DRAG
    vy *= DRAG
    vy -= GRAVITY
    if (y < -1000) return null
  }
  return null
}

/** 低弧线：水平距离 d、高度差 h 要用的仰角（弧度）；够不着 → null */
export function solvePitch(d, h, speed = SPEED) {
  let best = -Infinity
  let bestTheta = null
  for (let deg = -89; deg <= 89; deg += 0.5) {
    const y = heightAt((deg * Math.PI) / 180, d, speed)
    if (y !== null && y > best) {
      best = y
      bestTheta = (deg * Math.PI) / 180
    }
  }
  if (bestTheta === null || best < h) return null
  let lo = (-89 * Math.PI) / 180
  let hi = bestTheta
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const y = heightAt(mid, d, speed)
    if (y === null || y < h) lo = mid
    else hi = mid
  }
  return hi
}

/** 从 from 射向 point 的低弧线轨迹（每 tick 一个点，走过 point 再多走一段）；够不着 → null */
export function trajectory(from, point, speed = SPEED) {
  const dx = point[0] - from[0]
  const dz = point[2] - from[2]
  const d = Math.hypot(dx, dz)
  const theta = solvePitch(d, point[1] - from[1], speed)
  if (theta === null) return null
  const ux = d > 0 ? dx / d : 0
  const uz = d > 0 ? dz / d : 0
  let v = [speed * Math.cos(theta) * ux, speed * Math.sin(theta), speed * Math.cos(theta) * uz]
  let p = [...from]
  const points = [p]
  for (let t = 0; t < MAX_TICKS; t++) {
    p = add(p, v)
    points.push(p)
    if (Math.hypot(p[0] - from[0], p[2] - from[2]) > d + 2 || p[1] < point[1] - 50) break
    v = scale(v, DRAG)
    v[1] -= GRAVITY
  }
  return { theta, points }
}

/** 线段 p→q 和方块盒 [min, max) 的第一个交点：{ t（0–1）, face（从哪一面进去） }；不相交 → null */
export function segmentBox(p, q, min, max) {
  let t0 = 0
  let t1 = 1
  let face = null
  for (let a = 0; a < 3; a++) {
    const d = q[a] - p[a]
    if (Math.abs(d) < 1e-12) {
      if (p[a] < min[a] || p[a] > max[a]) return null
      continue
    }
    const ta = (min[a] - p[a]) / d
    const tb = (max[a] - p[a]) / d
    const enter = Math.min(ta, tb)
    const exit = Math.max(ta, tb)
    if (enter > t0) {
      t0 = enter
      face = AXIS_FACES[a][d > 0 ? 0 : 1]
    }
    t1 = Math.min(t1, exit)
    if (t0 > t1) return null
  }
  return { t: t0, face }
}

const blockBox = (pos, grow = 0) => [pos.map((c) => c - grow), pos.map((c) => c + 1 + grow)]

/** 射击平台的地板和护栏（Q1），出题时弹道要离它们 CLEARANCE 以上 */
export function platformBoxes(origin) {
  const [ox, oy, oz] = origin
  return [
    [[ox - 1, oy, oz - 1], [ox + 2, oy + 1, oz + 2]],
    [[ox - 2, oy + 1, oz - 2], [ox - 1, oy + 3, oz + 3]],
    [[ox - 1, oy + 1, oz - 2], [ox + 2, oy + 3, oz - 1]],
    [[ox - 1, oy + 1, oz + 2], [ox + 2, oy + 3, oz + 3]]
  ]
}

/** 面的中点（Q2） */
export function faceCenter(pos, face) {
  return add(pos.map((c) => c + 0.5), scale(NORMALS[face], 0.5))
}

/** 面内两个方向的偏差取大的（同标靶方块的算法，F6） */
export function planeError(offset, face) {
  const k = axisOf(face)
  return Math.max(...offset.filter((_, i) => i !== k).map(Math.abs))
}

/**
 * Q3 的 5 个条件：这个面能不能当目标。others = 其他标靶的方块坐标；speed = 本轮武器的初速（第三稿 Q19）。
 * @returns {boolean}
 */
export function faceOk(origin, pos, face, others = [], speed = SPEED) {
  const eye = eyePoint(origin)
  const center = faceCenter(pos, face)
  const n = NORMALS[face]
  // 1. 看得到：从眼睛看过去，这个面朝着自己
  if (dot(n, sub(eye, center)) <= 0) return false
  // 2. 射得到：低弧线正好穿过中点
  const path = trajectory(spawnPoint(origin), center, speed)
  if (!path) return false
  const [min, max] = blockBox(pos)
  const obstacles = [...others.map((o) => blockBox(o, CLEARANCE)), ...platformBoxes(origin).map(([a, b]) => [a.map((c) => c - CLEARANCE), b.map((c) => c + CLEARANCE)])]
  for (let i = 0; i + 1 < path.points.length; i++) {
    const p = path.points[i]
    const q = path.points[i + 1]
    const hit = segmentBox(p, q, min, max)
    const end = hit ? hit.t : 1
    // 5. 路上没有阻挡：到命中点之前离别的标靶、平台、护栏都至少 CLEARANCE
    for (const [a, b] of obstacles) {
      const o = segmentBox(p, q, a, b)
      if (o && o.t <= end) return false
    }
    if (!hit) continue
    // 3. 从这一面进去，进去的地方就是中点
    if (hit.face !== face) return false
    const at = add(p, scale(sub(q, p), hit.t))
    if (norm(sub(at, center)) > 0.02) return false
    // 4. 不太斜：到达时的速度方向和法线的夹角不超过 70°
    const v = sub(q, p)
    return -dot(v, n) / norm(v) >= Math.cos((MAX_INCIDENCE_DEG * Math.PI) / 180)
  }
  return false
}

const distTo = (origin, pos) => norm(sub(pos.map((c) => c + 0.5), eyePoint(origin)))
const spacing = (a, b) => Math.max(...a.map((c, i) => Math.abs(c - b[i])))

/**
 * 抽一道题（Q2–Q4）。随机数抽取顺序：（weapon=any 时）武器 → 标靶数 → 逐个（位置 → 面）→ 武器、箭的格子 → 选中的快捷栏格。
 * 三叉戟（第四稿 Q22）：武器就是弹药，n 把各占一格，依次在剩下的格子里抽，不发箭。
 * 指定了武器时不抽武器，弓的题和加弩之前同一种子出同一道题。面的条件按本轮武器的初速算（第三稿 Q19、第四稿 Q25）。
 * 放完再对每个目标查一遍有没有被后放的标靶挡住，不满足就整题重抽。
 * @returns {{ weapon, targets: Array<{ pos, face, point, dist }>, items: Array<{ slot, id, count }>, selectedSlot }}
 */
export function sampleBowRound(seed, options, origin) {
  const random = rng(seed)
  const choice = options.weapon ?? 'bow'
  const weapon = choice === 'any' ? pickOne(random, WEAPON_NAMES) : choice
  const { item, speed } = WEAPONS[weapon]
  for (let attempt = 0; attempt < SAMPLE_ATTEMPTS; attempt++) {
    const n = between(random, options.targets.lo, options.targets.hi)
    const placed = []
    for (let tries = 0; placed.length < n && tries < POSITION_TRIES; tries++) {
      const pos = [origin[0] + between(random, ...FIELD.x), origin[1] + between(random, ...FIELD.y), origin[2] + between(random, ...FIELD.z)]
      const dist = distTo(origin, pos)
      if (dist < options.dist.lo || dist > options.dist.hi) continue
      if (placed.some((t) => spacing(t.pos, pos) < MIN_SPACING)) continue
      const faces = FACES.filter((face) => faceOk(origin, pos, face, placed.map((t) => t.pos), speed))
      if (!faces.length) continue
      placed.push({ pos, face: pickOne(random, faces) })
    }
    if (placed.length < n) continue
    if (!placed.every((t) => faceOk(origin, t.pos, t.face, placed.filter((o) => o !== t).map((o) => o.pos), speed))) continue
    let items
    if (weapon === 'trident') {
      const free = [...Array(INVENTORY_SLOTS).keys()]
      items = placed.map(() => ({ slot: free.splice(Math.floor(random() * free.length), 1)[0], id: TRIDENT, count: 1 }))
    } else {
      const bowSlot = between(random, 0, INVENTORY_SLOTS - 1)
      let arrowSlot = between(random, 0, INVENTORY_SLOTS - 2)
      if (arrowSlot >= bowSlot) arrowSlot++
      items = [{ slot: bowSlot, id: item, count: 1 }, { slot: arrowSlot, id: ARROW, count: n }]
    }
    const used = new Set(items.map((it) => it.slot))
    const hotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((s) => !used.has(s))
    return {
      weapon,
      targets: placed.map((t) => ({ pos: t.pos, face: t.face, point: faceCenter(t.pos, t.face), dist: Math.round(distTo(origin, t.pos) * 10) / 10 })),
      items,
      selectedSlot: pickOne(random, hotbar)
    }
  }
  throw new Error(`${SAMPLE_ATTEMPTS} 次都没抽出能做的题（weapon=${weapon}，targets=${rangeText(options.targets)}，dist=${options.dist.lo}-${options.dist.hi}）`)
}

/** mod 的到达检测和放标靶用的标靶列表（Q9） */
export const bowTargets = (picked) => picked.targets.map(({ pos, face }) => ({ pos, face }))

const fmt = (v, digits = 1) => `(${v.map((c) => c.toFixed(digits)).join(', ')})`

/** Q5：每个点一行，坐标写到一位小数 */
export function pointsText(picked) {
  return picked.targets.map((t) => `- ${fmt(t.point)}`).join('\n')
}

// ── 判定（Q6、Q7）────────────────────────────────────────────────────────

const arrowsIn = (counts) => counts?.[ARROW] ?? 0
/** 本轮武器的弹药个数（第四稿 Q24）：弓、弩数箭，三叉戟数三叉戟 */
const ammoIn = (counts, weapon) => counts?.[WEAPONS[weapon]?.ammo ?? ARROW] ?? 0
/** 装在弩里的箭（第三稿 Q17，F18）；三叉戟没有装填，不算 */
const loadedIn = (counts, weapon) => (weapon === 'trident' ? 0 : arrowsIn(counts))
/** 报完成时还没用的弹药：物品栏、光标、装在弩里的（unshot） */
const unshotOf = (final, weapon) => ammoIn(final?.held, weapon) + ammoIn(final?.carried, weapon) + loadedIn(final?.loaded, weapon)

/** 本轮还剩几件弹药：物品栏、光标、平台上的掉落物、装在弩里的、还在飞的（第四稿 Q24：按武器数） */
export function arrowsLeft(status, weapon = 'bow') {
  return ammoIn(status?.held, weapon) + ammoIn(status?.carried, weapon) + ammoIn(status?.dropped, weapon) + loadedIn(status?.loaded, weapon) + (status?.bow?.flying ?? 0)
}

const hitCount = (bow) => (bow?.targets ?? []).filter((t) => t.hit).length

/** Q7：离开平台，或者箭用完了还没全中 → 原因文字（训练器据此中止本轮）；否则 null */
export function doomedReason(picked, status) {
  const bow = status?.bow
  if (!bow?.targets) return null
  if (bow.leftPlatformAtMs !== null && bow.leftPlatformAtMs !== undefined) return '离开了射击平台，本轮结束'
  if (hitCount(bow) === picked.targets.length) return null
  const weapon = weaponOf(picked)
  if (arrowsLeft(status, weapon) === 0 && (bow.arrows ?? []).every((a) => a.result !== null)) return weapon === 'trident' ? '三叉戟已经用完，还有标靶没命中' : '箭已经用完，还有标靶没射中'
  return null
}

/**
 * 没中的箭（Q6）：对射出时还没被射中的每个标靶，取轨迹（逆着法线）穿过它指定面所在平面的点，
 * 算到中点的偏差，取最小的。没穿过任何一个平面 → null。
 */
export function nearestMiss(arrow, targets, hitBefore) {
  let best = null
  for (const [i, t] of targets.entries()) {
    if (hitBefore.has(i)) continue
    const n = NORMALS[t.face]
    const k = axisOf(t.face)
    const path = arrow.path ?? []
    for (let j = 0; j + 1 < path.length; j++) {
      const p = path[j]
      const q = path[j + 1]
      const a = p[k] - t.point[k]
      const b = q[k] - t.point[k]
      if (dot(sub(q, p), n) >= 0 || a * b > 0 || a === b) continue
      const at = add(p, scale(sub(q, p), a / (a - b)))
      const offset = sub(at, t.point)
      const err = planeError(offset, t.face)
      if (!best || err < best.err) best = { target: i, point: at, offset, err }
      break
    }
  }
  return best
}

const round3 = (v) => Math.round(v * 1000) / 1000
const round3v = (v) => v?.map(round3) ?? null

/** finish 用：mod 登记的每一支箭 → 记录里的形状（去掉轨迹，没中的补上最近的目标面） */
export function arrowRecords(picked, bow, t0) {
  const arrows = bow?.arrows ?? []
  return arrows.map((a) => {
    const hitBefore = new Set(arrows.filter((b) => b.result === 'hit' && b.resultMs !== null && b.resultMs < a.ms && b.target !== undefined).map((b) => b.target))
    const out = {
      n: a.n, ms: typeof a.ms === 'number' && typeof t0 === 'number' ? a.ms - t0 : null, crit: a.crit, weapon: a.weapon ?? null, from: a.from, velocity: a.velocity,
      playerPos: a.playerPos, rotation: a.rotation, result: a.result
    }
    if (a.block) Object.assign(out, { block: a.block, face: a.face, point: a.point })
    if (a.target !== undefined) out.target = a.target
    if (a.err !== undefined) Object.assign(out, { err: round3(a.err), offset: round3v(a.offset) })
    if (a.result !== 'hit' && a.result !== 'repeat') {
      const near = nearestMiss(a, picked.targets, hitBefore)
      out.nearest = near ? { target: near.target, point: round3v(near.point), offset: round3v(near.offset), err: round3(near.err) } : null
    }
    return out
  })
}

/**
 * 判定（Q7）。final：bow（targets、arrows、flying、leftPlatformAtMs）、held、carried、dropped、loaded（弩里的箭）、stationIntact。
 * @returns {{ outcome, reached, faults, hits }}
 */
export function judgeBow({ stopped, timedOut, taskState, final, picked, doomed = null }) {
  if (stopped && !doomed) return { outcome: 'aborted', reached: false, faults: [], hits: hitCount(final?.bow) }
  if (final?.stationIntact === false) return { outcome: 'lost', reached: false, faults: [], hits: hitCount(final?.bow) }
  const bow = final?.bow
  if (!bow?.targets) return { outcome: timedOut ? 'timeout' : 'failed', reached: false, faults: [], hits: 0 }
  const hits = hitCount(bow)
  const reached = hits === picked.targets.length
  const faults = []
  if (!reached) faults.push('miss')
  if ((bow.arrows ?? []).some((a) => a.result === 'weak')) faults.push('weak')
  if (unshotOf(final, weaponOf(picked)) > 0) faults.push('unshot')
  if (bow.leftPlatformAtMs !== null && bow.leftPlatformAtMs !== undefined) faults.push('left-platform')
  let outcome
  if (doomed) outcome = 'failed'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, faults: outcome === 'success' ? [] : faults, hits }
}

// ── 判定说明（Q13）──────────────────────────────────────────────────────

const OUTCOME_TEXT = { success: '成功', false_success: '报了完成，但没有全部射中', failed: '失败', timeout: '超时', aborted: '中止', lost: '标靶不在了' }
const DOOMED_TEXT = { [DOOMED_LEFT]: '离开了射击平台，本轮提前结束', [DOOMED_OUT]: '箭用完了还有标靶没射中，本轮提前结束' }
/** 三叉戟换说法（第四稿 Q26），代号不变 */
const TRIDENT_DOOMED_TEXT = { ...DOOMED_TEXT, [DOOMED_OUT]: '三叉戟用完了还有标靶没命中，本轮提前结束' }
const num = (v, digits = 2) => (typeof v === 'number' ? v.toFixed(digits) : '?')
const vecText = (v, digits = 2) => (Array.isArray(v) ? `(${v.map((c) => num(c, digits)).join(', ')})` : '?')

/** 一轮的判定说明：只列事实，不给建议（Q13 第 5 条） */
export function debriefText(record) {
  const targets = record.targets ?? []
  const arrows = record.arrows ?? []
  const weapon = weaponOf(record)
  const w = WEAPONS[weapon] ?? WEAPONS.bow
  const loaded = loadedIn(record.final?.loaded, weapon)
  const lines = []
  lines.push(`本轮武器：${WEAPONS[weapon]?.name ?? weapon}（${WEAPONS[weapon]?.item ?? weapon}）。`)
  lines.push(`本轮结果：${record.outcome}（${OUTCOME_TEXT[record.outcome] ?? record.outcome}），射中 ${record.hits ?? 0}/${targets.length} 个标靶。`)
  if (record.doomed) lines.push(`提前结束：${(weapon === 'trident' ? TRIDENT_DOOMED_TEXT : DOOMED_TEXT)[record.doomed] ?? record.doomed}。`)
  const unshotHeld = ammoIn(record.final?.held, weapon) + ammoIn(record.final?.carried, weapon)
  if (record.faults?.includes('unshot') && unshotHeld > 0) lines.push(weapon === 'trident' ? `报完成时物品栏里还有 ${unshotHeld} 把三叉戟没掷出。` : '报完成时物品栏里还有箭没射。')
  if (loaded > 0) lines.push(`还有 ${loaded} 支箭装在弩里没射出。`)
  lines.push('', '标靶：')
  for (const [i, t] of targets.entries()) lines.push(`- ${i + 1} 号：目标点 ${fmt(t.point)}（方块 ${fmt(t.pos, 0)} 的 ${t.face} 面），${record.hitTargets?.includes(i) ? '射中' : '没射中'}`)
  lines.push('', arrows.length ? `每一${w.unit}${w.ammoName}（按${w.shoot}出的顺序）：` : `没有${w.shoot}出任何${w.ammoName}。`)
  for (const a of arrows) {
    // 只有弓写是否拉满：弩只有装满才射得出（第三稿 Q20），三叉戟没有拉满一说（第四稿 Q26）
    const parts = [weapon === 'bow' ? `- 第 ${a.n} 支：${a.crit ? '拉满' : '没拉满'}` : `- 第 ${a.n} ${w.unit}`]
    parts.push(`${w.shoot}出时玩家在 ${vecText(a.playerPos)}，服务端用来${weapon === 'trident' ? '投掷' : '射箭'}的朝向 yaw=${num(a.rotation?.yaw)}、pitch=${num(a.rotation?.pitch)}`)
    parts.push(`${w.ammoName}从 ${vecText(a.from)} 出发，初速度 ${vecText(a.velocity, 3)} 格/tick`)
    let result = `结果 ${a.result ?? '（还在飞）'}（${RESULT_NAMES[a.result] ?? '没有结果'}）`
    if (a.block) result += `：命中方块 ${fmt(a.block, 0)} 的 ${a.face} 面，命中点 ${vecText(a.point, 3)}`
    if (a.offset) result += `，相对 ${a.target + 1} 号目标点偏移 ${vecText(a.offset, 3)}`
    if (a.nearest) result += `；轨迹穿过 ${a.nearest.target + 1} 号标靶指定面所在平面的点 ${vecText(a.nearest.point, 3)}，相对目标点偏移 ${vecText(a.nearest.offset, 3)}`
    else if (a.nearest === null) result += '；轨迹没有经过任何还没射中的目标面所在的平面'
    parts.push(result)
    lines.push(parts.join('；'))
  }
  return lines.join('\n')
}

export const bow = {
  type: 'bow',
  options: ['targets', 'dist', 'weapon'],

  setup(trainer, arena, arenaConfig, args) {
    // item= 是训练器的通用选项，弓箭题用不上，写了就报错，免得以为它起了作用
    if (args.item) throw new Error('弓箭题没有 item= 选项（可用 targets= / dist= / weapon=）')
    return { arena, arenaConfig, options: bowOptions(args, arenaConfig) }
  },

  startText(ctx) {
    const o = ctx.options
    return `weapon=${o.weapon}，targets=${rangeText(o.targets)}，dist=${o.dist.lo}-${o.dist.hi}`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleBowRound(seed, ctx.options, ctx.arenaConfig.origin)
  },

  label(ctx, picked, seed) {
    const dists = picked.targets.map((t) => t.dist)
    const span = dists.length === 1 ? `${Math.round(dists[0])} 格` : `${Math.round(Math.min(...dists))}–${Math.round(Math.max(...dists))} 格`
    return `${(WEAPONS[weaponOf(picked)] ?? WEAPONS.bow).label}：${picked.targets.length} 个靶，${span}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）
      target: `${weaponOf(picked)}:${picked.targets.length}`,
      weapon: weaponOf(picked),
      targets: picked.targets, items: picked.items, selectedSlot: picked.selectedSlot,
      arrows: [], hits: 0, hitTargets: [],
      doomed: null, doomedMs: null, faults: [], final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: 'bow', seed, watch: [], expect: { bow: { targets: bowTargets(picked) } }, dayTime: 1000,
      items: picked.items.map((it) => ({ ...it })),
      selectedSlot: picked.selectedSlot,
      bow: { targets: bowTargets(picked) }
    }
  },

  afterPrepare(ctx, picked, data) {
    const info = data?.bow
    if (!Array.isArray(info?.targets)) return { error: 'arena/prepare: no bow info (mod 版本太旧？)', fields: {} }
    const want = bowTargets(picked)
    const same = info.targets.length === want.length && want.every((w, i) => info.targets[i].face === w.face && info.targets[i].pos?.every((c, k) => c === w.pos[k]))
    if (!same) return { error: `arena/prepare: 标靶和题目不一致（${JSON.stringify(info.targets.map(({ pos, face }) => ({ pos, face })))}）`, fields: {} }
    if (info.selectedSlot !== picked.selectedSlot) return { error: `arena/prepare: 选中的快捷栏格是 ${info.selectedSlot}，应为 ${picked.selectedSlot}`, fields: {} }
    const items = Array.isArray(info.items) ? info.items : []
    const ok = items.length === picked.items.length && picked.items.every((w) => items.some((it) => it.slot === w.slot && it.id === w.id && it.count === w.count))
    if (!ok) return { error: `arena/prepare: 发放的物品和题目不一致（发了 ${JSON.stringify(items.map(({ slot, id, count }) => ({ slot, id, count })))}）`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // Q5：写目标和规则；不说怎么瞄准、要抬高多少、怎么拉弓，不说是哪个面、距离多远。弩用自己的模板，不说怎么装填（第三稿 Q16）
    return renderTemplate(prompts.training[WEAPONS[weaponOf(picked)].template], { n: picked.targets.length, points: pointsText(picked) })
  },

  /** Q7：离开平台、箭用完还没全中 → 原因文字（训练器据此中止本轮）；否则 null */
  doomed(ctx, picked, status) {
    return doomedReason(picked, status)
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0, doomed }) {
    const judged = judgeBow({ stopped, timedOut, taskState, final, picked, doomed })
    const reachedAtMs = final?.reachedAtMs ?? null
    const bowState = final?.bow ?? null
    const left = bowState?.leftPlatformAtMs !== null && bowState?.leftPlatformAtMs !== undefined
    return {
      outcome: judged.outcome, reached: judged.reached, faults: judged.faults, hits: judged.hits,
      hitTargets: (bowState?.targets ?? []).flatMap((t, i) => (t.hit ? [i] : [])),
      arrows: arrowRecords(picked, bowState, t0),
      doomed: doomed ? (left ? DOOMED_LEFT : DOOMED_OUT) : null,
      doomedMs: doomed ? doomed.at - t0 : null,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { hits: judged.hits, leftPlatformAtMs: bowState?.leftPlatformAtMs ?? null, held: final.held ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null, loaded: final.loaded ?? null, selectedSlot: final.selectedSlot ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  /** Q13：交给本轮复盘的判定说明 */
  debrief(record) {
    return debriefText(record)
  },

  annotate(record) {
    return { weapon: weaponOf(record), targets: Array.isArray(record.targets) ? record.targets.length : null, hits: record.hits ?? null, debrief: record.outcome ? debriefText(record) : null }
  }
}
