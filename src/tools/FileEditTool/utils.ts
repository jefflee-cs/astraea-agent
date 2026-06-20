// FileEditTool 工具函数
// 参考: astraea-trace-and-build / FileEditTool 教学文档 Step 3

/** 将弯引号规范化为直引号，用于 LLM 输出与文件内容的模糊匹配 */
function normalizeQuotes(s: string): string {
  return s
    .replace(/“|”/g, '"') // " " → "
    .replace(/‘|’/g, "'") // ' ' → '
}

/**
 * 在 fileContent 中查找 searchString。
 * 先精确匹配，失败则做引号规范化后再试。
 * 返回文件中实际存在的文本片段（保留原始引号），或 null。
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  if (searchString === '') return ''
  if (fileContent.includes(searchString)) return searchString

  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx === -1) return null

  // 返回文件中的原始片段（长度与 searchString 相同）
  return fileContent.substring(idx, idx + searchString.length)
}

/**
 * 若文件中的实际字符串含有弯引号（LLM 输出的是直引号，匹配时被规范化），
 * 则对 newString 中的直引号做相同转换，保持文件排版风格。
 */
export function preserveQuoteStyle(
  originalOld: string,
  actualOld: string,
  newString: string,
): string {
  if (originalOld === actualOld) return newString

  const hasCurlyDouble = /“|”/.test(actualOld)
  const hasCurlySingle = /‘|’/.test(actualOld)
  if (!hasCurlyDouble && !hasCurlySingle) return newString

  let result = newString
  if (hasCurlyDouble) {
    let open = true
    result = result.replace(/"/g, () => {
      const q = open ? '“' : '”'
      open = !open
      return q
    })
  }
  if (hasCurlySingle) {
    let open = true
    result = result.replace(/'/g, () => {
      const q = open ? '‘' : '’'
      open = !open
      return q
    })
  }
  return result
}

/**
 * 在 fileContents 中将 oldString 替换为 newString。
 * replaceAll=true 时替换全部匹配；否则只替换第一处。
 * old_string 为空表示创建新文件，直接返回 newString。
 */
export function applyEdit(
  fileContents: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === '') return newString

  if (replaceAll) {
    return fileContents.split(oldString).join(newString)
  }

  const idx = fileContents.indexOf(oldString)
  if (idx === -1) return fileContents
  return fileContents.substring(0, idx) + newString + fileContents.substring(idx + oldString.length)
}

/**
 * 生成标准 unified-diff（含上下文行 + @@ 行号头），用于 ToolCallResult 输出展示。
 *
 * 与旧实现的区别（trace 4 修复）：旧版只把 old 全打 '-'、new 全打 '+'，无行号、无上下文。
 * 现在对「整文件前后版本」做行级 diff，取公共前后缀定位变更区，输出带 context 行的单个 hunk：
 *   @@ -oldStart,oldCount +newStart,newCount @@
 *    context（空格前缀）
 *   -removed
 *   +added
 *    context
 * 行号由 renderResult 从 @@ 头推导（模型侧拿到的是标准 diff，渲染侧再加行号沟）。
 *
 * 入参是「整文件」前后内容（非 old_string/new_string 片段），这样上下文与行号都精确。
 */
export function formatDiff(oldFile: string, newFile: string, context = 3): string {
  if (oldFile === newFile) return ''
  const oldLines = oldFile.split('\n')
  const newLines = newFile.split('\n')

  // 公共前缀
  let p = 0
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++
  // 公共后缀（不与前缀重叠）
  let s = 0
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  ) s++

  const oldChangeEnd = oldLines.length - s   // 变更区：old[p, oldChangeEnd)
  const newChangeEnd = newLines.length - s   //         new[p, newChangeEnd)

  const ctxStart = Math.max(0, p - context)
  const oldCtxEnd = Math.min(oldLines.length, oldChangeEnd + context)
  const newCtxEnd = Math.min(newLines.length, newChangeEnd + context)

  const oldCount = oldCtxEnd - ctxStart
  const newCount = newCtxEnd - ctxStart

  const out: string[] = [`@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`]
  for (let i = ctxStart; i < p; i++) out.push(` ${oldLines[i]}`)            // 前置上下文
  for (let i = p; i < oldChangeEnd; i++) out.push(`-${oldLines[i]}`)         // 删除
  for (let i = p; i < newChangeEnd; i++) out.push(`+${newLines[i]}`)         // 新增
  for (let i = oldChangeEnd; i < oldCtxEnd; i++) out.push(` ${oldLines[i]}`) // 后置上下文
  return out.join('\n')
}
