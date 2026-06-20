// 内置命令迁移到统一命令表 —— 实现文档 §1.2/§1.9。
// 内置与 skill 同住 getCommands() 一张表；内置一律 userInvocable、绝不 modelInvocable。
//
// 分类：
//   local-jsx（派发 action tag，App reducer 执行）：/mode //goal /wechat /vigil /login
//                                                  /clear /compact /resume /mcp /plugin
//   local（表内直接跑，返回文本）：/help //model
//
// 迁移策略：App.tsx 收到 slash → findCommand() → 对 local-jsx 把 toAction() 交给 reducer；
// 对 local 调 run() 显示文本。既有面板组件复用，只是触发点统一。

import { config, activeContextWindow } from '../config'
import type { Command, LocalJsxCommand, LocalCommand, CommandAction } from './types'
import { getUsageStats } from '../state/usageStats'
import { computeCost } from '../api/pricing'

function jsx(
  name: string,
  description: string,
  toAction: (args: string | undefined) => CommandAction,
  opts: { argumentHint?: string; hidden?: boolean } = {},
): LocalJsxCommand {
  return {
    type: 'local-jsx',
    name,
    description,
    source: 'builtin',
    userInvocable: true,
    modelInvocable: false,
    argumentHint: opts.argumentHint,
    hidden: opts.hidden,
    toAction,
  }
}

function local(
  name: string,
  description: string,
  run: LocalCommand['run'],
  opts: { argumentHint?: string } = {},
): LocalCommand {
  return {
    type: 'local',
    name,
    description,
    source: 'builtin',
    userInvocable: true,
    modelInvocable: false,
    argumentHint: opts.argumentHint,
    run,
  }
}

let _commandsForHelp: () => Command[] = () => []
/** registry 注入：让 /help 能列出全表（避免循环依赖）。 */
export function _setHelpCommandSource(fn: () => Command[]) {
  _commandsForHelp = fn
}

export function getBuiltinCommands(): Command[] {
  return [
    jsx('mode', 'select session mode: orbit · cruise · forge · counsel · default',
      args => (args?.trim() ? { kind: 'switch-mode', args: args.trim() } : { kind: 'open-mode-panel' }),
      { argumentHint: '[orbit|cruise|forge|counsel|default]' }),

    jsx('goal', 'set a completion condition to work toward',
      args => ({ kind: 'set-goal', args }), { argumentHint: '<condition> | clear' }),

    jsx('wechat', 'summarize WeChat chats now', () => ({ kind: 'wechat-run' }), { hidden: true }),

    jsx('vigil', 'scheduled tasks', () => ({ kind: 'open-vigil-panel' }),
      { argumentHint: '[add|list|delete|wechat]' }),

    jsx('login', 'set API key and provider', () => ({ kind: 'login-wizard' })),

    jsx('internet', 'configure web search provider (Bocha/Zhipu/Tavily…)', () => ({ kind: 'internet-wizard' })),

    jsx('search', 'configure web search provider (alias of /internet)', () => ({ kind: 'internet-wizard' }), { hidden: true }),

    jsx('language', 'choose UI & reply language (en/de/fr/es/zh/ko)',
      args => ({ kind: 'language-wizard', args: args?.trim() }), { argumentHint: '[en|de|fr|es|zh|ko]' }),

    jsx('clear', 'clear conversation history', () => ({ kind: 'clear-history' })),

    jsx('compact', 'compact context now (optional: /compact <focus>)',
      args => ({ kind: 'compact-now', args }), { argumentHint: '[focus]' }),

    jsx('resume', 'resume a past session', () => ({ kind: 'resume-picker' })),

    local('mcp', 'show MCP server connection status', async () => {
      const { getMcpStatus, isMcpInitialized } = await import('../mcp/registry')
      if (!isMcpInitialized()) return { type: 'text', value: 'MCP not initialized yet (connecting at startup).' }
      const status = getMcpStatus()
      if (status.length === 0) {
        return { type: 'text', value: 'No MCP servers configured. Add one with `astraea mcp add …`.' }
      }
      const lines = status.map(s =>
        s.state === 'connected'
          ? `  ✓ ${s.name} [${s.transport}, ${s.scope}] — ${s.toolCount} tools`
          : `  ✗ ${s.name} [${s.transport}, ${s.scope}] — failed: ${s.error ?? 'unknown'}`,
      )
      return { type: 'text', value: ['**MCP servers:**', ...lines].join('\n') }
    }),

    local('plugin', 'show installed plugins & marketplaces', async () => {
      const { listInstalled } = await import('../plugins/installedManager')
      const { listMarketplaces } = await import('../plugins/marketplaceManager')
      const records = listInstalled()
      const mps = listMarketplaces()
      const parts: string[] = []
      parts.push('**Marketplaces:**')
      parts.push(mps.length ? mps.map(m => `  ${m.name} (${m.pluginCount} plugins)`).join('\n') : '  (none — add with `astraea plugin marketplace add <dir>`)')
      parts.push('', '**Installed plugins:**')
      parts.push(records.length ? records.map(r => `  ${r.enabled ? '✓' : '○'} ${r.pluginId} v${r.version} [${r.scope}]`).join('\n') : '  (none)')
      return { type: 'text', value: parts.join('\n') }
    }),

    local('model', 'show current provider, model, and endpoint', async () => {
      const p = config.provider
      const model = (config as unknown as Record<string, { model?: string }>)[p]?.model ?? 'unknown'
      const lines = [
        `**Provider:** ${p}`,
        `**Model:** ${model}`,
        `**Context window:** ${activeContextWindow().toLocaleString()} tokens`,
      ]
      return { type: 'text', value: lines.join('\n') }
    }),

    local('usage', 'show session token usage & cost (USD)', async () => {
      const rows = getUsageStats()
      if (rows.length === 0) {
        return { type: 'text', value: 'No model usage yet this session.' }
      }

      const tok = (n: number) =>
        n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
          : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
          : String(n)

      const modelW = Math.max(...rows.map(r => r.model.length))
      let totalTokens = 0
      let totalUsd = 0
      let anyUnpriced = false

      const lines = rows.map(r => {
        const cache = r.cacheRead + r.cacheCreation
        totalTokens += r.input + r.output + cache
        const { usd, local } = computeCost(r.model, r.provider, {
          input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation,
        })
        let costStr: string
        if (local) costStr = 'local·free'
        else if (usd === null) { anyUnpriced = true; costStr = '— (unpriced)' }
        else { totalUsd += usd; costStr = `$${usd.toFixed(2)}` }
        return `  ${r.model.padEnd(modelW)}  in ${tok(r.input).padStart(6)}  out ${tok(r.output).padStart(6)}  cache ${tok(cache).padStart(6)}  ${costStr}`
      })

      const parts = ['**Session usage**', '', ...lines, '',
        `  Total  ${tok(totalTokens)} tokens · $${totalUsd.toFixed(2)} USD`]
      if (anyUnpriced) {
        parts.push('', '  Some models are unpriced — add them to `src/api/pricing.ts` to include their cost.')
      }
      return { type: 'text', value: parts.join('\n') }
    }),

    local('help', 'show available commands', async () => {
      const { t } = await import('../i18n')
      const cmds = _commandsForHelp().filter(c => c.userInvocable && !c.hidden)
      const builtin = cmds.filter(c => c.source === 'builtin')
      const skills = cmds.filter(c => c.source !== 'builtin')
      const fmt = (c: Command) => `  /${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''} — ${c.description}`
      const parts = [`**${t('helpCommands')}:**`, ...builtin.map(fmt)]
      if (skills.length) parts.push('', `**${t('helpSkills')}:**`, ...skills.map(fmt))
      return { type: 'text', value: parts.join('\n') }
    }),
  ]
}
