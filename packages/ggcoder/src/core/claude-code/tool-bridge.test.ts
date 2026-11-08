import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AgentTool } from "@kenkaiiii/gg-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEditTool } from "../../tools/edit.js";
import {
  claudeCodeToolName,
  createToolBridge,
  stripClaudeCodeToolPrefix,
  type ToolBridgeOptions,
} from "./tool-bridge.js";

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function connect(
  opts: Partial<ToolBridgeOptions> & { tools: AgentTool[] },
  claudeCode: { relistOnChange?: boolean } = {},
) {
  const events: AgentEvent[] = [];
  const bridge = createToolBridge({ onEvent: (e) => events.push(e), ...opts });
  const pending = new Map<number, (msg: Rpc) => void>();
  const sent: Rpc[] = [];
  const transport = {
    onmessage: undefined as ((m: Rpc) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    async send(msg: Rpc) {
      sent.push(msg);
      pending.get(msg.id!)?.(msg);
      // Claude Code answers list_changed by reading tools/list again.
      if (claudeCode.relistOnChange && msg.method === "notifications/tools/list_changed") {
        setTimeout(() => void request("tools/list"), 5);
      }
    },
  };
  await (bridge.config.instance as unknown as { connect(t: unknown): Promise<void> }).connect(
    transport,
  );
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Rpc>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      transport.onmessage!({ jsonrpc: "2.0", id, method, params });
    });
  const call = (name: string, args: unknown, toolUseId = `toolu_${nextId + 1}`) =>
    request("tools/call", {
      name,
      arguments: args,
      _meta: { "claudecode/toolUseId": toolUseId },
    });
  return { bridge, events, request, call, transport, sent };
}

const echoParams = z.object({ text: z.string(), times: z.number().optional() });
const echo: AgentTool = {
  name: "echo",
  description: "Echo text",
  parameters: echoParams,
  execute: (args) => {
    const { text, times } = args as z.infer<typeof echoParams>;
    return text.repeat(times ?? 1);
  },
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bridge-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tool names", () => {
  it("prefixes and strips the gg server prefix", () => {
    expect(claudeCodeToolName("read")).toBe("mcp__gg__read");
    expect(stripClaudeCodeToolPrefix("mcp__gg__read")).toBe("read");
    expect(stripClaudeCodeToolPrefix("Bash")).toBe("Bash");
  });
});

describe("createToolBridge", () => {
  it("answers the MCP handshake and lists our JSON schemas, including the edit pipe schema", async () => {
    const edit = createEditTool(dir);
    const { request } = await connect({ tools: [echo, edit as AgentTool] });

    const init = await request("initialize", { protocolVersion: "2025-11-25" });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
    });
    const list = await request("tools/list");
    const tools = list.result!.tools as {
      name: string;
      inputSchema: Record<string, unknown>;
      _meta: Record<string, unknown>;
    }[];
    expect(tools.map((t) => t.name)).toEqual(["echo", "edit"]);
    expect(tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(tools[1].inputSchema).toMatchObject({
      type: "object",
      properties: { file_path: {}, edits: {}, files: {} },
    });
    expect(tools[1]._meta["anthropic/alwaysLoad"]).toBe(true);

    expect((await request("resources/list")).error?.code).toBe(-32601);
  });

  it("runs a tool with our full schema (edit's preprocess lifts a flat edit)", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "hello world\n");
    const { call, events, bridge } = await connect({ tools: [createEditTool(dir) as AgentTool] });

    const res = await call(
      "edit",
      { file_path: file, old_text: "world", new_text: "there" },
      "toolu_edit",
    );
    expect(res.result!.isError).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("hello there\n");
    expect(events.map((e) => e.type)).toEqual(["tool_call_start", "tool_call_end"]);
    expect(events[0]).toMatchObject({ toolCallId: "toolu_edit", name: "edit" });
    expect(bridge.takeResult("toolu_edit")).toMatchObject({
      type: "tool_result",
      toolCallId: "toolu_edit",
      isError: false,
    });
    expect(bridge.takeResult("toolu_edit")).toBeUndefined();
  });

  it("returns readable argument errors with hints, retrying once without nulls", async () => {
    const { call, events } = await connect({ tools: [echo] });

    const ok = await call("echo", { text: "a", times: null });
    expect(ok.result).toEqual({ content: [{ type: "text", text: "a" }] });

    const bad = await call("echo", { txt: "a" });
    expect(bad.result!.isError).toBe(true);
    const text = (bad.result!.content as { text: string }[])[0].text;
    expect(text).toContain("Invalid arguments for tool `echo`");
    expect(text).toContain("did you mean `text`?");
    expect(events.at(-1)).toMatchObject({ type: "tool_call_end", invalidArgAttempt: 1 });

    const unknown = await call("ehco", {});
    expect((unknown.result!.content as { text: string }[])[0].text).toContain("`echo`");
  });

  it("redacts secrets, applies transformToolResult, caps results and converts images", async () => {
    const tools: AgentTool[] = [
      {
        name: "leak",
        description: "",
        parameters: z.object({}),
        execute: () => "key sk-ant-api03-" + "x".repeat(90),
      },
      {
        name: "big",
        description: "",
        parameters: z.object({}),
        execute: () => "y".repeat(5_000),
      },
      {
        name: "pic",
        description: "",
        parameters: z.object({}),
        execute: () => ({
          content: [
            { type: "text", text: "shot" },
            { type: "image", mediaType: "image/png", data: "AAAA" },
          ],
        }),
      },
    ];
    const { call, bridge } = await connect({
      tools,
      maxToolResultChars: 1_000,
      transformToolResult: (c, content) =>
        c.name === "leak" && typeof content === "string" ? content + " [untrusted]" : content,
    });

    const leak = (await call("leak", {})).result!.content as { text: string }[];
    expect(leak[0].text).not.toContain("x".repeat(90));
    expect(leak[0].text).toMatch(/\[untrusted\]$/);

    const big = (await call("big", {}, "toolu_big")).result!.content as { text: string }[];
    expect(big[0].text.length).toBeLessThan(1_100);
    expect(bridge.takeResult("toolu_big")?.capped?.scope).toBe("per-result");

    const pic = (await call("pic", {})).result!.content;
    expect(pic).toEqual([
      { type: "text", text: "shot" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("aborts the tool on MCP cancellation and on the run's signal", async () => {
    const seen: string[] = [];
    const slow: AgentTool = {
      name: "slow",
      description: "",
      parameters: z.object({}),
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            seen.push(ctx.toolCallId);
            resolve("stopped");
          });
        }),
    };
    const run = new AbortController();
    const { call, request, transport } = await connect({ tools: [slow], signal: run.signal });

    const first = call("slow", {}, "toolu_a");
    transport.onmessage!({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    expect((await first).result!.content).toEqual([{ type: "text", text: "stopped" }]);

    const second = call("slow", {}, "toolu_b");
    run.abort();
    await second;
    expect(seen).toEqual(["toolu_a", "toolu_b"]);
    expect((await request("ping")).result).toEqual({});
  });

  it("cuts running tools short when the user steers, sparing edits", async () => {
    // Regression: on Claude Code a message sent during a long wait (task_output)
    // sat queued until the tool finished on its own.
    const waiter: AgentTool = {
      name: "task_output",
      description: "",
      parameters: z.object({}),
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve("partial log"));
        }),
    };
    const stuck: AgentTool = {
      name: "stuck",
      description: "",
      parameters: z.object({}),
      execute: () => new Promise(() => {}),
    };
    let finishEdit: (value: string) => void = () => {};
    const edit: AgentTool = {
      name: "edit",
      description: "",
      parameters: z.object({}),
      execute: () => new Promise<string>((resolve) => (finishEdit = resolve)),
    };
    const { bridge, call } = await connect({ tools: [waiter, stuck, edit] });
    const waiting = call("task_output", {}, "toolu_wait");
    const ignoring = call("stuck", {}, "toolu_stuck");
    const editing = call("edit", {}, "toolu_edit");
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge.preempt();

    const waited = await waiting;
    expect(waited.result!.isError).toBe(true);
    expect(waited.result!.content).toEqual([
      {
        type: "text",
        text: "Interrupted: the user sent a new message.\nPartial output:\npartial log",
      },
    ]);
    // A tool that ignores its signal is abandoned after the grace period.
    expect((await ignoring).result!.content).toEqual([
      { type: "text", text: "Interrupted: the user sent a new message." },
    ]);
    finishEdit("edited");
    expect((await editing).result!.content).toEqual([{ type: "text", text: "edited" }]);
  });

  it("resolves deferred tools by name, streams updates and reports endRun", async () => {
    let ended = 0;
    const deferred: AgentTool = {
      name: "later",
      description: "",
      parameters: z.object({}),
      execute: (_a, ctx) => {
        ctx.onUpdate?.({ step: 1 });
        return { content: "done", endRun: true };
      },
    };
    const { call, events, request } = await connect({
      tools: [echo],
      resolveTool: (name) => (name === "later" ? deferred : undefined),
      onEndRun: () => ended++,
    });
    await call("later", {});
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_update",
      "tool_call_end",
    ]);
    expect(ended).toBe(1);
    const listed = (await request("tools/list")).result!.tools as { name: string }[];
    expect(listed.map((t) => t.name)).toContain("later");
  });

  it("tells Claude Code to re-list tools after tool_search promotes one", async () => {
    const tools: AgentTool[] = [echo];
    const later: AgentTool = {
      name: "later",
      description: "",
      parameters: z.object({}),
      execute: () => "ok",
    };
    const promote: AgentTool = {
      name: "tool_search",
      description: "",
      parameters: z.object({}),
      execute: () => {
        tools.push(later);
        return "later is now available";
      },
    };
    tools.push(promote);
    const { request, call, sent } = await connect({ tools }, { relistOnChange: true });
    const init = await request("initialize", { protocolVersion: "2025-11-25" });
    expect(init.result).toMatchObject({ capabilities: { tools: { listChanged: true } } });
    await request("tools/list");

    const listChanged = () =>
      sent.filter((m) => m.method === "notifications/tools/list_changed").length;
    await call("echo", { text: "a" });
    expect(listChanged()).toBe(0);
    const searched = await call("tool_search", {});
    expect(listChanged()).toBe(1);
    // Regression: the result went back before Claude Code re-listed, so the
    // model's next call to the promoted tool failed with "No such tool
    // available". The re-list must reach Claude Code first.
    const relistAt = sent.findIndex(
      (m, i) =>
        i > sent.findIndex((n) => n.method === "notifications/tools/list_changed") &&
        Array.isArray((m.result as { tools?: unknown } | undefined)?.tools),
    );
    expect(relistAt).toBeGreaterThan(-1);
    expect(relistAt).toBeLessThan(sent.indexOf(searched));
    await call("echo", { text: "b" });
    expect(listChanged()).toBe(1);

    const list = await request("tools/list");
    const names = (list.result!.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["echo", "tool_search", "later"]);
  });
});

describe("createToolBridge — promotion without a re-list", () => {
  it("still answers when Claude Code never re-lists", async () => {
    const tools: AgentTool[] = [];
    const promote: AgentTool = {
      name: "tool_search",
      description: "",
      parameters: z.object({}),
      execute: () => {
        tools.push({ ...echo, name: "later" });
        return "later is now available";
      },
    };
    tools.push(promote);
    const { request, call } = await connect({ tools, relistWaitMs: 20 });
    await request("tools/list");
    const started = Date.now();
    const result = await call("tool_search", {});
    expect(result.result).toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("createToolBridge — across runs", () => {
  it("reports each call to the run that was current when it started", async () => {
    const { bridge, call, events } = await connect({ tools: [echo] });
    await call("echo", { text: "a" });
    const next: AgentEvent[] = [];
    bridge.update({ onEvent: (e) => next.push(e) });
    await call("echo", { text: "b" });
    expect(events.map((e) => e.type)).toEqual(["tool_call_start", "tool_call_end"]);
    expect(next.map((e) => e.type)).toEqual(["tool_call_start", "tool_call_end"]);
  });

  it("re-lists tools added between runs before the next prompt", async () => {
    const tools: AgentTool[] = [echo];
    const { bridge, request, sent } = await connect({ tools }, { relistOnChange: true });
    const listChanged = () =>
      sent.filter((m) => m.method === "notifications/tools/list_changed").length;
    // Nothing to announce before Claude Code has listed, or while the list is unchanged.
    await bridge.syncToolList();
    await request("tools/list");
    await bridge.syncToolList();
    expect(listChanged()).toBe(0);

    tools.push({ ...echo, name: "later" });
    await bridge.syncToolList();
    expect(listChanged()).toBe(1);
    const relisted = sent.filter((m) => Array.isArray((m.result as { tools?: unknown })?.tools));
    expect((relisted.at(-1)!.result!.tools as { name: string }[]).map((t) => t.name)).toEqual([
      "echo",
      "later",
    ]);
    await bridge.syncToolList();
    expect(listChanged()).toBe(1);
  });
});
