// 记忆路径解析 —— 定稿 §1（身份与存储）
//
// 决策：
//   #2 身份锚点 = canonical git root，无 git 回退 cwd（worktree/分支共享记忆）
//   #3 base = ~/.astraea/projects/<slug>/memory/，空目录起步
//   #4 路径只能推导，不支持 autoMemoryDirectory 覆盖 → 无注入向量
//   #5 isMemoryPath() 供写豁免在红线之前判定（只覆盖 memoryDir 子树）
//
// getMemoryDir 是同步且 memoize 的：isMemoryPath() 在 FileWrite 热路径上被调用，
// 不能每次 fork git 子进程。memoize key = cwd，便于测试换 mock 后重算。

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

/** 记忆根目录：~/.astraea（与 settings/plans/transcripts 同体系，独立于 ~/.claude）。 */
export function getMemoryBaseDir(): string {
  return join(homedir(), '.astraea')
}

/**
 * 找 canonical git root。返回 .git 真实根（resolve 软链），找不到返回 null。
 * 用 --show-toplevel；失败（非 git 仓 / git 未装）静默回退。
 */
function findGitRoot(cwd: string): string | null {
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return root ? resolve(root) : null
  } catch {
    return null
  }
}

// 全路径 → slug：防两个都叫 "app" 的项目共享记忆。
// /home/alice/work/my-app → home-alice-work-my-app
function pathToSlug(p: string): string {
  return p
    .replace(/^\//, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '_')
}

// 同步 memoize（cwd → memoryDir）。isMemoryPath 在 FileWrite 热路径上反复调用，
// 不能每次 fork git；缓存以 cwd 为 key，测试可 resetMemoryDirCache() 清。
const _dirCache = new Map<string, string>()

/**
 * 记忆目录绝对路径。身份锚点 = git root（无 git 回退 cwd）。
 */
export function getMemoryDir(cwd: string): string {
  const cached = _dirCache.get(cwd)
  if (cached !== undefined) return cached
  const anchor = findGitRoot(cwd) ?? cwd
  const dir = join(getMemoryBaseDir(), 'projects', pathToSlug(anchor), 'memory')
  _dirCache.set(cwd, dir)
  return dir
}

/** 清空路径缓存（测试用，或 mock fs 后重算）。 */
export function resetMemoryDirCache(): void {
  _dirCache.clear()
}

/**
 * 某绝对路径是否落在【当前 cwd 的】记忆目录子树内。先 normalize 防 `memory/../../etc`
 * 用 startsWith 蒙混。
 */
export function isMemoryPath(absolutePath: string, cwd: string): boolean {
  const dir = getMemoryDir(cwd)
  const p = normalize(absolutePath)
  return p === dir || p.startsWith(dir + '/')
}

/**
 * 某绝对路径是否落在【任意项目的】记忆子树 `<base>/projects/<slug>/memory/**`。
 * cwd 无关，供写豁免（#5）在 .astraea 红线之前判定 —— 只放行记忆数据子树，
 * `~/.astraea/settings.json`（不在 projects 下）、transcripts（projects/<slug>/*.jsonl，
 * 第二段非 memory）、plans/ 等仍走红线，杜绝自我提权。
 */
export function isAnyMemoryPath(absolutePath: string): boolean {
  const p = normalize(absolutePath)
  const projects = join(getMemoryBaseDir(), 'projects')
  if (!p.startsWith(projects + '/')) return false
  const parts = p.slice(projects.length + 1).split('/')
  // parts = [<slug>, 'memory', ...] —— 第二段必须正是 memory 目录。
  return parts.length >= 3 && parts[1] === 'memory'
}

/**
 * 保证记忆目录存在（harness 侧调用，对齐 DIR_EXISTS_GUIDANCE：prompt 告诉模型
 * 别 ls/mkdir，直接 Write）。失败静默 —— 调用方自行优雅降级。
 */
export async function ensureMemoryDirExists(cwd: string): Promise<void> {
  try {
    await mkdir(getMemoryDir(cwd), { recursive: true })
  } catch {
    // 权限/IO 错误 —— 不致命，读路径会 readdir 失败后返回 null。
  }
}

/** MEMORY.md 索引文件绝对路径。 */
export function getEntrypointPath(cwd: string): string {
  return join(getMemoryDir(cwd), 'MEMORY.md')
}
