import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'

type FetchResult = { content: string; mimeType?: string } | { error: string }

type McpFetcher = (server: string, uri: string) => Promise<FetchResult>

let _testFetcher: McpFetcher | undefined

/** Test-only: inject a fake MCP resource fetcher. Pass undefined to restore. */
export function _setMcpFetcherForTest(fn: McpFetcher | undefined) { _testFetcher = fn }

/** Production hook: replace with real MCP client call when available. */
export let fetchMcpResource: McpFetcher = async (_server, uri) => ({
  error: `No MCP client connected. Cannot fetch: ${uri}`,
})
function activeFetcher(): McpFetcher {
  return _testFetcher ?? fetchMcpResource
}
export const ReadMcpResourceTool = buildTool({
  name: 'ReadMcpResource',
  description: `Read the content of a specific MCP resource by URI.

Use ListMcpResources first to discover available URIs.
Binary resources (images, PDFs) are returned as a file path reference.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri:    { type: 'string', description: 'Resource URI (from ListMcpResources)' },
    },
    required: ['server', 'uri'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const server = String(input['server'] ?? '').trim()
    const uri    = String(input['uri']    ?? '').trim()

    if (!server) return { output: 'server is required.', isError: true }
    if (!uri)    return { output: 'uri is required.', isError: true }

    const result = await activeFetcher()(server, uri)

    if ('error' in result) {
      return { output: result.error, isError: true }
    }

    const header = `[MCP Resource: ${uri}]\n\n`
    return { output: header + result.content }
  },
})
