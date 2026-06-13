// ─────────────────────────────────────────────────────────────────────────────
// 总电源（client）—— 初始化/关闭 OTel Provider，并缓存 @arizeai/phoenix-otel 命名空间。
// 对标 claude-code: src/services/langfuse/client.ts
//
// 设计要点：
//   • 懒加载 + fail-open —— 用 `await import()` 动态加载 phoenix-otel。
//     未设 PHOENIX_ENABLED / 未 `bun add` 该依赖 / register 抛错 → 一律降级 no-op，
//     astraea 主流程绝不受影响（连"包没装"都不会让进程崩）。
//   • 路线 B 用「手工建 span」，不依赖自动埋点，因此不要求"早于 SDK import 初始化"——
//     在 query() 顶部调一次 initPhoenix() 即可覆盖所有入口（CLI/REPL/headless/子 agent）。
//   • 默认即时导出（batch=false）：CLI 单发跑完即退，避免 BatchSpanProcessor 缓冲丢 span。
//     高吞吐场景设 PHOENIX_BATCH=1 切回批量。
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

let otel: any = null // 缓存的 @arizeai/phoenix-otel 命名空间（含 trace/context/SemanticConventions…）
let provider: any = null // register() 返回的 TracerProvider（带 forceFlush/shutdown）
let initialized = false

/** 是否启用（显式开关，默认关 → 零开销）。 */
export function isPhoenixEnabled(): boolean {
  const v = process.env.PHOENIX_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** 是否「真正激活」：启用 + 依赖已加载成功。所有建 span 的 helper 据此 fail-open。 */
export function isPhoenixActive(): boolean {
  return otel !== null
}

/** 取缓存的 phoenix-otel 命名空间（未激活时为 null）。 */
export function getOtel(): any {
  return otel
}

/** 取 astraea 专用 tracer（未激活时为 null）。 */
export function getTracer(): any {
  if (!otel) return null
  try {
    return otel.trace.getTracer('astraea')
  } catch {
    return null
  }
}

/** 进程内调一次即可（幂等）。建议放在 query() 顶部。 */
export async function initPhoenix(): Promise<void> {
  if (initialized) return
  initialized = true
  if (!isPhoenixEnabled()) return

  try {
    // 可选依赖：未 `bun add @arizeai/phoenix-otel` 时此处在运行时被 catch 降级，
    // ts-ignore 让核心在「依赖未安装」状态下仍能 typecheck 通过（fail-open 的延伸）。
    // @ts-ignore optional peer dependency, resolved at runtime
    const mod: any = await import('@arizeai/phoenix-otel')
    provider = mod.register({
      projectName: process.env.PHOENIX_PROJECT ?? 'astraea',
      url: process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006',
      apiKey: process.env.PHOENIX_API_KEY,
      batch: process.env.PHOENIX_BATCH === '1', // 默认 false = 即时导出
    })
    otel = mod

    // 进程自然退出时兜底 flush（不劫持 SIGINT/SIGTERM，避免干扰 REPL 自己的 Ctrl+C 处理）
    process.once('beforeExit', () => {
      void provider?.forceFlush?.().catch(() => {})
    })
  } catch (e) {
    console.error('[phoenix] 初始化失败，已降级为 no-op：', (e as Error).message)
    otel = null
    provider = null
  }
}

/** 显式刷盘并关闭。用于会主动 process.exit() 的路径（如 headless），防止丢最后几个 span。 */
export async function shutdownPhoenix(): Promise<void> {
  try {
    await provider?.forceFlush?.()
    await provider?.shutdown?.()
  } catch {
    /* ignore */
  } finally {
    otel = null
    provider = null
  }
}
