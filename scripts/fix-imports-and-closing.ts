// 修复脚本：
// 1. 给缺少 buildTool import 的工具文件补上（兼容 '../Tool' 和 '../Tool.js'）
// 2. 把误替换的 helper 函数 }) 改回 }，再在工具对象末尾加 })
// 运行：bun run scripts/fix-imports-and-closing.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '../src/tools')

const TARGETS = [
  'ListMcpResourcesTool', 'LSPTool', 'PowerShellTool', 'ReadMcpResourceTool',
  'ReviewArtifactTool', 'SendUserFileTool', 'SkillTool', 'TodoWriteTool',
  'WebBrowserTool', 'WebFetchTool', 'WebSearchTool', 'WechatReadTool', 'WechatWriteTool',
]

for (const name of TARGETS) {
  const filePath = join(TOOLS_DIR, name, 'index.ts')
  let src = readFileSync(filePath, 'utf8')

  // ── 1. 补 buildTool import（兼容有无 .js 后缀）──────────────────────────
  if (!src.includes("import { buildTool }")) {
    // 找第一个从 Tool 的 import 行，在它前面插入
    src = src.replace(
      /^(import (?:type )?\{[^}]*\} from '\.\.\/Tool(?:\.js)?')/m,
      `import { buildTool } from '../Tool.js'\n$1`,
    )
  }

  // ── 2. 找到 buildTool({ 对应的配对闭合位置 ──────────────────────────────
  const buildStart = src.indexOf('= buildTool({')
  if (buildStart === -1) {
    console.log(`⚠  no buildTool: ${name}`)
    continue
  }

  // 追踪 { } 深度从 buildTool({ 开始
  let depth = 0
  let toolCloseIdx = -1
  for (let i = buildStart + '= buildTool({'.length - 1; i < src.length; i++) {
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
    console.log(`⚠  no closing brace: ${name}`)
    continue
  }

  // ── 3. 确保 toolCloseIdx 处是 }) 而非单独 } ─────────────────────────────
  // 先把整个文件中所有错误的 }) （在 buildStart 之前的函数体结尾）改回 }
  // 策略：把 buildStart 之前区域的所有行尾 }) 改回 }（行格式为 "^  })" 或 "^}")
  const before = src.slice(0, buildStart)
  const after  = src.slice(buildStart)

  // 修复 before 区域里被误改的 })（只还原独占一行的 }）
  const fixedBefore = before.replace(/^([ \t]*)\}(\)|)\s*$/gm, (_, indent, paren) => {
    if (paren === ')') return `${indent}}`  // 还原错误的 })
    return `${indent}}`
  })

  // 重新定位 toolCloseIdx（after 区域不变，对它做精确处理）
  let newSrc = fixedBefore + after

  // 重新找 buildTool({ 位置并追踪配对 }
  const newBuildStart = newSrc.indexOf('= buildTool({')
  let newDepth = 0
  let newCloseIdx = -1
  for (let i = newBuildStart + '= buildTool({'.length - 1; i < newSrc.length; i++) {
    if (newSrc[i] === '{') newDepth++
    else if (newSrc[i] === '}') {
      newDepth--
      if (newDepth === 0) {
        newCloseIdx = i
        break
      }
    }
  }

  if (newCloseIdx === -1) {
    console.log(`⚠  still no closing brace after fix: ${name}`)
    continue
  }

  // 确保该位置是 }) 而不是 }
  if (newSrc[newCloseIdx + 1] !== ')') {
    newSrc = newSrc.slice(0, newCloseIdx + 1) + ')' + newSrc.slice(newCloseIdx + 1)
  }

  writeFileSync(filePath, newSrc, 'utf8')
  console.log(`✓ fixed: ${name}`)
}
