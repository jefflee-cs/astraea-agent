#!/usr/bin/env bun
// REPL 入口 — 启动 React Ink 交互式 UI，支持多轮持续对话
// 用法: bun run repl
//      bun run src/repl.tsx

import { render } from 'ink'
import React from 'react'
import { App } from './ui/App'
import { assertConfig, config } from './config'
import { listTools } from './tools/registry'

// 管理子命令：`astraea mcp …` / `astraea plugin …`（全局 bin 指向本文件）。
// 在渲染 REPL 之前拦截，跑完即退，不进 Ink UI。
const argv = process.argv.slice(2)
if (argv[0] === 'mcp') {
  const { runMcpCommand } = await import('./cli/mcpCommand')
  await runMcpCommand(argv.slice(1))
  process.exit(0)
}
if (argv[0] === 'plugin') {
  const { runPluginCommand } = await import('./cli/pluginCommand')
  await runPluginCommand(argv.slice(1))
  process.exit(0)
}

assertConfig()

const provider = config.provider
const model =
  provider === 'ollama'
    ? config.ollama.model
    : provider === 'openai'
      ? config.openai.model
      : config.anthropic.model

process.stderr.write(`[provider] ${provider} / ${model}\n`)

// render() 接管终端（raw mode），返回 waitUntilExit() Promise
const { waitUntilExit } = render(<App />)

waitUntilExit()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
