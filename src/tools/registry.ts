// 工具注册表 — 唯一的工具定义入口
// getAllTools()   → 主 Agent 完整工具集
// getWorkerTools() → 子 Agent 工具集（去掉协调工具）
import { platform } from 'os'
import type { Tool, ToolSchema } from './Tool'
import { BashTool } from './BashTool'
import { FileReadTool } from './FileReadTool'
import { FileEditTool } from './FileEditTool'
import { FileWriteTool } from './FileWriteTool'
import { GlobTool } from './GlobTool'
import { GrepTool } from './GrepTool'
import { LSPTool } from './LSPTool'
import { PowerShellTool } from './PowerShellTool'
import { WebFetchTool } from './WebFetchTool'
import { WebSearchTool } from './WebSearchTool'
import { WebBrowserTool } from './WebBrowserTool'
import { TaskCreateTool } from './TaskCreateTool'
import { TaskGetTool } from './TaskGetTool'
import { TaskListTool } from './TaskListTool'
import { TaskUpdateTool } from './TaskUpdateTool'
import { TaskStopTool } from './TaskStopTool'
import { TaskOutputTool } from './TaskOutputTool'
import { AgentTool } from './AgentTool'
import { SendMessageTool } from './SendMessageTool'
import { ListPeersTool } from './ListPeersTool'
import { AskUserQuestionTool } from './AskUserQuestionTool'
import { EnterOrbitModeTool } from './EnterOrbitModeTool'
import { ExitOrbitModeTool } from './ExitOrbitModeTool'
import { VerifyOrbitExecutionTool } from './VerifyOrbitExecutionTool'
import { TodoWriteTool } from './TodoWriteTool'
import { VigilOnceTool } from './VigilOnceTool'
import { VigilScheduleTool } from './VigilScheduleTool'
import { VigilDeleteTool } from './VigilDeleteTool'
import { VigilListTool } from './VigilListTool'
import { WechatReadTool } from './WechatReadTool'
import { WechatWriteTool } from './WechatWriteTool'
import { ConfigTool } from './ConfigTool'
import { SkillTool } from './SkillTool'
import { ListMcpResourcesTool } from './ListMcpResourcesTool'
import { ReadMcpResourceTool } from './ReadMcpResourceTool'
import { SendUserFileTool } from './SendUserFileTool'
import { ReviewArtifactTool } from './ReviewArtifactTool'
import { getMcpTools } from '../mcp/registry'

const IS_WIN = platform() === 'win32'

// 每个平台只暴露一个 shell 工具：Windows 用 PowerShell（无 /bin/bash），
// macOS/Linux 用 Bash。避免模型在 Windows 上调用 BashTool 触发 spawn '/bin/bash' ENOENT。
function filterShellTools(tools: Tool[]): Tool[] {
  const drop = IS_WIN ? BashTool.name : PowerShellTool.name
  return tools.filter((t) => t.name !== drop)
}

export function getAllTools(): Tool[] {
  return [...getBuiltinToolList(), ...getMcpTools()]
}

function getBuiltinToolList(): Tool[] {
  return filterShellTools([
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    LSPTool,
    PowerShellTool,
    WebFetchTool,
    WebSearchTool,
    WebBrowserTool,
    TaskCreateTool,
    TaskGetTool,
    TaskListTool,
    TaskUpdateTool,
    TaskStopTool,
    TaskOutputTool,
    AgentTool,
    SendMessageTool,
    ListPeersTool,
    AskUserQuestionTool,
    // ── 计划与调度控制层 ──────────────────────────────────────────
    EnterOrbitModeTool,
    ExitOrbitModeTool,
    VerifyOrbitExecutionTool,
    TodoWriteTool,
    VigilOnceTool,
    VigilScheduleTool,
    VigilDeleteTool,
    VigilListTool,
    WechatReadTool,
    WechatWriteTool,
    // ── 元能力层 ────────────────────────────────────────────────────────────────
    ConfigTool,
    SkillTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    SendUserFileTool,
    ReviewArtifactTool,
  ])
}

// 子 Agent 工具集 — 去掉 AgentTool、SendMessageTool、ListPeersTool（协调专属工具）
// 子 Agent 只能"做任务、汇报结果"，通信权保留在协调器
export function getWorkerTools(): Tool[] {
  return filterShellTools([
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    LSPTool,
    PowerShellTool,
    WebFetchTool,
    WebSearchTool,
    WebBrowserTool,
    TaskCreateTool,
    TaskGetTool,
    TaskListTool,
    TaskUpdateTool,
    TaskStopTool,
    TaskOutputTool,
    AskUserQuestionTool,
  ])
}

// 微信工具名集合 —— 仅可由用户显式 /wechat（直接执行）或 /vigil wechat（调度后
// 由 headless 任务执行）触发，模型在普通交互对话里不得自行调用，故从交互工具集中剔除。
export const WECHAT_TOOL_NAMES = new Set(['WechatRead', 'WechatWrite'])

// 交互式主 Agent 工具集 —— 在 getAllTools() 基础上排除微信工具。
// App.tsx 的对话/调度 query 一律用它；headless 执行（cli.ts）才用完整 listTools()。
export function getInteractiveTools(): Tool[] {
  return getAllTools().filter((t) => !WECHAT_TOOL_NAMES.has(t.name))
}

export function findTool(name: string): Tool | undefined {
  return getAllTools().find((t) => t.name === name)
}

export function listTools(): Tool[] {
  return getAllTools()
}

export function getToolSchemas(): ToolSchema[] {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}
