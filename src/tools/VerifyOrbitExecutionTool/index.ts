// VerifyOrbitExecutionTool — 执行完成后的自查工具（env 开关保护）
// 仅在 ASTRAEA_VERIFY_ORBIT=true 时启用
// 只读工具，强制模型在汇报结果前自我核查
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'

const ENABLED = process.env.ASTRAEA_VERIFY_ORBIT === 'true'

export const VerifyOrbitExecutionTool = buildTool({
  name: 'VerifyOrbitExecution',
  description: `Self-verification tool: call this BEFORE reporting a task as complete.

Checks:
1. Were all planned steps completed?
2. Did tests pass (if applicable)?
3. Was the output verified (files exist, commands succeeded)?

Returns a verification report. Only report the task as complete after this tool confirms all steps.

This tool is only active when ASTRAEA_VERIFY_ORBIT=true.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      plan_summary: {
        type: 'string',
        description: 'Brief summary of what was planned',
      },
      steps_completed: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of steps that were completed',
      },
      steps_skipped: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of planned steps that were skipped, with reasons',
      },
      verification_commands_run: {
        type: 'array',
        items: { type: 'string' },
        description: 'Commands or checks run to verify the implementation',
      },
      all_tests_passed: {
        type: 'boolean',
        description: 'Whether all relevant tests passed',
      },
    },
    required: ['plan_summary', 'steps_completed'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    if (!ENABLED) {
      return {
        output: 'VerifyOrbitExecution is disabled. Set ASTRAEA_VERIFY_ORBIT=true to enable.',
      }
    }

    const planSummary = input['plan_summary'] as string
    const stepsCompleted = (input['steps_completed'] as string[]) ?? []
    const stepsSkipped = (input['steps_skipped'] as string[]) ?? []
    const verifyCmds = (input['verification_commands_run'] as string[]) ?? []
    const allTestsPassed = input['all_tests_passed'] as boolean | undefined

    const issues: string[] = []

    if (stepsCompleted.length === 0) {
      issues.push('No steps reported as completed.')
    }
    if (stepsSkipped.length > 0) {
      issues.push(`${stepsSkipped.length} planned step(s) were skipped: ${stepsSkipped.join(', ')}`)
    }
    if (verifyCmds.length === 0) {
      issues.push('No verification commands were run. Cannot confirm implementation correctness.')
    }
    if (allTestsPassed === false) {
      issues.push('Tests failed. Do not report as complete until tests pass.')
    }

    const verdict = issues.length === 0 ? 'PASS' : 'FAIL'

    return {
      output: [
        `Verification: ${verdict}`,
        '',
        `Plan: ${planSummary}`,
        '',
        `Steps completed (${stepsCompleted.length}):`,
        ...stepsCompleted.map(s => `  ✓ ${s}`),
        ...(stepsSkipped.length > 0
          ? ['', `Steps skipped (${stepsSkipped.length}):`, ...stepsSkipped.map(s => `  ✗ ${s}`)]
          : []),
        ...(verifyCmds.length > 0
          ? ['', `Verification commands run:`, ...verifyCmds.map(c => `  $ ${c}`)]
          : []),
        ...(issues.length > 0
          ? ['', 'Issues found:', ...issues.map(i => `  ! ${i}`)]
          : []),
        '',
        verdict === 'PASS'
          ? 'All checks passed. Safe to report completion.'
          : 'Fix the issues above before reporting completion.',
      ].join('\n'),
      isError: verdict === 'FAIL',
    }
  },
})
