import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebBrowserTool, injectBrowserDriver, resetBrowserDriver } from './index.js'
import type { BrowserDriver } from './index.js'

// ─── Mock 浏览器驱动 ──────────────────────────────────────────────────────────

class MockBrowserDriver implements BrowserDriver {
  private _pages = new Map<string, { title: string; content: string }>()
  private _lastScreenshot = 'bW9ja19zY3JlZW5zaG90'  // base64 "mock_screenshot"
  private _available: boolean

  constructor(available = true) {
    this._available = available
  }

  registerPage(url: string, title: string, content: string) {
    this._pages.set(url, { title, content })
  }

  isAvailable() { return this._available }

  async navigate(url: string) {
    const page = this._pages.get(url) ?? { title: 'Mock Page', content: `Mock content for ${url}` }
    return { title: page.title, url, content: page.content }
  }

  async screenshot() { return this._lastScreenshot }

  async click(selector: string) {
    return { title: 'After Click', url: 'https://mock.test', content: `Clicked: ${selector}` }
  }

  async type(selector: string, text: string) {
    return { title: 'After Type', url: 'https://mock.test', content: `Typed "${text}" into ${selector}` }
  }

  async scroll() {
    return { title: 'After Scroll', url: 'https://mock.test', content: 'Loaded more content after scroll' }
  }
}

describe('WebBrowserTool — 运行时不可用', () => {
  // ⚠️ 不能用 resetBrowserDriver() 来制造「不可用」状态：lazyInit() 会在 Playwright
  // 已安装的机器上自动拉起真实浏览器，于是测试在装了 Playwright 的环境（CI / 本机）
  // 会失败。改为显式注入一个 isAvailable()=false 的 mock 驱动，确定性地走「不可用」分支，
  // 与运行环境是否装了 Playwright 解耦。
  beforeEach(() => injectBrowserDriver(new MockBrowserDriver(false)))
  afterEach(() => resetBrowserDriver())

  test('无驱动时返回说明性内容（不报错）', async () => {
    const result = await WebBrowserTool.call({ url: 'https://app.example.com', action: 'navigate' }, { mode: "default" })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('浏览器运行时不可用')
    expect(result.output).toContain('WebFetch')
  })

  test('任何 action 在无驱动时都返回说明', async () => {
    for (const action of ['navigate', 'screenshot', 'click', 'type', 'scroll'] as const) {
      const result = await WebBrowserTool.call({ url: 'https://example.com', action }, { mode: "default" })
      expect(result.isError).toBeFalsy()
      expect(result.output).toContain('不可用')
    }
  })
})

describe('WebBrowserTool — navigate', () => {
  beforeEach(() => {
    const driver = new MockBrowserDriver()
    driver.registerPage('https://app.example.com/dashboard', 'Dashboard', '欢迎回来，用户。数据加载中...')
    injectBrowserDriver(driver)
  })

  afterEach(() => resetBrowserDriver())

  test('navigate 返回页面内容', async () => {
    const result = await WebBrowserTool.call({ url: 'https://app.example.com/dashboard' }, { mode: "default" })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('Dashboard')
    expect(result.output).toContain('欢迎回来')
  })

  test('action 默认为 navigate', async () => {
    const result = await WebBrowserTool.call({ url: 'https://app.example.com/dashboard' }, { mode: "default" })
    expect(result.output).toContain('[WebBrowser] navigate')
  })
})

describe('WebBrowserTool — screenshot', () => {
  beforeEach(() => injectBrowserDriver(new MockBrowserDriver()))
  afterEach(() => resetBrowserDriver())

  test('screenshot 返回 base64 内容', async () => {
    const result = await WebBrowserTool.call({ url: 'https://example.com', action: 'screenshot' }, { mode: "default" })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('bW9ja19zY3JlZW5zaG90')
    expect(result.output).toContain('screenshot')
  })
})

describe('WebBrowserTool — click & type', () => {
  beforeEach(() => injectBrowserDriver(new MockBrowserDriver()))
  afterEach(() => resetBrowserDriver())

  test('click 需要 selector', async () => {
    const result = await WebBrowserTool.call({ url: 'https://example.com', action: 'click' }, { mode: "default" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('selector')
  })

  test('click 成功执行', async () => {
    const result = await WebBrowserTool.call({
      url: 'https://example.com',
      action: 'click',
      selector: 'button[type="submit"]',
    }, { mode: 'default' })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('Clicked')
    expect(result.output).toContain('button[type="submit"]')
  })

  test('type 需要 selector 和 text', async () => {
    const noSelector = await WebBrowserTool.call({ url: 'https://example.com', action: 'type', text: 'hello' }, { mode: "default" })
    expect(noSelector.isError).toBe(true)

    const noText = await WebBrowserTool.call({ url: 'https://example.com', action: 'type', selector: '#input' }, { mode: "default" })
    expect(noText.isError).toBe(true)
  })

  test('type 成功执行', async () => {
    const result = await WebBrowserTool.call({
      url: 'https://example.com',
      action: 'type',
      selector: '#username',
      text: 'admin',
    }, { mode: 'default' })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('admin')
    expect(result.output).toContain('#username')
  })

  test('scroll 触发懒加载内容', async () => {
    const result = await WebBrowserTool.call({ url: 'https://example.com', action: 'scroll' }, { mode: "default" })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('scroll')
  })
})

describe('WebBrowserTool — 依赖注入验证', () => {
  test('injectBrowserDriver 替换驱动后立即生效', async () => {
    // 同样不用 resetBrowserDriver()（见上文说明）——注入一个不可用驱动来代表「初始无可用驱动」
    injectBrowserDriver(new MockBrowserDriver(false))
    const result1 = await WebBrowserTool.call({ url: 'https://test.com' }, { mode: "default" })
    expect(result1.output).toContain('不可用')

    injectBrowserDriver(new MockBrowserDriver())
    const result2 = await WebBrowserTool.call({ url: 'https://test.com' }, { mode: "default" })
    expect(result2.output).not.toContain('不可用')

    resetBrowserDriver()
  })
})

describe('WebBrowserTool — 工具元数据', () => {
  test('工具名称正确', () => expect(WebBrowserTool.name).toBe('WebBrowser'))
  test('isReadOnly 为 true', () => expect(WebBrowserTool.isReadOnly({})).toBe(true))
  test('inputSchema 包含 url 和 action', () => {
    expect(WebBrowserTool.inputSchema.required).toContain('url')
    expect(WebBrowserTool.inputSchema.properties).toHaveProperty('action')
  })
})
