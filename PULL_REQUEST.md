# PR: Remote Control via Unix Socket

## Summary

This adds a **remote control** feature to ggcoder — a Unix domain socket server that lets external agents, scripts, and orchestrators control a running ggcoder instance programmatically.

The human keeps using the TUI as normal. An external process connects to the socket and sends prompts, receives real-time events, and shares the same session. Both can work side-by-side.

## Why

Right now ggcoder is interactive-only. You type, it responds. But the ecosystem is moving toward **agent-to-agent communication** — orchestrators that delegate coding tasks, CI pipelines that send prompts and parse results, multi-agent workflows where one agent controls another.

This PR makes ggcoder controllable from the outside without losing the interactive TUI experience. It's the foundation for:

- **[Pocket Agent](https://github.com/KenKaiii/pocket-agent) integration** — Pocket Agent could delegate coding tasks to a running ggcoder instance over the socket. User asks Pocket Agent from Telegram or the menu bar to "fix the failing tests in my project" → Pocket Agent connects to the RC socket, sends the prompt, streams back the results. The coding brain stays in ggcoder, the conversational brain stays in Pocket Agent.
- **[OpenClaw](https://github.com/openclaw/openclaw) / [acpx](https://github.com/openclaw/acpx) integration** — acpx is a headless CLI client for the Agent Client Protocol (ACP). It already supports Codex, Claude, Pi, Gemini, Cursor, and others. With a thin `ggcoder acp` wrapper on top of this socket, ggcoder becomes another first-class agent in the acpx ecosystem. OpenClaw is the multi-channel gateway (WhatsApp, Telegram, Discord) — same idea as Pocket Agent but open-source and protocol-native.
- **CI/CD agents** that send prompts and wait for `agent_done`
- **Multi-agent orchestration** where a supervisor controls multiple ggcoder instances
- **Custom dashboards** that monitor what the agent is doing in real time

## How It Works

**Protocol:** NDJSON (newline-delimited JSON) over a Unix domain socket at `~/.gg/rc-<PID>.sock`.

**Commands** (client → server):

| Command | Description |
|---|---|
| `prompt` | Send a prompt (like typing in the TUI) |
| `abort` | Cancel the current agent turn |
| `get_state` | Query agent state |

**Events** (server → client): 15 event types broadcast to all connected clients — `text_delta`, `thinking_delta`, `tool_call_start/update/end`, `turn_end`, `agent_done`, `error`, session lifecycle events, and more.

**Activation:**
```bash
ggcoder --rc              # on launch
/rc                       # mid-session
```

**Quick test:**
```bash
# Terminal 1
ggcoder --rc

# Terminal 2
echo '{"id":"1","command":"prompt","text":"Hello!"}' \
  | socat - UNIX-CONNECT:$HOME/.gg/rc-$(pgrep -f ggcoder).sock
```

## What's Included

### New Files

| File | Description |
|---|---|
| `src/core/remote-control.ts` | `RemoteControlServer` class — Unix socket server, NDJSON parsing, event broadcasting, cleanup handlers |
| `src/core/event-bus.ts` | Typed `EventBus` with 15+ event types, used to bridge agent events to the socket |
| `src/ui/components/RemoteControlBanner.tsx` | TUI banner showing socket path and connected client count |
| `REMOTE-CONTROL.md` | Comprehensive docs — protocol spec, all commands/events with examples, Node.js/Python/socat client examples, troubleshooting, security notes, ACP roadmap |
| `.gg/skills/remote-control.md` | Agent skill file so AI agents know how to use the RC socket programmatically |

### Modified Files

| File | Change |
|---|---|
| `cli.ts` | `--rc` / `--remote-control` flag, server lifecycle management |
| `App.tsx` | `/rc` slash command, event bus forwarding to socket, prompt queue for incoming RC prompts |
| `render.ts` | Pass RC server instance through to App |
| `agent-session.ts` | Event bus integration |
| `README.md` | Added Remote Control section with usage example and link to detailed docs |

## Design Decisions

- **Unix socket, not TCP/HTTP** — local-only by default, no auth needed, no port conflicts, automatically scoped to the user via filesystem permissions (0600).
- **NDJSON, not JSON-RPC** — simpler protocol that's easy to work with from any language. One JSON object per line. A future ACP bridge can translate to JSON-RPC 2.0 over stdio.
- **EventBus as the bridge** — agent events flow through a typed EventBus that both the TUI and the socket server subscribe to. Clean separation, no tight coupling.
- **Prompt queue** — prompts from the socket are queued and processed in order, interleaved with human input. No race conditions.
- **Cleanup handlers** — socket file is removed on exit, SIGTERM, and SIGINT. Stale sockets are cleaned up automatically on startup.

## Integration Roadmap

### Pocket Agent

This is probably the most natural integration. Pocket Agent already has Telegram, menu bar, routines, and 40+ skill integrations. The missing piece is a **dedicated coding backend**. Right now if you ask Pocket Agent to write code, it does it inline. With RC, Pocket Agent could spin up (or connect to) a running ggcoder instance and delegate:

1. User messages Pocket Agent from Telegram: "Fix the auth bug in my backend"
2. Pocket Agent connects to `~/.gg/rc-<PID>.sock`
3. Sends `{"command":"prompt","text":"Fix the auth bug..."}` 
4. Streams `text_delta` events back to the Telegram chat
5. Waits for `agent_done`, reports the result

ggcoder handles the coding (file reads, edits, bash, grep — all its tools). Pocket Agent handles the conversation, memory, and channel routing. Clean separation.

### ACP / acpx

This PR is the **transport layer**. The next step would be a `ggcoder acp` subcommand that wraps this socket in JSON-RPC 2.0 over stdio, making ggcoder a drop-in agent for acpx:

```bash
acpx --agent "ggcoder acp" "fix the failing tests"
```

Or registered in `~/.acpx/config.json`:
```json
{ "agents": { "ggcoder": { "command": "ggcoder acp" } } }
```

Then: `acpx ggcoder "fix the failing tests"`

### OpenClaw

OpenClaw is the open-source multi-channel gateway — WhatsApp, Telegram, Discord, iMessage through one process. Same idea as Pocket Agent's Telegram integration but protocol-native and multi-channel. With an ACP bridge, ggcoder slots in as a coding agent behind the OpenClaw gateway.

## Testing

- Tested manually with `socat` and Node.js clients
- Tested `/rc` mid-session activation
- Tested `--rc` flag on launch
- Tested multiple simultaneous socket clients
- Tested prompt queueing (send while agent is busy)
- Tested cleanup on process exit (socket file removed)
- Tested stale socket recovery (old socket file from crashed process)

## No Breaking Changes

- Remote control is **opt-in** — nothing changes unless you pass `--rc` or type `/rc`
- No new dependencies
- No changes to existing behavior, tools, or session format
