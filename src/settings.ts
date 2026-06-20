// ~/.astraea/settings.json — 行为配置（非 secrets）
// 与 config.ts 的分工：
//   config.ts / .env  → API keys、model 选择等 secrets
//   settings.ts / settings.json → vigil 规则、权限白名单等行为配置

import { join } from 'path'
import { homedir } from 'os'

export const globalSettingsPath = join(homedir(), '.astraea', 'settings.json')

// ─── Schema ──────────────────────────────────────────────────────────────────

// ── WeChat 聊天整理配置 ────────────────────────────────────────────────────────

/** 读取范围：三选一 */
export type WechatScope =
  | { type: 'all';      limit: number }     // 所有联系人（上限 50，默认 20）
  | { type: 'top';      k: number }         // 最近 K 个联系人
  | { type: 'contacts'; names: string[] }   // 指定联系人列表

/**
 * 整理方式（可多选）
 *   timeline  - 按时间线排列，以日期分段
 *   contacts  - 按联系人/群聊分组
 *   topics    - 按主题分组（LLM 自动归类）
 *   tasks     - 仅提取待办事项（需要用户行动的）
 *   decisions - 仅提取决策记录（谁决定了什么）
 *   promises  - 承诺追踪（谁承诺了什么，是否已兑现）
 */
export type WechatOrganizeMode =
  | 'timeline'
  | 'contacts'
  | 'topics'
  | 'tasks'
  | 'decisions'
  | 'promises'

export interface WechatSettings {
  /** 读取范围（必填） */
  scope: WechatScope
  /** 往前读取天数，1-30，超出自动截断为 30（默认 30） */
  days: number
  /** 摘要文件保存目录（必填），支持 ~ 展开 */
  outputDir: string
  /** 整理方式，至少一项（默认 ['timeline', 'tasks']） */
  organize: WechatOrganizeMode[]
}

// ── 压缩 hooks（设计文档 §5.1/§5.3）────────────────────────────────────────────
// 用户配的 shell 命令，在压缩前/后由 harness 执行。非致命：超时/报错不阻断压缩。
export interface CompactHooks {
  /** 压缩前执行；stdin 收 {trigger, customInstructions}；stdout 合并进摘要指令。 */
  preCompact?: string
  /** 压缩后执行；stdin 收 {trigger, summary}；纯副作用，stdout 忽略。 */
  postCompact?: string
  /** hook 执行超时（毫秒），默认 10_000。 */
  timeoutMs?: number
}

export interface AstraeaSettings {
  wechat?: Partial<WechatSettings>
  hooks?: CompactHooks
  /** transcript 保留天数（设计文档 §10）：>0 保留天数；0 关闭持久化；<0 永久保留。默认 30。 */
  cleanupPeriodDays?: number
  /** 界面与回复语言（/language 显式选择时写入）。en|de|fr|es|zh|ko；未设置则启动按系统 locale 探测。 */
  language?: string
  /** 推理强度（/reason 持久化）。low|medium|high；max 仅会话不落盘。启动时水合进会话单例。 */
  reasoningEffort?: string
  /**
   * 环境变量注入：启动时由 config.ts 灌进 process.env（如 PHOENIX_ENABLED）。
   * 优先级：shell > settings.json > 项目 .env > 全局 .env（不覆盖 shell 已设的值）。
   */
  env?: Record<string, string>
}

// ─────────────────────────────────────────────────────────────────────────────

/** 验证 wechat 配置，返回错误信息或 null */
export function validateWechatSettings(s: Partial<WechatSettings> | undefined): string | null {
  if (!s) {
    return [
      '微信整理功能尚未配置，请在 ~/.astraea/settings.json 中添加：',
      '',
      '  "wechat": {',
      '    "scope": { "type": "contacts", "names": ["妈妈", "李嘉俊"] },',
      '    "days": 30,',
      '    "outputDir": "~/Documents/wechat-summary",',
      '    "organize": ["timeline", "tasks"]',
      '  }',
      '',
      'scope 三选一：',
      '  { "type": "contacts", "names": [...] }  指定联系人',
      '  { "type": "top", "k": 5 }               最近 K 个联系人',
      '  { "type": "all", "limit": 20 }           所有联系人（上限 50）',
    ].join('\n')
  }
  if (!s.scope) return '缺少 wechat.scope，请配置读取范围'
  if (!s.outputDir?.trim()) return '缺少 wechat.outputDir，请配置摘要文件保存目录'
  if (!s.organize?.length) return '缺少 wechat.organize，请至少填写一种整理方式'

  const { scope } = s
  if (scope.type === 'contacts' && !scope.names?.length)
    return 'wechat.scope.names 不能为空，请填写联系人名字列表'
  if (scope.type === 'top' && (scope.k < 1 || !Number.isFinite(scope.k)))
    return 'wechat.scope.k 必须 ≥ 1'
  if (scope.type === 'all' && (s.scope as { limit: number }).limit > 50)
    return 'wechat.scope.limit 最大为 50'

  return null
}

/** 返回规范化后的 WechatSettings（caps days to 30，填默认值） */
export function resolveWechatSettings(s: Partial<WechatSettings>): WechatSettings {
  const { homedir } = require('node:os')
  return {
    scope: s.scope!,
    days: Math.min(Math.max(1, s.days ?? 30), 30),
    outputDir: (s.outputDir ?? '~/Documents/wechat-summary').replace(/^~/, homedir()),
    organize: s.organize?.length ? s.organize : ['timeline', 'tasks'],
  }
}

// ─── Loader ──────────────────────────────────────────────────────────────────

let _cache: AstraeaSettings | null = null

export function getSettings(): AstraeaSettings {
  if (_cache !== null) return _cache
  try {
    const raw = require('fs').readFileSync(globalSettingsPath, 'utf-8')
    _cache = JSON.parse(raw) as AstraeaSettings
  } catch {
    _cache = {}
  }
  return _cache
}

export function resetSettingsCache(): void {
  _cache = null
}

// 合并写入 ~/.astraea/settings.json：读现有 → patch → 写回，并刷新内存缓存。
// 仅在用户显式选择时调用（如 /language）。pretty-print 与 permissions writer 对齐。
export async function updateSettings(patch: Partial<AstraeaSettings>): Promise<void> {
  let existing: AstraeaSettings = {}
  try {
    existing = JSON.parse(require('fs').readFileSync(globalSettingsPath, 'utf-8')) as AstraeaSettings
  } catch {
    // 文件不存在 / 解析失败 → 从空开始（Bun.write 自动建 ~/.astraea 目录）
  }
  const merged = { ...existing, ...patch }
  await Bun.write(globalSettingsPath, JSON.stringify(merged, null, 2) + '\n')
  _cache = merged
}
