// 全局配置 — 从环境变量读取，不硬编码敏感值
//
// 加载优先级（低 → 高，高优先级覆盖低优先级）：
//   1. ~/.astraea/.env           — 用户个人全局 secrets（API key 放这里，一次配置所有项目生效）
//   2. <project>/.env            — 项目级覆盖（开发调试用，勿提交 key）
//   3. ~/.astraea/settings.json 的 env 块 — 行为开关（如 PHOENIX_ENABLED）
//   4. shell 环境变量             — 最高优先级
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { getSettings } from './settings'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const envPath = join(__dirname, '..', '.env')
export const globalEnvPath = join(homedir(), '.astraea', '.env')

function loadEnvFile(path: string): void {
  try {
    const lines = readFileSync(path, 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      // 不覆盖已存在的值（shell 环境变量 > 项目 .env > 全局 .env）
      if (key && !(key in process.env)) process.env[key] = val
    }
  } catch {
    // 文件不存在则跳过
  }
}

// 把 ~/.astraea/settings.json 的 env 块灌进 process.env（沿用"不覆盖已存在值"规则）。
// 在 .env 之前应用 → 仅 shell 已设的值能压过它；之后 .env 只填它没设的 key。
// 即优先级：shell > settings.json > 项目 .env > 全局 .env。
function applySettingsEnv(): void {
  const env = getSettings().env
  if (!env) return
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === 'string' && !(key in process.env)) process.env[key] = val
  }
}

// 加载顺序：settings.json 先于 .env；项目 .env 先于全局 .env。
// loadEnvFile / applySettingsEnv 都用 !(key in process.env) 跳过已存在的值，所以：
//   shell 环境变量 > settings.json > 项目 .env > ~/.astraea/.env
applySettingsEnv()         // 先吃 settings.json 的 env，让它占位（shell 已占的除外）
loadEnvFile(envPath)       // 再加载项目级，只填它没设的 key
loadEnvFile(globalEnvPath) // 最后全局，只填仍缺的 key

export type Provider = 'anthropic' | 'deepseek' | 'ollama' | 'openai'

function detectProvider(): Provider {
  const raw = process.env.PROVIDER?.toLowerCase()
  if (raw === 'ollama') return 'ollama'
  if (raw === 'openai') return 'openai'
  if (raw === 'deepseek') return 'deepseek'
  return 'anthropic'
}

// 输出 token 上限 — 旧值统一 8192，对自包含 HTML/SVG 这类大产物会自我缩水或中途截断。
// 各 provider 默认提到对应模型的真实上限；可用 <PROVIDER>_MAX_TOKENS 环境变量覆盖。
function maxTokensFrom(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// 上下文窗口（total context window）— 与 maxTokens 对称的 per-provider 配置。
// 各 provider/model 真实窗口差异极大（本地 8K ~ Anthropic 1M），不能写死一个常量，
// 必须按 provider 给默认值并支持 <PROVIDER>_CONTEXT_WINDOW 覆盖。详见上下文设计文档 §1。
function contextWindowFrom(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// autocompact 总开关：默认开；ASTRAEA_AUTOCOMPACT 设为 0/false/off/no → 关闭。
// 关闭时不自动压缩，改走 0.98 硬阻塞，强制用户手动 /compact（设计文档 §4/§9）。
function autocompactEnabledFrom(): boolean {
  const raw = process.env.ASTRAEA_AUTOCOMPACT?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

// Eclipse（上下文折叠）总开关：默认【关】；ASTRAEA_ECLIPSE 设为 1/true/on/yes → 开启。
// 开启时：后台 ctx-agent 周期折叠中段、0.85 提交、0.95 阻塞现折，且压制主动 autocompact。
function eclipseEnabledFrom(): boolean {
  const raw = process.env.ASTRAEA_ECLIPSE?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

// 提前解析，供 maxTokens 的模型相关默认值复用（gpt-5.x vs gpt-4o 输出预算不同）
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4o'

export const config = {
  provider: detectProvider() as Provider,

  // autocompact 总开关（设计文档 §9）。关闭时走 0.98 硬阻塞。
  autocompact: autocompactEnabledFrom(),

  // Eclipse 折叠总开关（默认关）。开启时压制主动 autocompact，由折叠接管 0.85~0.95 带。
  eclipse: eclipseEnabledFrom(),

  // ctx-agent 可选模型覆盖：默认用 querySmallModel 的 per-provider 小模型；
  // 设了就用它（如想用更强模型提升折叠摘要保真度，不影响 WebFetch 等其它小模型调用方）。
  ctxAgentModel: process.env.CTX_AGENT_MODEL?.trim() || undefined,

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    // Sonnet 4.x 支持 64k 输出；32k 与 Claude Code 对齐，留足大文件余量。
    maxTokens: maxTokensFrom('ANTHROPIC_MAX_TOKENS', 32000),
    // 默认 200K（人人可用的安全窗口）；需要 1M 的人用 env 开。Sonnet 4.6/Opus 真实窗口是 1M。
    contextWindow: contextWindowFrom('ANTHROPIC_CONTEXT_WINDOW', 200_000),
  },

  // DeepSeek — OpenAI-compatible API
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    // deepseek-chat 输出硬上限即 8192。
    maxTokens: maxTokensFrom('DEEPSEEK_MAX_TOKENS', 8192),
    contextWindow: contextWindowFrom('DEEPSEEK_CONTEXT_WINDOW', 128_000),
  },

  // Ollama（本地）
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
    // 本地模型受显存/上下文限制，保守默认，按需用 OLLAMA_MAX_TOKENS 调高。
    maxTokens: maxTokensFrom('OLLAMA_MAX_TOKENS', 8192),
    // 本地窗口由 num_ctx 决定，保守默认 32K，须按实际模型用 OLLAMA_CONTEXT_WINDOW 调。
    contextWindow: contextWindowFrom('OLLAMA_CONTEXT_WINDOW', 32_000),
  },

  // OpenAI（云端）
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: openaiModel,
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    // gpt-5.x 支持 128K 输出；给它 32k 单次产物余量（足够大型自包含 HTML），gpt-4o 维持 16384 硬上限。
    maxTokens: maxTokensFrom('OPENAI_MAX_TOKENS', /^gpt-5/i.test(openaiModel) ? 32000 : 16384),
    contextWindow: contextWindowFrom('OPENAI_CONTEXT_WINDOW', 128_000),
    // gpt-5.x 推理强度：none|low|medium|high|xhigh，默认 medium。仅对 reasoning 模型生效。
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT?.trim() || undefined,
  },
}

// 当前激活 provider 的窗口与输出上限 —— 阈值每次现算时调用（设计文档 §6：阈值现算随 provider）。
export function activeContextWindow(): number {
  switch (config.provider) {
    case 'deepseek': return config.deepseek.contextWindow
    case 'ollama':   return config.ollama.contextWindow
    case 'openai':   return config.openai.contextWindow
    default:         return config.anthropic.contextWindow
  }
}

export function activeMaxTokens(): number {
  switch (config.provider) {
    case 'deepseek': return config.deepseek.maxTokens
    case 'ollama':   return config.ollama.maxTokens
    case 'openai':   return config.openai.maxTokens
    default:         return config.anthropic.maxTokens
  }
}

// 当前激活 provider 是否已配置可用的 API Key。
// ollama 走本地、无需 key，视为永远「已配置」。
export function hasValidConfig(): boolean {
  switch (config.provider) {
    case 'anthropic': return !!config.anthropic.apiKey
    case 'deepseek':  return !!config.deepseek.apiKey
    case 'openai':    return !!config.openai.apiKey
    case 'ollama':    return true
    default:          return false
  }
}

export function assertConfig(): void {
  if (config.provider === 'anthropic' && !config.anthropic.apiKey) {
    console.error('Error: ANTHROPIC_API_KEY is not set (or run /login)')
    process.exit(1)
  }
  if (config.provider === 'deepseek' && !config.deepseek.apiKey) {
    console.error('Error: DEEPSEEK_API_KEY is not set (or run /login)')
    process.exit(1)
  }
  if (config.provider === 'openai' && !config.openai.apiKey) {
    console.error('Error: OPENAI_API_KEY is not set (or run /login)')
    process.exit(1)
  }
}

export function updateProviderConfig(provider: Provider, model: string, apiKey: string): void {
  config.provider = provider
  switch (provider) {
    case 'anthropic':
      config.anthropic.apiKey = apiKey
      config.anthropic.model = model
      break
    case 'deepseek':
      config.deepseek.apiKey = apiKey
      config.deepseek.model = model
      break
    case 'openai':
      config.openai.apiKey = apiKey
      config.openai.model = model
      break
  }
}

export async function saveConfigToEnv(): Promise<void> {
  const content = [
    '# ─── Provider 选择 ───────────────────────────────────────',
    `PROVIDER=${config.provider}`,
    '',
    '# ─── Anthropic ──────────────────────────────────────────',
    `ANTHROPIC_API_KEY=${config.anthropic.apiKey}`,
    `ANTHROPIC_MODEL=${config.anthropic.model}`,
    '',
    '# ─── DeepSeek ───────────────────────────────────────────',
    `DEEPSEEK_API_KEY=${config.deepseek.apiKey}`,
    `DEEPSEEK_MODEL=${config.deepseek.model}`,
    '',
    '# ─── Ollama（本地）────────────────────────────────────────',
    `# OLLAMA_BASE_URL=${config.ollama.baseUrl}`,
    `# OLLAMA_MODEL=${config.ollama.model}`,
    '',
    '# ─── OpenAI ─────────────────────────────────────────────',
    `OPENAI_API_KEY=${config.openai.apiKey}`,
    `OPENAI_MODEL=${config.openai.model}`,
    `OPENAI_BASE_URL=${config.openai.baseUrl}`,
    '',
  ].join('\n')
  await Bun.write(envPath, content)
}
