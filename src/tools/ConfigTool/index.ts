import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { globalSettingsPath } from '../../settings.js'

let _testPath: string | undefined

/** Test-only: override the settings file path. Pass undefined to restore. */
export function _setSettingsPathForTest(p: string | undefined) { _testPath = p }

function settingsPath() { return _testPath ?? globalSettingsPath }

function readSettings(): Record<string, unknown> {
  const p = settingsPath()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

function writeSettings(obj: Record<string, unknown>) {
  const p = settingsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2))
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) =>
    cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined, obj)
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.')
  const result = structuredClone(obj)
  let cur = result as Record<string, unknown>
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]!] = value
  return result
}

export const ConfigTool = buildTool({
  name: 'Config',
  description: `Read or write Astraea settings in ~/.astraea/settings.json.

Read:  { key: "wechat.days" }                     → returns current value
Write: { key: "wechat.days", value: 14 }          → updates and returns before/after

Key supports dot-path notation for nested fields (e.g. "wechat.scope", "model").`,
  isReadOnly: (input) => !('value' in input),
  inputSchema: {
    type: 'object',
    properties: {
      key:   { type: 'string', description: 'Dot-path key, e.g. "model" or "wechat.days"' },
      value: { description: 'New value to write. Omit for read-only.' },
    },
    required: ['key'],
  },

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult> {
    const key = String(input['key'] ?? '')
    const hasValue = 'value' in input

    const settings = readSettings()

    if (!hasValue) {
      const val = getByPath(settings, key)
      return {
        output: val === undefined
          ? `"${key}" is not set in settings.json.`
          : `${key} = ${JSON.stringify(val, null, 2)}`,
      }
    }

    const before = getByPath(settings, key)
    const updated = setByPath(settings, key, input['value'])
    writeSettings(updated)

    return {
      output: [
        `✓ Updated "${key}"`,
        `  before: ${JSON.stringify(before)}`,
        `  after:  ${JSON.stringify(input['value'])}`,
      ].join('\n'),
    }
  },
})
