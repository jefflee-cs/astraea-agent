// Skill 目录扫描 —— 实现文档 §1.3。
// 来源优先级（先到先得去重）：
//   1. user    → ~/.astraea/skills/
//   2. project → <cwd>/.astraea/skills/（从 cwd 向 home 逐层 walk）
// 物理形态：只认「子目录 + SKILL.md」，裸 .md 跳过。
// 去重身份：realpath(SKILL.md) + 技能名，任一撞上即跳过（first-wins → user 胜 project）。
// 分桶：有非空 paths → conditional（v1 不注入菜单）；否则 unconditional。

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { parseSkillFrontmatter } from './frontmatter'
import type { LoadedSkill } from './types'
import type { CommandSource } from '../commands/types'

let _userDirOverride: string | undefined
let _projectRootOverride: string | undefined

/** 测试钩子：覆盖 user / project 根。传 undefined 还原。 */
export function _setSkillDirsForTest(opts: { userDir?: string; projectRoot?: string }) {
  _userDirOverride = opts.userDir
  _projectRootOverride = opts.projectRoot
}

const SKILLS_SUBPATH = ['.astraea', 'skills']

function userSkillsDir(): string {
  return _userDirOverride ?? join(homedir(), ...SKILLS_SUBPATH)
}

/** 从 cwd 向 home 逐层收集 .astraea/skills 目录（近 cwd 在前）。 */
function projectSkillDirs(cwd: string): string[] {
  const root = _projectRootOverride ?? cwd
  const home = _userDirOverride ? null : homedir()
  const dirs: string[] = []
  let dir = root
  while (true) {
    dirs.push(join(dir, ...SKILLS_SUBPATH))
    if (home && dir === home) break
    const parent = dirname(dir)
    if (parent === dir) break // 到根
    dir = parent
  }
  return dirs
}

/** 扫描一个 skills 目录，产出该目录下所有 LoadedSkill。 */
function scanDir(dir: string, source: CommandSource): LoadedSkill[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: LoadedSkill[] = []
  for (const name of entries) {
    const skillRoot = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(skillRoot).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue // 裸 .md 跳过
    const filePath = join(skillRoot, 'SKILL.md')
    if (!existsSync(filePath)) continue
    let realPath: string
    try {
      realPath = realpathSync(filePath)
    } catch {
      realPath = filePath
    }
    let content: string
    try {
      content = require('node:fs').readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const { frontmatter } = parseSkillFrontmatter(content)
    out.push({ name, filePath, skillRoot, realPath, source, frontmatter })
  }
  return out
}

/** 扫描单个目录的技能（插件吸管用）。source 标签由调用方给（通常 'plugin'）。 */
export function loadSkillsFromDir(dir: string, source: CommandSource): LoadedSkill[] {
  return scanDir(dir, source)
}

export interface LoadedSkills {
  /** 进菜单的无条件技能。 */
  unconditional: LoadedSkill[]
  /** 带 paths 的条件技能（v1 存而不注入）。 */
  conditional: LoadedSkill[]
}

/**
 * 加载 user + project 全部技能，去重分桶。
 * @param cwd 项目工作目录（默认 process.cwd()）
 */
export function loadSkills(cwd: string = process.cwd()): LoadedSkills {
  // 优先级顺序：user 先（撞名时胜），再 project（近 cwd → 远）
  const candidates: LoadedSkill[] = [
    ...scanDir(userSkillsDir(), 'user'),
    ...projectSkillDirs(cwd).flatMap(d => scanDir(d, 'project')),
  ]

  const seenReal = new Set<string>()
  const seenName = new Set<string>()
  const unconditional: LoadedSkill[] = []
  const conditional: LoadedSkill[] = []

  for (const s of candidates) {
    if (seenReal.has(s.realPath) || seenName.has(s.name)) continue
    seenReal.add(s.realPath)
    seenName.add(s.name)
    if (s.frontmatter.paths && s.frontmatter.paths.length > 0) {
      conditional.push(s)
    } else {
      unconditional.push(s)
    }
  }

  return { unconditional, conditional }
}
