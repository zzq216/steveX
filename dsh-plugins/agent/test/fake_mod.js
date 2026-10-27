import fs from 'node:fs'

/**
 * 假 mod：在内存里模拟够用的客户端行为，返回格式与真 mod 的 container/get / inventory / f3 / player 一致。
 * 不被 node:test 当作测试文件（没有 test() 调用）。
 *
 * 菜单点击语义照 vanilla：PICKUP 左键整摞拿起 / 放下 / 合并 / 交换，右键在光标有物品时放 1 个；
 * QUICK_MOVE 在产物格上反复合成直到材料用完；SWAP 与快捷栏 button 号交换。
 * 合成结果按 data/recipes.json 算（它在这里扮演服务端，所以可以知道配方）；文件不存在时产物格恒为空。
 */
const RECIPES_FILE = new URL('../data/recipes.json', import.meta.url)
let recipes = null
export function allRecipes() {
  recipes ??= fs.existsSync(RECIPES_FILE) ? JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8')).recipes : []
  return recipes
}

/** 网格内容（cell → 物品 id）是否构成这条配方（含平移与左右镜像）。 */
function matchesGrid(recipe, grid, size) {
  const filled = [...grid.entries()].filter(([, id]) => id)
  if (recipe.type === 'shapeless') {
    if (filled.length !== recipe.ingredients.length) return false
    const used = new Set()
    return recipe.ingredients.every((options) => {
      const i = filled.findIndex(([, id], idx) => !used.has(idx) && options.includes(id))
      if (i < 0) return false
      used.add(i)
      return true
    })
  }
  const height = recipe.pattern.length
  const width = Math.max(...recipe.pattern.map((row) => row.length))
  for (let dr = 0; dr + height <= size; dr++) {
    for (let dc = 0; dc + width <= size; dc++) {
      for (const mirror of [false, true]) {
        let ok = true
        for (let r = 0; r < size && ok; r++) {
          for (let c = 0; c < size && ok; c++) {
            const pr = r - dr
            const inside = pr >= 0 && pr < height && c - dc >= 0 && c - dc < width
            const pc = mirror ? width - 1 - (c - dc) : c - dc
            const ch = inside ? (recipe.pattern[pr][pc] ?? ' ') : ' '
            const id = grid.get(r * size + c)
            ok = ch === ' ' ? !id : Boolean(id) && recipe.key[ch].includes(id)
          }
        }
        if (ok) return true
      }
    }
  }
  return false
}

const LAYOUTS = {
  inventory: { size: 2, grid: [1, 2, 3, 4], toMenu: (i) => (i <= 8 ? 36 + i : i) },
  crafting: { size: 3, grid: [1, 2, 3, 4, 5, 6, 7, 8, 9], toMenu: (i) => (i <= 8 ? 37 + i : i + 1) }
}

export class FakeMod {
  constructor({ inventory = {}, blocks = {}, position = [0, 64, 0], health = 20, air = 300 } = {}) {
    this.inv = new Array(36).fill(null)
    for (const [slot, [id, count]] of Object.entries(inventory)) this.inv[Number(slot)] = { id: ns(id), count }
    this.blocks = new Map(Object.entries(blocks).map(([key, id]) => [key, ns(id)]))
    this.position = position
    this.health = health
    this.air = air
    this.inWater = false
    this.onFire = false
    this.inLava = false
    this.lastDamage = null // { type, ticksAgo, attacker? }
    this.screen = 'none'
    this.grid = new Map()
    this.carried = null
    this.selected = 0
    this.target = null
    this.pressed = new Set()
    this.calls = []
    this.digTicks = 2
    this.digProgress = 0
    this.failNext = new Map() // method → error text（下一次调用失败）
    this.deathMessage = null
  }

  async call(method, params = {}) {
    this.calls.push([method, params])
    if (this.failNext.has(method)) {
      const error = this.failNext.get(method)
      this.failNext.delete(method)
      return { ok: false, error }
    }
    try {
      const data = this.handle(method, params)
      return { ok: true, data: data ?? { status: 'ok' } }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  handle(method, p) {
    if (method.startsWith('key/') && 'pressed' in p) {
      if (p.pressed) this.pressed.add(method)
      else this.pressed.delete(method)
      if (method === 'key/attack' && !p.pressed) this.digProgress = 0
      return
    }
    switch (method) {
      case 'player':
        return {
          vitals: { health: this.health.toFixed(1), maxHealth: '20.0', food: 20, air: this.air },
          flags: { onGround: true, inWater: this.inWater, sprinting: false, sneaking: false, onFire: this.onFire, inLava: this.inLava, inPowderSnow: false },
          effects: [],
          attributes: { 'minecraft:block_interaction_range': { base: '4.50', value: '4.50' } },
          dead: this.health <= 0,
          deathMessage: this.health <= 0 ? this.deathMessage : null,
          lastDamage: this.lastDamage
        }
      case 'player/respawn':
        if (this.health > 0) throw new Error('player is not dead')
        if (this.hardcore) throw new Error('hardcore world: cannot respawn')
        this.health = 20
        this.deathMessage = null
        this.onFire = false
        this.inLava = false
        this.lastDamage = null
        this.inv.fill(null)
        return { status: 'ok' }
      case 'inventory':
        return { slots: this.inv.flatMap((s, i) => (s ? [{ slot: i, ...s, maxStack: 64 }] : [])) }
      case 'f3':
        this.advanceDig()
        return {
          position: { xyz: this.position.map((v) => v.toFixed(3)) },
          target: { block: this.target && this.blocks.has(key(this.target)) ? { id: this.blocks.get(key(this.target)), ...this.target } : null }
        }
      case 'container/get':
        return this.containerView()
      case 'container/close':
        this.closeScreen()
        return
      case 'container/slot':
        this.click(p.slot, p.button ?? 0, p.clickType ?? 0)
        return
      case 'key/inventory':
        if (this.screen === 'none') this.screen = 'inventory'
        return
      case 'key/hotbar':
        this.selected = p.slot
        return
      case 'camera/look-at': {
        const cell = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
        this.target = this.blocks.has(key(cell)) ? cell : null
        return
      }
      case 'key/use-once':
        this.useOnce()
        return
      default:
        return
    }
  }

  advanceDig() {
    if (!this.pressed.has('key/attack') || !this.target || !this.blocks.has(key(this.target))) return
    if (++this.digProgress < this.digTicks) return
    const id = this.blocks.get(key(this.target))
    this.blocks.delete(key(this.target))
    this.digProgress = 0
    this.addToInventory({ id, count: 1 })
  }

  useOnce() {
    if (!this.target) return
    const id = this.blocks.get(key(this.target))
    if (id === 'minecraft:crafting_table') {
      this.screen = 'crafting'
      return
    }
    const held = this.inv[this.selected]
    if (!held) return
    const above = { ...this.target, y: this.target.y + 1 }
    if (this.blocks.has(key(above))) return
    this.blocks.set(key(above), held.id)
    if (--held.count === 0) this.inv[this.selected] = null
  }

  // ── 菜单 ──
  layout() {
    const layout = LAYOUTS[this.screen]
    if (!layout) throw new Error(`no menu for screen ${this.screen}`)
    return layout
  }

  /** 菜单下标 → { get(), set(stack) }。 */
  slotRef(index) {
    const layout = this.layout()
    const gridPos = layout.grid.indexOf(index)
    if (gridPos >= 0) {
      return { kind: 'grid', get: () => this.grid.get(gridPos) ?? null, set: (s) => (s ? this.grid.set(gridPos, s) : this.grid.delete(gridPos)) }
    }
    if (index === 0) return { kind: 'result', get: () => this.result(), set: () => {} }
    for (let i = 0; i < 36; i++) {
      if (layout.toMenu(i) === index) return { kind: 'player', inv: i, get: () => this.inv[i], set: (s) => { this.inv[i] = s } }
    }
    throw new Error(`no slot ${index} in ${this.screen}`)
  }

  result() {
    const size = this.layout().size
    const ids = new Map([...this.grid].map(([pos, s]) => [pos, s.id]))
    if (ids.size === 0) return null
    const recipe = allRecipes().find((r) => matchesGrid(r, ids, size))
    return recipe ? { id: recipe.result, count: recipe.count, recipe } : null
  }

  click(index, button, clickType) {
    const ref = this.slotRef(index)
    if (clickType === 1) {
      if (ref.kind === 'result') {
        let res
        while ((res = this.result())) {
          if (!this.addToInventory({ id: res.id, count: res.count })) break
          for (const [pos, s] of [...this.grid]) {
            if (--s.count === 0) this.grid.delete(pos)
          }
        }
      } else {
        const stack = ref.get()
        if (stack && this.addToInventory(stack)) ref.set(null)
      }
      return
    }
    if (clickType === 2) {
      const hot = this.inv[button]
      this.inv[button] = ref.get()
      ref.set(hot)
      return
    }
    if (ref.kind === 'result') return
    const stack = ref.get()
    if (button === 0) {
      if (!this.carried) { this.carried = stack; ref.set(null) }
      else if (!stack) { ref.set(this.carried); this.carried = null }
      else if (stack.id === this.carried.id) { stack.count += this.carried.count; this.carried = null }
      else { ref.set(this.carried); this.carried = stack }
      return
    }
    if (!this.carried) {
      if (!stack) return
      const half = Math.ceil(stack.count / 2)
      this.carried = { id: stack.id, count: half }
      stack.count -= half
      if (stack.count === 0) ref.set(null)
      return
    }
    if (!stack) ref.set({ id: this.carried.id, count: 1 })
    else if (stack.id === this.carried.id) stack.count++
    else return
    if (--this.carried.count === 0) this.carried = null
  }

  addToInventory(stack) {
    const same = this.inv.findIndex((s) => s && s.id === stack.id && s.count + stack.count <= 64)
    if (same >= 0) { this.inv[same].count += stack.count; return true }
    const empty = this.inv.findIndex((s) => !s)
    if (empty < 0) return false
    this.inv[empty] = { id: stack.id, count: stack.count }
    return true
  }

  closeScreen() {
    if (this.screen === 'none') return
    for (const s of this.grid.values()) this.addToInventory(s)
    this.grid.clear()
    if (this.carried) this.addToInventory(this.carried)
    this.carried = null
    this.screen = 'none'
  }

  containerView() {
    if (this.screen === 'none') return { type: 'none', slots: [] }
    const layout = this.layout()
    const slots = []
    const res = this.result()
    if (res) slots.push({ slot: 0, id: res.id, count: res.count })
    for (const [pos, s] of this.grid) slots.push({ slot: layout.grid[pos], ...s })
    this.inv.forEach((s, i) => { if (s) slots.push({ slot: layout.toMenu(i), ...s }) })
    slots.sort((a, b) => a.slot - b.slot)
    const view = { type: this.screen, slots }
    if (this.carried) view.carriedItem = { slot: -2, ...this.carried }
    return view
  }

  count(id) {
    return this.inv.filter((s) => s && s.id === ns(id)).reduce((n, s) => n + s.count, 0)
  }
}

function ns(id) {
  return id.includes(':') ? id : `minecraft:${id}`
}

function key({ x, y, z }) {
  return `${x},${y},${z}`
}

export function blockKey(x, y, z) {
  return `${x},${y},${z}`
}
