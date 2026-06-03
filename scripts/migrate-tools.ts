// 迁移脚本：把所有工具从静态 isReadOnly: boolean 改为 buildTool() 模式
// 运行：bun run scripts/migrate-tools.ts

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '../src/tools')

// 只读工具：isReadOnly: () => true, isConcurrencySafe: () => true
const READ_ONLY_CONCURRENT = new Set([
  'AskUserQuestionTool', 'EnterOrbitModeTool', 'ExitOrbitModeTool',
  'FileReadTool', 'GlobTool', 'GrepTool', 'ListMcpResourcesTool',
  'ListPeersTool', 'LSPTool', 'ReadMcpResourceTool', 'ReviewArtifactTool',
  'SendUserFileTool', 'SkillTool', 'TaskGetTool', 'TaskListTool',
  'TaskOutputTool', 'VerifyOrbitExecutionTool', 'VigilListTool',
  'WebBrowserTool', 'WebFetchTool', 'WebSearchTool',
])

// 只读但 UI 串行：isReadOnly: () => true, isConcurrencySafe: () => false
const READ_ONLY_SERIAL = new Set(['WechatReadTool'])

// 写操作工具：isReadOnly: () => false（isConcurrencySafe 继承默认 false）
const WRITE_ONLY = new Set([
  'AgentTool', 'PowerShellTool', 'SendMessageTool',
  'TaskCreateTool', 'TaskStopTool', 'TaskUpdateTool',
  'TodoWriteTool', 'VigilDeleteTool', 'VigilOnceTool',
  'VigilScheduleTool', 'WechatWriteTool',
])

// 跳过：需要手动处理（BashTool, ConfigTool, FileEditTool, FileWriteTool）
const SKIP = new Set(['BashTool', 'ConfigTool', 'FileEditTool', 'FileWriteTool'])

function migrate(toolName: string, src: string): string {
  // 1. 修改 import：给已有的 '../Tool' import 行加上 buildTool
  src = src.replace(
    /import type \{ (Tool[^}]*)\} from '\.\.\/Tool'/,
    `import { buildTool } from '../Tool'\nimport type { $1} from '../Tool'`,
  )
  // 处理已含 ToolContext 等具名导入的情况
  src = src.replace(
    /import type \{ (Tool, ToolCallResult(?:, ToolContext)?)\} from '\.\.\/Tool'/,
    `import { buildTool } from '../Tool'\nimport type { $1} from '../Tool'`,
  )

  // 2. 去掉 `: Tool` 类型注解（工厂函数会推断）
  src = src.replace(
    /^(export const \w+): Tool = \{/m,
    '$1 = buildTool({',
  )

  // 3. 替换 isReadOnly 声明
  if (READ_ONLY_CONCURRENT.has(toolName)) {
    src = src.replace(
      /  isReadOnly: true,/,
      '  isReadOnly: () => true,\n  isConcurrencySafe: () => true,',
    )
  } else if (READ_ONLY_SERIAL.has(toolName)) {
    src = src.replace(
      /  isReadOnly: true,/,
      '  isReadOnly: () => true,',
    )
  } else if (WRITE_ONLY.has(toolName)) {
    src = src.replace(
      /  isReadOnly: false,/,
      '  isReadOnly: () => false,',
    )
  }

  // 4. 最后一行的 `}` 改为 `})`
  src = src.replace(/^}$/m, '})')

  return src
}

const dirs = readdirSync(TOOLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)

let migrated = 0
let skipped = 0

for (const dir of dirs) {
  if (SKIP.has(dir)) {
    console.log(`⏭  skip   ${dir}`)
    skipped++
    continue
  }

  const all = [...READ_ONLY_CONCURRENT, ...READ_ONLY_SERIAL, ...WRITE_ONLY]
  if (!all.includes(dir)) {
    console.log(`⚠️  unknown ${dir}`)
    continue
  }

  const filePath = join(TOOLS_DIR, dir, 'index.ts')
  const original = readFileSync(filePath, 'utf8')
  const result = migrate(dir, original)

  if (result !== original) {
    writeFileSync(filePath, result, 'utf8')
    console.log(`✓  migrated ${dir}`)
    migrated++
  } else {
    console.log(`～  no-change ${dir}`)
  }
}

console.log(`\nDone: ${migrated} migrated, ${skipped} skipped`)
