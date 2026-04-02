# RC Testing Notes

## Status

**Bug found and fixed.** Needs rebuild + re-test.

## What Happened (First Test, 2 Apr 2026)

**Tester:** OpenClaw agent (via Discord, using `exec` tool + Python)

**What worked:** OpenClaw connected to the RC socket and sent prompts. ggcoder received them and responded — the TUI showed the agent's replies.

**What didn't work:** OpenClaw only got back `{"type":"result","data":{"status":"done"}}`. No streaming events (`text_delta`, `tool_call_end`, `agent_done`, etc.) were broadcast to the socket client.

**Root cause:** The event broadcasting was never wired up. `forwardEventBus()` existed in `remote-control.ts` but was never called. The TUI mode uses the raw `agentLoop` generator, not the `AgentSession`/`EventBus` pattern used by headless modes. Events went to the TUI but not to the socket.

**Fix:** Added `onRawEvent` callback to `useAgentLoop` that fires for every `AgentEvent`. `App.tsx` broadcasts all event types to connected RC socket clients. Commit `e295230`.

## Why OpenClaw Used Python (Not ACP)

ggcoder's RC socket speaks **NDJSON over Unix socket**. OpenClaw's standard ACP dispatch expects **JSON-RPC 2.0 over stdio**. These are different protocols. There's no `ggcoder acp` subcommand yet — that's future work.

So OpenClaw has to connect via its `exec` tool, running a Python/socat script that talks to the Unix socket directly. This is the correct approach for now.

## How to Re-test

### Step 1: Rebuild ggcoder

```bash
cd /home/light/gg-framework-rc && pnpm build
cd packages/ggcoder && npm install -g .
```

### Step 2: Start ggcoder with RC enabled

Either start fresh or type `/rc` in an existing session:

```bash
ggcoder --rc
```

Note the socket path shown in the banner (e.g. `/home/light/.gg/rc-XXXXX.sock`).

### Step 3: Run the test script

OpenClaw can use its `exec` tool to run this Python script. It connects to the socket, sends a prompt, accumulates the full response from `text_delta` events, and reports back when `agent_done` arrives.

```python
import socket, json, os, glob, select, time, sys

# Find the RC socket
gg_dir = os.path.expanduser("~/.gg")
socks = sorted(glob.glob(os.path.join(gg_dir, "rc-*.sock")), key=os.path.getmtime, reverse=True)
if not socks:
    print("ERROR: No RC socket found. Is ggcoder running with --rc?")
    sys.exit(1)
sock_path = socks[0]
print(f"Connecting to {sock_path}")

# Connect
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(sock_path)
client.setblocking(False)
time.sleep(0.3)

# Send prompt
cmd = {"id": "openclaw-test-1", "command": "prompt", "text": "Say exactly: RC_EVENT_STREAM_WORKING and nothing else."}
client.sendall((json.dumps(cmd) + "\n").encode())
print(f"Sent prompt: {cmd['text']}")

# Read events — accumulate text, report key events
buffer = ""
full_text = ""
events_seen = []
start = time.time()

while time.time() - start < 30:
    ready, _, _ = select.select([client], [], [], 1.0)
    if ready:
        try:
            data = client.recv(8192).decode()
            if not data:
                print("CONNECTION CLOSED")
                break
            buffer += data
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if not line.strip():
                    continue
                event = json.loads(line)
                etype = event.get("type", "?")
                events_seen.append(etype)

                if etype == "text_delta":
                    full_text += event.get("text", "")
                elif etype == "tool_call_start":
                    print(f"  [tool] {event.get('name')} started")
                elif etype == "tool_call_end":
                    print(f"  [tool] done ({event.get('durationMs')}ms, error={event.get('isError')})")
                elif etype == "turn_end":
                    print(f"  [turn] #{event.get('turn')} reason={event.get('stopReason')} tokens={event.get('usage',{})}")
                elif etype == "agent_done":
                    print(f"\n=== AGENT DONE ===")
                    print(f"Response text: {full_text}")
                    print(f"Total turns: {event.get('totalTurns')}")
                    print(f"Total usage: {event.get('totalUsage')}")
                    print(f"Events received: {', '.join(set(events_seen))}")
                    print(f"Event count: {len(events_seen)}")

                    # Verify streaming worked
                    if "text_delta" in events_seen:
                        print("\n✅ SUCCESS: text_delta events received (streaming works!)")
                    else:
                        print("\n❌ FAIL: no text_delta events (streaming still broken)")

                    client.close()
                    sys.exit(0)
                elif etype == "result":
                    print(f"  [result] {event.get('data')}")
                elif etype == "error":
                    print(f"  [error] {event.get('message')}")
        except BlockingIOError:
            pass

print(f"\nTIMEOUT after 30s")
print(f"Events received: {', '.join(set(events_seen)) if events_seen else 'NONE'}")
print(f"Full text so far: {full_text or '(empty)'}")
if not events_seen:
    print("❌ FAIL: no events at all — bug may not be fixed, or ggcoder needs rebuild")
client.close()
```

### What to expect

**If the fix works** (after rebuild):
```
Connecting to /home/light/.gg/rc-XXXXX.sock
Sent prompt: Say exactly: RC_EVENT_STREAM_WORKING and nothing else.
  [turn] #1 reason=end_turn tokens={...}

=== AGENT DONE ===
Response text: RC_EVENT_STREAM_WORKING
Total turns: 1
Total usage: {...}
Events received: text_delta, turn_end, agent_done, result
Event count: ~5-10

✅ SUCCESS: text_delta events received (streaming works!)
```

**If NOT rebuilt yet** (old binary):
```
  [result] {'status': 'done'}
TIMEOUT after 30s
Events received: result
❌ FAIL: no events at all — bug may not be fixed, or ggcoder needs rebuild
```

## For OpenClaw: Recommended Usage Pattern

Since ggcoder can stream a LOT of events during coding (hundreds of text_delta tokens, many tool calls), don't feed every event into the agent context. Instead:

1. **Connect** to `~/.gg/rc-*.sock` (most recent by mtime)
2. **Send** `{"id":"...","command":"prompt","text":"..."}` + newline
3. **Buffer** all `text_delta` texts into one string
4. **Note** tool calls if you want a summary (name, duration, error status)
5. **Wait for `agent_done`** — that's the "all done" signal
6. **Report** the final assembled text + turn/token summary

Don't stream raw events back into the agent conversation — just summarize the result.

## Architecture Note (Why No ACP Yet)

```
Current:   OpenClaw --exec--> python script --unix-socket--> ggcoder RC
Future:    OpenClaw --ACP/stdio--> ggcoder acp --internal--> ggcoder RC
Ideal:     acpx ggcoder "fix the tests"  (ggcoder as first-class ACP agent)
```

The `ggcoder acp` subcommand (JSON-RPC 2.0 over stdio) would let OpenClaw use its native ACP dispatch instead of exec+python. That's the next feature after RC is proven stable.
