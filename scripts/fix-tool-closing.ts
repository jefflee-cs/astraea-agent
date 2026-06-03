// 修复脚本：将文件内第一个被误替换的 }) 还原，并在正确位置（文件末尾）补 })
// 运行：bun run scripts/fix-tool-closing.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '../src/tools')

const BROKEN = [
  'ListMcpResourcesTool', 'LSPTool', 'PowerShellTool', 'ReadMcpResourceTool',
  'ReviewArtifactTool', 'SendUserFileTool', 'SkillTool', 'TodoWriteTool',
  'WebBrowserTool', 'WebFetchTool', 'WebSearchTool', 'WechatReadTool', 'WechatWriteTool',
]

for (const name of BROKEN) {
  const filePath = join(TOOLS_DIR, name, 'index.ts')
  let src = readFileSync(filePath, 'utf8')

  // 文件末尾是否已正确以 })\n 结尾？
  if (src.trimEnd().endsWith('})')) {
    console.log(`✓ already ok: ${name}`)
    continue
  }

  // 找到 buildTool({ 开始位置，从那里之后找最后一个顶层 }
  const buildStart = src.indexOf('= buildTool({')
  if (buildStart === -1) {
    console.log(`⚠  no buildTool: ${name}`)
    continue
  }

  // 从 buildStart 之后，追踪大括号深度找到对应的 }
  let depth = 0
  let toolCloseIdx = -1
  for (let i = buildStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        toolCloseIdx = i
        break
      }
    }
  }

  if (toolCloseIdx === -1) {
    console.log(`⚠  no closing brace found: ${name}`)
    continue
  }

  // 将该 } 改为 })
  src = src.slice(0, toolCloseIdx) + '})' + src.slice(toolCloseIdx + 1)
  writeFileSync(filePath, src, 'utf8')
  console.log(`✓ fixed: ${name}`)
}
