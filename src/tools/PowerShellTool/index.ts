import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { executePowerShell } from './executor/powershell.js'
import { matchRule, DEFAULT_RULES, type PermissionRule } from '../BashTool/permissions/permission-rules.js'
import { confirmWithUser } from '../BashTool/permissions/confirm.js'
import { loadPermissionRules, appendPermissionRule } from '../../config/permissions.js'

// Patterns that are always blocked regardless of permission rules
const BLOCKED_PATTERNS = [
  /Remove-Item\s+.*-Recurse\s+.*-Force\s+['"\/\\]?[cC]:[\/\\]?['"]/i,
  /Format-Volume/i,
  /Clear-Disk/i,
  /Initialize-Disk/i,
  /\$env:PATH\s*=[^=]/i,
]

function checkPsSecurity(command: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Blocked by pattern: ${pattern.source}` }
    }
  }
  return { safe: true }
}
const runtimeRules: PermissionRule[] = []

export function addPsPermissionRule(rule: PermissionRule): void {
  runtimeRules.unshift(rule)
}
let configRules: PermissionRule[] = []
let configLoaded = false

async function ensureConfigLoaded(): Promise<void> {
  if (configLoaded) return
  configLoaded = true
  try {
    configRules = await loadPermissionRules(process.cwd())
  } catch {
    configRules = []
  }
}
const TOOL_DESCRIPTION = `Executes a PowerShell (pwsh) command and returns its output.

Requires PowerShell 7+ (pwsh) to be installed. On macOS/Linux install via: brew install --cask powershell

## Instructions
- Use PowerShell cmdlets and syntax (Get-ChildItem, Set-Content, etc.)
- Prefer pipeline idioms over loops where possible
- Quote paths with spaces using single quotes inside the command
- You may specify an optional timeout in milliseconds (up to 600000ms). Default: 120000ms
- Working directory starts from the current session directory`

export const PowerShellTool = buildTool({
  name: 'PowerShell',
  description: TOOL_DESCRIPTION,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The PowerShell command or script block to execute.',
      },
      description: {
        type: 'string',
        description: 'Short description of what this command does (shown to user during confirmation).',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (max 600000). Default: 120000.',
      },
    },
    required: ['command'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    const command = input['command'] as string | undefined
    if (!command?.trim()) {
      return { output: 'Error: command is required', isError: true }
    }

    const timeout     = input['timeout'] as number | undefined
    const description = input['description'] as string | undefined

    // Safety check
    const security = checkPsSecurity(command)
    if (!security.safe) {
      return { output: `Security check blocked: ${security.reason}`, isError: true }
    }

    await ensureConfigLoaded()
    const allRules = [...runtimeRules, ...configRules, ...DEFAULT_RULES]
    const ruleAction = matchRule(command, allRules)

    if (ruleAction === 'deny') {
      return { output: `Command denied by permission rules: \`${command}\``, isError: true }
    }

    if (ruleAction === 'ask') {
      const confirm = await confirmWithUser(command, description)

      if (confirm.remember === 'always-deny') {
        await appendPermissionRule(process.cwd(), command, 'deny')
        configRules.unshift({ pattern: command, action: 'deny' })
        return { output: `Command denied. Rule saved: deny "${command}"`, isError: true }
      }

      if (!confirm.proceed) {
        return { output: 'Command cancelled by user.', isError: true }
      }

      if (confirm.remember === 'always-allow') {
        await appendPermissionRule(process.cwd(), command, 'allow')
        configRules.unshift({ pattern: command, action: 'allow' })
      }
    }

    const result = await executePowerShell({ command, timeout, description })
    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`)
    if (result.timedOut) parts.push('[timed out]')

    return {
      output: parts.join('\n').trim() || '(no output)',
      isError: result.exitCode !== 0,
    }
  },
})
