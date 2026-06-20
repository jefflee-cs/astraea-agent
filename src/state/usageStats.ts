// session 级 token 用量累计 —— /usage 命令的数据源。进程级单例。
//
// 为什么是单例、且独立于 contextTokens：
//   - contextTokens 只存「最近一次响应的上下文大小」（给压缩阈值用），且 /clear 时归零。
//   - usageStats 是「本进程开机至今累计花了多少 token / 多少钱」，跨所有 turn、跨主对话与
//     子 agent 累加，/clear 不动它（钱已经花了，清对话历史不该让花费凭空消失）。
//   - 只有进程退出才归零；/login 切 provider 也不清（历史花费照算）。
//
// 打点位置：src/api/stream.ts 的 streamMessage 收口处。所有 LLM 调用都穿过它
// （主对话 / 子 agent / 记忆提取 / 压缩摘要），在那里拦截 message_stop 的 usage 调
// recordUsage，于是「全部计入，零遗漏」。

export interface ModelUsage {
  model: string
  provider: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 该模型被调用的次数（一次 message_stop = 一次）。 */
  calls: number
}

// key = `${provider}:${model}`，避免不同 provider 同名模型串账。
const stats = new Map<string, ModelUsage>()

interface RawUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** streamMessage 每次 message_stop 调用：把这一笔 usage 累加到对应模型。 */
export function recordUsage(model: string, provider: string, usage: RawUsage): void {
  const key = `${provider}:${model}`
  const cur = stats.get(key) ?? {
    model, provider, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, calls: 0,
  }
  cur.input += usage.input_tokens || 0
  cur.output += usage.output_tokens || 0
  cur.cacheRead += usage.cache_read_input_tokens || 0
  cur.cacheCreation += usage.cache_creation_input_tokens || 0
  cur.calls += 1
  stats.set(key, cur)
}

/** 当前累计快照（按 token 总量降序，花得多的模型排前面）。 */
export function getUsageStats(): ModelUsage[] {
  return [...stats.values()].sort(
    (a, b) =>
      (b.input + b.output + b.cacheRead + b.cacheCreation) -
      (a.input + a.output + a.cacheRead + a.cacheCreation),
  )
}

/** 清空累计（一般只在测试里用；正常进程生命周期内不调）。 */
export function resetUsageStats(): void {
  stats.clear()
}
