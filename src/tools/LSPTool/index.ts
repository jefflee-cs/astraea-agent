// LSPTool — 语义代码理解工具（通过 Language Server Protocol）
// 参考: astraea-trace-and-build / LSPTool 教学文档
//
// 启用条件: ENABLE_LSP_TOOL=true 环境变量
//
// 支持的操作（9 种）:
//   goToDefinition     — 跳转到符号定义
//   findReferences     — 查找所有引用
//   hover              — 获取悬停文档/类型信息
//   documentSymbol     — 列出文档内所有符号
//   workspaceSymbol    — 跨文件符号搜索
//   goToImplementation — 跳转到接口实现
//   prepareCallHierarchy — 准备调用层级
//   incomingCalls      — 谁调用了这个函数
//   outgoingCalls      — 这个函数调用了谁
//
// 设计要点:
//   - 工具接口使用 1-based 坐标（编辑器约定），内部转为 0-based LSP 协议坐标
//   - Initialization Fence: 等待 LSP 服务器初始化完成再处理请求
//   - didOpen 前置: 自动处理 textDocument/didOpen 生命周期
//   - 10MB 文件大小限制，防止语言服务器 OOM
//   - gitignore 后置过滤：移除 node_modules 等噪音结果

import { resolve, extname } from 'node:path'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildTool } from '../Tool'
import type { Tool, ToolCallResult } from '../Tool'
import { getLspManager } from './lsp-manager'
import { formatLspResult } from './formatters'
import { filterGitIgnoredLocations } from './gitignore-filter'

// INTENT: 10MB 文件大小限制 —— 超大文件会导致语言服务器 OOM 或极慢响应
const MAX_FILE_SIZE = 10 * 1024 * 1024

type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'

// INTENT: operation → LSP JSON-RPC method name 映射
// 单步操作直接映射；双步操作（incomingCalls/outgoingCalls）需要特殊处理
const OPERATION_TO_METHOD: Record<LspOperation, string> = {
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  hover: 'textDocument/hover',
  documentSymbol: 'textDocument/documentSymbol',
  workspaceSymbol: 'workspace/symbol',
  goToImplementation: 'textDocument/implementation',
  prepareCallHierarchy: 'textDocument/prepareCallHierarchy',
  incomingCalls: 'textDocument/prepareCallHierarchy',  // 第一步
  outgoingCalls: 'textDocument/prepareCallHierarchy',  // 第一步
}
// 需要 gitignore 后置过滤的操作（返回文件位置数组的操作）
const OPERATIONS_NEED_FILTER: Set<LspOperation> = new Set([
  'goToDefinition', 'findReferences', 'goToImplementation',
])

export const LSPTool = buildTool({
  name: 'LSP',
  description: `Semantic code intelligence using Language Server Protocol.
Understands code structure, types, and references — not just text patterns.

Operations:
  goToDefinition      — jump to where a symbol is defined
  findReferences      — find all usages of a symbol
  hover               — get type info / documentation at a position
  documentSymbol      — list all symbols (functions, classes, etc.) in a file
  workspaceSymbol     — search symbols across all files (set line=1 character=1)
  goToImplementation  — jump to interface/abstract implementations
  prepareCallHierarchy — get call hierarchy item at position
  incomingCalls       — who calls this function
  outgoingCalls       — what does this function call

Coordinates are 1-based (matching editor display, e.g. line 42 character 15).

Requires ENABLE_LSP_TOOL=true and a supported language server installed.
TypeScript/JavaScript: typescript-language-server (included)
Python: pyright-langserver or pylsp | Go: gopls | Rust: rust-analyzer`,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'goToDefinition', 'findReferences', 'hover',
          'documentSymbol', 'workspaceSymbol',
          'goToImplementation', 'prepareCallHierarchy',
          'incomingCalls', 'outgoingCalls',
        ],
        description: 'LSP operation to perform',
      },
      filePath: {
        type: 'string',
        description: 'Path to the file (absolute or relative to cwd)',
      },
      line: {
        type: 'number',
        description: '1-based line number (as shown in editor)',
      },
      character: {
        type: 'number',
        description: '1-based column/character number (as shown in editor)',
      },
    },
    required: ['operation', 'filePath', 'line', 'character'],
  },

  async call(input, _ctx: import("../Tool.js").ToolContext): Promise<ToolCallResult> {
    // INTENT: ENABLE_LSP_TOOL 环境变量控制工具可用性
    // 未启用时给出明确提示，不是静默失败
    if (!process.env['ENABLE_LSP_TOOL']) {
      return {
        output: 'LSPTool is disabled. Set ENABLE_LSP_TOOL=true to enable.',
        isError: true,
      }
    }

    const operation = input['operation'] as LspOperation
    const filePath = input['filePath'] as string
    const line = input['line'] as number
    const character = input['character'] as number

    // ── 路径验证 ──────────────────────────────────────────────────────────
    const absPath = resolve(filePath)

    if (!existsSync(absPath)) {
      return { output: `File not found: ${filePath}`, isError: true }
    }

    let fileSize: number
    try {
      const stat = statSync(absPath)
      if (!stat.isFile()) {
        return { output: `Not a file: ${filePath}`, isError: true }
      }
      fileSize = stat.size
    } catch (err) {
      return { output: `Cannot stat file: ${err}`, isError: true }
    }

    // INTENT: 10MB 文件大小限制 — 防止语言服务器 OOM
    if (fileSize > MAX_FILE_SIZE) {
      return {
        output: `File too large (${Math.ceil(fileSize / 1e6)}MB > 10MB limit): ${filePath}`,
        isError: true,
      }
    }

    const projectRoot = process.cwd()
    const manager = getLspManager()

    // ── 检查语言服务器是否可用 ────────────────────────────────────────────
    const ext = extname(absPath).toLowerCase()
    const supported = manager.getSupportedExtensions()
    if (!supported.includes(ext)) {
      return {
        output: `No language server available for ${ext} files.\nSupported: ${supported.join(', ')}`,
        isError: true,
      }
    }

    // ── 确保文件已在 LSP 中打开 ──────────────────────────────────────────
    // INTENT: textDocument/didOpen 前置 — LSP 协议要求先通知服务器文件存在
    // 工具内部自动处理，LLM 不需要手动 open 文件
    const isOpen = await manager.isFileOpen(absPath, projectRoot)
    if (!isOpen) {
      try {
        const content = readFileSync(absPath, 'utf8')
        await manager.openFile(absPath, content, projectRoot)
      } catch (err) {
        return { output: `Failed to open file for LSP: ${err}`, isError: true }
      }
    }

    // ── 构建 LSP 请求参数 ─────────────────────────────────────────────────
    const uri = pathToFileURL(absPath).href

    // INTENT: 1-based → 0-based 坐标转换在此处完成，不暴露给调用方
    // 工具接口使用编辑器约定（1-based），内部协议使用 LSP 约定（0-based）
    const position = { line: line - 1, character: character - 1 }

    const isTextDocumentOp = operation !== 'workspaceSymbol'
    const baseParams = isTextDocumentOp
      ? { textDocument: { uri }, position }
      : { query: '' }  // workspaceSymbol 用 query 参数（空字符串返回所有符号）

    const method = OPERATION_TO_METHOD[operation]

    // ── 执行 LSP 请求 ─────────────────────────────────────────────────────
    let result: unknown

    try {
      result = await manager.sendRequest(absPath, method, baseParams, projectRoot)
    } catch (err) {
      return {
        output: `LSP request failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    if (result === undefined || result === null) {
      return { output: `No language server is available for this file type (${ext})` }
    }

    // ── 双步操作：incomingCalls / outgoingCalls ───────────────────────────
    // INTENT: LSP 协议中调用层级查询需要两步：
    // 1. textDocument/prepareCallHierarchy → CallHierarchyItem[]
    // 2. callHierarchy/incomingCalls 或 outgoingCalls → 实际调用关系
    // 工具内部合并为单步接口，降低 LLM 使用复杂度
    if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
      const callItems = result as Array<{ name: string; uri: string; range: unknown }>
      if (!Array.isArray(callItems) || callItems.length === 0) {
        return { output: 'No call hierarchy items found at this position' }
      }

      const callMethod = operation === 'incomingCalls'
        ? 'callHierarchy/incomingCalls'
        : 'callHierarchy/outgoingCalls'

      try {
        result = await manager.sendRequest(absPath, callMethod, { item: callItems[0] }, projectRoot)
      } catch (err) {
        return {
          output: `LSP ${callMethod} failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    }

    // ── 结果质量过滤：移除 node_modules 等噪音 ───────────────────────────
    // INTENT: 后置过滤不侵入核心 LSP 请求逻辑
    // 外部系统（LSP）返回技术上正确但对任务无用的结果，工具负责清洗
    if (OPERATIONS_NEED_FILTER.has(operation) && Array.isArray(result)) {
      const filtered = await filterGitIgnoredLocations(
        result as Array<{ uri: string; range: unknown }>,
        projectRoot,
      )
      result = filtered
    }

    // ── 格式化为 LLM 可读文本 ─────────────────────────────────────────────
    const formatted = formatLspResult(operation, result, projectRoot)

    return {
      output: `[LSP ${operation}] ${filePath}:${line}:${character}\n\n${formatted}`,
    }
  },
})
