// 修复剩余问题：
// 1. 给缺少 buildTool import 的工具文件补上
// 2. 测试文件：isReadOnly → isReadOnly({}) 函数调用形式
// 运行：bun run scripts/fix-remaining.ts

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '../src/tools')

function fixFile(filePath: string): boolean {
  let src = readFileSync(filePath, 'utf8')
  let changed = false

  // ── 1. 补 buildTool import（处理 Tool.js 后缀）─────────────────────────
  if (src.includes('buildTool(') && !src.includes("import { buildTool }")) {
    src = src.replace(
      /^(import (?:type )?\{[^}]*\} from '\.\.\/Tool(?:\.js)?')/m,
      `import { buildTool } from '../Tool.js'\n$1`,
    )
    changed = true
  }

  // ── 2. 测试文件：.isReadOnly).toBe → .isReadOnly({})).toBe ───────────────
  if (filePath.endsWith('.test.ts') && src.includes('.isReadOnly)')) {
    src = src.replace(/\.isReadOnly\)\.toBe\(/g, '.isReadOnly({})).toBe(')
    // 修复可能的双括号
    src = src.replace(/\.isReadOnly\(\{\}\)\)\.toBe\(/g, '.isReadOnly({})).toBe(')
    changed = true
  }

  if (changed) {
    writeFileSync(filePath, src, 'utf8')
    return true
  }
  return false
}

// 递归遍历 tools 目录下所有 .ts 文件
function walkDir(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkDir(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

let fixed = 0
for (const file of walkDir(TOOLS_DIR)) {
  if (fixFile(file)) {
    console.log(`✓ ${file.replace(TOOLS_DIR + '/', '')}`)
    fixed++
  }
}
console.log(`\nFixed ${fixed} files`)
