#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// 离线评估脚本 —— 用 @arizeai/phoenix-evals 给 astraea 的产出打分。
//
// 跟 astraea 运行时用哪个 provider 无关：评估「裁判模型」走 Vercel AI SDK，
// 独立配置（默认 OpenAI）。你只需要喂一份记录文件。
//
// 安装（评估侧）：
//   bun add @arizeai/phoenix-evals @ai-sdk/openai
//   # 想用 Anthropic 当裁判： bun add @ai-sdk/anthropic
//
// 用法：
//   export OPENAI_API_KEY=sk-...
//   bun run scripts/eval/run-evals.ts ./scripts/eval/sample-dataset.jsonl
//
// 输入文件格式（JSONL，每行一条；或 JSON 数组）：
//   {"input":"用户问题","output":"astraea 的回答","context":"可选参考材料","expectedTool":"可选：期望调用的工具名","tools":"可选：可用工具描述"}
//
// 输出：逐条打印 label/score/explanation，并落地一个 *.scored.json 汇总。
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs'
import { openai } from '@ai-sdk/openai'
import {
  createCorrectnessEvaluator,
  createConcisenessEvaluator,
  createRefusalEvaluator,
} from '@arizeai/phoenix-evals/llm'

// ── 裁判模型：可用 EVAL_MODEL 覆盖 ──────────────────────────────────────────────
const model = openai(process.env.EVAL_MODEL ?? 'gpt-4o-mini')

type Record_ = {
  input: string
  output: string
  context?: string
  expectedTool?: string
  tools?: string
}

function loadRecords(path: string): Record_[] {
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.startsWith('[')) return JSON.parse(raw)
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('用法: bun run scripts/eval/run-evals.ts <records.jsonl>')
    process.exit(1)
  }

  const records = loadRecords(path)
  console.log(`▶ 载入 ${records.length} 条记录，裁判模型 = ${process.env.EVAL_MODEL ?? 'gpt-4o-mini'}\n`)

  // 选用的内置 evaluator。需要 tool-selection / faithfulness 等可自行加，见 SOP §3。
  const correctness = createCorrectnessEvaluator({ model })
  const conciseness = createConcisenessEvaluator({ model })
  const refusal = createRefusalEvaluator({ model })

  const scored: any[] = []
  let i = 0
  for (const r of records) {
    i++
    const [corr, conc, ref] = await Promise.all([
      correctness.evaluate({ input: r.input, output: r.output }).catch(errResult),
      conciseness.evaluate({ input: r.input, output: r.output }).catch(errResult),
      refusal.evaluate({ input: r.input, output: r.output }).catch(errResult),
    ])

    const row = {
      input: r.input.slice(0, 80),
      correctness: corr,
      conciseness: conc,
      refusal: ref,
    }
    scored.push({ ...r, evals: { correctness: corr, conciseness: conc, refusal: ref } })

    console.log(
      `#${i}  correctness=${fmt(corr)}  conciseness=${fmt(conc)}  refusal=${fmt(ref)}\n` +
        `    ↳ ${r.input.slice(0, 70)}`,
    )
  }

  // ── 汇总 ──
  const avg = (k: string) =>
    (scored.reduce((s, r) => s + (r.evals[k]?.score ?? 0), 0) / scored.length).toFixed(3)
  console.log('\n── 汇总 ──────────────────────────────')
  console.log(`correctness 均分: ${avg('correctness')}`)
  console.log(`conciseness 均分: ${avg('conciseness')}`)
  console.log(`refusal 均分:     ${avg('refusal')}  (1 = 拒答)`)

  const out = path.replace(/\.(jsonl|json)$/, '') + '.scored.json'
  writeFileSync(out, JSON.stringify(scored, null, 2))
  console.log(`\n✓ 明细已写入 ${out}`)
}

function fmt(r: any): string {
  return `${r.label}(${r.score})`
}
function errResult(e: unknown) {
  return { label: 'error', score: 0, explanation: String(e) }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
