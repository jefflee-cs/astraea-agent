// 进程级会话推理强度（reasoning effort）单例 —— 对应 /reason 命令的"会话设置"层。
// 设计同 sessionMode.ts：模块级单例，API 适配器在发请求时读取，无需 React 线程化。
//
// 与 effort 指令（claude-code）一脉相承：用户用 /reason 设一个等级，决定模型"思考多努力"。
// 但 Astraea 是多 provider，最终值要按 provider 映射成各自的原生参数（见 api/reasoningEffort.ts）。

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

const LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max']

export function isReasoningEffort(v: string): v is ReasoningEffort {
  return (LEVELS as readonly string[]).includes(v)
}

// 会话态：undefined = 用户本次未手动设（走 env 或 provider 默认）。
let _sessionEffort: ReasoningEffort | undefined

export function getSessionEffort(): ReasoningEffort | undefined {
  return _sessionEffort
}

export function setSessionEffort(value: ReasoningEffort): void {
  _sessionEffort = value
}

/** /reason auto —— 清除会话设置，回到"自动"（env 或 provider 默认）。 */
export function unsetSessionEffort(): void {
  _sessionEffort = undefined
}
