// ExitOrbitModeTool — 提交规划、请求用户审批、恢复执行权限
// 执行流程：
//   1. 计划文本写入 ~/.astraea/plans/<slug>.md
//   2. 通过 AskUserQuestion bridge 向用户弹出审批
//   3. 用户批准 → restorePreMode()，返回完整计划文本给模型
//   4. 用户拒绝 → 保持 orbit 模式，返回拒绝消息
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { restorePreMode, getMode } from '../../state/sessionMode.js'
import { getPlanFilePath, getPlanSlug } from '../../utils/planSlug.js'
import { ask } from '../AskUserQuestionTool/bridge.js'
import { writeFileSync } from 'node:fs'

export const ExitOrbitModeTool = buildTool({
  name: 'ExitOrbitMode',
  description: `Exit orbit mode by presenting your complete plan for user approval.

Call this tool when you have finished exploring and are ready to present your plan.

The plan will be:
1. Written to ~/.astraea/plans/<slug>.md for audit trail
2. Presented to the user for approval
3. If approved: file write permissions are restored and you can begin implementation
4. If rejected: you remain in orbit mode to revise the plan

The plan parameter must contain your complete, structured implementation plan.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'Your complete implementation plan in markdown format',
      },
    },
    required: ['plan'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    if (getMode() !== 'orbit') {
      return {
        output: 'ExitOrbitMode can only be called when in orbit mode.',
        isError: true,
      }
    }

    const plan = input['plan'] as string
    if (!plan?.trim()) {
      return { output: 'plan is required and must not be empty.', isError: true }
    }

    // ── 1. 写计划文件 ─────────────────────────────────────────────────────
    const planPath = getPlanFilePath()
    const slug = getPlanSlug()
    try {
      writeFileSync(planPath, plan, 'utf-8')
    } catch (err) {
      return { output: `Failed to write plan file: ${err}`, isError: true }
    }

    // ── 2. 向用户展示摘要 + 审批 ─────────────────────────────────────────
    const previewLines = plan.split('\n').slice(0, 25)
    const preview = previewLines.join('\n') + (plan.split('\n').length > 25 ? '\n…' : '')

    const approvalPrompt = [
      `Plan ready (saved to ~/.astraea/plans/${slug}.md):`,
      '',
      preview,
      '',
      'Approve this plan and begin implementation?',
    ].join('\n')

    const answer = await ask(approvalPrompt, ['yes — approve and execute', 'no — revise the plan'])

    const approved = answer.toLowerCase().startsWith('y') ||
      answer === '1' ||
      answer.toLowerCase().includes('approve')

    // ── 3. 审批结果处理 ───────────────────────────────────────────────────
    if (approved) {
      restorePreMode()
      return {
        output: [
          'Plan approved. Orbit mode deactivated — file writes restored.',
          '',
          `Plan file: ~/.astraea/plans/${slug}.md`,
          '',
          '--- APPROVED PLAN ---',
          plan,
          '--- END PLAN ---',
          '',
          'Proceed with implementation as planned.',
        ].join('\n'),
      }
    } else {
      return {
        output: [
          'Plan rejected. Still in orbit mode.',
          '',
          'Revise your plan and call ExitOrbitMode again when ready.',
        ].join('\n'),
        isError: false,
      }
    }
  },
})
