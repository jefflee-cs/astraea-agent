// ─────────────────────────────────────────────────────────────────────────────
// 录像机（tracing）—— 手工建 span，用 OpenInference 语义约定标注 AGENT / LLM / TOOL。
// 对标 claude-code: src/services/langfuse/tracing.ts
//
// 层级（手工搭出来）：
//   createTrace()            → AGENT 根 span（每个 query() 调用 = 一个用户 turn）
//     ├─ recordLLMObservation()  → LLM span（每次模型调用）
//     ├─ recordToolObservation() → TOOL span（每个工具）
//     └─ createChildSpan()       → 供子 agent / side-query 挂在主 trace 下
//   endTrace()               → 关根 span
//
// 与 Langfuse 的唯一差异：Langfuse 用 startObservation(asType)，Phoenix 用
// OTel span + 属性 openinference.span.kind = AGENT/LLM/TOOL（语义约定来自
// @arizeai/openinference-semantic-conventions，由 phoenix-otel re-export）。
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from '../../config'
import { getOtel, getTracer, isPhoenixActive } from './client'
import { sanitizeGlobal, sanitizeToolInput, sanitizeToolOutput } from './sanitize'

/** trace 句柄 —— 在 query() 出生，穿过 ToolContext 传到各调用点。 */
export interface PhoenixTrace {
  /** OTel 根 span（不透明）。 */
  span: any
  sessionId: string
  userId?: string
}

const MIME_JSON = 'application/json'
const MIME_TEXT = 'text/plain'

// provider → 友好的 LLM span 名（对标 claude-code 的 PROVIDER_GENERATION_NAMES）
const PROVIDER_SPAN_NAMES: Record<string, string> = {
  anthropic: 'ChatAnthropic',
  openai: 'ChatOpenAI',
  deepseek: 'ChatDeepSeek',
  kimi: 'ChatKimi',
  ollama: 'ChatOllama',
}

function activeModel(): string {
  switch (config.provider) {
    case 'deepseek':
      return config.deepseek.model
    case 'kimi':
      return config.kimi.model
    case 'ollama':
      return config.ollama.model
    case 'openai':
      return config.openai.model
    default:
      return config.anthropic.model
  }
}

function resolveUserId(): string | undefined {
  return process.env.PHOENIX_USER_ID ?? process.env.USER ?? undefined
}

/** 把任意值转成 {值, MIME}，字符串走 text、其余走 JSON。已脱敏。 */
function asAttrValue(v: unknown): { value: string; mime: string } {
  const safe = sanitizeGlobal(v)
  if (typeof safe === 'string') return { value: safe, mime: MIME_TEXT }
  try {
    return { value: JSON.stringify(safe), mime: MIME_JSON }
  } catch {
    return { value: String(safe), mime: MIME_TEXT }
  }
}

/** 在 parent 之下开一个 OTel span（显式传父上下文，不依赖 async-context 自动传播）。 */
function startChild(parent: any, name: string, startTime?: Date): any {
  const otel = getOtel()
  const tracer = getTracer()
  const parentCtx = otel.trace.setSpan(otel.context.active(), parent)
  return tracer.startSpan(name, startTime ? { startTime } : {}, parentCtx)
}

function setKind(span: any, kind: string): void {
  const { SemanticConventions } = getOtel()
  span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, kind)
}

function setSessionUser(span: any, t: PhoenixTrace): void {
  const { SemanticConventions } = getOtel()
  if (t.sessionId) span.setAttribute(SemanticConventions.SESSION_ID, t.sessionId)
  if (t.userId) span.setAttribute(SemanticConventions.USER_ID, t.userId)
}

// ── 根 trace（一个用户 turn）──────────────────────────────────────────────────

export function createTrace(params: {
  sessionId: string
  input?: unknown
  name?: string
  metadata?: Record<string, unknown>
}): PhoenixTrace | null {
  if (!isPhoenixActive()) return null
  try {
    const otel = getOtel()
    const { SemanticConventions, OpenInferenceSpanKind } = otel
    const tracer = getTracer()
    const span = tracer.startSpan(params.name ?? 'agent-run')
    span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, OpenInferenceSpanKind.AGENT)
    if (params.input !== undefined) {
      const { value, mime } = asAttrValue(params.input)
      span.setAttribute(SemanticConventions.INPUT_VALUE, value)
      span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, mime)
    }
    const userId = resolveUserId()
    const t: PhoenixTrace = { span, sessionId: params.sessionId, userId }
    setSessionUser(span, t)
    span.setAttribute(
      SemanticConventions.METADATA,
      JSON.stringify({ provider: config.provider, model: activeModel(), agentType: 'main', ...params.metadata }),
    )
    return t
  } catch (e) {
    warn('createTrace', e)
    return null
  }
}

// ── LLM span（每次模型调用）────────────────────────────────────────────────────

export function recordLLMObservation(
  trace: PhoenixTrace | null,
  params: {
    input: unknown
    output: unknown
    usage: { input_tokens: number; output_tokens: number }
    model?: string
    startTime?: Date
    endTime?: Date
    /** 首 token 时刻，用于 TTFT。 */
    completionStartTime?: Date
  },
): void {
  if (!trace || !isPhoenixActive()) return
  try {
    const { SemanticConventions, OpenInferenceSpanKind } = getOtel()
    const name = PROVIDER_SPAN_NAMES[config.provider] ?? `Chat_${config.provider}`
    const span = startChild(trace.span, name, params.startTime)
    setKind(span, OpenInferenceSpanKind.LLM)
    setSessionUser(span, trace)

    const model = params.model ?? activeModel()
    span.setAttribute(SemanticConventions.LLM_MODEL_NAME, model)

    const inp = asAttrValue(params.input)
    span.setAttribute(SemanticConventions.INPUT_VALUE, inp.value)
    span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, inp.mime)
    const out = asAttrValue(params.output)
    span.setAttribute(SemanticConventions.OUTPUT_VALUE, out.value)
    span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, out.mime)

    const inTok = params.usage.input_tokens ?? 0
    const outTok = params.usage.output_tokens ?? 0
    span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT, inTok)
    span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, outTok)
    span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_TOTAL, inTok + outTok)

    span.setAttribute(
      SemanticConventions.METADATA,
      JSON.stringify({
        provider: config.provider,
        ...(params.completionStartTime &&
          params.startTime && { ttft_ms: params.completionStartTime.getTime() - params.startTime.getTime() }),
      }),
    )
    span.end(params.endTime)
  } catch (e) {
    warn('recordLLMObservation', e)
  }
}

// ── TOOL span（每个工具调用）──────────────────────────────────────────────────

export function recordToolObservation(
  trace: PhoenixTrace | null,
  params: {
    toolName: string
    toolUseId: string
    input: unknown
    output: string
    isError?: boolean
    startTime?: Date
  },
): void {
  if (!trace || !isPhoenixActive()) return
  try {
    const { SemanticConventions, OpenInferenceSpanKind, SpanStatusCode } = getOtel()
    const span = startChild(trace.span, params.toolName, params.startTime)
    setKind(span, OpenInferenceSpanKind.TOOL)
    setSessionUser(span, trace)

    span.setAttribute(SemanticConventions.TOOL_NAME, params.toolName)
    const inp = asAttrValue(sanitizeToolInput(params.toolName, params.input))
    span.setAttribute(SemanticConventions.INPUT_VALUE, inp.value)
    span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, inp.mime)
    span.setAttribute(SemanticConventions.OUTPUT_VALUE, sanitizeToolOutput(params.toolName, params.output))
    span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MIME_TEXT)
    span.setAttribute(SemanticConventions.METADATA, JSON.stringify({ toolUseId: params.toolUseId, isError: !!params.isError }))

    if (params.isError) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  } catch (e) {
    warn('recordToolObservation', e)
  }
}

// ── 子 span（供子 agent / side-query 挂在主 trace 下）───────────────────────────

export function createChildSpan(
  parent: PhoenixTrace | null,
  params: { name: string; input?: unknown; kind?: 'AGENT' | 'CHAIN' },
): PhoenixTrace | null {
  if (!parent || !isPhoenixActive()) return null
  try {
    const { SemanticConventions, OpenInferenceSpanKind } = getOtel()
    const span = startChild(parent.span, params.name)
    span.setAttribute(
      SemanticConventions.OPENINFERENCE_SPAN_KIND,
      params.kind === 'AGENT' ? OpenInferenceSpanKind.AGENT : OpenInferenceSpanKind.CHAIN,
    )
    if (params.input !== undefined) {
      const { value, mime } = asAttrValue(params.input)
      span.setAttribute(SemanticConventions.INPUT_VALUE, value)
      span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, mime)
    }
    const child: PhoenixTrace = { span, sessionId: parent.sessionId, userId: parent.userId }
    setSessionUser(span, child)
    return child
  } catch (e) {
    warn('createChildSpan', e)
    return null
  }
}

// ── 关 trace ──────────────────────────────────────────────────────────────────

export function endTrace(trace: PhoenixTrace | null, output?: unknown, status?: 'error' | 'interrupted'): void {
  if (!trace) return
  try {
    const { SemanticConventions, SpanStatusCode } = getOtel()
    if (output !== undefined) {
      const { value, mime } = asAttrValue(output)
      trace.span.setAttribute(SemanticConventions.OUTPUT_VALUE, value)
      trace.span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, mime)
    }
    if (status === 'error') trace.span.setStatus({ code: SpanStatusCode.ERROR })
    else if (status === 'interrupted') trace.span.setAttribute('astraea.status', 'interrupted')
    trace.span.end()
  } catch (e) {
    warn('endTrace', e)
  }
}

function warn(where: string, e: unknown): void {
  if (process.env.PHOENIX_DEBUG === '1') console.error(`[phoenix] ${where} failed:`, (e as Error)?.message ?? e)
}
