// 极简 frontmatter 解析 —— 定稿 §2 决策 #6（扁平 type:，不解嵌套 metadata.type）。
//
// 只解析顶部 `---\n key: value \n---` 块的扁平键值，足够拿 name/description/type。
// 不引 YAML 库：记忆 frontmatter 是我们自己写入的封闭格式，值都是单行字符串。

export type Frontmatter = {
  name?: string
  description?: string
  type?: string
  [key: string]: string | undefined
}

/**
 * 从内容头部抽取 frontmatter。无 `---` 起始块 → 返回空对象（老文件优雅降级）。
 * 只读到第二个 `---` 为止；每行按第一个 `:` 拆 key/value，去引号去空白。
 */
export function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return {}

  const fm: Frontmatter = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    if (line.trim() === '---') break // 结束块
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    if (!key) continue
    let value = line.slice(colon + 1).trim()
    // 去包裹引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    fm[key] = value
  }
  return fm
}
