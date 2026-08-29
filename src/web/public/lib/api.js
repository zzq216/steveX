// ── steveX HTTP API client ──

import { setState } from './state.js'

export async function fetchStatus() {
  const res = await fetch('/api/status')
  const data = await res.json()
  setState({ agents: data.agents, uptimeSec: data.uptimeSec })
  return data
}

export async function reloadConfig() {
  await fetch('/api/reload', { method: 'POST' })
  // Wait a moment for agents to establish connections before checking status
  await new Promise(resolve => setTimeout(resolve, 1500))
  await fetchStatus()
}

export async function connectAgent(name) {
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}/connect`, {
    method: 'POST'
  })
  return res.ok
}

export async function disconnectAgent(name) {
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}/disconnect`, {
    method: 'POST'
  })
  return res.ok
}

// 透传调用采集端 mod 方法（POST /api/mod/:method，body 即 params）
export async function callModMethod(method, params = {}) {
  const res = await fetch(`/api/mod/${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  return res.json()
}

// 获取 mod 48 方法清单（含参数签名与说明）
export async function fetchModMethods() {
  const res = await fetch('/api/mod/methods')
  const data = await res.json()
  return (data && data.methods) || []
}

// 获取 mod 连接状态（GET /api/mod/status）
export async function fetchModStatus() {
  const res = await fetch('/api/mod/status')
  return res.json()
}
export async function fetchEnvConfig() {
  const res = await fetch('/api/config/environment')

  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error || 'Failed to load config')
  }

  return res.json()
}

export async function saveEnvConfig(config) {
  const res = await fetch('/api/config/environment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ config })
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error || 'Failed to save config')
  }

  return res.json()
}