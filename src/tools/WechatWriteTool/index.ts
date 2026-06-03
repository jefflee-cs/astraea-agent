import { join } from 'node:path'
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { checkWechatSetup } from '../../utils/wechatSetupGuard.js'

const SCRIPT = join(import.meta.dir, 'send_message.py')

async function runSend(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(['python3', SCRIPT], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(new TextEncoder().encode(JSON.stringify(args)))
  proc.stdin.end()
  const [stdout, , exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  try {
    return JSON.parse(stdout.trim())
  } catch {
    return { error: `python3 exited ${exit}: ${stdout.slice(0, 200)}` }
  }
}
export const WechatWriteTool = buildTool({
  name: 'WechatWrite',
  description: `Send a WeChat message to a contact or group chat via macOS keyboard simulation.
Does not require Accessibility API — navigates via Cmd+F search, pastes via clipboard.

Contact names MUST be the exact strings as they appear in WeChat, in the original language.
Do NOT transliterate Chinese names to English (use "李嘉俊", never "Li Jiajun").

Requires: WeChat open on screen (macOS only). Same setup as WechatRead.`,
  isReadOnly: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      contact: {
        type: 'string',
        description: 'Exact contact or group chat name as shown in WeChat.',
      },
      message: {
        type: 'string',
        description: 'Text message to send. Sent as plain text; do not include Markdown formatting.',
      },
    },
    required: ['contact', 'message'],
  },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolCallResult> {
    const setupError = checkWechatSetup()
    if (setupError) return { output: setupError, isError: true }

    const contact = String(input['contact'] ?? '').trim()
    const message = String(input['message'] ?? '').trim()

    if (!contact) return { output: 'contact is required.', isError: true }
    if (!message) return { output: 'message is required.', isError: true }

    const result = await runSend({ contact, message })

    if (result['error']) {
      return { output: String(result['error']), isError: true }
    }

    return {
      output: `已向「${contact}」发送消息（${result['message_length']} 字）。`,
    }
  },
})
