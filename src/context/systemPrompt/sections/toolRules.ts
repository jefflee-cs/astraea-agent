// § 5 工具使用规范 — 全局总则，根据实际启用的工具集动态裁剪
// 工具集在会话初始化后固定，仍归入静态段

export function getToolRulesSection(enabledTools: Set<string>): string {
  const hasRead    = enabledTools.has('Read')
  const hasEdit    = enabledTools.has('Edit')
  const hasWrite   = enabledTools.has('Write')
  const hasGlob    = enabledTools.has('Glob')
  const hasGrep    = enabledTools.has('Grep')
  const hasTask    = enabledTools.has('TaskCreate')
  const hasAskUser = enabledTools.has('AskUserQuestion')
  const hasVigilOnce     = enabledTools.has('VigilOnce')
  const hasVigilSchedule = enabledTools.has('VigilSchedule')

  const substitutions = [
    hasRead  ? 'Use Read instead of cat, head, tail, or sed' : null,
    hasEdit  ? 'Use Edit instead of sed or awk' : null,
    hasWrite ? 'Use Write instead of echo redirection or cat heredoc' : null,
    hasGlob  ? 'Use Glob instead of find or ls' : null,
    hasGrep  ? 'Use Grep instead of grep or rg' : null,
    'Reserve Bash for system commands that truly require shell execution — it is the last resort',
  ].filter((x): x is string => x !== null)

  const globGuidance = hasGlob
    ? ` - When you do not know the exact filename, ALWAYS use a broad Glob pattern first (e.g. \`**/*keyword*\`) to discover the actual name and extension before operating on the file. Never assume a specific filename, separator style (space vs underscore), or extension — use Glob to confirm reality first.`
    : null

  const taskGuidance = hasTask
    ? ` - Break down work with TaskCreate. Mark each task in_progress before starting, completed immediately when done — do not batch completions.`
    : null

  const askGuidance = hasAskUser
    ? ` - Use AskUserQuestion to clarify ambiguous intent BEFORE starting implementation (e.g. "minimal or visually rich?", "which approach?"). Ask at most once per task.`
    : null

  const vigilGuidance = (hasVigilOnce || hasVigilSchedule)
    ? [
        ` - Scheduling tasks (VigilOnce / VigilSchedule):`,
        `   - Ask yourself: does the user want the action to happen NOW, or LATER? If later, use VigilOnce or VigilSchedule instead of executing immediately.`,
        `   - Use VigilOnce for deferred one-time actions. Use VigilSchedule for recurring or calendar-based actions.`,
        `   - NEVER use VigilSchedule to express a one-time delay by picking a cron like "*/1 * * * *".`,
        `   - Before calling either tool, state what you understood (what, when, one-time vs recurring) so the user can correct you.`,
        `   - CRITICAL: When the prompt involves a person's name, place, or any identifier, preserve it EXACTLY in its original language and form. NEVER transliterate or translate names (e.g. keep "李嘉俊" as "李嘉俊", never convert to "Li Jiajun").`,
      ].join('\n')
    : null

  const writeGuidance = hasWrite
    ? ` - Before writing any file with the Write tool, first attempt to Read it. If Read fails (file does not exist), proceed with Write directly. If Read succeeds (file exists), write only after reading.`
    : null

  const editGuidance = hasEdit
    ? ` - Before editing a file with Edit, Read the WHOLE file first — not a 50-line slice with offset/limit. Edit refuses to run against a partially-read file (the write guard rejects it), so a partial Read forces a wasteful re-read and retry. Read it fully once, then edit.`
    : null

  const lines = [
    '# Using your tools',
    ` - Do NOT use Bash when a dedicated tool is provided:`,
    ...substitutions.map(g => `   - ${g}`),
    ` - You can call multiple tools in a single response. When tools have no dependencies between them, call them in parallel. When tool calls depend on previous results, call them sequentially.`,
    globGuidance,
    taskGuidance,
    askGuidance,
    vigilGuidance,
    writeGuidance,
    editGuidance,
  ].filter((x): x is string => x !== null)

  return lines.join('\n')
}
