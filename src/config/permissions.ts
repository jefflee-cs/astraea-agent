// 权限配置文件读写（Permission & Safety Technical Spec §1.1 三层 Scope）
//
// 三层叠加，优先级高 → 低：
//   local  ：<cwd>/.astraea/settings.local.json   （个人私有，gitignored）
//   project：<cwd>/.astraea/settings.json          （团队共享，进 Git）
//   global ：~/.astraea/settings.json              （个人全局）
//
// 文件格式:
// {
//   "permissions": {
//     "allow": ["bun install", "git fetch:*"],
//     "deny":  ["git push origin main --force"],
//     "ask":   ["git push:*", "npm publish:*"]
//   }
// }

import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'
import type { PermissionRule } from '../tools/BashTool/permissions/permission-rules.js'
import { commandTouchesSensitivePath } from './redlines.js'

interface PermissionsSection {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

interface AstraeaSettings {
  permissions?: PermissionsSection
}

export const CONFIG_DIR = '.astraea'
export const CONFIG_FILE = 'settings.json'
export const LOCAL_CONFIG_FILE = 'settings.local.json'

/** 持久化目标 scope。'session' 仅内存（由调用方处理，不落盘）。 */
export type RuleDestination = 'session' | 'local' | 'project' | 'global'

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE)
}

export function localConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, LOCAL_CONFIG_FILE)
}

export function globalConfigPath(): string {
  return join(homedir(), CONFIG_DIR, CONFIG_FILE)
}

function destinationPath(cwd: string, dest: Exclude<RuleDestination, 'session'>): string {
  switch (dest) {
    case 'local':
      return localConfigPath(cwd)
    case 'project':
      return projectConfigPath(cwd)
    case 'global':
      return globalConfigPath()
  }
}

async function readConfig(path: string): Promise<AstraeaSettings> {
  try {
    const text = await Bun.file(path).text()
    return JSON.parse(text) as AstraeaSettings
  } catch {
    return {}
  }
}

/**
 * 从 local + project + global 三层合并权限规则。
 * 规则顺序：deny → ask → allow（保守优先）；同一行为内 local > project > global。
 */
export async function loadPermissionRules(cwd: string): Promise<PermissionRule[]> {
  const [local, project, global] = await Promise.all([
    readConfig(localConfigPath(cwd)),
    readConfig(projectConfigPath(cwd)),
    readConfig(globalConfigPath()),
  ])

  // 同一行为内，local 在前（高优先），再 project，再 global
  const collect = (key: keyof PermissionsSection): string[] => [
    ...(local.permissions?.[key] ?? []),
    ...(project.permissions?.[key] ?? []),
    ...(global.permissions?.[key] ?? []),
  ]

  const merged: Required<PermissionsSection> = {
    deny: collect('deny'),
    ask: collect('ask'),
    allow: collect('allow'),
  }

  return [
    ...merged.deny.map((pattern) => ({ pattern, action: 'deny' as const })),
    ...merged.ask.map((pattern) => ({ pattern, action: 'ask' as const })),
    ...merged.allow.map((pattern) => ({ pattern, action: 'allow' as const })),
  ]
}

/**
 * 将一条新规则持久化写入指定 scope（默认 local，对齐 CC 的"Always allow 默认写 local"）。
 * - destination='session' → 不落盘（调用方应自行维护内存规则）。
 * - 红线保护：禁止把触碰敏感路径的命令写成 'allow' 规则（防自我提权 / Ask→Persist 打开后门）。
 * - 自动创建目录；重复 pattern 幂等跳过。
 */
export async function appendPermissionRule(
  cwd: string,
  pattern: string,
  action: 'allow' | 'deny',
  destination: RuleDestination = 'local',
): Promise<void> {
  if (destination === 'session') return // 仅内存，调用方负责

  // 红线：不允许把敏感路径命令持久化为 allow
  if (action === 'allow' && commandTouchesSensitivePath(pattern)) {
    throw new Error(
      `Refusing to persist an allow rule for a command that touches a sensitive path (red-line): "${pattern}". This protects .git/ .astraea/ and shell configs from being permanently auto-approved.`,
    )
  }

  const path = destinationPath(cwd, destination)
  const existing = await readConfig(path)

  if (!existing.permissions) existing.permissions = {}
  const list = existing.permissions[action] ?? []

  if (list.includes(pattern)) return // 已存在，幂等

  existing.permissions[action] = [...list, pattern]

  mkdirSync(join(cwd, CONFIG_DIR), { recursive: true })
  // global 落在 ~/.astraea，需确保其目录存在
  if (destination === 'global') mkdirSync(join(homedir(), CONFIG_DIR), { recursive: true })

  await Bun.write(path, JSON.stringify(existing, null, 2) + '\n')
}
