/**
 * 系统提示词里的"清单"分段（集成方案 §6.3 第 3、4 项）：命令名 + 一句话、胶囊库摘要。
 * 详细参数用 command_docs / capsule_get 查，这里只让大模型知道"有什么"。
 * 命令表很少变；胶囊库只在保存新胶囊时变——两者都不是每回合变的东西，不破坏 KV 缓存前缀。
 */
export function renderCatalog({ registry, library }) {
  const lines = ['# 可用的命令与胶囊', '', '## 命令（参数用 command_docs 查；read 的只能在条件代码 / Compute 的 read 里间接使用）', '']
  for (const doc of registry.docs()) {
    lines.push(`- \`${doc.name}\`${doc.read ? '（read）' : ''}：${firstClause(doc.description)}`)
  }
  lines.push('', '## 胶囊库（契约与正文用 capsule_get 查）', '')
  const rows = library.list().filter((row) => !row.draft)
  if (rows.length === 0) lines.push('（空）')
  for (const row of rows) lines.push(`- \`${row.ref.replace(/@[0-9a-f]+$/, '')}\`（${row.kind}）：${row.description || '无说明'}`)
  return lines.join('\n')
}

/** 方法说明的第一句（mod 的中文说明很长，后面是参数细节）。 */
function firstClause(text) {
  const head = String(text ?? '').split(/[；;。\n]/)[0].trim()
  return head.length > 60 ? `${head.slice(0, 59)}…` : head
}
