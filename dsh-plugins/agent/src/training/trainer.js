import fs from 'node:fs'
import path from 'node:path'

import { loadItemProps, loadRecipes, parseCountSpec } from './sampler.js'
import { craft, judge, resolveCounts } from './craft.js'
import { STORAGE_CHOICES, parseTargetsSpec, parseTypesSpec, storage } from './storage.js'
import { STONECUT_CHOICES, loadStonecutting, parseMaterialsSpec, parseSlotsSpec, parseStylesSpec, stonecut } from './stonecut.js'
import { COOK_CHOICES, cook, loadCooking, parseCookSlotsSpec, parseTotalSpec } from './cook.js'
import { enchant, parseBookshelves, parseXpLevel } from './enchant.js'
import { beacon, parseAmplifier, parseBeaconCountSpec } from './beacon.js'
import { ANVIL_CHOICES, anvil, parseEnchantsSpec } from './anvil.js'
import { SMITHING_CHOICES, parseTasksSpec, smithing } from './smithing.js'
import { MOUNT_CHOICES, mount, parseMountMove, parseMountTotal } from './mount.js'
import { LOOM_CHOICES, loom, parseBannersSpec, parseSpareSpec } from './loom.js'
import { CARTOGRAPHY_CHOICES, cartography, parseCopiesSpec, parseMapScaleSpec, parseMapsSpec, parseOpsSpec } from './cartography.js'
import { brew, loadBrewing, parseBottlesSpec } from './brew.js'
import { crafter, parseExtraSpec } from './crafter.js'
import { parseTradeLevelSpec, trade } from './trade.js'

export { judge, resolveCounts }

/**
 * 训练器（训练场设计方案 §3）：/bt train 每轮"出题 → 发任务 → 判定 → 记录"，可连续多轮。
 *
 * 每轮一个新会话（T13）：执行 /bt train 的会话只当控制台，每轮开始、结束各插一条通知；
 * 本轮的规划、执行、复盘都在本轮自己的会话里，轮与轮之间不共享上下文。
 *
 * 一轮：
 *   等空闲（上一轮的复盘 / 整理结束，T11）→ 新建本轮会话 → arena/prepare（重置 + 布置）→ startPlanning（计时起点 t0）
 *   → 每 pollMs 查 arena/status，等任务 done / failed、规划作废或超时（超时中止任务，T6）
 *   → arena/finish（读最终状态、传送出场）→ 判定 → 等本轮会话空闲（复盘结束）→ 统计回合与 token → 追加一行 jsonl
 *
 * 题型（箱子训练场设计方案 C11）：场地配置的 type 选题型模块——craft（craft.js，合成，缺省）、storage（storage.js，
 * 箱子存取）、stonecut（stonecut.js，切石机，docs/切石机训练场设计方案.md）、cook（cook.js，熔炉 / 高炉 / 烟熏炉，docs/熔炉训练场设计方案.md）、enchant（enchant.js，附魔台，docs/附魔台训练场设计方案.md）、beacon（beacon.js，信标，docs/信标训练场设计方案.md）、anvil（anvil.js，铁砧，docs/铁砧训练场设计方案.md）、smithing（smithing.js，锻造台，docs/锻造台训练场设计方案.md）、mount（mount.js，坐骑，docs/坐骑训练场设计方案.md）、loom（loom.js，织布机，docs/织布机训练场设计方案.md）、cartography（cartography.js，制图台，docs/制图台训练场设计方案.md）、brew（brew.js，酿造台，docs/酿造台训练场设计方案.md）、crafter（crafter.js，合成器，docs/合成器训练场设计方案.md）、trade（trade.js，村民交易，docs/村民交易训练场设计方案.md）。题型管出题、发放参数、指令、判定和题型自己的记录字段；训练器只管轮次、会话、超时、记录这套公共流程。
 * 有工作站的场地：prepare 的服务器射线自检不过（题型的 afterPrepare 报错）时本轮记 aborted 并停止整组（W2）；
 * 记录里有 openedMs、stationIntact（W8、W9）。
 * 题型可选的异步钩子（信标训练场设计方案 G2、G6）：ready 在 afterPrepare 之后、发任务之前等场地真正就绪（信标数出底座等级），
 * 报错时本轮 aborted 并停止整组；settle 在 arena/finish 之前等场地稳定下来（扔出的付款物品被捡回）。
 */

/** 场地配置的 type → 题型模块 */
const TASK_TYPES = { craft, storage, stonecut, cook, enchant, beacon, anvil, smithing, mount, loom, cartography, brew, crafter, trade }
/** prepare 之后等客户端更新准星目标（W2）：客户端要过 1 个 tick 才知道准星指着工作站 */
const AIM_SETTLE_MS = 100
/** 中止之后等任务真正停下的上限 */
const SETTLE_TIMEOUT_MS = 30000
/** 记录里最多留几条 chat/send 的内容 */
const MAX_CHAT_SAMPLES = 5
/** 这些请求的回合不算进本轮（任务结束之后才有，T10） */
const AFTER_TASK_REQUESTS = ['reflect', 'curate']

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seconds = (label, ms) => (ms === null || ms === undefined ? '' : `，${label} ${(ms / 1000).toFixed(1)} 秒`)

/** 题型选项的命令行名 → start() 的参数名（n、m 是合成题的份数与次数） */
const OPTION_NAMES = { n: 'portions', m: 'crafts', kind: 'kind', rel: 'rel', chest: 'chest', stack: 'stack', fill: 'fill', types: 'types', targets: 'targets', materials: 'materials', slots: 'slots', styles: 'styles', bypass: 'bypass', material: 'material', station: 'station', raw: 'raw', fuel: 'fuel', rawSlots: 'rawSlots', fuelSlots: 'fuelSlots', input: 'input', fuelItem: 'fuelItem', bookshelves: 'bookshelves', xpLevel: 'xpLevel', effect: 'effect', amplifier: 'amplifier', primary: 'primary', level: 'level', payment: 'payment', count: 'count', task: 'task', second: 'second', enchants: 'enchants', curses: 'curses', tasks: 'tasks', base: 'base', pattern: 'pattern', group: 'group', animal: 'animal', total: 'total', move: 'move', banners: 'banners', spare: 'spare', itemPatterns: 'itemPatterns', banner: 'banner', ops: 'ops', scale: 'scale', maps: 'maps', copies: 'copies', bottles: 'bottles', extra: 'extra', profession: 'profession' }
/** 写成 k 或 a-b 的选项 → 校验函数（原样留成字符串，start 里解析） */
const RANGE_OPTIONS = { n: (v) => parseCountSpec(v, 'n'), m: (v) => parseCountSpec(v, 'm'), types: parseTypesSpec, targets: parseTargetsSpec, materials: parseMaterialsSpec, slots: parseSlotsSpec, styles: parseStylesSpec, raw: (v) => parseTotalSpec('raw', v), fuel: (v) => parseTotalSpec('fuel', v), rawSlots: (v) => parseCookSlotsSpec('rawSlots', v), fuelSlots: (v) => parseCookSlotsSpec('fuelSlots', v), level: parseTradeLevelSpec, count: parseBeaconCountSpec, enchants: parseEnchantsSpec, tasks: parseTasksSpec, total: parseMountTotal, move: parseMountMove, banners: parseBannersSpec, spare: parseSpareSpec, ops: parseOpsSpec, scale: parseMapScaleSpec, maps: parseMapsSpec, copies: parseCopiesSpec, bottles: parseBottlesSpec, extra: parseExtraSpec }

/**
 * `/bt train` 的参数：`<场地> [item=…] [runs=…] [seed=…]`，合成题另有 `[n=…] [m=…]`，箱子题另有
 * `[kind=…] [rel=…] [chest=…] [stack=…] [fill=…] [types=…] [targets=…]`，切石题另有 `[materials=…] [slots=…] [fill=…] [styles=…] [bypass=…] [material=…]`，
 * 熔炉题另有 `[station=…] [raw=…] [fuel=…] [rawSlots=…] [fuelSlots=…] [n=…] [m=…] [input=…] [fuelItem=…]`，
 * 附魔台题另有 `[item=…] [bookshelves=…] [xpLevel=…]`，信标题另有 `[effect=…] [amplifier=…] [primary=…] [level=…] [payment=…] [count=…]`（信标训练场设计方案 §5），
 * 铁砧题另有 `[task=…] [second=…] [item=…] [enchants=…] [curses=…] [xpLevel=…]`（铁砧训练场设计方案 §5），
 * 锻造台题另有 `[tasks=…] [kind=upgrade|trim] [base=…] [pattern=…] [material=…]`（锻造台训练场设计方案 §5；kind 和箱子题共用一个名字，取值按场地分别校验），
 * 坐骑题另有 `[group=…] [animal=…] [task=equip|unequip] [item=…] [total=…] [move=…]`（坐骑训练场设计方案 §5；task 和铁砧题共用一个名字，取值按场地分别校验），
 * 织布机题另有 `[banners=…] [slots=…] [fill=…] [styles=…] [spare=…] [itemPatterns=off|on] [banner=…]`（织布机训练场设计方案 §5；slots、styles、fill 和切石题共用名字，范围由场地的 setup 再查）。
 * 制图台题另有 `[task=zoom|lock|clone|mix|chain] [scale=…] [maps=…] [copies=…] [ops=…] [spare=…]`（制图台训练场设计方案 §5；task 和铁砧题、坐骑题共用，spare 和织布机题共用）。
 * 酿造台题另有 `[fuel=…] [raw=…] [bottles=…] [n=…] [m=…] [input=…]`（酿造台训练场设计方案 §5；fuel / raw / n / m / input 和熔炉题共用名字）。
 * 合成器题另有 `[item=…] [n=…] [extra=…]`（合成器训练场设计方案 R4；n 和合成题共用名字）。
 * 村民交易题另有 `[profession=…] [level=…] [tasks=…] [n=…] [extra=…] [item=…]`（村民交易训练场设计方案 §5；level 和信标题共用，全局按 1–5 查，信标场地的 setup 再查不超过 4；tasks 和锻造台题共用）。
 * 这里只查写法；哪个场地认哪些选项由 start 按题型查。n、m、types、targets、materials、slots、styles、raw、fuel、rawSlots、fuelSlots、level、count、enchants、tasks、total、move、banners、spare、ops、scale、maps、copies、bottles、extra 原样留成字符串（"4" / "2-5"），start 里解析。
 * @returns {{ ok: true, arena, item, runs, seed, portions, crafts, kind, rel, chest, stack, fill, types, targets, materials, slots, styles, bypass, material, station, raw, fuel, rawSlots, fuelSlots, input, fuelItem, bookshelves, xpLevel, effect, amplifier, primary, level, payment, count, task, second, enchants, curses, tasks, base, pattern, group, animal, total, move, banners, spare, itemPatterns, banner, ops, scale, maps, copies, bottles, extra, profession } | { ok: false, error }}
 */
export function parseTrainArgs(words) {
  const [arena, ...options] = words
  if (!arena) return { ok: false, error: '缺场地名，例如 /bt train craft2x2' }
  const out = { ok: true, arena, item: null, runs: 1, seed: null, portions: null, crafts: null, kind: null, rel: null, chest: null, stack: null, fill: null, types: null, targets: null, materials: null, slots: null, styles: null, bypass: null, material: null, station: null, raw: null, fuel: null, rawSlots: null, fuelSlots: null, input: null, fuelItem: null, bookshelves: null, xpLevel: null, effect: null, amplifier: null, primary: null, level: null, payment: null, count: null, task: null, second: null, enchants: null, curses: null, tasks: null, base: null, pattern: null, group: null, animal: null, total: null, move: null, banners: null, spare: null, itemPatterns: null, banner: null, ops: null, scale: null, maps: null, copies: null, bottles: null, extra: null, profession: null }
  for (const option of options) {
    const match = /^(item|runs|seed|n|m|kind|rel|chest|stack|fill|types|targets|materials|slots|styles|bypass|material|station|raw|fuel|rawSlots|fuelSlots|input|fuelItem|bookshelves|xpLevel|effect|amplifier|primary|level|payment|count|task|second|enchants|curses|tasks|base|pattern|group|animal|total|move|banners|spare|itemPatterns|banner|ops|scale|maps|copies|bottles|extra|profession)=(.+)$/.exec(option)
    if (!match) return { ok: false, error: `看不懂的选项 "${option}"（可用 item= / runs= / seed=；合成题 n= / m=；箱子题 kind= / rel= / chest= / stack= / fill= / types= / targets=；切石题 materials= / slots= / fill= / styles= / bypass= / material=；熔炉题 station= / raw= / fuel= / rawSlots= / fuelSlots= / n= / m= / input= / fuelItem=；附魔台题 item= / bookshelves= / xpLevel=；信标题 effect= / amplifier= / primary= / level= / payment= / count=；铁砧题 task= / second= / item= / enchants= / curses= / xpLevel=；锻造台题 tasks= / kind= / base= / pattern= / material=；坐骑题 group= / animal= / task= / item= / total= / move=；织布机题 banners= / slots= / fill= / styles= / spare= / itemPatterns= / banner=；制图台题 task= / scale= / maps= / copies= / ops= / spare=；酿造台题 fuel= / raw= / bottles= / n= / m= / input=；合成器题 item= / n= / extra=；村民交易题 profession= / level= / tasks= / n= / extra= / item=）` }
    const [, key, value] = match
    if (RANGE_OPTIONS[key]) {
      try {
        RANGE_OPTIONS[key](value)
      } catch (error) {
        return { ok: false, error: error.message }
      }
      out[OPTION_NAMES[key]] = value
    } else if (key === 'task') {
      // 铁砧题（merge / rename / both）、坐骑题（equip / unequip）和制图台题（zoom / lock / clone / mix / chain）共用 task，
      // 这里只查是不是其中之一，场地自己的 setup 再按题型校验
      const choices = [...ANVIL_CHOICES.task, ...MOUNT_CHOICES.task, ...CARTOGRAPHY_CHOICES.task]
      if (!choices.includes(value)) return { ok: false, error: `task 只能是 ${ANVIL_CHOICES.task.join(' / ')}（铁砧题）、${MOUNT_CHOICES.task.join(' / ')}（坐骑题）或 ${CARTOGRAPHY_CHOICES.task.join(' / ')}（制图台题）` }
      out[key] = value
    } else if (key === 'group') {
      if (!MOUNT_CHOICES.group.includes(value)) return { ok: false, error: `group 只能是 ${MOUNT_CHOICES.group.join(' / ')}` }
      out[key] = value
    } else if (key === 'kind') {
      // 箱子题（take / put / mix）和锻造台题（upgrade / trim）共用 kind，这里只查是不是其中之一，场地自己的 setup 再按题型校验
      const choices = [...STORAGE_CHOICES.kind, ...SMITHING_CHOICES.kind]
      if (!choices.includes(value)) return { ok: false, error: `kind 只能是 ${STORAGE_CHOICES.kind.join(' / ')}（箱子题）或 ${SMITHING_CHOICES.kind.join(' / ')}（锻造台题）` }
      out[key] = value
    } else if (STORAGE_CHOICES[key]) {
      if (!STORAGE_CHOICES[key].includes(value)) return { ok: false, error: `${key} 只能是 ${STORAGE_CHOICES[key].join(' / ')}` }
      out[key] = value
    } else if (STONECUT_CHOICES[key]) {
      if (!STONECUT_CHOICES[key].includes(value)) return { ok: false, error: `${key} 只能是 ${STONECUT_CHOICES[key].join(' / ')}` }
      out[key] = value
    } else if (COOK_CHOICES[key]) {
      if (!COOK_CHOICES[key].includes(value)) return { ok: false, error: `${key} 只能是 ${COOK_CHOICES[key].join(' / ')}` }
      out[key] = value
    } else if (key === 'itemPatterns') {
      if (!LOOM_CHOICES.itemPatterns.includes(value)) return { ok: false, error: `itemPatterns 只能是 ${LOOM_CHOICES.itemPatterns.join(' / ')}` }
      out[key] = value
    } else if (ANVIL_CHOICES[key]) {
      if (!ANVIL_CHOICES[key].includes(value)) return { ok: false, error: `${key} 只能是 ${ANVIL_CHOICES[key].join(' / ')}` }
      out[key] = value
    } else if (key === 'amplifier') {
      try {
        out[key] = parseAmplifier(value)
      } catch (error) {
        return { ok: false, error: error.message }
      }
    } else if (key === 'bookshelves' || key === 'xpLevel') {
      try {
        out[key] = key === 'bookshelves' ? parseBookshelves(value) : parseXpLevel(value)
      } catch (error) {
        return { ok: false, error: error.message }
      }
    } else if (key === 'item' || key === 'material' || key === 'input' || key === 'fuelItem' || key === 'payment' || key === 'effect' || key === 'primary' || key === 'base' || key === 'pattern' || key === 'animal' || key === 'banner' || key === 'profession') {
      if (!/^([a-z0-9_.-]+:)?[a-z0-9_/.-]+$/.test(value)) return { ok: false, error: `${key} 不像${key === 'effect' || key === 'primary' ? '效果' : key === 'pattern' ? '纹饰样式' : key === 'animal' ? '动物' : key === 'profession' ? '职业' : '物品'} id：${value}` }
      out[key] = value
    } else {
      const n = Number(value)
      if (key === 'runs' && !(Number.isInteger(n) && n >= 1 && n <= 1000)) return { ok: false, error: 'runs 要是 1–1000 的整数' }
      if (key === 'seed' && !(Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF)) return { ok: false, error: 'seed 要是 0–4294967295 的整数' }
      out[key] = n
    }
  }
  return out
}

/** 会话事件按回合切片：turn → turn/start 到 turn/end 之间的事件（没结束的回合不收）。 */
export function sliceTurns(events) {
  const slices = new Map()
  let open = null
  for (const event of events) {
    if (event?.type === 'turn/start') open = { turn: event.data?.turn, events: [] }
    if (!open) continue
    open.events.push(event)
    if (event.type === 'turn/end' && event.data?.turn === open.turn) {
      slices.set(open.turn, open.events)
      open = null
    }
  }
  return slices
}

/**
 * 几个回合的 token 合计（F8）：每个回合用 DSH 的 deriveTurnTokenUsage 算，有一个算不出就整体记 null，不估算。
 * @returns {{ input, output, total, cacheRead?, cacheWrite?, reasoning? } | null}
 */
export function sumTurnUsage(events, turns, deriveUsage) {
  if (!events || !deriveUsage) return null
  const slices = sliceTurns(events)
  const sum = { input: 0, output: 0, total: 0 }
  const optional = { cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens', reasoning: 'reasoningTokens' }
  const complete = Object.fromEntries(Object.keys(optional).map((k) => [k, true]))
  for (const turn of turns) {
    const slice = slices.get(turn)
    const usage = slice ? deriveUsage(slice) : undefined
    if (!usage) return null
    sum.input += usage.uncachedInputTokens
    sum.output += usage.outputTokens
    sum.total += usage.totalTokens
    for (const [key, field] of Object.entries(optional)) {
      if (usage[field] === undefined) complete[key] = false
      else sum[key] = (sum[key] ?? 0) + usage[field]
    }
  }
  for (const key of Object.keys(optional)) if (!complete[key]) delete sum[key]
  return sum
}

export class Trainer {
  /**
   * @param {object} options
   * @param {object} options.bridge         Bridge（startPlanning / abort / busyReason / requests）
   * @param {object} options.executor       Executor（'task' / 'event' 事件、abortTask、task）
   * @param {object} options.game           GameState（mod.call、onCall）
   * @param {object} options.prompts        loadPrompts() 的结果（training.<场地>_<模式>）
   * @param {object} options.config         normalizeConfig().training
   * @param {string|null} options.runtimeDir
   * @param {(sessionId) => Promise<boolean>} options.whenIdle        会话回到空闲；会话不在了 → false
   * @param {(consoleSessionId) => Promise<string>} options.openSession  新建本轮的会话（模型跟随控制台会话），返回会话 id
   * @param {(sessionId, text) => void} options.notify                往控制台会话插一条通知（不开新回合）
   * @param {(sessionId) => boolean} options.sessionExists             控制台会话还在吗：不在了就不再开新的一轮
   * @param {(sessionId, reason) => void} [options.cancelTurn]       取消会话当前的回合（停止训练时打断复盘 / 整理回合）
   * @param {(sessionId) => object[]|null} [options.sessionEvents]   会话的全部事件（算 token 用）
   * @param {(events) => object|undefined} [options.deriveUsage]      DSH 的 deriveTurnTokenUsage
   */
  constructor({ bridge, executor, game, prompts, config, runtimeDir, whenIdle, openSession, history = null, notify = () => {}, sessionExists = () => true, cancelTurn = () => {},
    sessionEvents = () => null, deriveUsage = null, log = () => {}, now = () => Date.now(), sleep = defaultSleep, randomSeed = () => Math.floor(Math.random() * 0x100000000) }) {
    this.bridge = bridge
    this.executor = executor
    this.game = game
    this.prompts = prompts
    this.config = config
    this.runtimeDir = runtimeDir
    this.whenIdle = whenIdle
    this.openSession = openSession
    this.history = history
    this.notify = notify
    this.sessionExists = sessionExists
    this.cancelTurn = cancelTurn
    this.sessionEvents = sessionEvents
    this.deriveUsage = deriveUsage
    this.log = log
    this.now = now
    this.sleep = sleep
    this.randomSeed = randomSeed
    this.pool = null
    this.props = undefined
    this.cutting = undefined
    this.batch = null
    this.last = null
  }

  running() {
    return Boolean(this.batch)
  }

  /**
   * 开始一组训练（后台跑，立即返回）。
   * @returns {{ ok: true, text } | { ok: false, error }}
   */
  start({ sessionId, arena, item = null, runs = 1, seed = null, ...options }) {
    if (this.batch) return { ok: false, error: `训练 ${this.batch.id} 还在进行（第 ${this.batch.run}/${this.batch.runs} 轮）；先 /bt train stop` }
    if (!sessionId) return { ok: false, error: '/bt train 只能在会话里用' }
    if (!this.config.arenas[arena]) return { ok: false, error: `未知场地 ${arena}（配置 training.arenas 里有 ${Object.keys(this.config.arenas).join(', ')}）` }
    const type = this.config.arenas[arena].type ?? 'craft'
    const task = TASK_TYPES[type]
    if (!task) return { ok: false, error: `场地 ${arena} 的题型 ${type} 不认识（只有 ${Object.keys(TASK_TYPES).join(', ')}）` }
    const arenaConfig = type === 'craft' ? { grid: 2, station: null, ...this.config.arenas[arena] } : { ...this.config.arenas[arena] }
    const args = { item, ...options }
    const foreign = Object.entries(OPTION_NAMES).filter(([, name]) => args[name] !== null && args[name] !== undefined && !task.options.includes(name))
    if (foreign.length) return { ok: false, error: `场地 ${arena}（${type}）不认这些选项：${foreign.map(([flag]) => flag).join('、')}` }
    let ctx
    try {
      ctx = task.setup(this, arena, arenaConfig, args)
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const batch = {
      id: `b${new Date(this.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
      arena, arenaConfig, task, ctx, sessionId, item, runs, seed,
      run: 0, outcomes: {}, current: null, stopping: false
    }
    this.batch = batch
    batch.promise = this.runBatch(batch)
      .catch((error) => this.log(`[train] ${batch.id} 出错停止：${error?.message ?? error}`))
      .finally(() => {
        if (this.batch === batch) this.batch = null
        this.last = batch
      })
    return { ok: true, text: `训练 ${batch.id} 开始：场地 ${arena}，${runs} 轮，${task.startText(ctx)}${seed !== null ? `，seed=${seed}` : ''}。进度用 /bt train status 看` }
  }

  /**
   * 开局先清理上次没收尾的一轮（2026-11-07，session-a1a0dc6c）：mod 在内存里记着进行中的一轮，
   * DSH 在一轮中途被关掉时没人调 arena/finish，之后的 arena/prepare 全被拒。一个 DSH 进程只有一个训练器，
   * 这一批还没开始，mod 却说有进行中的一轮，那就是上一个进程留下的：按它的场地 finish 掉（传送出场），再开始。
   */
  async clearStaleRun(batch) {
    const res = await this.game.mod.call('arena/status', {})
    if (!res?.ok || !res.data?.active) return
    const stale = res.data.arena ?? batch.arena
    const origin = this.config.arenas[stale]?.origin ?? batch.arenaConfig.origin
    const finished = await this.game.mod.call('arena/finish', { arena: stale, origin })
    const text = finished?.ok
      ? `清理了上次没结束的一轮（场地 ${stale}，可能是 DSH 在那一轮中途被关掉了）`
      : `场地 ${stale} 有上次没结束的一轮，清理失败：${finished?.error ?? 'no response'}`
    this.log(`[train] ${batch.id}：${text}`)
    this.tellConsole(batch, text)
  }

  /** 中止当前轮并停止后续轮次（本轮记 aborted）。 */
  stop() {
    const batch = this.batch
    if (!batch) return { ok: false, error: '没有进行中的训练' }
    batch.stopping = true
    batch.stoppingAt ??= this.now()
    const reviewing = batch.current?.phase === '等复盘 / 整理结束'
    const what = reviewing ? `第 ${batch.run} 轮已经做完，中断它的复盘 / 整理` : `中止第 ${batch.run} 轮`
    return { ok: true, text: `训练 ${batch.id} 正在停止：${what}，不再开新的一轮` }
  }

  status() {
    const batch = this.batch ?? this.last
    if (!batch) return '还没有训练过（/bt train craft2x2 [item=…] [runs=…] [seed=…] [n=…] [m=…]）'
    const lines = [`训练 ${batch.id}${this.batch ? (batch.stopping ? '（正在停止）' : '（进行中）') : '（已结束）'}：场地 ${batch.arena}，第 ${batch.run}/${batch.runs} 轮`]
    const current = batch.current
    if (this.batch && current) {
      const elapsed = current.t0 ? `${Math.round((this.now() - current.t0) / 1000)}s` : '未开始'
      lines.push(`本轮：${current.label}，${current.phase}，已用 ${elapsed}${current.sessionId ? `，会话 ${current.sessionId}` : ''}${current.taskId ? `，任务 ${current.taskId}` : ''}`)
    }
    const outcomes = Object.entries(batch.outcomes).map(([k, v]) => `${k} ${v}`).join('，')
    lines.push(`结果：${outcomes || '（还没有）'}`)
    return lines.join('\n')
  }

  dispose() {
    if (!this.batch) return
    this.batch.stopping = true
    this.batch.stoppingAt ??= this.now()
  }

  /** 配方表（合成题出题用），读一次 */
  recipes() {
    this.pool ??= loadRecipes(this.config.recipes)
    return this.pool
  }

  /** data/stonecutting.json（切石题出题用）；没配置或文件不在 → null */
  stonecutting() {
    if (this.cutting === undefined) this.cutting = this.config.stonecutting && fs.existsSync(this.config.stonecutting) ? loadStonecutting(this.config.stonecutting) : null
    return this.cutting
  }

  /** data/cooking.json（熔炉题出题用）；没配置或文件不在 → null */
  cooking() {
    if (this.cookingRecipes === undefined) this.cookingRecipes = this.config.cooking && fs.existsSync(this.config.cooking) ? loadCooking(this.config.cooking) : null
    return this.cookingRecipes
  }

  /** data/brewing.json（酿造台题出题用）；没配置或文件不在 → null */
  brewing() {
    if (this.brewingData === undefined) this.brewingData = this.config.brewing && fs.existsSync(this.config.brewing) ? loadBrewing(this.config.brewing) : null
    return this.brewingData
  }

  /** data/item-props.json（合成题的多份模式、箱子题、熔炉题要用）；文件不在 → null */
  itemProps() {
    if (this.props === undefined) this.props = loadItemProps(this.config.itemProps)
    return this.props
  }

  async runBatch(batch) {
    await this.clearStaleRun(batch)
    for (let i = 1; i <= batch.runs && !batch.stopping; i++) {
      // 控制台会话关了：没地方发通知，也取不到要跟随的模型（T13）
      if (!this.sessionExists(batch.sessionId)) {
        this.log(`[train] ${batch.id}：控制台会话 ${batch.sessionId} 已关闭，不再开新的一轮`)
        break
      }
      batch.run = i
      const seed = batch.seed !== null ? (batch.seed + (i - 1) * 0x9E3779B9) >>> 0 : this.randomSeed()
      const record = await this.runOne(batch, i, seed)
      batch.outcomes[record.outcome] = (batch.outcomes[record.outcome] ?? 0) + 1
      this.write(batch.arena, record)
      const timings = batch.task.timings(record)
      this.log(`[train] ${batch.id} #${i} ${record.target}: ${record.outcome}${timings.map(([label, ms]) => (ms === null || ms === undefined ? '' : ` (${label} ${ms} ms)`)).join('')}${record.error ? ` — ${record.error}` : ''}`)
      this.tellConsole(batch, `第 ${i}/${batch.runs} 轮结果 ${record.outcome}${timings.map(([label, ms]) => seconds(label, ms)).join('')}${seconds('任务用时', record.taskMs)}${record.error ? `（${record.error}）` : ''}`)
      if (record.setupFailed) break
    }
    batch.current = null
    this.log(`[train] ${batch.id} 结束：${JSON.stringify(batch.outcomes)}`)
    const outcomes = Object.entries(batch.outcomes).map(([k, v]) => `${k} ${v}`).join('，')
    this.tellConsole(batch, `训练 ${batch.id} 结束：${outcomes || '没有跑完任何一轮'}。记录在 runtime/training/${batch.arena}.jsonl`)
  }

  tellConsole(batch, text) {
    if (!this.sessionExists(batch.sessionId)) return
    try {
      this.notify(batch.sessionId, text)
    } catch (error) {
      this.log(`[train] 控制台通知失败：${error?.message ?? error}`)
    }
  }

  async runOne(batch, run, seed) {
    const { arena, arenaConfig, task, ctx } = batch
    const timeoutSec = arenaConfig.timeoutSec ?? this.config.timeoutSec
    const wallTimeoutSec = arenaConfig.wallTimeoutSec ?? this.config.wallTimeoutSec
    let picked
    try {
      picked = task.sample(ctx, seed)
    } catch (error) {
      // 出不了题（合成题换了几次配方都放不下，T14）：本轮记 aborted 并停止整组
      return { arena, run, batch: batch.id, seed, ...task.batchFields(ctx), outcome: 'aborted', error: `sample: ${error.message}`, setupFailed: true }
    }
    // 出题的第二步（附魔台训练场设计方案 N5）：题型要先问 mod 才能定题的（附魔台三档预览），在这里补全
    if (task.preview) {
      try {
        picked = await task.preview(ctx, picked, seed, (method, params) => this.game.mod.call(method, params))
      } catch (error) {
        return { arena, run, batch: batch.id, seed, ...task.batchFields(ctx), outcome: 'aborted', error: `preview: ${error.message}`, setupFailed: true }
      }
    }
    const label = task.label(ctx, picked, seed)
    const current = { run, seed, label, phase: '等空闲', t0: null, sessionId: null, taskId: null }
    batch.current = current
    const record = {
      arena, run, batch: batch.id, seed, ...task.record(ctx, picked),
      sessionId: null, taskId: null, outcome: null, t0: null, llmWaitMs: 0, openedMs: null, taskMs: null, insideArena: null, stationIntact: null,
      planAttempts: 0, treeVersions: null, nodeCalls: 0, capsules: [], turns: 0, tokens: null,
      usedChatSend: false, chatSends: [], error: null
    }
    const finishRecord = (fields) => Object.assign(record, fields)

    if (!(await this.waitIdle(null, batch))) return finishRecord({ outcome: 'aborted', error: 'stopped before start' })

    current.phase = '新建会话'
    let sessionId
    try {
      sessionId = await this.openSession(batch.sessionId)
    } catch (error) {
      return finishRecord({ outcome: 'aborted', error: `openSession: ${error?.message ?? error}`, setupFailed: true })
    }
    current.sessionId = sessionId
    finishRecord({ sessionId })
    this.tellConsole(batch, `第 ${run}/${batch.runs} 轮：会话 ${sessionId}，${label}`)

    current.phase = '准备场地'
    const origin = arenaConfig.origin
    const params = task.prepareParams(ctx, picked, seed)
    const prepared = await this.game.mod.call('arena/prepare', { arena, origin, ...params })
    if (!prepared?.ok) {
      return finishRecord({ outcome: 'aborted', error: `arena/prepare: ${prepared?.error ?? 'no response'}`, setupFailed: true })
    }
    const checked = task.afterPrepare(ctx, picked, prepared.data)
    finishRecord(checked.fields ?? {})
    if (checked.error) {
      // 场地自检不过（准星没对准、大箱子没连上）：场地坐标出了问题，本轮记 aborted 并停止整组（W2、箱子方案 C2）
      await this.game.mod.call('arena/finish', { arena, origin })
      return finishRecord({ outcome: 'aborted', error: checked.error, setupFailed: true })
    }
    if (task.ready) {
      current.phase = '等场地就绪'
      const ready = await task.ready(ctx, picked, this.hookHelpers())
      finishRecord(ready.fields ?? {})
      if (ready.error) {
        await this.game.mod.call('arena/finish', { arena, origin })
        return finishRecord({ outcome: 'aborted', error: ready.error, setupFailed: true })
      }
    }
    if (params.station) await this.sleep(AIM_SETTLE_MS)

    // 旁听：本轮的节点、任务结束、chat/send
    const state = { taskEnd: null, taskSeen: false, nodeCalls: 0, refs: new Set() }
    const onTask = (summary) => {
      if (!state.taskId || summary?.taskId !== state.taskId) return
      state.taskSeen = true
      if (summary.state === 'done' || summary.state === 'failed') state.taskEnd ??= { ...summary, at: this.now() }
    }
    const onEvent = (rec) => {
      if (!state.taskId || rec?.taskId !== state.taskId || rec.event !== 'node' || rec.phase !== 'exit') return
      state.nodeCalls++
      if (typeof rec.ref === 'string') state.refs.add(rec.ref)
    }
    const offCall = this.game.onCall?.((method, params) => {
      if (method !== 'chat/send' || !state.taskId) return
      record.usedChatSend = true
      if (record.chatSends.length < MAX_CHAT_SAMPLES) record.chatSends.push(String(params?.text ?? '').slice(0, 200))
    })
    this.executor.on('task', onTask)
    this.executor.on('event', onEvent)

    let stopped = false
    let timedOut = false
    let lastStatus = null
    let reachedAt = null
    // 村民交易训练场设计方案 V7：不可逆的失败（多换、换错）被发现的原因和时刻；题型没有 doomed 钩子时一直是 null
    let doomed = null
    const reached = (status) => Boolean(task.reached?.(ctx, picked, status))
    try {
      const instruction = task.instruction(ctx, picked, this.prompts)
      const t0 = this.now()
      const planned = this.bridge.startPlanning({ sessionId, instruction })
      if (!planned.ok) {
        await this.game.mod.call('arena/finish', { arena, origin })
        return finishRecord({ outcome: 'aborted', error: `startPlanning: ${planned.error}`, setupFailed: true })
      }
      state.taskId = planned.taskId
      current.taskId = planned.taskId
      current.t0 = t0
      current.phase = '进行中'
      finishRecord({ taskId: planned.taskId, t0: new Date(t0).toISOString() })

      let abortedAt = null
      // 时间上限（T6，2026-11-07 修订）：timeoutSec 不算等本任务 LLM 回合（规划 / 展开 / 修补）的时间，
      // wallTimeoutSec 是总墙钟上限，防回合卡住
      let lastTick = t0
      const ended = () => state.taskEnd || this.planFailed(planned, state)
      while (!ended()) {
        await this.sleep(this.config.pollMs)
        const tick = this.now()
        if (this.llmPending(planned.taskId)) record.llmWaitMs += tick - lastTick
        lastTick = tick
        const res = await this.game.mod.call('arena/status', {})
        if (res?.ok) lastStatus = res.data
        if (reachedAt === null && reached(lastStatus)) reachedAt = this.now()
        if (ended()) break
        if (abortedAt === null && !batch.stopping && task.doomed && lastStatus) {
          const reason = task.doomed(ctx, picked, lastStatus)
          if (reason) {
            doomed = { reason, at: this.now() }
            abortedAt = this.now()
            current.phase = '无法挽回，中止中'
            this.abortRun(sessionId, planned, reason, 'arena')
            try {
              this.cancelTurn(sessionId, reason)
            } catch (error) {
              this.log(`[train] 取消会话 ${sessionId} 的回合失败：${error?.message ?? error}`)
            }
            continue
          }
        }
        if (abortedAt !== null) {
          if (this.now() - abortedAt > SETTLE_TIMEOUT_MS) {
            record.error = 'task did not stop within 30s after abort'
            break
          }
          continue
        }
        if (batch.stopping) {
          stopped = true
          abortedAt = this.now()
          this.abortRun(sessionId, planned, 'training stopped (/bt train stop)', 'user')
        } else if (this.now() - t0 - record.llmWaitMs > timeoutSec * 1000 || this.now() - t0 > wallTimeoutSec * 1000) {
          timedOut = true
          abortedAt = this.now()
          current.phase = '超时，中止中'
          const reason = this.now() - t0 > wallTimeoutSec * 1000
            ? `训练超时：总用时超过 ${wallTimeoutSec} 秒`
            : `训练超时：不算等 LLM 回合的用时超过 ${timeoutSec} 秒`
          record.error = reason
          this.abortRun(sessionId, planned, reason, 'timeout')
          // 规划 / 修补回合还在跑的话一并取消：请求已经关了，回合再做也交不上
          try {
            this.cancelTurn(sessionId, reason)
          } catch (error) {
            this.log(`[train] 取消会话 ${sessionId} 的回合失败：${error?.message ?? error}`)
          }
        }
      }

      current.phase = '结束本轮'
      if (task.settle) await task.settle(ctx, picked, this.hookHelpers())
      const finished = await this.game.mod.call('arena/finish', { arena, origin })
      const final = finished?.ok ? finished.data : lastStatus
      if (!finished?.ok) record.error ??= `arena/finish: ${finished?.error ?? 'no response'}`
      const openedAtMs = final?.openedAtMs ?? null
      finishRecord({
        ...task.finish(ctx, picked, { final, stopped, timedOut, taskState: state.taskEnd?.state ?? 'failed', t0, reachedAt, now: this.now(), doomed }),
        openedMs: openedAtMs !== null ? openedAtMs - t0 : null,
        stationIntact: final?.stationIntact ?? null,
        taskMs: state.taskEnd ? state.taskEnd.at - t0 : null,
        insideArena: final?.insideArena ?? null,
        treeVersions: state.taskEnd?.version ?? null,
        nodeCalls: state.nodeCalls,
        capsules: [...state.refs].sort()
      })
      if (state.taskEnd?.result && state.taskEnd.state === 'failed') record.taskResult = state.taskEnd.result
      if (!state.taskEnd && !stopped && !timedOut && !doomed) record.error ??= 'planning closed without a tree'
    } finally {
      this.executor.off('task', onTask)
      this.executor.off('event', onEvent)
      offCall?.()
    }

    // 复盘 / 整理结束后再统计：它们的回合不算进本轮，但要等它们结束才能开下一轮
    // 自动复盘另开会话（2026-11-07）：本轮会话和复盘会话都要空闲
    current.phase = '等复盘 / 整理结束'
    await this.waitIdle(() => [sessionId, ...(this.bridge.reviewSessions?.(record.taskId) ?? [])], batch)
    const reviewSessions = (this.bridge.reviewSessions?.(record.taskId) ?? []).filter((id) => id !== sessionId)
    if (reviewSessions.length) finishRecord({ reviewSessions })
    const turns = this.turnsOf(record.taskId, sessionId)
    const plan = [...this.bridge.requests.values()].find((r) => r.type === 'plan' && r.taskId === record.taskId)
    // 代码草稿单独提交设计方案 D7：本任务所有请求里坏工具参数 JSON 的回合数、bt_write_code 写成的草稿数
    const taskRequests = record.taskId ? [...this.bridge.requests.values()].filter((r) => r.taskId === record.taskId) : []
    finishRecord({
      planAttempts: plan ? plan.invalidAttempts + (plan.answered ? 1 : 0) : 0,
      malformedTurns: taskRequests.reduce((n, r) => n + (r.malformedTurns ?? 0), 0),
      draftWrites: taskRequests.reduce((n, r) => n + (r.draftWrites ?? 0), 0),
      // 事实库写入挪到复盘设计方案 E6：任务回合查源码的次数、复盘写成的事实条数
      sourceReads: taskRequests.reduce((n, r) => n + (r.sourceReads ?? 0), 0),
      factWrites: taskRequests.reduce((n, r) => n + (r.factWrites ?? 0), 0),
      turns: turns.length,
      tokens: sumTurnUsage(this.sessionEvents(sessionId), turns, this.deriveUsage)
    })
    // 任务历史（任务历史方案 H10）：给记录打上训练标记，成本指标抄进训练记录
    const hist = record.taskId && this.history?.annotate(record.taskId, {
      training: { arena, batch: batch.id, run, seed, outcome: record.outcome, ...task.annotate(record) }
    })
    if (hist) {
      const { execMs, waitMs, modCalls, actions, reads } = hist.metrics ?? {}
      finishRecord({
        execMs, waitMs, modCalls, actions, reads,
        assessed: Boolean(hist.assessment), issues: hist.assessment?.issues?.length ?? 0,
        predecessors: hist.predecessors ?? [],
        reviewed: hist.assessment?.review?.length ?? 0,
        resolved: (hist.assessment?.review ?? []).filter((r) => r.status === 'resolved').length
      })
    }
    return record
  }

  /** 题型异步钩子（ready、settle）用的工具：mod 调用、等待、当前时刻 */
  hookHelpers() {
    return { call: (method, params) => this.game.mod.call(method, params), sleep: (ms) => this.sleep(ms), now: () => this.now() }
  }

  /** 本任务有没有在等 LLM 回合：规划 / 展开 / 修补请求开着（复盘、整理不算）。 */
  llmPending(taskId) {
    for (const req of this.bridge.requests?.values?.() ?? []) {
      if (req.taskId !== taskId || AFTER_TASK_REQUESTS.includes(req.type)) continue
      if (this.bridge.isOpen ? this.bridge.isOpen(req) : !(req.answered || req.closed)) return true
    }
    return false
  }

  /** 规划请求关掉了却没有任务（大纲次数用完、被中止）。 */
  planFailed(planned, state) {
    const req = this.bridge.requests.get(planned.requestId)
    return Boolean(req?.closed) && !state.taskSeen && this.executor.task?.taskId !== planned.taskId
  }

  abortRun(sessionId, planned, reason, by) {
    const task = this.executor.task
    try {
      if (task?.taskId === planned.taskId && ['running', 'suspended', 'paused'].includes(task.state)) {
        this.executor.abortTask(reason, { by })
      } else {
        this.bridge.abort({ sessionId, requestId: planned.requestId, reason })
      }
    } catch (error) {
      this.log(`[train] abort failed: ${error.message}`)
    }
  }

  /** 本任务的规划、修补、展开请求绑定过的回合号（不含复盘、整理）。 */
  turnsOf(taskId, sessionId) {
    if (!taskId) return []
    const turns = new Set()
    for (const req of this.bridge.requests.values()) {
      if (req.taskId !== taskId || AFTER_TASK_REQUESTS.includes(req.type)) continue
      for (const bound of req.boundTurns ?? []) if (bound.sessionId === sessionId) turns.add(bound.turn)
    }
    return [...turns].sort((a, b) => a - b)
  }

  /**
   * 等到没有任务、请求；给了会话还要等这些会话空闲（sessions：会话 id、数组，或每次现取的函数）。
   * 会话不在了 → false；要停止时也 → false。
   */
  async waitIdle(sessions, batch) {
    for (;;) {
      if (batch.stopping && !this.bridge.busyReason()) return false
      while (this.bridge.busyReason()) {
        // 要停了：复盘 / 整理回合不等它做完——放弃请求、取消回合；再等不下来（回合不响应取消）就不等了
        if (batch.stopping) {
          if (!batch.reviewsAbandoned) {
            batch.reviewsAbandoned = true
            this.interruptReviews()
          }
          if (this.now() - batch.stoppingAt > SETTLE_TIMEOUT_MS) {
            this.log(`[train] ${batch.id}：停止时还在忙（${this.bridge.busyReason()}），不再等`)
            return false
          }
        }
        await this.sleep(this.config.pollMs)
      }
      if (batch.stopping) return false
      const ids = [...new Set([typeof sessions === 'function' ? sessions() : sessions].flat().filter(Boolean))]
      for (const id of ids) if (!(await this.whenIdle(id))) return false
      if (!this.bridge.busyReason()) return !batch.stopping
    }
  }

  /** 停止训练：放弃在飞的复盘 / 整理请求，并取消它们所在会话的当前回合。 */
  interruptReviews() {
    const reason = 'training stopped (/bt train stop)'
    for (const sessionId of this.bridge.abandonReviews?.(reason) ?? []) {
      try {
        this.cancelTurn(sessionId, reason)
      } catch (error) {
        this.log(`[train] 取消会话 ${sessionId} 的回合失败：${error?.message ?? error}`)
      }
    }
  }

  write(arena, record) {
    if (!this.runtimeDir) return
    const { setupFailed, ...line } = record
    const dir = path.join(this.runtimeDir, 'training')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `${arena}.jsonl`), JSON.stringify(line) + '\n')
  }
}
