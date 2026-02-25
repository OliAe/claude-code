# Agent Interaction Architecture Review

## Overview

Claude Code implements a hierarchical multi-agent orchestration system. Agents are
Markdown files with YAML frontmatter, discovered at plugin load time, and invoked
via the `Task` tool. There are **15 agents** across **6 plugins** and **4 major
orchestration commands** that coordinate them.

---

## 1. Agent Inventory

| Plugin | Agent | Model | Role |
|---|---|---|---|
| `feature-dev` | `code-explorer` | sonnet | Trace execution paths, map architecture |
| `feature-dev` | `code-architect` | sonnet | Design implementation blueprints |
| `feature-dev` | `code-reviewer` | opus | Review code with confidence scoring |
| `pr-review-toolkit` | `code-reviewer` | opus | CLAUDE.md compliance + bug detection |
| `pr-review-toolkit` | `comment-analyzer` | — | Comment accuracy & rot |
| `pr-review-toolkit` | `pr-test-analyzer` | — | Test coverage quality |
| `pr-review-toolkit` | `silent-failure-hunter` | inherit | Error handling audit |
| `pr-review-toolkit` | `type-design-analyzer` | — | Type design & invariants |
| `pr-review-toolkit` | `code-simplifier` | — | Simplify for clarity |
| `hookify` | `conversation-analyzer` | inherit | Find frustration signals in transcripts |
| `plugin-dev` | `agent-creator` | sonnet | Meta-agent: generates new agents |
| `plugin-dev` | `plugin-validator` | inherit | Validate plugin structure |
| `plugin-dev` | `skill-reviewer` | — | Review skill quality |
| `agent-sdk-dev` | `agent-sdk-verifier-ts` | — | Verify TS SDK apps |
| `agent-sdk-dev` | `agent-sdk-verifier-py` | — | Verify Python SDK apps |

---

## 2. Orchestration Patterns

### Pattern A: Multi-Phase Pipeline (`/code-review`)

7 steps, multiple model tiers, and a validation layer to filter false positives:

```
Step 1: Haiku gate-check (closed? draft? trivial? already reviewed?)
Step 2: Haiku context gather (find relevant CLAUDE.md files)
Step 3: Sonnet summarizer (PR summary for context)
Step 4: 4 parallel reviewers:
   ├─ Sonnet × 2: CLAUDE.md compliance
   ├─ Opus: Bug detection (diff-only)
   └─ Opus: Security/logic issues
Step 5: Parallel validators (1 per issue from steps 3-4)
   └─ Opus for bugs, Sonnet for CLAUDE.md issues
Step 6: Filter — keep only validated high-confidence issues
Step 7: Output + optional GitHub inline comments
```

### Pattern B: Explore-Design-Implement-Review (`/feature-dev`)

```
Phase 1: Discovery (clarify requirements with user)
Phase 2: 2-3 code-explorer agents in parallel → key files list
Phase 3: Clarifying questions to user (CRITICAL — not skipped)
Phase 4: 2-3 code-architect agents in parallel → competing designs
Phase 5: Implementation (only after explicit user approval)
Phase 6: 3 code-reviewer agents in parallel
Phase 7: Summary
```

### Pattern C: Aspect-Based Fan-Out (`/review-pr`)

Selectively launches specialized agents based on what changed:

```
1. Detect changed files
2. Determine applicable agents based on file types
3. Launch agents (sequential or parallel)
4. Aggregate: Critical → Important → Suggestions → Strengths
```

---

## 3. Inter-Agent Communication

Agents interact through four channels:

1. **Prompt injection** — Parent passes context in the Task tool's `prompt` parameter
2. **Shared filesystem** — All agents share the working directory, git state, CLAUDE.md
3. **Result aggregation** — Subagent final message flows back as tool result
4. **Tool restriction** — `tools` frontmatter field controls capabilities

**No direct agent-to-agent communication.** All coordination is parent-driven.

---

## 4. Runtime Architecture

### There Is No Separate Runtime Engine

The source ships as a single bundled/minified `cli.js`. The architecture is:

- **Commands** (.md files) are loaded, variable-substituted, and injected as
  system instructions into Claude API calls
- **Agents** (.md files) define triggering conditions (description) and system
  prompts (body); Claude decides when to invoke them via the Task tool
- **The Task tool** spawns subagents as new conversation loops
- **Claude itself is the runtime** — it processes instructions and orchestrates

### Key Functions in cli.js (minified names)

| Function | Role |
|----------|------|
| `bj()` | Frontmatter parser (regex-based YAML extraction) |
| `dd7()` / `cd7()` | Plugin agent directory scanner / per-file agent loader |
| `Lu9()` | User/project agent loader with full validation |
| `$P1.call()` | Task tool entry point — agent lookup, spawn, result packaging |
| `Rj6()` | Model resolver (inherit → parent model, or sonnet/opus/haiku) |
| `FyY()` → `qU1()` | System prompt builder (markdown body + CLAUDE.md injection) |
| `rs()` | Tool allowlist resolver (intersect agent tools with available tools) |
| `GG6()` | Permission-based tool filtering |
| `Wy()` | Core subagent conversation runner (async generator) |
| `iR()` | Main API conversation loop (shared by parent and child) |
| `uRA()` | Result packager (content, token count, duration, tool uses) |
| `BRA()` | Agent permission filter (deny rules for Task(agent_type)) |
| `KU1()` | Fork context cleaner (removes orphaned tool_use without results) |
| `it7()` | Fork context separator message injector |

### Execution Flow

```
User message → Claude decides to call Task tool
  │
  ├─ $P1.call()                          Task tool entry point
  │   ├─ activeAgents.find()             Agent lookup by subagent_type
  │   ├─ BRA()                           Filter denied agents
  │   ├─ Rj6()                           Model resolution
  │   ├─ T.getSystemPrompt()             Raw markdown body
  │   ├─ qU1()                           Inject CLAUDE.md / memory
  │   ├─ rs()                            Tool allowlist resolution
  │   ├─ GG6()                           Permission-based tool filtering
  │   ├─ forkContext check               Context sharing decision
  │   │
  │   └─ Wy()                            Subagent runner
  │       ├─ rLA()                        SubagentStart hooks
  │       ├─ ByY()                        MCP server setup
  │       ├─ YU1()                        Child toolUseContext
  │       └─ iR()                         Conversation loop
  │           ├─ Claude API call
  │           ├─ Tool execution
  │           └─ Repeat until stop
  │
  └─ uRA()                               Package result → parent
```

### Context Sharing

Two modes controlled by `forkContext` in agent frontmatter:

- **`forkContext: true`** → Parent's full message history prepended to child.
  `it7()` injects separator: `"### FORKING CONVERSATION CONTEXT ###"`
- **Default (false)** → Child gets ONLY the prompt text. No parent history.

### Permission Mode

Subagents default to `acceptEdits` permission mode (auto-approve edits) unless
the agent definition specifies a different `permissionMode` in frontmatter.

---

## 5. Observations & Potential Issues

### Strengths

- **Tiered model selection** — Haiku for gates, Sonnet for moderate tasks, Opus
  for nuanced judgment. Cost-effective.
- **Validation layer** (`/code-review` step 5) — Independent second opinion per
  issue before reporting. Reduces false positives via ensemble voting.
- **Human-in-the-loop checkpoints** (`/feature-dev`) — Mandatory clarifying
  questions prevent autonomous runaway.
- **Tool restrictions** enforce least privilege well.

### Areas Worth Examining

1. **Duplicate agent names** — Both `feature-dev` and `pr-review-toolkit` define
   `code-reviewer` with different configs. Could cause shadowing.

2. **Context loss between phases** — In `/feature-dev`, architect agents must be
   explicitly told key files from explorer phase. If orchestrator context compacts,
   earlier results may be lost.

3. **No retry/error handling in orchestration** — Commands are linear scripts.
   Agent timeout or failure has no fallback.

4. **Validation cost scaling** — `/code-review` step 5 spawns one validator per
   issue. No cap or batching — noisy PRs trigger many Opus calls.

5. **`model: inherit` inconsistency** — `silent-failure-hunter` with inherit may
   run on Haiku if user's session is Haiku. May not be capable enough.

6. **Hookify prompt duplication** — `/hookify` command hardcodes the
   conversation-analyzer prompt inline rather than referencing the agent
   definition. The two copies will drift.

7. **No cross-agent deduplication** — Parallel reviewers in `/code-review` may
   flag the same issue independently, producing duplicate PR comments.

### Architecture Diagram

```
                        ┌─────────────────────┐
                        │   User / CLI Input   │
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │  Orchestrator Agent  │
                        │  (Command .md file)  │
                        └──────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
     ┌────────▼────────┐ ┌────────▼────────┐  ┌────────▼────────┐
     │  Gate / Context  │ │  Primary Work   │  │   Validation    │
     │  (Haiku agents)  │ │ (Sonnet / Opus) │  │ (per-issue Opus)│
     └────────┬────────┘ └────────┬────────┘  └────────┬────────┘
              │                    │                     │
              └────────────────────┼────────────────────┘
                                   │
                        ┌──────────▼──────────┐
                        │  Result Aggregation  │
                        │  Filter & Present    │
                        └─────────────────────┘
```

Data flows unidirectionally: parent → child (via prompt), child → parent (via
result). No lateral agent-to-agent communication.
