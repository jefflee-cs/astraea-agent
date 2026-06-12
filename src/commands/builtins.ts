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

function jsx(
  name: string,
  description: string,
  toAction: (args: string | undefined) => CommandAction,
  opts: { argumentHint?: string } = {},
): LocalJsxCommand {
  return {
    type: 'local-jsx',
    name,
    description,
    source: 'builtin',
    userInvocable: true,
    modelInvocable: false,
    argumentHint: opts.argumentHint,
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

    jsx('wechat', 'summarize WeChat chats now', () => ({ kind: 'wechat-run' })),

    jsx('vigil', 'scheduled tasks', () => ({ kind: 'open-vigil-panel' }),
      { argumentHint: '[add|list|delete|wechat]' }),

    jsx('login', 'set API key and provider', () => ({ kind: 'login-wizard' })),

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

    local('help', 'show available commands', async () => {
      const cmds = _commandsForHelp().filter(c => c.userInvocable)
      const builtin = cmds.filter(c => c.source === 'builtin')
      const skills = cmds.filter(c => c.source !== 'builtin')
      const fmt = (c: Command) => `  /${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''} — ${c.description}`
      const parts = ['**Commands:**', ...builtin.map(fmt)]
      if (skills.length) parts.push('', '**Skills:**', ...skills.map(fmt))
      return { type: 'text', value: parts.join('\n') }
    }),
  ]
}
