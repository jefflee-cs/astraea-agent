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

/** 把累计 usage 行渲染成 /usage 文本。空 → 提示语；否则逐行 + 合计 + 未定价说明。 */
export function renderUsage(rows: ModelUsage[]): string {
  if (rows.length === 0) {
    return 'No model usage yet this session.'
  }

  // 列宽按「provider/model」标签对齐，使带 provider 的行也整齐。
  const label = (r: ModelUsage) => `${r.provider}/${r.model}`
  const labelW = Math.max(...rows.map(r => label(r).length))
  let totalTokens = 0
  let totalUsd = 0
  let anyUnpriced = false

  const lines = rows.map(r => {
    const cache = r.cacheRead + r.cacheCreation
    totalTokens += r.input + r.output + cache
    const { usd, local } = computeCost(r.model, r.provider, {
      input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation,
    })
    let costStr: string
    if (local) costStr = 'local·free'
    else if (usd === null) { anyUnpriced = true; costStr = '— (unpriced)' }
    else { totalUsd += usd; costStr = `$${usd.toFixed(2)}` }
    return `  ${label(r).padEnd(labelW)}  in ${tok(r.input).padStart(6)}  out ${tok(r.output).padStart(6)}  cache ${tok(cache).padStart(6)}  ${costStr}`
  })

  const parts = ['**Session usage**', '', ...lines, '',
    `  Total  ${tok(totalTokens)} tokens · $${totalUsd.toFixed(2)} USD`]
  if (anyUnpriced) {
    parts.push('', '  Some models are unpriced — add them to `src/api/pricing.ts` to include their cost.')
  }
  return parts.join('\n')
}
