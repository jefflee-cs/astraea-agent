// SKILL.md frontmatter 解析 —— 比 memory/frontmatter 更全：支持布尔、内联数组 [a,b]
// 与块数组（- item）。不引 YAML 库（封闭格式，值都简单），手解足够。
//
// 字段映射（kebab/snake → camel），对齐 claude-code parseSkillFrontmatterFields：
//   description, when_to_use/when-to-use, allowed-tools, paths, model,
//   user-invocable, disable-model-invocation, argument-hint, context, agent
//
// 注意闸门方向：disable-model-invocation:true → modelInvocable=false。

import type { SkillFrontmatter } from './types'

/** frontmatter 原始值：标量字符串 / 布尔 / 字符串数组。 */
type RawValue = string | boolean | string[]

/**
 * 抽取顶部 `---` 块为 key→RawValue 映射。无起始 `---` → 空对象。
 * 支持：
 *   key: value            → 标量（布尔 true/false 识别）
 *   key: [a, b, "c"]      → 内联数组
 *   key:                  → 紧跟若干 "  - item" 行 → 块数组
 */
export function parseRawFrontmatter(content: string): {
  fields: Record<string, RawValue>
  body: string
} {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return { fields: {}, body: content }

  const fields: Record<string, RawValue> = {}
  let endIdx = -1

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    if (line.trim() === '---') {
      endIdx = i
      break
    }
    // 块数组项：归属上一个 "key:" 空值
    const blockItem = line.match(/^\s*-\s+(.*)$/)
    if (blockItem) continue // 在下面的 key 处理里前瞻消费，这里跳过

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    if (!key) continue
    let rest = line.slice(colon + 1).trim()

    if (rest === '') {
      // 可能是块数组：前瞻收集后续 "- item" 行
      const items: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const m = lines[j]?.match(/^\s*-\s+(.*)$/)
        if (!m) break
        items.push(unquote(m[1]!.trim()))
        j++
      }
      if (items.length > 0) {
        fields[key] = items
        i = j - 1
      } else {
        fields[key] = ''
      }
      continue
    }

    // 内联数组
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      fields[key] = inner === '' ? [] : inner.split(',').map(s => unquote(s.trim())).filter(Boolean)
      continue
    }

    rest = unquote(rest)
    // 布尔
    if (rest === 'true' || rest === 'false') {
      fields[key] = rest === 'true'
    } else {
      fields[key] = rest
    }
  }

  const body = endIdx >= 0 ? lines.slice(endIdx + 1).join('\n') : content
  return { fields, body }
}

function unquote(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1)
  }
  return v
}

function asString(v: RawValue | undefined): string | undefined {
  if (typeof v === 'string') return v || undefined
  if (Array.isArray(v)) return v.join(', ')
  return undefined
}

function asArray(v: RawValue | undefined): string[] | undefined {
  if (Array.isArray(v)) return v.length ? v : undefined
  if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean)
  return undefined
}

function asBool(v: RawValue | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

/** 取第一个存在的键（容忍 kebab / snake 两种写法）。 */
function pick(f: Record<string, RawValue>, ...keys: string[]): RawValue | undefined {
  for (const k of keys) if (k in f) return f[k]
  return undefined
}

/** 把原始字段映射成强类型 SkillFrontmatter（含闸门默认值）。 */
export function parseSkillFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const { fields, body } = parseRawFrontmatter(content)

  const disableModel = asBool(pick(fields, 'disable-model-invocation', 'disable_model_invocation'))
  const userInv = asBool(pick(fields, 'user-invocable', 'user_invocable'))
  const ctx = asString(pick(fields, 'context'))

  const frontmatter: SkillFrontmatter = {
    description: asString(pick(fields, 'description')),
    whenToUse: asString(pick(fields, 'when_to_use', 'when-to-use')),
    allowedTools: asArray(pick(fields, 'allowed-tools', 'allowed_tools')),
    paths: asArray(pick(fields, 'paths')),
    model: asString(pick(fields, 'model')),
    // 默认两个入口都开（CC 常态）
    userInvocable: userInv ?? true,
    modelInvocable: disableModel === undefined ? true : !disableModel,
    argumentHint: asString(pick(fields, 'argument-hint', 'argument_hint')),
    context: ctx === 'fork' ? 'fork' : ctx === 'inline' ? 'inline' : undefined,
    agent: asString(pick(fields, 'agent')),
  }

  return { frontmatter, body }
}
