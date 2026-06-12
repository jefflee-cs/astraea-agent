// 系统提示总装函数
// 参考 claude-code-main/src/constants/prompts.ts → getSystemPrompt()
//
// 输出顺序：
//   静态段（跨会话不变，适合 prompt cache 静态前缀）
//     § 1  身份定位
//     § 2  系统规范
//     § 3  任务哲学
//     § 4  风险规范
//     § 5  工具规范
//     § 6  语气风格
//     § 7  Token 预算提示（静态，缓存）
//   ── DYNAMIC_BOUNDARY ──
//   动态段（会话级缓存，随 clearSectionCache() 重算）
//     · 环境信息
//     · 语言偏好（可选）
//     · 内存注入
//   不可缓存段（每轮强制重算，DANGEROUS_UNCACHED）
//     · MCP 插件说明

import { getIdentitySection }         from './sections/identity'
import { getOperationalNormsSection } from './sections/operationalNorms'
import { getTaskPhilosophySection }   from './sections/taskPhilosophy'
import { getRiskRailsSection }        from './sections/riskRails'
import { getToolRulesSection }        from './sections/toolRules'
import { getVoiceToneSection }        from './sections/voiceTone'
import { getCounselModeSection }      from './sections/counselMode'
import { systemPromptSection, uncachedSection, resolveSections } from './sections'
import { computeEnvInfo }             from './envInfo'
import { loadMemoryInstructions }     from '../../memory/inject'
import { getMcpInstructions }         from '../../mcp/instructions'
import { getMcpInstructionBlocks }    from '../../mcp/registry'
import type { MCPServerConnection }   from '../../mcp/types'
import { TOKEN_BUDGET_HINT_TEXT }     from '../../utils/token-budget'
import type { SessionMode }           from '../../state/sessionMode'

export const DYNAMIC_BOUNDARY = '__ASTRAEA_PROMPT_DYNAMIC_BOUNDARY__'

export interface SystemPromptOptions {
  modelId: string
  enabledTools: Set<string>
  language?: string
  cwd?: string
  mcpClients?: readonly MCPServerConnection[]
  mode?: SessionMode
}

export async function getSystemPrompt(options: SystemPromptOptions): Promise<string> {
  const { modelId, enabledTools, language, mode = 'default' } = options
  const cwd = options.cwd ?? process.cwd()

  const dynamicSections = [
    systemPromptSection('env_info', () => computeEnvInfo(modelId)),
    systemPromptSection('language', () =>
      language
        ? `# Language\nAlways respond in ${language}. Technical terms and code identifiers remain in their original form.`
        : null,
    ),
    // 记忆「行为指令」段（类型规范/怎么存/防漂移/边界）—— 定稿 #10：稳定进缓存前缀。
    // 不含 MEMORY.md 索引/记忆正文（索引走 reminder 块，召回正文走用户消息尾部）。
    // 会话级缓存（/clear 失效）。指令静态，永远非空。
    systemPromptSection('memory', () => loadMemoryInstructions(cwd)),
    // MCP 服务器说明：从会话级 MCP 注册表读已连接 server 的 instructions。
    // DANGEROUS_UNCACHED — 跳过 prompt cache（server 可在会话中途上下线/重连）。
    uncachedSection(
      'mcp_instructions',
      () => {
        // registry 的 instruction 块映射成 ConnectedMCPServer 形态，复用既有截断格式化。
        const clients: MCPServerConnection[] = getMcpInstructionBlocks().map(b => ({
          type: 'connected' as const, name: b.name, instructions: b.instructions, tools: [],
        }))
        const text = getMcpInstructions(clients)
        return text ? `# MCP Servers\n${text}` : null
      },
      'MCP servers can connect/disconnect between turns; stale cache would expose outdated tool descriptions',
    ),
  ]

  const resolvedDynamic = await resolveSections(dynamicSections)

  // 模式感知段：orbit 和 counsel 模式注入额外指令
  const orbitModeSection = mode === 'orbit'
    ? `# Orbit Mode — Read-Only Planning\n\nYou are in ORBIT mode. File writes are BLOCKED. You may only read files, search, and plan.\n\nWhen your plan is complete, call the ExitOrbitMode tool with your full plan text to present it for approval. Do NOT attempt to edit or write files — those calls will be rejected.`
    : null

  const parts: (string | null)[] = [
    // ── 静态段 ──────────────────────────────────────────────────
    getIdentitySection(),
    getOperationalNormsSection(),
    getTaskPhilosophySection(),
    getRiskRailsSection(),
    getToolRulesSection(enabledTools),
    getVoiceToneSection(),
    // Token 预算提示：静态文本，注入一次后随静态段缓存
    `# Token Budget\n${TOKEN_BUDGET_HINT_TEXT}`,
    // ── 动态段 ──────────────────────────────────────────────────
    ...resolvedDynamic,
    // ── 模式感知段（按需注入）────────────────────────────────────
    mode === 'counsel' ? getCounselModeSection() : null,
    orbitModeSection,
  ]

  return parts.filter((s): s is string => s !== null && s !== DYNAMIC_BOUNDARY).join('\n\n')
}
