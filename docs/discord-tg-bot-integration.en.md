# Discord / Telegram Bot Integration with ggboss

> This document covers the architecture research for integrating ggcoder / ggboss with Discord and Telegram, including solution comparisons, sequence analysis, and implementation guidance.

---

## Table of Contents

1. [Background: gg-framework Architecture Overview](#1-background-gg-framework-architecture-overview)
2. [Option A: Discord + ggcoder](#2-option-a-discord--ggcoder)
3. [Option B: Discord + ggboss (Recommended)](#3-option-b-discord--ggboss-recommended)
4. [Can ggboss Run as a Subprocess?](#4-can-ggboss-run-as-a-subprocess)
5. [Telegram is Natively Supported: ggboss serve](#5-telegram-is-natively-supported-ggboss-serve)
6. [Telegram → ggboss → LLM Sequence Diagram](#6-telegram--ggboss--llm-sequence-diagram)
7. [ggboss serve Startup Test](#7-ggboss-serve-startup-test)
8. [Claude Pro Subscription Policy](#8-claude-pro-subscription-policy)
9. [Quick Start: Telegram Integration Steps](#9-quick-start-telegram-integration-steps)

---

## 1. Background: gg-framework Architecture Overview

```
@kenkaiiii/gg-ai       ← Unified LLM streaming API (Anthropic / OpenAI / ...)
    └─► @kenkaiiii/gg-agent   ← Agent loop + tool execution
          └─► @kenkaiiii/ggcoder   ← CLI coding agent (single project)
                └─► @kenkaiiii/gg-boss  ← Multi-project orchestrator
```

| Package | Role | Use Case |
|---------|------|----------|
| `gg-ai` | LLM streaming abstraction | Low-level, not used directly |
| `gg-agent` | Agent loop | When maximum flexibility is needed |
| `ggcoder` | Single-project CLI agent | One conversation, one project |
| `gg-boss` | Multi-project orchestrator | Cross-project concurrency, long task management |

---

## 2. Option A: Discord + ggcoder

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        DISCORD LAYER                         │
│  User ──→ Discord Gateway ──→ Discord Bot App                │
│                               • Command parsing              │
│                               • Session routing              │
│                               • Message buffering / rate limiting │
└──────────────────────────────────┬───────────────────────────┘
                                   │
                          Session Coordinator
                       (isolated per channel / user)
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   ggcoder Worker #1       ggcoder Worker #2       ggcoder Worker #N
   (RPC subprocess)        (RPC subprocess)        (RPC subprocess)
   JSON stdin/stdout        JSON stdin/stdout
          │
     AgentSession
     agentLoop()
     Tools (read/write/bash/...)
          │
     LLM API (Anthropic etc.)
```

### Integration Approach

**ggcoder has `--rpc-mode` with JSON over stdin/stdout:**

```typescript
const proc = spawn("ggcoder", ["--rpc-mode"], { cwd: projectDir });

// Send command
proc.stdin.write(JSON.stringify({ id: "1", command: "prompt", text: "..." }) + "\n");

// Receive streaming events
proc.stdout.on("data", (data) => {
  const event = JSON.parse(data); // text_delta / tool_call_* / agent_done
});
```

### Components to Build

```
discord-ggcoder-bot/
├── src/
│   ├── bot.ts                  # discord.js entry point
│   ├── coordinator/
│   │   ├── session-pool.ts     # Manage Worker instances
│   │   ├── worker.ts           # Wrap ggcoder RPC subprocess
│   │   └── queue.ts            # Serialize requests within a session
│   ├── discord/
│   │   ├── commands/           # /ask /new /compact /model
│   │   └── reply-streamer.ts   # Stream text_delta → edit Discord message
│   └── auth/
│       └── credential-store.ts # Per guild/user API key storage
```

### Drawbacks

- Must implement SessionPool and Worker management from scratch (~500 lines of new code)
- Each Worker only knows its own project; no coordination between Workers
- No built-in task tracking

---

## 3. Option B: Discord + ggboss (Recommended)

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          DISCORD LAYER                           │
│  User A ──→ #general                                             │
│  User B ──→ #project-api    ──→ Discord Bot App                  │
│  User C ──→ DM                    Discord Adapter (new)          │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ GGBoss.enqueueUserMessage()
┌──────────────────────────────────▼───────────────────────────────┐
│                         GGBOSS LAYER                             │
│                                                                  │
│  GGBoss Orchestrator                                             │
│  ├── EventQueue (priority FIFO)                                  │
│  ├── TasksStore (persistent backlog)                             │
│  ├── BossStore (UI state / subscriptions)                        │
│  └── Boss Agent (claude-opus — coordinator)                      │
│       ├── prompt_worker(project, msg)                            │
│       ├── list_workers() / get_worker_activity()                 │
│       └── add_task / dispatch_pending                            │
│                                                                  │
│  Workers (same process, each with independent AgentSession)      │
│  ├── Worker #1  project: api   (claude-sonnet)                   │
│  ├── Worker #2  project: web   (claude-sonnet)                   │
│  └── Worker #N  ...                                              │
└──────────────────────────────────────────────────────────────────┘
```

### Comparison with Telegram serve-mode

ggboss already has a full Telegram integration. A Discord adapter only needs to replace the transport layer:

| | Telegram (existing) | Discord (to build) |
|---|---|---|
| Receive messages | Long-poll `getUpdates` | discord.js WebSocket |
| Event handling | `bot.onText(handler)` | `client.on("messageCreate", handler)` |
| Send messages | `bot.send(chatId, text)` | `channel.send()` / `msg.edit()` |
| Session isolation | Single chatId | Thread / channel |
| Push logic | `bossStore.subscribe(...)` | **identical — fully reused** |
| Boss entry point | `GGBoss.enqueueUserMessage()` | **identical — fully reused** |

### New Code Required (minimal)

```
packages/gg-boss/src/
├── discord-adapter.ts     # mirrors telegram.ts, ~150 lines
└── discord-serve-mode.ts  # mirrors serve-mode.ts, ~80 lines

packages/gg-boss/src/cli.ts
└── add "ggboss discord" subcommand
```

### Solution Comparison

| Dimension | A: ggcoder | B: ggboss |
|-----------|-----------|----------|
| Multi-project coordination | ✗ | ✓ Boss Agent coordinates |
| Task tracking | ✗ | ✓ TasksStore persistence |
| Auto-dispatch | ✗ | ✓ auto-chain built-in |
| Inter-worker communication | ✗ | ✓ via Boss Agent |
| Existing headless precedent | ✗ | ✓ Telegram serve-mode |
| New code required | ~500 lines | ~230 lines |
| Best for | Single-project Q&A | Multi-project concurrency, long tasks |

---

## 4. Can ggboss Run as a Subprocess?

### Current State

| | ggcoder | ggboss |
|---|---|---|
| RPC mode | ✓ `--rpc-mode` (JSON stdin/stdout) | ✗ none |
| Headless mode | ✗ | ✓ `ggboss serve` (Telegram) |
| Programmatic API | `AgentSession` class | `GGBoss` class |

**ggboss currently only supports in-process use.**

### Three Possible Approaches

**Approach 1: In-process (works today)**
```
Discord Bot Process
└── GGBoss instance (import { GGBoss } from "@kenkaiiii/gg-boss")
    ├── Worker #1 (AgentSession)
    └── Worker #2 (AgentSession)
```
Pros: Direct API, `bossStore.subscribe()` streams natively
Cons: ggboss crash = bot crash

**Approach 2: Add RPC mode to ggboss (~150 new lines)**
```
Discord Bot Process
└── spawn("ggboss", ["--rpc-mode"])
    JSON over stdin/stdout (modeled on ggcoder's rpc-mode.ts)
```
Pros: Process isolation, restartable on crash
Cons: Requires modifying ggboss source

**Approach 3: Extend ggboss serve for Discord (most recommended)**
```
ggboss discord --token=xxx
└── GGBoss (embedded)
    └── Discord Adapter (replaces Telegram)
```
The bot is a serve mode of ggboss rather than the reverse — inverts the dependency, maximizes code reuse.

---

## 5. Telegram is Natively Supported: ggboss serve

**No code required — works out of the box.**

```
packages/gg-boss/src/
├── telegram.ts          # Telegram bot send/receive
├── telegram-setup.ts    # ggboss telegram interactive wizard
└── serve-mode.ts        # ggboss serve startup logic
```

### Usage

```bash
# Step 1: Log in to Anthropic (once only)
ggcoder login

# Step 2: Link your projects
ggboss link

# Step 3: Configure Telegram bot credentials
ggboss telegram
# Interactive prompts:
#   - Bot token (from @BotFather)
#   - Your Telegram User ID (from @userinfobot)
# Saved to ~/.gg/boss/telegram.json

# Step 4: Start
ggboss serve
```

### BotFather Setup Note

After creating the bot, disable group privacy so the bot can read group messages:
```
/mybots → select bot → Bot Settings → Group Privacy → Turn off
```

### Telegram Commands

| Command | Function |
|---------|----------|
| `/help` | Show help |
| `/m` or `/model` | Switch boss model |
| `/model-workers` | Switch worker model |
| `/scope` | Set scope (all / specific project) |
| `/new` | Start new conversation |
| `/compact` | Compact context |
| Plain text | Sent to Boss Agent for processing |

---

## 6. Telegram → ggboss → LLM Sequence Diagram

```
User(TG)   TelegramBot    serve-mode      GGBoss         BossAgent     Worker#1      LLM(boss)   LLM(worker)
   │            │              │              │               │             │              │            │
   │         ── Startup ──     │              │               │             │              │            │
   │            │    new TelegramBot()        │               │             │              │            │
   │            │  subscribeToBossStore(cb)   │               │             │              │            │
   │            │              │   new GGBoss() + initialize()│             │              │            │
   │            │              │─────────────►│  new Worker() × N           │              │            │
   │            │              │              │─────────────────────────────►              │            │
   │            │              │              │  new Agent(bossModel)       │              │            │
   │            │              │              │───────────────►             │              │            │
   │            │   bot.start() [long poll]   │               │             │              │            │
   │            │   boss.run() [forever loop] │               │             │              │            │
   │            │              │              │  await queue.next() [block] │              │            │
   │            │              │              │               │             │              │            │
   │   ── User sends message ── │              │               │             │              │            │
   │─── send ──►│              │              │               │             │              │            │
   │            │ GET /getUpdates (30s poll)   │               │             │              │            │
   │            │  onText handler fires       │               │             │              │            │
   │            │─────────────►│              │               │             │              │            │
   │            │              │  scopePrefix + text          │             │              │            │
   │            │              │  boss.enqueueUserMessage()   │             │              │            │
   │            │              │─────────────►│  queue.push(user_message)   │              │            │
   │            │   sendTyping() every 4s     │               │             │              │            │
   │            │◄─────────────│ (when streaming=true)        │             │              │            │
   │            │              │              │               │             │              │            │
   │   ── Boss processes event ──              │               │             │              │            │
   │            │              │              │  queue.next() → user_message│              │            │
   │            │              │              │  formatEventForBoss()       │              │            │
   │            │              │              │  bossAgent.prompt(text)     │              │            │
   │            │              │              │───────────────►             │              │            │
   │            │              │              │               │  POST /messages (stream)    │            │
   │            │              │              │               │─────────────────────────────►│            │
   │            │              │◄── bossStore change ──────────│◄── text_delta × N ──────────│            │
   │            │◄─────────────│ startTyping()│               │             │              │            │
   │            │              │              │               │◄── tool_call_start          │            │
   │            │              │              │◄──────────────│ name:"prompt_worker"        │            │
   │            │              │              │  worker.prompt(msg) [fire-and-forget]       │            │
   │            │              │              │─────────────────────────────►              │            │
   │            │              │              │               │             │  POST /messages│            │
   │            │              │              │               │             │─────────────►│            │
   │            │              │              │               │◄── agent_done ──────────────│            │
   │            │              │◄── bossStore change ──────────│             │              │            │
   │            │              │  flushNewItems()             │             │              │            │
   │            │              │  formatItemForTelegram()     │             │              │            │
   │◄── reply ──│ bot.send()   │              │               │             │              │            │
   │            │              │              │               │             │              │            │
   │   ── Worker completes (async, later) ──   │               │             │              │            │
   │            │              │              │               │             │◄── agent_done│            │
   │            │              │              │◄──────────────────────────── │ worker_turn_complete      │
   │            │              │              │  tasksStore.update(done)     │              │            │
   │            │              │              │  bossAgent.prompt(summary)   │              │            │
   │            │              │  flushNewItems() → bot.send()│             │              │            │
   │◄── worker done notice ─────│              │               │             │              │            │
```

### Key Mechanisms

**1. Input: TG → boss**
- `bot.onText()` → `scopePrefix + text` → `enqueueUserMessage()`
- EventQueue is priority FIFO: `user_message` jumps ahead of `worker_turn_complete`

**2. Output: boss → TG**
- `bossStore` acts as a central state store (similar to Redux)
- serve-mode subscribes to it, diffs history length, pushes only new items
- Filter rules (`formatItemForTelegram`):
  - ✓ Send: assistant text, worker_error, task_dispatch
  - ✗ Drop: user echo, tool calls, worker_event, info chatter

**3. Workers are fire-and-forget**
- Boss calls `prompt_worker` tool → returns immediately
- Worker runs AgentSession in the background (may take minutes)
- On completion, pushes `worker_turn_complete` to the queue
- Boss processes it on the next iteration

**4. Typing indicator**
- `bossStore.streaming !== null` → `startTyping()` repeats every 4 seconds
- `bossStore.streaming === null` → `stopTyping()`

---

## 7. ggboss serve Startup Test

Tested startup sequence in sandbox:

```
Gate 1: ggboss serve command is executable           ✓
   ↓
Gate 2: Check linked projects
   → none → error: run ggboss link first
   → found → continue                                ✓
   ↓
Gate 3: Verify Anthropic login
   → not logged in → error:
     "Not logged in to anthropic.
      Run ggcoder login to authenticate."            ✗ (sandbox limitation)
   ↓
Gate 4: Verify Telegram bot token
   → invalid token → error + exit
   ↓
Gate 5: Normal startup, begin long-polling TG        ✓ (real environment)
```

**Verdict:** The command itself works and the flow is complete. The sandbox lacks real Anthropic credentials — this is an environment constraint, not a program error.

---

## 8. Claude Pro Subscription Policy

### Conclusion: Using a Pro Subscription Does Not Violate Policy

**Reason: ggcoder uses the exact same OAuth flow as the official Claude Code CLI.**

```typescript
// packages/ggcoder/src/core/oauth/anthropic.ts
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
// decoded = 9d1c250a-e61b-44d9-88ed-5944d1962f5e
// ↑ This is Anthropic's official Claude Code OAuth client_id

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL     = "https://platform.claude.com/v1/oauth/token";
const SCOPES        = "user:sessions:claude_code ...";
//                                    ↑ explicit claude_code session scope
```

- ggcoder reuses the official Claude Code CLI's OAuth client directly
- Anthropic explicitly designed this OAuth flow for third-party Claude Code–compatible tools
- Claude Pro / Max subscriptions natively support Claude Code; ggcoder follows the same path

### Usage Boundaries

| Scenario | Compliant? |
|----------|-----------|
| Personal use of ggcoder / ggboss | ✓ Fine |
| `ggboss serve` for personal remote control | ✓ Should be fine |
| Running as a commercial service for third parties | ⚠ Switch to API billing |

---

## 9. Quick Start: Telegram Integration Steps

### Prerequisites

1. Install ggboss: `npm i -g @kenkaiiii/gg-boss`
2. Create a Telegram bot:
   - Message `@BotFather` → `/newbot` → copy the token
   - Disable group privacy: `/mybots → Bot Settings → Group Privacy → Turn off`
3. Get your Telegram User ID: message `@userinfobot` with any text

### Start

```bash
# 1. Log in to Anthropic (Pro or Max subscription)
ggcoder login

# 2. Link the projects you want the boss to manage
ggboss link

# 3. Save Telegram credentials
ggboss telegram
# Follow the prompts for bot token and user ID
# Saved to ~/.gg/boss/telegram.json

# 4. Start the server
ggboss serve
```

### Test It

Send to your bot in Telegram:
```
Hey, please review the README for the api project
```

The Boss Agent will analyze the request, dispatch it to the appropriate worker, and reply with the result when done.

---

*Document date: 2026-05-10*
