// 记忆年龄字符串 —— 定稿 §3 决策 #11。
//
// 给模型「人话年龄」而非 ISO 时间戳：模型不擅长日期算术，原始时间戳不触发
// 陈旧性推理，「47 days ago」才会触发「这么久了该核实」。
// 年龄在 attachment 创建时算一次固化（防渲染时重算跨午夜破缓存）—— 见 recall 注入。

/** mtime 到现在的天数（floor）；未来 mtime/时钟漂移 clamp 到 0。 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/** 人话年龄：today / yesterday / N days ago。 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/**
 * >1 天的记忆的陈旧性 caveat（today/yesterday 返回 '' —— 新记忆加警告是噪音）。
 * 用于召回注入：file:line 引用会让过期声明显得更权威，故主动提示核实。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}
