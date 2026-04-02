# Remote Control

Control ggcoder programmatically from external agents, scripts, or other processes. A Unix domain socket server speaks [NDJSON](https://github.com/ndjson/ndjson-spec) — you send commands, you receive a real-time stream of everything the agent does.

---

## Quick Start

### 1. Install socat (optional but recommended)

```bash
# macOS
brew install socat

# Ubuntu / Debian
sudo apt install socat

# Arch
sudo pacman -S socat
```

socat is the easiest way to interact with Unix sockets from the command line. You can also use Node.js, Python, or any language that supports Unix sockets.

### 2. Activate remote control

Three ways to turn it on:

```bash
# Option A: CLI flag (on launch)
ggcoder --rc

# Option B: CLI flag (long form)
ggcoder --remote-control

# Option C: Slash command (mid-session)
/rc
```

When active, you'll see a banner in the TUI:

```
╭ 🔌 Remote control active · waiting for connection ╮
│ socket: /home/you/.gg/rc-12345.sock               │
╰────────────────────────────────────────────────────╯
```

### 3. Connect and send a prompt

```bash
echo '{"id":"1","command":"prompt","text":"Hello from outside!"}' | socat - UNIX-CONNECT:$HOME/.gg/rc-$(pgrep -f ggcoder).sock
```

---

## Architecture

```
┌──────────────┐                  ┌──────────────────────┐
│  Human (TUI) │                  │  External Agent /    │
│  keyboard    │                  │  Script / OpenClaw   │
└──────┬───────┘                  └──────────┬───────────┘
       │                                     │
       │  React state                        │  NDJSON over
       │                                     │  Unix socket
       ▼                                     ▼
┌─────────────────────────────────────────────────────────┐
│                     ggcoder process                     │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌───────────────────┐  │
│  │  App.tsx  │◄──►│ EventBus │◄──►│ RemoteControl     │  │
│  │  (Ink)   │    │          │    │ Server            │  │
│  └──────────┘    └──────────┘    │  (net.Server)     │  │
│                                  │  ~/.gg/rc-PID.sock│  │
│                                  └───────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- The **human** types in the TUI as usual.
- An **external agent** connects to the Unix socket and sends JSON commands.
- Both share the same session — the agent sees what the human does and vice versa.
- All agent events (text output, tool calls, errors) are broadcast to **all** connected socket clients.

---

## Protocol

The protocol is **NDJSON** (newline-delimited JSON). Each message is a single JSON object followed by `\n`.

- **Client → Server**: Commands (you send these)
- **Server → Client**: Events (you receive these)

### Commands (Client → Server)

Every command must include an `id` field (any string). The server uses it to correlate responses.

#### `prompt`

Send a prompt to the agent, just like typing in the TUI.

```json
{"id":"abc123","command":"prompt","text":"Read the file src/main.ts and summarize it"}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique command identifier |
| `command` | string | yes | Must be `"prompt"` |
| `text` | string | yes | The prompt text |

#### `abort`

Cancel the currently running agent turn.

```json
{"id":"abc124","command":"abort"}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique command identifier |
| `command` | string | yes | Must be `"abort"` |

#### `get_state`

Query the current state of the agent (idle, running, etc.).

```json
{"id":"abc125","command":"get_state"}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique command identifier |
| `command` | string | yes | Must be `"get_state"` |

---

### Events (Server → Client)

Events are broadcast to all connected clients. Each event has a `type` field.

#### Agent Output Events

##### `text_delta`

Streamed text output from the model.

```json
{"type":"text_delta","text":"Here is the summary of "}
```

##### `thinking_delta`

Streamed thinking/reasoning output (when extended thinking is enabled).

```json
{"type":"thinking_delta","text":"I need to read the file first..."}
```

#### Tool Events

##### `tool_call_start`

A tool call has started.

```json
{"type":"tool_call_start","toolCallId":"tc_001","name":"read","args":{"file_path":"src/main.ts"}}
```

##### `tool_call_update`

Incremental update during a tool call (e.g., streaming bash output).

```json
{"type":"tool_call_update","toolCallId":"tc_001","update":"line of output\n"}
```

##### `tool_call_end`

A tool call has completed.

```json
{"type":"tool_call_end","toolCallId":"tc_001","result":"file contents...","isError":false,"durationMs":42}
```

##### `server_tool_call`

A server-side tool (MCP) has been invoked.

```json
{"type":"server_tool_call","id":"st_001","name":"mcp__grep__searchGitHub","input":{"query":"useState("}}
```

##### `server_tool_result`

A server-side tool has returned.

```json
{"type":"server_tool_result","toolUseId":"st_001","resultType":"text","data":"...results..."}
```

#### Turn & Session Events

##### `turn_end`

One LLM turn has completed (the model stopped generating).

```json
{"type":"turn_end","turn":1,"stopReason":"tool_use","usage":{"inputTokens":1200,"outputTokens":350,"cacheRead":800}}
```

##### `agent_done`

The agent has finished processing a prompt (all turns complete, no more tool calls).

```json
{"type":"agent_done","totalTurns":3,"totalUsage":{"inputTokens":5000,"outputTokens":1200,"cacheRead":3000}}
```

This is the event to wait for before sending the next `prompt` command.

##### `session_start`

A new session has been created.

```json
{"type":"session_start","sessionId":"2025-04-02T10-30-00-000Z"}
```

##### `model_change`

The model has been switched (via `/model` or programmatically).

```json
{"type":"model_change","provider":"anthropic","model":"claude-sonnet-4-20250514"}
```

#### Context Events

##### `compaction_start`

Context compaction has started (too many messages in context).

```json
{"type":"compaction_start","messageCount":45}
```

##### `compaction_end`

Context compaction has completed.

```json
{"type":"compaction_end","originalCount":45,"newCount":12}
```

##### `branch_created`

A conversation branch was created.

```json
{"type":"branch_created","leafId":"msg_abc","messagesKept":8}
```

#### Error Events

##### `error`

An error occurred.

```json
{"type":"error","message":"Rate limit exceeded"}
```

---

## Connection Examples

### socat (interactive session)

Connect and stay connected, seeing all events in real time:

```bash
# Find the socket
SOCK=$(ls ~/.gg/rc-*.sock 2>/dev/null | head -1)

# Interactive session — type JSON commands, see events
socat - UNIX-CONNECT:$SOCK
```

Then type commands line by line:

```json
{"id":"1","command":"prompt","text":"What files are in this directory?"}
```

Events will stream back as NDJSON lines.

### socat (one-shot)

Send a single prompt and capture all output:

```bash
SOCK=$(ls ~/.gg/rc-*.sock 2>/dev/null | head -1)

# Send prompt and keep reading events
echo '{"id":"1","command":"prompt","text":"List all TODO comments in the codebase"}' \
  | socat -t 30 - UNIX-CONNECT:$SOCK
```

### Node.js client

```javascript
import net from "node:net";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Discover socket
const ggDir = join(homedir(), ".gg");
const sockFile = readdirSync(ggDir).find((f) => f.startsWith("rc-") && f.endsWith(".sock"));
if (!sockFile) throw new Error("No ggcoder RC socket found. Start ggcoder with --rc");
const sockPath = join(ggDir, sockFile);

// Connect
const client = net.createConnection(sockPath);
let buffer = "";

client.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    const event = JSON.parse(line);
    console.log("Event:", event.type, event);

    // Wait for agent_done before sending next prompt
    if (event.type === "agent_done") {
      console.log("Agent finished. Ready for next prompt.");
    }
  }
});

client.on("connect", () => {
  console.log("Connected to ggcoder");

  // Send a prompt
  client.write(
    JSON.stringify({
      id: "1",
      command: "prompt",
      text: "What is the project structure?",
    }) + "\n",
  );
});

client.on("error", (err) => {
  console.error("Connection error:", err.message);
});
```

### Python client

```python
import socket
import json
import os
import glob

# Discover socket
gg_dir = os.path.expanduser("~/.gg")
socks = glob.glob(os.path.join(gg_dir, "rc-*.sock"))
if not socks:
    raise RuntimeError("No ggcoder RC socket found. Start ggcoder with --rc")
sock_path = socks[0]

# Connect
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(sock_path)
print(f"Connected to {sock_path}")

# Send a prompt
cmd = {"id": "1", "command": "prompt", "text": "Summarize the README"}
client.sendall((json.dumps(cmd) + "\n").encode())

# Read events
buffer = ""
while True:
    data = client.recv(4096).decode()
    if not data:
        break
    buffer += data
    while "\n" in buffer:
        line, buffer = buffer.split("\n", 1)
        if not line.strip():
            continue
        event = json.loads(line)
        print(f"[{event.get('type', '?')}]", event)
        if event.get("type") == "agent_done":
            print("Agent finished.")
            # Send next prompt or disconnect
            client.close()
            exit()
```

---

## Human + Agent Coexistence

When remote control is active, both the human at the keyboard and the remote agent can interact with the same session:

- **Prompts queue up.** If the agent is busy processing a prompt, incoming prompts (from either the human or the socket) are queued and processed in order.
- **Events go everywhere.** Human-triggered actions produce events that socket clients see. Socket-triggered prompts produce output that the human sees in the TUI.
- **Multiple clients allowed.** Multiple agents/scripts can connect simultaneously. All receive all events.

---

## Socket Discovery

The socket file is created at `~/.gg/rc-<PID>.sock` where `<PID>` is the ggcoder process ID.

```bash
# List all active RC sockets
ls ~/.gg/rc-*.sock

# Find socket for a specific ggcoder process
ls ~/.gg/rc-$(pgrep -f ggcoder).sock
```

If you have multiple ggcoder instances with `--rc`, each gets its own socket.

---

## Troubleshooting

### `ENOENT: no such file or directory`

The socket file doesn't exist. Either:
- ggcoder isn't running with `--rc`
- The process exited and the socket was cleaned up
- You're using tilde (`~`) in a context that doesn't expand it — use `$HOME` instead

```bash
# ✗ This may fail (tilde not expanded in all contexts)
socat - UNIX-CONNECT:~/.gg/rc-12345.sock

# ✓ Use $HOME
socat - UNIX-CONNECT:$HOME/.gg/rc-12345.sock
```

### `socat: command not found`

Install socat (see [Prerequisites](#1-install-socat-optional-but-recommended)) or use Node.js/Python instead.

### Stale socket files

If ggcoder crashes without cleaning up, a stale `.sock` file may remain. The server removes stale sockets automatically on startup, but you can also clean them up manually:

```bash
rm ~/.gg/rc-*.sock
```

### Connection refused / broken pipe

The ggcoder process that created the socket has exited. Remove the stale socket and start a new ggcoder instance with `--rc`.

### Events arrive with line wrapping / truncation

NDJSON lines can be long (especially `tool_call_end` with large results). Make sure your client reads complete lines before parsing. Buffer incoming data and split on `\n`.

### Agent is busy — prompt ignored?

Prompts sent while the agent is processing are queued. They'll execute in order once the current turn finishes. Wait for `agent_done` before sending the next prompt for sequential workflows.

---

## Security

- The socket file is created with **mode 0600** (owner read/write only). Other users on the system cannot connect.
- The socket lives in `~/.gg/` which should also be owner-only.
- No authentication is performed on the socket — anyone who can access the file can control the agent.
- The agent has the same permissions as the ggcoder process (file access, shell commands, etc.).
- **Do not expose the socket over a network** without additional authentication and encryption.

---

## Future Roadmap

### Pocket Agent / OpenClaw

[Pocket Agent](https://github.com/KenKaiii/pocket-agent) is a personal AI assistant (menu bar + Telegram) with persistent memory, routines, and 40+ integrations. [OpenClaw](https://github.com/openclaw/openclaw) is an open-source multi-channel gateway (WhatsApp, Telegram, Discord, iMessage).

Both can use the RC socket to delegate coding tasks to ggcoder:

1. User asks from Telegram/menu bar: "Fix the auth bug in my backend"
2. Pocket Agent (or OpenClaw) connects to `~/.gg/rc-<PID>.sock`
3. Sends `{"id":"1","command":"prompt","text":"Fix the auth bug..."}`
4. Streams `text_delta` events back to the chat
5. Waits for `agent_done`, reports the result

ggcoder handles the coding (file reads, edits, bash, grep). The conversational agent handles routing, memory, and channels. Clean separation.

### ACP (Agent Communication Protocol) Bridge

ACP uses JSON-RPC 2.0 over stdio. Bridging to our NDJSON/Unix-socket protocol is straightforward:

| ACP | ggcoder RC |
|---|---|
| `session/prompt` | `{"command":"prompt","text":"..."}` |
| `session/cancel` | `{"command":"abort"}` |
| `session/notification` stream | Our event stream |

A future `ggcoder acp` subcommand could speak JSON-RPC 2.0 over stdio, making ggcoder a drop-in ACP-compatible agent.

### acpx / OpenClaw Integration

[acpx](https://github.com/openclaw/acpx) is a headless CLI client for ACP — it lets AI agents and orchestrators talk to coding agents over a structured protocol instead of PTY scraping. It already supports Pi, Codex, Claude, Gemini, Cursor, and many others via built-in agent registries.

acpx supports custom agents via the `--agent` escape hatch. Once ggcoder has an ACP bridge (`ggcoder acp`), it could be registered as:

```bash
# Using the --agent escape hatch
acpx --agent "ggcoder acp" "Fix the failing tests"

# Or configured in ~/.acpx/config.json
{
  "agents": {
    "ggcoder": {
      "command": "ggcoder acp"
    }
  }
}

# Then used like any built-in agent
acpx ggcoder "Fix the failing tests"
acpx ggcoder sessions new
acpx ggcoder -s backend "implement token pagination"
```

This would give ggcoder access to acpx features like persistent sessions, named sessions, prompt queueing, cooperative cancel, and multi-agent flows — plus integration with OpenClaw's multi-channel gateway (WhatsApp, Telegram, Discord, etc.).

### TCP / WebSocket Transport

The current Unix socket is local-only. Future transports could include:
- **TCP** with TLS for remote access
- **WebSocket** for browser-based control panels
- **HTTP/SSE** for REST-style integration
