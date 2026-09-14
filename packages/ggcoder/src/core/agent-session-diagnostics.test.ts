import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentSession } from "./agent-session.js";
import { LspManager } from "./lsp/manager.js";
import { LspClientPool } from "./lsp/pool.js";
import { fileURLToPath } from "node:url";
import { useFakeHome } from "../test-support/fake-home.js";
import { removeWhenReleased } from "./lsp/test-support.js";

interface Internals {
  tools: AgentTool[];
  lspManager: LspManager;
  trackHookEvent(event: AgentEvent): Promise<void>;
  getHookSteeringMessages(): Message[] | null;
  getHookFollowUpMessages(): Promise<Message[] | null>;
  eventBus: { on(event: string, callback: (data: Record<string, unknown>) => void): () => void };
}
let cwd: string;
let restoreHome: () => void;
let session: AgentSession;
let internal: Internals;
let id = 0;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-session-diagnostics-"));
  restoreHome = useFakeHome(cwd);
  await fs.mkdir(path.join(cwd, ".gg"));
  await fs.writeFile(
    path.join(cwd, ".gg", "settings.json"),
    JSON.stringify({ idealReviewEnabled: false }),
  );
  await fs.writeFile(path.join(cwd, "package.json"), '{"private":true}');
  await fs.writeFile(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
  );
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    systemPrompt: "test",
    allowedTools: ["read", "write", "edit", "bash"],
  });
  await session.initialize();
  internal = session as unknown as Internals;
});
afterEach(async () => {
  await session?.dispose();
  restoreHome?.();
  await removeWhenReleased(cwd);
});

async function execute(name: string, args: Record<string, unknown>): Promise<string> {
  const toolCallId = `diagnostics-${++id}`;
  const tool = internal.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  await internal.trackHookEvent({ type: "tool_call_start", toolCallId, name, args });
  const result = await tool.execute(args, { toolCallId, signal: new AbortController().signal });
  const content = typeof result === "string" ? result : result.content;
  if (typeof content !== "string") throw new Error("Expected textual code-tool content");
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result: content,
    isError: false,
    durationMs: 0,
  });
  return content;
}

describe("GG App session asynchronous diagnostics", () => {
  it("does not add another model turn for silent diagnostics after a real passing typecheck", async () => {
    await execute("write", { file_path: "a.ts", content: "export const value: number = 1;\n" });
    await internal.lspManager.flushDiagnostics();
    internal.lspManager.drainDiagnostics();
    await execute("read", { file_path: "a.ts" });
    await execute("edit", { file_path: "a.ts", edits: [{ old_text: "= 1;", new_text: "= 2;" }] });
    const check = await execute("bash", { command: "pnpm exec tsc --noEmit --project ." });
    expect(check).toContain("Exit code: 0");
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.lspManager.getLatestOutcome("a.ts")?.kind).toBe("timeout");
  }, 30_000);

  it("summarizes multiple file timeouts once alongside final verification, never between steps", async () => {
    const hooks: unknown[] = [];
    const diagnostics: unknown[] = [];
    internal.eventBus.on("hook", (event) => hooks.push(event));
    internal.eventBus.on("diagnostics", (event) => diagnostics.push(event));
    const originalManager = internal.lspManager;
    const pool = new LspClientPool();
    // Real RPC timeout, deterministically silent: a healthy TypeScript server
    // can publish a clean result, so it cannot reproduce an unavailable server.
    internal.lspManager = new LspManager(cwd, {
      pool,
      firstBudgetMs: 100,
      warmBudgetMs: 100,
      catalog: [
        {
          id: "silent-session-test",
          extensions: [".ts"],
          rootMarkers: ["package.json"],
          languageIdFor: () => "typescript",
          resolveCommand: () => ({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../tools/__fixtures__/fake-lsp-server.mjs", import.meta.url)),
              "--silent",
            ],
          }),
        },
      ],
    });
    try {
      for (const file of ["a.ts", "b.ts"]) {
        const content = "export const value = 1;\n";
        await execute("write", { file_path: file, content });
        internal.lspManager.queueDiagnosticsAfterWrite(file, content);
        await internal.lspManager.flushDiagnostics();
        expect(internal.getHookSteeringMessages()).toBeNull();
      }
      expect(hooks).toEqual([]);
      expect(diagnostics).toEqual([]);
      const followUp = JSON.stringify(await internal.getHookFollowUpMessages());
      expect(followUp).toContain("a.ts: diagnostics timeout; not verified");
      expect(followUp).toContain("b.ts: diagnostics timeout; not verified");
      expect(followUp).toContain("Verification gate:");
      expect(hooks).toEqual([{ kind: "verification" }]);
      expect(diagnostics).toHaveLength(1);
      expect(await internal.getHookFollowUpMessages()).toBeNull();
    } finally {
      internal.lspManager.shutdownAll();
      pool.shutdownAll();
      internal.lspManager = originalManager;
    }
  }, 30_000);

  it("returns the real write before diagnostics and checks errors before allowing completion", async () => {
    const events: string[] = [];
    internal.eventBus.on("hook_armed", (event) =>
      events.push(`armed:${String(event.kind)}:${String(event.armed)}`),
    );
    internal.eventBus.on("hook", (event) => events.push(`hook:${String(event.kind)}`));
    const diagnosticNotices: string[] = [];
    internal.eventBus.on("diagnostics", (event) => diagnosticNotices.push(String(event.text)));
    const output = await execute("write", {
      file_path: "a.ts",
      content: 'export const value: number = "wrong";\n',
    });
    expect(output).toContain("Diagnostics queued");
    expect(internal.lspManager.hasQueuedDiagnostics()).toBe(true);
    expect(events).toContain("armed:verification:true");
    const followUp = await internal.getHookFollowUpMessages();
    expect(JSON.stringify(followUp)).toContain("Diagnostics in a.ts");
    expect(internal.lspManager.getLatestOutcome("a.ts")?.kind).toBe("diagnostics");
    expect(events).toContain("hook:verification");
    // Diagnostics share the real verification intervention, rather than falsely
    // announcing one themselves and demanding a second model turn.
    expect(JSON.stringify(followUp)).toContain("Verification gate:");
    expect(diagnosticNotices).toHaveLength(1);
    expect(diagnosticNotices[0]).toContain("Diagnostics in a.ts");
    expect(events.filter((event) => event === "hook:verification")).toHaveLength(1);
  }, 30_000);

  it("delivers the latest edit's errors through steering without an output-polling tool", async () => {
    const hooks: unknown[] = [];
    const diagnostics: unknown[] = [];
    internal.eventBus.on("hook", (event) => hooks.push(event));
    internal.eventBus.on("diagnostics", (event) => diagnostics.push(event));
    await execute("write", { file_path: "a.ts", content: "export const value: number = 1;\n" });
    await execute("read", { file_path: "a.ts" });
    const edit = await execute("edit", {
      file_path: "a.ts",
      edits: [{ old_text: "= 1;", new_text: '= "wrong";' }],
    });
    expect(edit).toContain("Diagnostics queued");
    await internal.lspManager.flushDiagnostics();
    expect(JSON.stringify(internal.getHookSteeringMessages())).toContain("Diagnostics in a.ts");
    expect(JSON.stringify(internal.getHookSteeringMessages())).not.toContain("Diagnostics in a.ts");
    expect(hooks).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).toContain("Diagnostics in a.ts");
  }, 30_000);
});
