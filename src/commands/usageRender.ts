// /usage 输出的纯渲染函数 —— 从 builtins.ts 内联闭包抽出，便于单测（见 EVAL-001 F3）。
//
// 输入是 usageStats 的累计快照，输出是 /usage 显示的整段文本。无副作用、不读全局。
// 同一 model-id 跨两个 provider 会是两行，故每行带 provider 区分（见 EVAL-001 F4）。

import type { ModelUsage } from '../state/usageStats'
import { computeCost } from '../api/pricing'

const tok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
    : String(n)

/** 把累计 usage 行渲染成 Markdown 表格（由 renderMarkdown 渲染为 indigo 边框表格）。空 → 提示语。 */
export function renderUsage(rows: ModelUsage[]): string {
  if (rows.length === 0) {
    return 'No model usage yet this session.'
  }

  let totalTokens = 0
  let totalUsd = 0
  let anyUnpriced = false

  const rows_md = rows.map(r => {
    const cache = r.cacheRead + r.cacheCreation
    totalTokens += r.input + r.output + cache
    const { usd, local } = computeCost(r.model, r.provider, {
      input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation,
    })
    let costStr: string
    if (local) costStr = 'local·free'
    else if (usd === null) { anyUnpriced = true; costStr = '—' }
    else { totalUsd += usd; costStr = `$${usd.toFixed(2)}` }
    return `| ${r.provider}/${r.model} | ${tok(r.input)} | ${tok(r.output)} | ${tok(cache)} | ${costStr} |`
  })

  const parts = [
    '**Session usage**',
    '',
    '| Model | Input | Output | Cache | Cost |',
    '|---|---|---|---|---|',
    ...rows_md,
    '',
    `  **Total:** ${tok(totalTokens)} tokens · $${totalUsd.toFixed(2)} USD`,
  ]
  if (anyUnpriced) {
    parts.push('', '  _Some models are unpriced — add them to `src/api/pricing.ts` to include their cost._')
  }
  return parts.join('\n')
}
