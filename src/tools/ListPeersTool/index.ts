// ListPeersTool — 发现本机可通信的其他 Astraea 进程
// 双层探活：OS 级（process.kill probe）+ 应用级（socket ping）

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { discoverPeers } from '../../services/uds-server.js'

export const ListPeersTool = buildTool({
  name: 'ListPeers',
  description: `Discover other Astraea instances running on this machine that you can communicate with.

Returns a list of alive peers with their socket paths.
Use the socket path with SendMessage(to="uds:/path/to/socket") to communicate.

Two-layer liveness check:
1. OS-level: verify the process is still alive
2. App-level: ping the socket to confirm it's accepting connections

Use this before SendMessage to get valid socket addresses.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },

  async call(): Promise<ToolCallResult> {
    const peers = await discoverPeers()

    if (peers.length === 0) {
      return { output: 'No other Astraea processes found on this machine.' }
    }

    const alivePeers = peers.filter(p => p.alive)
    if (alivePeers.length === 0) {
      return { output: `Found ${peers.length} peer(s) but none are accepting connections.` }
    }

    return {
      output: JSON.stringify(
        alivePeers.map(p => ({
          pid: p.pid,
          socket: p.socket,
          sendTo: `uds:${p.socket}`,
        })),
        null,
        2,
      ),
    }
  },
})
