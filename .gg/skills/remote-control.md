---
name: remote-control
description: Control a running ggcoder instance programmatically via Unix socket (NDJSON protocol)
---

# Remote Control — Agent Skill

Connect to a running ggcoder instance over a Unix domain socket. Send prompts, abort tasks, and receive real-time events. Protocol is NDJSON (one JSON object per line).

## Socket Discovery

```bash
ls ~/.gg/rc-*.sock
```

Each socket is named `rc-<PID>.sock`. If no sockets exist, ggcoder isn't running with `--rc`. Start it with `ggcoder --rc` or type `/rc` in an existing session.

## Protocol

**Transport:** Unix domain socket, bidirectional, NDJSON (each message is `JSON + \n`).

### Commands (send to server)

Every command requires an `id` field (string).

#### prompt

```json
{"id":"1","command":"prompt","text":"Read src/main.ts and explain it"}
```

#### abort

```json
{"id":"2","command":"abort"}
```

#### get_state

```json
{"id":"3","command":"get_state"}
```

### Events (received from server)

| Event | Key Fields | Description |
|---|---|---|
| `text_delta` | `text` | Streamed model output |
| `thinking_delta` | `text` | Streamed reasoning output |
| `tool_call_start` | `toolCallId`, `name`, `args` | Tool invocation started |
| `tool_call_update` | `toolCallId`, `update` | Incremental tool output |
| `tool_call_end` | `toolCallId`, `result`, `isError`, `durationMs` | Tool completed |
| `server_tool_call` | `id`, `name`, `input` | MCP tool invoked |
| `server_tool_result` | `toolUseId`, `resultType`, `data` | MCP tool returned |
| `turn_end` | `turn`, `stopReason`, `usage` | One LLM turn done |
| `agent_done` | `totalTurns`, `totalUsage` | **All turns complete — safe to send next prompt** |
| `session_start` | `sessionId` | New session created |
| `model_change` | `provider`, `model` | Model switched |
| `compaction_start` | `messageCount` | Context compaction started |
| `compaction_end` | `originalCount`, `newCount` | Compaction finished |
| `branch_created` | `leafId`, `messagesKept` | Conversation branched |
| `error` | `message` | Error occurred |

## Usage Pattern

1. Connect to the socket
2. Send a `prompt` command
3. Read events until you receive `agent_done`
4. Send the next `prompt` (or disconnect)

**Always wait for `agent_done` before sending the next prompt.** Prompts sent while the agent is busy are queued but sequential processing is not guaranteed to match your intended order if you fire multiple prompts rapidly.

## Node.js Client (ready to use)

```javascript
import net from "node:net";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function connectToGGCoder() {
  const ggDir = join(homedir(), ".gg");
  const sockFile = readdirSync(ggDir).find((f) => f.startsWith("rc-") && f.endsWith(".sock"));
  if (!sockFile) throw new Error("No ggcoder RC socket found");
  return net.createConnection(join(ggDir, sockFile));
}

function sendPrompt(client, id, text) {
  client.write(JSON.stringify({ id, command: "prompt", text }) + "\n");
}

function readEvents(client, onEvent) {
  let buffer = "";
  client.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onEvent(JSON.parse(line));
    }
  });
}

// Example: send a prompt and wait for completion
const client = connectToGGCoder();
client.on("connect", () => {
  sendPrompt(client, "1", "List all files in src/");
  readEvents(client, (event) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "agent_done") {
      console.log("\nDone.");
      client.end();
    }
  });
});
```

## Error Handling

- If the socket doesn't exist → ggcoder isn't running with `--rc`
- If you send invalid JSON → you receive `{"type":"error","message":"Invalid JSON: ..."}`
- If you send an unknown command → you receive `{"type":"error","message":"Unknown command: ..."}`
- If the connection drops → ggcoder process exited; remove stale socket and reconnect to a new instance
- Always use `$HOME` not `~` when constructing socket paths programmatically (tilde is a shell expansion, not a filesystem path)

## Building Custom Tooling

The RC socket is a general-purpose control plane. You can build:

- **CI/CD agents** that send prompts and parse `agent_done` for pass/fail
- **Orchestrators** that chain multiple prompts (wait for `agent_done` between each)
- **Monitoring dashboards** that connect read-only and display events
- **Testing harnesses** that send prompts and assert on tool calls or output
- **Multi-agent workflows** where one agent controls another ggcoder instance

## acpx Integration (Future)

[acpx](https://github.com/openclaw/acpx) is a headless CLI client for the Agent Client Protocol (ACP). It supports coding agents like Pi, Codex, Claude, Gemini, and more via built-in registries, plus custom agents via `--agent`.

Once ggcoder ships a `ggcoder acp` subcommand (JSON-RPC 2.0 over stdio), it can be used with acpx:

```bash
# Escape hatch
acpx --agent "ggcoder acp" "fix the failing tests"

# Or register in ~/.acpx/config.json
{ "agents": { "ggcoder": { "command": "ggcoder acp" } } }

# Then use like any built-in agent
acpx ggcoder "fix the failing tests"
acpx ggcoder -s backend "implement pagination"
```

This gives ggcoder persistent sessions, named sessions, prompt queueing, cooperative cancel, multi-agent flows, and OpenClaw gateway integration (WhatsApp, Telegram, Discord channels).
