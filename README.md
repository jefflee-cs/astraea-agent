<div align="center">

# Astraea

### An agent of order and precision

**Astraea** is a terminal-native AI coding agent that resolves disorder — it doesn't just write code, it imposes structure on any problem that arrives with ambiguity, inefficiency, or unchecked complexity.

Built from the ground up on [**Bun**](https://bun.com), with a React Ink TUI, multi-provider model support, sub-agents, scheduling, and a permission system you can actually trust.

<p>
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white">
  <img alt="Language" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white">
  <img alt="UI" src="https://img.shields.io/badge/TUI-React%20Ink-61DAFB?logo=react&logoColor=black">
  <img alt="Providers" src="https://img.shields.io/badge/providers-Anthropic%20·%20OpenAI%20·%20Ollama-7C3AED">
  <img alt="License" src="https://img.shields.io/badge/license-Private-lightgrey">
</p>

</div>

---

## 1 · Introduction

Astraea is an interactive agent for software engineering and any task with high logical density — system design, contract analysis, decision decomposition, process planning. It operates through structured reasoning and verified facts: it reaches for a tool before it speculates, and follows a defined path before it improvises.

It runs in your terminal as either a **persistent REPL** (multi-turn, React Ink UI) or a **single-shot CLI** (great for pipes and scripts), and can run **headless** as a scheduled daemon.

### Why Astraea

| | |
|---|---|
| 🧩 **Multi-provider** | First-class support for **Anthropic**, **OpenAI**, and local **Ollama** — switch with a single env var. |
| 🛰️ **Five session modes** | `default` · `orbit` (read-only planning) · `cruise` (auto-accept edits) · `forge` (bypass prompts) · `counsel` (confirm direction first). |
| 🛡️ **Permission system** | A mode × behavior matrix with hard **red-lines** that can never be bypassed — auto-approve the safe, always gate the dangerous. |
| 🔧 **Rich tool suite** | Files, shell (Bash + PowerShell), web (fetch / search / headless browser), LSP, MCP resources, and skills. |
| 🤝 **Sub-agents** | Spawn worker agents, message peers, and fan out complex work — coordination tools included. |
| ⏰ **Vigil scheduling** | Schedule one-off or recurring agent tasks that run headless via a background daemon. |
| 🧠 **Memory & compaction** | Persistent file-based memory injection, prompt-cache-aware system prompts, and automatic context compaction. |
| 💬 **WeChat integration** | Read and write WeChat conversations through driven automation. |
| 🔍 **Web search** | Pluggable providers — **Tavily**, **Brave**, or **Exa** semantic search. |

---

## 2 · Quick Install

Astraea runs on [Bun](https://bun.com) (v1.3+). If you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then clone and install dependencies:

```bash
git clone <your-repo-url> astraea
cd astraea
bun install
```

Configure your provider. Copy the example env and add a key:

```bash
cp .env.example .env
```

```bash
# .env  — pick one provider
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx     # default
# PROVIDER=openai
# OPENAI_API_KEY=sk-xxxxxxxxxxxxx
# PROVIDER=ollama                          # fully local, no key needed
# OLLAMA_MODEL=qwen2.5:7b
```

> 💡 **Tip:** Personal API keys (search providers, etc.) can live in a global `~/.astraea/.env`, so every Astraea project reuses them and you never risk committing a secret. Create it with `mkdir -p ~/.astraea`.

Optional — enable web search by adding one of these to `~/.astraea/.env`:

```bash
TAVILY_API_KEY=tvly-xxx        # 1,000 req/mo, built for AI agents (recommended)
# BRAVE_SEARCH_API_KEY=BSA-xxx # 2,000 req/mo
# EXA_API_KEY=xxx              # 1,000 req/mo, semantic search for research
```

---

## 3 · Getting Started

### Launch the interactive REPL

The primary way to use Astraea — a persistent, multi-turn React Ink UI:

```bash
bun run repl
# or directly
bun run src/repl.tsx
```

You'll see the active provider and model printed on startup, then a prompt. Just start talking:

```
✦ astraea › refactor src/query.ts to extract the streaming loop into its own module
```

### One-shot CLI

Ask a single question and get a single answer — ideal for scripts and pipes:

```bash
# direct argument
bun run src/cli.ts "explain what src/services/compact does"

# pipe mode
echo "summarize the changes on this branch" | bun run src/cli.ts
```

### Session modes

Switch how much autonomy Astraea has. Each mode trades convenience for caution:

| Mode | Behavior |
|------|----------|
| `default` | Standard prompts — asks before writing files or running shell commands. |
| `orbit` | **Read-only planning.** Writes are blocked; Astraea reads, searches, and presents a plan for approval. |
| `cruise` | File writes auto-approved; shell still asks. |
| `forge` | Auto-accepts all changes, skipping prompts — red-lines still block. |
| `counsel` | Confirms direction with you (AI-driven questionnaire) before executing. |

### Scheduled & headless tasks (Vigil)

Run the scheduler daemon, which executes recurring agent tasks in the background:

```bash
bun run src/cli.ts --daemon          # start the scheduling daemon
```

Tasks are dispatched as isolated headless agents — no UI, full tool access.

### WeChat automation

```bash
bun run setup:wechat                 # one-time setup
bun run wechat:stop                  # signal the reader to stop at the next checkpoint
```

### Project scripts

| Command | Description |
|---------|-------------|
| `bun run repl` | Launch the interactive Ink REPL |
| `bun run cli` | Run the single-shot CLI |
| `bun test` | Run the test suite (`bun:test`) |
| `bun run typecheck` | Type-check with `tsc --noEmit` |

---

## Architecture at a glance

```
src/
├── cli.ts / repl.tsx      # entry points — single-shot CLI & Ink REPL
├── query.ts               # the agent loop (streaming, tool dispatch, framework rails)
├── api/                   # provider clients & streaming
├── context/               # system prompt builder, session preamble, memory injection
│   └── systemPrompt/      #   layered, prompt-cache-aware sections
├── tools/                 # the full tool suite (Bash, File*, Web*, Task*, Vigil*, Wechat*, …)
├── services/              # compaction, transcript, eclipse, cron-daemon
├── permissions/           # mode × behavior matrix + red-lines
├── state/                 # session mode, micro-compact state
├── memory/                # persistent file-based memory
├── mcp/                   # Model Context Protocol clients & instructions
└── ui/                    # React Ink components
```

---

## Inspiration

Astraea stands on the shoulders of the agents that defined the category:

- [**Claude Code**](https://github.com/anthropics/claude-code) — Anthropic's official terminal agent
- [**Hermes Agent**](https://github.com/nousresearch/hermes-agent) — Nous Research
- [**opencode**](https://github.com/anomalyco/opencode) — Anomaly

---

<div align="center">

*Astraea — resolving disorder, one verified fact at a time.*

</div>
