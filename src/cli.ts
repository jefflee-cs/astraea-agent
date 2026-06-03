#!/usr/bin/env bun
// 入口 CLI — 多启动模式：
//   bun run src/cli.ts "问题"          — 标准 CLI 单轮
//   echo "问题" | bun run src/cli.ts   — pipe 模式
//   bun run src/cli.ts --daemon        — 启动 vigil daemon（调度进程，不调 LLM）
//   bun run src/cli.ts --headless --task <id>  — 执行单个 vigil 任务（headless agent，调 LLM）

import { assertConfig, config } from './config'
import { query } from './query'
import { listTools } from './tools/registry'
import { createUserMessage } from './types/message'
import { getSystemPrompt } from './context/systemPrompt/builder'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)

// ── --daemon 模式：纯调度进程，不调 LLM ─────────────────────────────────────
if (args.includes('--daemon')) {
  const { runDaemon } = await import('./services/cron-daemon.js')
  await runDaemon()
  process.exit(0)
}

// ── --headless --task 模式：执行单个 vigil 任务 ──────────────────────────────
if (args.includes('--headless') && args.includes('--task')) {
  const taskId = process.env.ASTRAEA_HEADLESS_TASK_ID ?? args[args.indexOf('--task') + 1] ?? 'unknown'
  const prompt = process.env.ASTRAEA_HEADLESS_PROMPT
  const resultFile = process.env.ASTRAEA_RESULT_FILE

  if (!prompt) {
    console.error('[headless] ASTRAEA_HEADLESS_PROMPT not set')
    process.exit(1)
  }

  assertConfig()
  await runHeadlessTask(taskId, prompt, resultFile)
  process.exit(0)
}

// ── 标准 CLI 模式 ────────────────────────────────────────────────────────────
async function main() {
  assertConfig()

  const provider = config.provider

  let userInput = args.join(' ').trim()
  if (!userInput) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    userInput = Buffer.concat(chunks).toString('utf-8').trim()
  }

  if (!userInput) {
    console.error('Usage: bun run src/cli.ts "your message"')
    console.error('   or: echo "your message" | bun run src/cli.ts')
    process.exit(1)
  }

  // ── /goal 非交互模式：设定完成条件并把它当作 directive 一路跑到达成 ──────────
  // 用法: bun run src/cli.ts "/goal <condition>"
  if (userInput === '/goal' || userInput.startsWith('/goal ')) {
    const { setGoal, GOAL_CLEAR_ALIASES } = await import('./state/goalState.js')
    const arg = userInput.slice('/goal'.length).trim()
    if (!arg) {
      console.error('Usage: /goal <completion condition>')
      process.exit(1)
    }
    if ((GOAL_CLEAR_ALIASES as readonly string[]).includes(arg.toLowerCase())) {
      console.error('[goal] nothing to clear in single-shot mode')
      process.exit(0)
    }
    setGoal(arg)
    console.error(`[goal] active — working until: ${arg}`)
    userInput = arg  // condition 本身即 directive
  }

  const tools = listTools()
  const enabledTools = new Set(tools.map(t => t.name))
  const modelId = provider === 'anthropic'
    ? config.anthropic.model
    : provider === 'openai'
      ? config.openai.model
      : config.ollama.model

  console.error(`[provider] ${provider} / ${modelId}`)

  const system = await getSystemPrompt({ modelId, enabledTools })
  const messages = [createUserMessage(userInput)]
  process.stdout.write('\n')

  for await (const event of query(messages, tools, { system, maxTurns: 10, enablePromptCaching: true })) {
    switch (event.type) {
      case 'turn_start':
        if (event.turn > 1) process.stdout.write('\n')
        console.error(`\n[turn ${event.turn}]`)
        break
      case 'text':
        process.stdout.write(event.text)
        break
      case 'tool_use': {
        const t = tools.find(t => t.name === event.name)
        const label = t ? (t.isReadOnly(event.input) ? 'Read' : 'Edit') : '?'
        console.error(`\n[tool_use:${label}] ${event.name}(${JSON.stringify(event.input)})`)
        break
      }
      case 'tool_result': {
        const status = event.isError ? 'error' : 'ok'
        const preview = event.output.slice(0, 120).replace(/\n/g, '↵')
        console.error(`[tool_result:${status}] ${event.name} → ${preview}${event.output.length > 120 ? '…' : ''}`)
        break
      }
      case 'message_stop':
        if (event.usage.input_tokens > 0) {
          console.error(`[tokens] in=${event.usage.input_tokens} out=${event.usage.output_tokens}`)
        }
        break
      case 'max_turns_reached':
        console.error(`\n[max_turns] reached ${event.maxTurns}`)
        break
      case 'goal_evaluated':
        console.error(`\n[goal] ${event.met ? 'ACHIEVED' : 'continuing'} (turn ${event.turns}) — ${event.reason}`)
        break
      case 'goal_exhausted':
        console.error(`\n[goal] stopped at safety cap ${event.maxTurns} turns — ${event.reason}`)
        break
    }
  }

  process.stdout.write('\n')
}

// ── headless 任务执行（vigil daemon 触发，调用 LLM）────────────────────────
async function runHeadlessTask(taskId: string, prompt: string, resultFile?: string): Promise<void> {
  const provider = config.provider
  const tools = listTools()
  const enabledTools = new Set(tools.map(t => t.name))
  const modelId = provider === 'anthropic' ? config.anthropic.model
    : provider === 'openai' ? config.openai.model : config.ollama.model

  console.error(`[vigil:headless] task=${taskId}`)

  // isReadOnly 现在是函数，用空 input 保守判断（无 input 时默认视为写操作）
  const writeToolNames = new Set(tools.filter(t => !t.isReadOnly({})).map(t => t.name))

  const system = await getSystemPrompt({ modelId, enabledTools })
  const messages = [createUserMessage(prompt)]
  const outputParts: string[] = []
  const filesWritten: string[] = []
  const toolErrors: string[] = []

  for await (const event of query(messages, tools, { system, maxTurns: 15, enablePromptCaching: true })) {
    if (event.type === 'text') {
      outputParts.push(event.text)
    } else if (event.type === 'tool_result' && writeToolNames.has(event.name)) {
      // Capture write-tool outcomes as ground truth — independent of LLM text
      const filePath = event.input['file_path'] as string | undefined
      if (event.isError) {
        toolErrors.push(`${event.name}(${filePath ?? '?'}): ${event.output}`)
      } else if (filePath) {
        filesWritten.push(filePath)
      }
    }
  }

  const output = outputParts.join('')

  if (resultFile) {
    const result = {
      taskId,
      prompt,
      output,
      filesWritten: filesWritten.length > 0 ? filesWritten : undefined,
      toolErrors: toolErrors.length > 0 ? toolErrors : undefined,
      completedAt: new Date().toISOString(),
      read: false,
    }
    writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8')
    console.error(`[vigil:headless] result written to ${resultFile}`)
  }
}

main().catch((err) => {
  console.error('Fatal error:', (err as Error).message ?? err)
  process.exit(1)
})
