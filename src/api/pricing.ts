// 模型价目表 + 成本换算 —— /usage 命令用。
//
// 为什么要这张表：模型 API 只在响应里返回 token 数量（usage），从不返回美元金额。
// 「花了多少钱」必须本地算 = token 数 × 单价。单价随模型不同，逐模型登记在这里。
//
// 开了 prompt caching 后，input 被服务器拆成三笔，价格倍率各不同：
//   input_tokens          → 基础 input 价
//   cache_read_input_*    → 基础 input 价 × 0.1   （命中缓存读取，省 90%）
//   cache_creation_input_*→ 基础 input 价 × 1.25  （写入 5 分钟 ephemeral 缓存，贵 25%）
// 非 Anthropic provider 不返回 cache 两项 → 缺省为 0 → 公式自动退化成 input×in + output×out。
//
// ollama 是本地模型，零成本；表里查不到的模型记为「未定价」（显 token、cost 标 —）。

export const CACHE_READ_MULT = 0.1
export const CACHE_WRITE_MULT = 1.25 // 5 分钟 ephemeral；若改用 1h TTL 应为 2.0

export interface ModelPrice {
  /** 每百万 input token 美元价 */
  inputPerMTok: number
  /** 每百万 output token 美元价 */
  outputPerMTok: number
}

// 按 model-id 前缀匹配（取最长匹配命中），避免逐个登记日期后缀变体。
// Anthropic 价格核对自 claude-api 参考（2026-06）。DeepSeek/OpenAI 为公开价目近似，
// 价格调整时请直接改这里。ollama 不登记（本地免费，特判）。
const PRICING: Record<string, ModelPrice> = {
  // ── Anthropic ──
  'claude-fable-5':    { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5':   { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-4-8':   { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-opus-4-7':   { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-opus-4-6':   { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-opus-4-5':   { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-sonnet-4-6': { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-haiku-4-5':  { inputPerMTok: 1,  outputPerMTok: 5 },

  // ── DeepSeek（公开价目近似，请核对） ──
  'deepseek-chat':     { inputPerMTok: 0.27, outputPerMTok: 1.10 },
  'deepseek-reasoner': { inputPerMTok: 0.55, outputPerMTok: 2.19 },

  // ── OpenAI（公开价目近似，请核对） ──
  'gpt-4o-mini':       { inputPerMTok: 0.15, outputPerMTok: 0.60 },
  'gpt-4o':            { inputPerMTok: 2.50, outputPerMTok: 10 },
}

/** 本地 provider（无 API 计费）。这些模型成本恒为 $0。 */
export function isLocalProvider(provider: string): boolean {
  return provider === 'ollama'
}

/** 查某模型单价；未登记返回 null（→ 上层标「未定价」）。 */
export function lookupPrice(model: string): ModelPrice | null {
  const exact = PRICING[model]
  if (exact) return exact
  // 前缀匹配：取能命中的最长 key（如带后缀的 'claude-haiku-4-5-20251001'）。
  let best: string | null = null
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  return best ? PRICING[best]! : null
}

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export interface CostResult {
  /** 美元成本；null = 未定价（模型不在表里且非本地）。 */
  usd: number | null
  /** true = 本地模型，恒 $0。 */
  local: boolean
}

/** 按价目表把一组 token 用量换算成美元。 */
export function computeCost(model: string, provider: string, t: UsageTokens): CostResult {
  if (isLocalProvider(provider)) return { usd: 0, local: true }
  const price = lookupPrice(model)
  if (!price) return { usd: null, local: false }
  const usd =
    (t.input * price.inputPerMTok +
      t.cacheRead * price.inputPerMTok * CACHE_READ_MULT +
      t.cacheCreation * price.inputPerMTok * CACHE_WRITE_MULT +
      t.output * price.outputPerMTok) /
    1_000_000
  return { usd, local: false }
}
