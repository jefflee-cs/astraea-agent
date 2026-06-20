// 状态色矩阵（State Matrix）—— 终端 ANSI 颜色的语义化单一来源。
//
// 人对颜色的语义感知是本能的：用一致的三色把 Agent 状态「翻译」成颜色，能极大降低
// 用户的认知负载。改一处即可全局换肤；Web 端如需复用，沿用同名语义映射到 CSS 颜色即可。
//
//   success —— 绿：安全、已落盘（工具成功、测试通过、任务交付）。"这部分改动已进盘，别担心。"
//   pending —— 黄：进行中 / 等待 / 需用户介入（思考中、调用收费 API、待授权）。"我在动，请关注。"
//   error   —— 红：报错 / 中断 / 防御触发（工具失败、编译失败、Guardrail、用户主动 /stop）。"出事了，已暂停。"
//
// 约束：只用 ANSI 颜色表达状态，不引入任何 emoji。

export type AgentStatus = 'success' | 'pending' | 'error'

// Ink <Text color> 接受的颜色名。集中在此 → 全局唯一真相源。
export const STATUS_COLOR: Record<AgentStatus, string> = {
  success: 'green',
  pending: 'yellow',
  error: 'red',
}

// 单个工具调用状态 → 语义颜色（ToolBatch 调用头用）。
//   running → 黄（进行中）  done → 绿（已落盘）  error → 红（失败）
export function toolStatusColor(status: 'running' | 'done' | 'error'): string {
  if (status === 'error') return STATUS_COLOR.error
  if (status === 'running') return STATUS_COLOR.pending
  return STATUS_COLOR.success
}

// Astraea 自述结论（verdict）的语义色 —— 与工具/状态行的色彩「刻意区分」。
// 工具行用 ANSI 'green'（偏亮的浅绿）；verdict 文本用深绿 #2e7d32，让一句结论不会被
// 误读成一行工具调用。红/黄无碰撞顾虑，沿用标准名即可（工具/状态本就用同名）。
//   ok   —— 深绿：成功 / 通过 / 全部解决（"这一轮交付了，放心。"）
//   warn —— 黄：有遗留 / 待用户操作 / 未做完（"做完 X，还剩 Y，要我接着做吗？"）
//   err  —— 红：失败 / 报错 / 中断（"测试 fail，已暂停。"）
export const VERDICT_COLOR = {
  ok: '#2e7d32',
  warn: 'yellow',
  err: 'red',
} as const

export type VerdictKind = keyof typeof VERDICT_COLOR

// 折叠组的聚合颜色：任一失败 → 红；否则任一在跑 → 黄；全部完成 → 绿。
export function aggregateStatusColor(
  statuses: Array<'running' | 'done' | 'error'>,
): string {
  if (statuses.some(s => s === 'error')) return STATUS_COLOR.error
  if (statuses.some(s => s === 'running')) return STATUS_COLOR.pending
  return STATUS_COLOR.success
}
