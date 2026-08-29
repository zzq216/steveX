// ── steveX Agents page ──
// Rendering + event handlers for the agent management view.
//
// 底层已改为透传采集端 mod 的 48 方法（steveX_改进方案.md）：原"Send Command"
// 自由文本框改为"Call Mod Method"结构化调用（POST /api/mod/:method）。
// 卡片同时展示该 agent 的 mod 连接状态（host:port / connected / busy）。

import { getState, subscribe } from '../lib/state.js'
import { connectAgent, disconnectAgent, callModMethod, fetchModMethods } from '../lib/api.js'
import { escapeHtml } from '../lib/utils.js'
import { hydrateIcons } from '../lib/icons.js'

const PLACEHOLDER = {
  health: 20,
  maxHealth: 20,
  mode: 'Survival',
  model: 'deepseek-v4-flash',
  position: { x: '~', y: '~', z: '~' },
  action: 'Idle',
  mod: { host: null, port: null, connected: false, busy: false, error: '' }
}

// Backend getStatus() already returns canonical field names.
// Fall back to PLACEHOLDER only when a field is truly missing.
function getAgentView(agent) {
  return {
    health: agent.health ?? PLACEHOLDER.health,
    maxHealth: agent.maxHealth ?? PLACEHOLDER.maxHealth,
    mode: agent.gameMode ?? PLACEHOLDER.mode,
    model: agent.model ?? PLACEHOLDER.model,
    position: agent.position ?? PLACEHOLDER.position,
    action: agent.currentAction ?? PLACEHOLDER.action,
    mod: agent.mod ?? PLACEHOLDER.mod
  }
}

function formatPosition(position) {
  const pos = position || PLACEHOLDER.position

  const x = pos.x ?? '~'
  const y = pos.y ?? '~'
  const z = pos.z ?? '~'

  return `x: ${x}, y: ${y}, z: ${z}`
}

function getHealthPercent(health, maxHealth) {
  if (!maxHealth || maxHealth <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((health / maxHealth) * 100)))
}

// ── Filter / sort ──

function filteredAgents() {
  const { agents, filters } = getState()
  const query = filters.query.toLowerCase()

  let list = agents.filter(agent => {
    const matchText = agent.name.toLowerCase().includes(query)
    const matchStatus =
      filters.status === 'all' ||
      (filters.status === 'online' ? agent.online : !agent.online)
    return matchText && matchStatus
  })

  list.sort((a, b) => {
    if (filters.sortBy === 'status') {
      return Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
    }

    if (filters.sortBy === 'health') {
      const ah = getAgentView(a).health
      const bh = getAgentView(b).health
      return bh - ah || a.name.localeCompare(b.name)
    }

    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  return list
}

// ── mod 方法清单（填充 Call Mod Method 下拉）──

let METHOD_LIST = []

function methodOptionsHtml() {
  return METHOD_LIST.map(m => `<option value="${m.method}">${m.method}</option>`).join('')
}

function syncMethodSelects() {
  document.querySelectorAll('.method-select').forEach(sel => {
    const current = sel.value
    sel.innerHTML = `<option value="">— select method —</option>${methodOptionsHtml()}`
    if (current) sel.value = current
  })
}

async function loadMethodList() {
  try {
    METHOD_LIST = (await fetchModMethods()) || []
  } catch (err) {
    console.error('[agents] Failed to load mod methods:', err)
    METHOD_LIST = []
  }
  syncMethodSelects()
}

// ── Agent card template ──

function agentCardHtml(agent) {
  const statusClass = agent.online ? 'online' : 'offline'
  const statusText = agent.online ? 'online' : 'offline'
  const username = agent.username || '—'

  const view = getAgentView(agent)
  const percent = getHealthPercent(view.health, view.maxHealth)
  const position = formatPosition(view.position)

  const mod = view.mod
  const modDot = mod.connected ? (mod.busy ? 'busy' : 'online') : 'offline'
  const modEndpoint = mod.host ? `${escapeHtml(mod.host)}:${escapeHtml(mod.port)}` : '—'
  const modBusyTag = mod.connected && mod.busy ? '<span class="pill busy-pill">busy</span>' : ''

  return `
    <article class="agent-card" data-agent-name="${escapeHtml(agent.name)}">
      <div class="agent-header">
        <div class="agent-id">
          <h2>${escapeHtml(agent.name)}</h2>
          <span class="dot ${statusClass}" aria-hidden="true"></span>
          <span class="state-label" data-status="${agent.online ? 'online' : 'offline'}">${statusText}</span>
          <span class="pill username-pill" style="margin-left:8px;color:var(--muted);font-size:14px">${escapeHtml(username)}</span>
        </div>

        <div class="agent-actions">
          <button class="btn soft-success" type="button" data-action="connect" data-agent="${escapeHtml(agent.name)}">
            <span data-icon="link"></span>
            Connect
          </button>
          <button class="btn soft-danger" type="button" data-action="disconnect" data-agent="${escapeHtml(agent.name)}">
            <span data-icon="unlink"></span>
            Disconnect
          </button>
          <button class="btn ghost" type="button" data-action="log" data-agent="${escapeHtml(agent.name)}">
            <span data-icon="logs"></span>
            Agent Log
          </button>
        </div>
      </div>

      <div class="agent-body">
        <div class="stats-panel">
          <div class="stats-column">
            <div class="stat-row">
              <div class="stat-label">Health</div>
              <div class="stat-value">
                <span data-icon="heart"></span>
                <span class="health-wrap">
                  <span class="health-number">${view.health} / ${view.maxHealth}</span>
                  <span class="health-bar" aria-label="Health ${percent}%">
                    <span class="health-fill" style="--health:${percent}%"></span>
                  </span>
                </span>
              </div>
            </div>

            <div class="stat-row">
              <div class="stat-label">Game Mode</div>
              <div class="stat-value"><span data-icon="gamepad"></span>${escapeHtml(view.mode)}</div>
            </div>

            <div class="stat-row">
              <div class="stat-label">Model</div>
              <div class="stat-value"><span data-icon="brain"></span>${escapeHtml(view.model)}</div>
            </div>
          </div>

          <div class="stats-column">
            <div class="stat-row">
              <div class="stat-label">Position</div>
              <div class="stat-value"><span data-icon="pin"></span>${escapeHtml(position)}</div>
            </div>

            <div class="stat-row">
              <div class="stat-label">Current Action</div>
              <div class="stat-value"><span data-icon="walk"></span>${escapeHtml(view.action)}</div>
            </div>

            <div class="stat-row">
              <div class="stat-label">Mod</div>
              <div class="stat-value">
                <span class="dot ${modDot}" aria-hidden="true"></span>
                <span class="mod-endpoint">${modEndpoint}</span>
                ${modBusyTag}
              </div>
            </div>
          </div>
        </div>

        <div class="command-stack">
          <form class="command-panel" data-action="modcall">
            <div class="command-title">Call Mod Method <span>(Phase A 单连接：作用于已 Connect 的 mod)</span></div>
            <div class="command-row">
              <select name="method" class="method-select" aria-label="mod method">
                <option value="">— select method —</option>
                ${methodOptionsHtml()}
              </select>
              <button class="btn send" type="submit">Send</button>
            </div>
            <div class="command-row">
              <textarea name="params" class="method-params" rows="2" placeholder='Params JSON (optional) — e.g. {"pressed": true}' spellcheck="false"></textarea>
            </div>
            <pre class="mod-result" hidden></pre>
          </form>

          <form class="command-panel" data-action="modbatch">
            <div class="command-title">Mod Batch <span>(多行序列 + delay:毫秒 前缀，逐条走 /api/mod)</span></div>
            <div class="command-row">
              <textarea name="batch" class="method-params batch-input" rows="5" spellcheck="false"
                placeholder='每行一条：可选 delay:毫秒 前缀 + JSON
{"method":"key/up","params":{"pressed":true}}
delay:3000 {"method":"key/up","params":{"pressed":true}}
{"method":"key/right","params":{"pressed":true}}'></textarea>
            </div>
            <div class="command-row">
              <button class="btn send" type="submit">Run Batch</button>
              <button class="btn ghost" type="button" data-action="stop-batch" hidden>Stop</button>
            </div>
            <pre class="mod-result batch-result" hidden></pre>
          </form>
        </div>
      </div>
    </article>
  `
}

// ── Log modal ──

function showLogModal(name) {
  // Remove any existing modal
  const existing = document.getElementById('log-modal')
  if (existing) existing.remove()

  const entries = getState().logs[name] || []

  const modal = document.createElement('div')
  modal.id = 'log-modal'
  modal.className = 'log-modal-overlay'
  modal.innerHTML = `
    <div class="log-modal">
      <div class="log-modal-header">
        <h2>${escapeHtml(name)} <span>Agent Log</span></h2>
        <button class="log-modal-close" type="button">&times;</button>
      </div>
      <div class="log-modal-body">
        ${entries.length === 0 ? '<div class="log-empty">No log entries yet.</div>' : ''}
      </div>
    </div>
  `

  document.body.appendChild(modal)

  // Populate existing entries
  const body = modal.querySelector('.log-modal-body')
  for (const entry of entries) {
    body.appendChild(buildLogEntryEl(entry))
  }
  body.scrollTop = body.scrollHeight

  // Close handlers
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('.log-modal-close')) {
      modal.remove()
    }
  })

  // Subscribe for live updates while modal is open
  const unsub = subscribe(() => {
    if (!document.getElementById('log-modal')) {
      unsub()
      return
    }

    const currentEntries = getState().logs[name] || []
    const currentCount = body.children.length - (body.querySelector('.log-empty') ? 1 : 0)

    const empty = body.querySelector('.log-empty')
    if (empty && currentEntries.length > 0) empty.remove()

    for (let i = currentCount; i < currentEntries.length; i++) {
      body.appendChild(buildLogEntryEl(currentEntries[i]))
    }

    body.scrollTop = body.scrollHeight
  })
}

function buildLogEntryEl(entry) {
  const el = document.createElement('div')
  el.className = `log-entry ${entry.type}`

  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString()

  let html = ''
  switch (entry.type) {
    case 'cmd-start':
      html = `<span class="log-time">${time}</span> <span class="log-tag">[CMD]</span> → ${escapeHtml(entry.command)}`
      break
    case 'cmd-done':
      html = `<span class="log-time">${time}</span> <span class="log-tag">[CMD]</span> ← ${escapeHtml(entry.command)}<br>${escapeHtml(entry.output)}`
      break
    case 'cmd-error':
      html = `<span class="log-time">${time}</span> <span class="log-tag">[CMD]</span> ✕ ${escapeHtml(entry.command)}<br>${escapeHtml(entry.output)}`
      break
    case 'llm-input':
      html = `<span class="log-time">${time}</span> <span class="log-tag">[LLM]</span> → <em>${escapeHtml(entry.model)}</em><br>${escapeHtml(entry.prompt ? entry.prompt.slice(0, 2000) + (entry.prompt.length > 2000 ? '…' : '') : '')}`
      break
    case 'llm-output':
      html = `<span class="log-time">${time}</span> <span class="log-tag">[LLM]</span> ← <em>${escapeHtml(entry.model)}</em><br>${escapeHtml(entry.response ? entry.response.slice(0, 2000) + (entry.response.length > 2000 ? '…' : '') : '')}`
      break
  }

  el.innerHTML = html
  return el
}

// ── Render the full agents list ──

export function renderAgents(container) {
  const list = filteredAgents()

  if (!list.length) {
    container.innerHTML = '<div class="empty-state">No agents match the current filters.</div>'
    return
  }

  // Smart diff: update existing cards, add new ones, remove gone ones
  const existingNames = new Set()

  list.forEach(agent => {
    existingNames.add(agent.name)

    let card = container.querySelector(`.agent-card[data-agent-name="${escapeHtml(agent.name)}"]`)

    if (!card) {
      const temp = document.createElement('div')
      temp.innerHTML = agentCardHtml(agent)
      card = temp.firstElementChild
      container.appendChild(card)
      hydrateIcons(card)
    }

    // Update dynamic parts without full re-render
    updateDynamicFields(card, agent)
  })

  // Remove cards for agents that no longer exist
  container.querySelectorAll('.agent-card').forEach(card => {
    if (!existingNames.has(card.dataset.agentName)) {
      card.remove()
    }
  })
}

function updateDynamicFields(card, agent) {
  const statusClass = agent.online ? 'online' : 'offline'
  const statusText = agent.online ? 'online' : 'offline'

  const view = getAgentView(agent)
  const percent = getHealthPercent(view.health, view.maxHealth)
  const position = formatPosition(view.position)

  const mod = view.mod
  const modDot = mod.connected ? (mod.busy ? 'busy' : 'online') : 'offline'
  const modEndpoint = mod.host ? `${mod.host}:${mod.port}` : '—'

  // Header dot + state label
  const dot = card.querySelector('.agent-id .dot')
  if (dot) dot.className = `dot ${statusClass}`

  const label = card.querySelector('.agent-id .state-label')
  if (label) {
    label.textContent = statusText
    label.dataset.status = statusClass
  }

  // Username pill
  const usernamePill = card.querySelector('.username-pill')
  if (usernamePill) {
    usernamePill.textContent = agent.username || '—'
  }

  // Update each stat row by label
  const statRows = card.querySelectorAll('.stat-row')

  statRows.forEach(row => {
    const lbl = row.querySelector('.stat-label')
    const val = row.querySelector('.stat-value')
    if (!lbl || !val) return

    const name = lbl.textContent.trim()

    if (name === 'Health') {
      const healthNumber = row.querySelector('.health-number')
      if (healthNumber) {
        healthNumber.textContent = `${view.health} / ${view.maxHealth}`
      }

      const healthBar = row.querySelector('.health-bar')
      if (healthBar) {
        healthBar.setAttribute('aria-label', `Health ${percent}%`)
      }

      const healthFill = row.querySelector('.health-fill')
      if (healthFill) {
        healthFill.style.setProperty('--health', `${percent}%`)
      }
    }

    if (name === 'Game Mode') {
      val.innerHTML = `<span data-icon="gamepad"></span>${escapeHtml(view.mode)}`
      hydrateIcons(val)
    }

    if (name === 'Model') {
      val.innerHTML = `<span data-icon="brain"></span>${escapeHtml(view.model)}`
      hydrateIcons(val)
    }

    if (name === 'Position') {
      val.innerHTML = `<span data-icon="pin"></span>${escapeHtml(position)}`
      hydrateIcons(val)
    }

    if (name === 'Current Action') {
      val.innerHTML = `<span data-icon="walk"></span>${escapeHtml(view.action)}`
      hydrateIcons(val)
    }

    if (name === 'Mod') {
      const busyTag = mod.connected && mod.busy ? '<span class="pill busy-pill">busy</span>' : ''
      val.innerHTML = `
        <span class="dot ${modDot}" aria-hidden="true"></span>
        <span class="mod-endpoint">${escapeHtml(modEndpoint)}</span>
        ${busyTag}
      `
    }
  })
}

// ── Event delegation ──

function handleClick(e) {
  const btn = e.target.closest('button[data-action]')
  if (!btn) return

  const name = btn.dataset.agent
  const action = btn.dataset.action

  if (action === 'connect') {
    connectAgent(name)
  } else if (action === 'disconnect') {
    disconnectAgent(name)
  } else if (action === 'log') {
    showLogModal(name)
  } else if (action === 'stop-batch') {
    const form = btn.closest('form.command-panel')
    if (form) form.dataset.batchRunning = '0'
  }
}

async function handleSubmit(e) {
  const form = e.target.closest('form.command-panel')
  if (!form) return

  e.preventDefault()

  const name = form.dataset.agent
  const action = form.dataset.action

  if (action === 'modcall') {
    const method = form.querySelector('select[name="method"]').value
    const raw = form.querySelector('textarea[name="params"]').value.trim()

    if (!method) {
      alert('Select a mod method first')
      return
    }

    let params = {}
    if (raw) {
      try {
        params = JSON.parse(raw)
      } catch {
        alert('Params must be valid JSON or empty')
        return
      }
    }

    const resultEl = form.querySelector('.mod-result')
    resultEl.hidden = false
    resultEl.className = 'mod-result'
    resultEl.textContent = `Calling ${method} …`

    const result = await callModMethod(method, params)

    if (result.ok) {
      resultEl.className = 'mod-result ok'
      resultEl.textContent = `${method} → ${JSON.stringify(result.data, null, 2)}`
    } else {
      resultEl.className = 'mod-result err'
      resultEl.textContent = `${method} ✕ ${result.error || 'unknown error'}`
    }
  }

  if (action === 'modbatch') {
    runModBatch(form)
  }
}

// ── Mod Batch 批量执行（多行 + delay:毫秒 前缀）──
// 语法与 control_panel.html 一致：每行一条 JSON，可用 delay:N 前缀插入等待。
// 与单方法面板的区别只在编排层：这里逐条解析并按序 await，最后走同一个
// /api/mod/:method 透传，所以延时时序在浏览器端完成，mod 端能力不变。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseBatchLine(line) {
  let rest = line.trim()
  if (!rest || rest.startsWith('#') || rest.startsWith('//')) return null

  let delayMs = 0
  const delayMatch = rest.match(/^delay:(\d+)\s+/)
  if (delayMatch) {
    delayMs = parseInt(delayMatch[1], 10) || 0
    rest = rest.slice(delayMatch[0].length).trim()
  }

  let obj
  try {
    obj = JSON.parse(rest)
  } catch {
    return { error: `invalid JSON: ${rest}` }
  }

  if (!obj || typeof obj.method !== 'string' || !obj.method) {
    return { error: `missing method: ${rest}` }
  }

  return {
    method: obj.method,
    params: obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params) ? obj.params : {},
    delayMs
  }
}

async function runModBatch(form) {
  if (form.dataset.batchRunning === '1') return

  const textarea = form.querySelector('textarea[name="batch"]')
  const runBtn = form.querySelector('button[type="submit"]')
  const stopBtn = form.querySelector('[data-action="stop-batch"]')
  const resultEl = form.querySelector('.batch-result')

  const cmds = []
  const errors = []
  textarea.value.split('\n').forEach((line, i) => {
    const c = parseBatchLine(line)
    if (!c) return
    if (c.error) errors.push(`line ${i + 1}: ${c.error}`)
    else cmds.push({ ...c, lineNo: i + 1 })
  })

  if (!cmds.length) {
    alert(errors.length ? `No valid commands:\n${errors.join('\n')}` : 'No commands to run')
    return
  }

  form.dataset.batchRunning = '1'
  runBtn.disabled = true
  stopBtn.hidden = false
  resultEl.hidden = false
  resultEl.className = 'mod-result batch-result'
  resultEl.textContent = errors.length ? errors.join('\n') + '\n\n' : ''

  let completed = true
  for (let i = 0; i < cmds.length; i++) {
    if (form.dataset.batchRunning !== '1') {
      completed = false
      break
    }
    const c = cmds[i]

    if (c.delayMs > 0) {
      resultEl.textContent += `… wait ${c.delayMs}ms → line ${c.lineNo} ${c.method}\n`
      resultEl.scrollTop = resultEl.scrollHeight
      await sleep(c.delayMs)
      if (form.dataset.batchRunning !== '1') {
        completed = false
        break
      }
    }

    resultEl.textContent += `[${i + 1}/${cmds.length}] ${c.method} …\n`
    resultEl.scrollTop = resultEl.scrollHeight
    const result = await callModMethod(c.method, c.params)

    if (result.ok) {
      resultEl.textContent += `[${i + 1}/${cmds.length}] ${c.method} → ${JSON.stringify(result.data)}\n`
      resultEl.className = 'mod-result batch-result ok'
    } else {
      resultEl.textContent += `[${i + 1}/${cmds.length}] ${c.method} ✕ ${result.error || 'unknown error'}\n`
      resultEl.className = 'mod-result batch-result err'
    }
    resultEl.scrollTop = resultEl.scrollHeight
  }

  form.dataset.batchRunning = '0'
  runBtn.disabled = false
  stopBtn.hidden = true
  resultEl.textContent += completed ? '— batch finished —\n' : '— batch stopped —\n'
  resultEl.scrollTop = resultEl.scrollHeight
}

// ── Init ──

export function initAgents(container) {
  container.addEventListener('click', handleClick)
  container.addEventListener('submit', handleSubmit)
  loadMethodList()
}
