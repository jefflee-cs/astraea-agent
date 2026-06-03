// WebBrowserTool — 浏览器交互工具（当前为降级实现）
// 参考文档: Astraea Development/v1.0/工具系统/网络执行层/WebBrowserTool 教学文档.md
//
// 设计原则：运行时不可用时返回说明性内容而非抛出异常，
// 让 LLM 可以理解限制并引导用户使用 WebFetch 替代。
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'

type BrowserAction = 'navigate' | 'screenshot' | 'click' | 'type' | 'scroll'

// BrowserDriver 接口 — 真实浏览器引擎的抽象层
// 在 Astraea 获得浏览器运行时后，注入实现此接口的驱动即可
export interface BrowserDriver {
  isAvailable(): boolean
  navigate(url: string): Promise<{ title: string; url: string; content: string }>
  screenshot(): Promise<string>
  click(selector: string): Promise<{ title: string; url: string; content: string }>
  type(selector: string, text: string): Promise<{ title: string; url: string; content: string }>
  scroll(): Promise<{ title: string; url: string; content: string }>
}
let _driver: BrowserDriver | null = null
let _initAttempted = false

export function injectBrowserDriver(driver: BrowserDriver): void {
  _driver = driver
  _initAttempted = true
}
export function resetBrowserDriver(): void {
  _driver = null
  _initAttempted = false
}
async function lazyInit(): Promise<void> {
  if (_initAttempted) return
  _initAttempted = true
  try {
    const { createPlaywrightDriver } = await import('./PlaywrightDriver.js')
    _driver = await createPlaywrightDriver()
  } catch {
    // playwright not installed or browser binaries missing — remain unavailable
  }
}
export const WebBrowserTool = buildTool({
  name: 'WebBrowser',
  description: `Interact with web pages using an embedded browser: navigate, screenshot, click, type, scroll.

Use for JavaScript-heavy SPAs, authenticated pages, or UI interaction testing.
NOTE: Requires browser runtime. If unavailable, use WebFetch for static content instead.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to operate on',
      },
      action: {
        type: 'string',
        enum: ['navigate', 'screenshot', 'click', 'type', 'scroll'],
        description: 'Browser action to perform (default: navigate)',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for click or type actions',
      },
      text: {
        type: 'string',
        description: 'Text to input, used with action=type',
      },
    },
    required: ['url'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const url = input['url'] as string
    const action = (input['action'] as BrowserAction | undefined) ?? 'navigate'
    const selector = input['selector'] as string | undefined
    const text = input['text'] as string | undefined

    await lazyInit()

    const driver = _driver
    if (!driver || !driver.isAvailable()) {
      return {
        output: [
          `[WebBrowser] 浏览器运行时不可用 (browser runtime unavailable)。`,
          `URL: ${url}  Action: ${action}`,
          '',
          'Playwright 未安装或浏览器二进制缺失 (Playwright not installed or browser binaries missing)。',
          'Run: bun add playwright && bunx playwright install chromium',
          '降级方案：改用 WebFetch 抓取静态内容 (fall back to WebFetch for static content)。',
        ].join('\n'),
        isError: false,
      }
    }

    try {
      switch (action) {
        case 'navigate': {
          const state = await driver.navigate(url)
          return { output: `[WebBrowser] navigate → ${state.url}\n标题：${state.title}\n\n${state.content}` }
        }
        case 'screenshot': {
          const base64 = await driver.screenshot()
          return { output: `[WebBrowser] screenshot 完成（Base64 PNG，${base64.length} 字符）\n${base64}` }
        }
        case 'click': {
          if (!selector) return { output: 'Error: click 操作需要提供 selector', isError: true }
          const state = await driver.click(selector)
          return { output: `[WebBrowser] click "${selector}" → ${state.url}\n${state.content}` }
        }
        case 'type': {
          if (!selector) return { output: 'Error: type 操作需要提供 selector', isError: true }
          if (text === undefined) return { output: 'Error: type 操作需要提供 text', isError: true }
          const state = await driver.type(selector, text)
          return { output: `[WebBrowser] type "${text}" into "${selector}" 完成\n${state.content}` }
        }
        case 'scroll': {
          const state = await driver.scroll()
          return { output: `[WebBrowser] scroll 完成\n${state.content}` }
        }
        default:
          return { output: `Error: 未知 action "${action}"`, isError: true }
      }
    } catch (err: unknown) {
      return { output: `Browser error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
})
