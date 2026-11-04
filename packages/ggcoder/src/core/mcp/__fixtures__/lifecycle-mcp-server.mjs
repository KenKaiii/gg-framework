// Minimal stdio MCP server for idle-shutdown and progress-timeout tests.
//
// Tools:
//   pid                         → this process's pid (proves a respawn happened)
//   echo { text }               → text
//   slow { ms }                 → "done" after `ms`, with NO progress notifications
//   progress { ms, every }      → "done" after `ms`, sending notifications/progress
//                                 every `every` ms (only when the caller asked
//                                 for progress by sending a progressToken)
//   fail { text }               → a result the server marks `isError: true`

import process from "node:process";

const PROTOCOL_VERSION = "2025-11-25";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
  { name: "pid", description: "Return the server pid", inputSchema: { type: "object" } },
  {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "slow",
    description: "Reply after ms, silently",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
  {
    name: "fail",
    description: "Reply with a tool-level error",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "progress",
    description: "Reply after ms, reporting progress every `every` ms",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number" }, every: { type: "number" } },
    },
  },
];

function text(id, value) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(value) }] } });
}

function callTool(id, params) {
  const args = params?.arguments ?? {};
  switch (params?.name) {
    case "pid":
      return text(id, process.pid);
    case "echo":
      return text(id, args.text ?? "");
    case "fail":
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(args.text ?? "") }], isError: true },
      });
    case "slow":
      setTimeout(() => text(id, "done"), Number(args.ms ?? 0));
      return;
    case "progress": {
      const token = params?._meta?.progressToken;
      let n = 0;
      const tick =
        token === undefined
          ? undefined
          : setInterval(
              () => {
                n += 1;
                send({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: { progressToken: token, progress: n, message: `step ${n}` },
                });
              },
              Number(args.every ?? 100),
            );
      setTimeout(
        () => {
          if (tick) clearInterval(tick);
          text(id, "done");
        },
        Number(args.ms ?? 0),
      );
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
  }
}

function handle(message) {
  if (message.id === undefined || message.id === null) return;
  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "lifecycle-fixture", version: "1.0.0" },
        },
      });
    case "ping":
      return send({ jsonrpc: "2.0", id: message.id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    case "tools/call":
      return callTool(message.id, message.params);
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore malformed input
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
