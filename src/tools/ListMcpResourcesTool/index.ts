import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import type { ConnectedMCPServer } from '../../mcp/types.js'

let _testRegistry: ConnectedMCPServer[] | undefined

/** Test-only: inject a fake MCP server list. Pass undefined to restore. */
export function _setMcpRegistryForTest(servers: ConnectedMCPServer[] | undefined) {
  _testRegistry = servers
}
/** Production hook: replace with real MCP connection registry when available. */
export let getMcpServers: () => ConnectedMCPServer[] = () => _testRegistry ?? []

export const ListMcpResourcesTool = buildTool({
  name: 'ListMcpResources',
  description: `List resources exposed by connected MCP servers.

Resources are named data objects (files, docs, repo contents) that MCP servers
expose separately from their tools. Use ReadMcpResource to fetch a specific URI.

Optional: filter by server name to see only that server's resources.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Filter by MCP server name (optional)' },
    },
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const serverFilter = input['server'] ? String(input['server']) : undefined
    const servers = getMcpServers()

    if (serverFilter) {
      const target = servers.find(s => s.name === serverFilter)
      if (!target) {
        return { output: `MCP 服务器"${serverFilter}"未连接或不存在。`, isError: true }
      }
      return { output: formatServerResources(target) }
    }

    if (servers.length === 0) {
      return { output: '没有已连接的 MCP 服务器。' }
    }

    const sections = servers.map(formatServerResources)
    return { output: sections.join('\n\n') }
  },
})

function formatServerResources(server: ConnectedMCPServer): string {
  const resources = server.resources ?? []
  if (resources.length === 0) {
    return `## ${server.name}\n（无资源）`
  }
  const items = resources.map(r => {
    const mime = r.mimeType ? `  [${r.mimeType}]` : ''
    return `  • ${r.name}${mime}\n    ${r.uri}`
  })
  return `## ${server.name}\n${items.join('\n')}`
}
