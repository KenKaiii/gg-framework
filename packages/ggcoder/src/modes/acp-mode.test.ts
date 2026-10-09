import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACP_PROTOCOL_VERSION } from "./acp-mode.js";

const MODES_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODES_DIR, "../..");
const FIXTURE = path.join(MODES_DIR, "__fixtures__", "acp-stdio-agent.mjs");

/**
 * Keep `import.meta.url` pointing at each ORIGINAL source file inside the
 * bundle. Several modules locate files relative to themselves (bundled skills,
 * LSP binaries, MCP launchers); without this they would resolve relative to the
 * bundle's temp directory and quietly change what the fixture sees.
 */
const preserveModuleUrls: Plugin = {
  name: "preserve-module-urls",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[\\/]src[\\/].*\.(ts|mjs)$/ }, async (args) => {
      const source = await fs.readFile(args.path, "utf8");
      return {
        contents: source.replaceAll(
          "import.meta.url",
          JSON.stringify(pathToFileURL(args.path).href),
        ),
        loader: args.path.endsWith(".ts") ? "ts" : "js",
        resolveDir: path.dirname(args.path),
      };
    });
  },
};

/** Directory holding the prebuilt fixture; removed after the suite. */
let bundleDir: string;
/** The fixture, bundled once per run. */
let agentBundle: string;

// Every test starts a fresh agent process. Loading ~150 source modules through
// `tsx` cost ~0.8s per start locally and ~3s on Windows CI, which made this the
// slowest file in the suite. Bundling the fixture's own sources once (third
// party packages stay external and load from node_modules as usual) roughly
// halves every start without changing the code under test.
beforeAll(async () => {
  // Inside the package's node_modules so the external imports resolve.
  const cacheDir = path.join(PACKAGE_ROOT, "node_modules", ".cache");
  await fs.mkdir(cacheDir, { recursive: true });
  bundleDir = await fs.mkdtemp(path.join(cacheDir, "acp-fixture-"));
  agentBundle = path.join(bundleDir, "acp-stdio-agent.mjs");
  await build({
    entryPoints: [FIXTURE],
    outfile: agentBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [preserveModuleUrls],
    logLevel: "error",
  });
}, 60_000);

afterAll(async () => {
  if (bundleDir) await fs.rm(bundleDir, { recursive: true, force: true });
});

interface Frame {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  params?: { sessionId?: string; update?: Record<string, unknown> };
}

interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

interface StoredSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
}

/**
 * A HOME the fixture seeds sessions into, and the project directory they
 * belong to.
 *
 * Real files rather than a stub: `session/list` and `session/load` exist to
 * surface sessions the desktop wrote, so anything short of the real
 * `~/.gg/sessions` layout would prove nothing about that.
 */
let tmpHome: string;
let tmpProject: string;
/** A second checkout, so "list everything" can be told apart from "list here". */
let tmpOtherProject: string;

/**
 * A live ACP agent in a child process, driven exactly the way a client drives
 * it: NDJSON in on stdin, NDJSON out on stdout.
 */
class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private frames: Frame[] = [];
  private waiters: (() => void)[] = [];
  stderr = "";
  exit: Promise<number | null>;

  constructor() {
    this.child = spawn(process.execPath, [agentBundle, tmpProject, tmpOtherProject], {
      // The project directory is passed explicitly rather than inherited from
      // the test runner.
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        GG_DISABLE_TELEMETRY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.frames.push(JSON.parse(line) as Frame);
      }
      for (const wake of this.waiters.splice(0)) wake();
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.exit = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
  }

  send(frame: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Write bytes verbatim, so malformed input can be tested. */
  sendRaw(text: string): void {
    this.child.stdin.write(text);
  }

  /** Close stdin, which is how an ACP client disconnects. */
  end(): void {
    this.child.stdin.end();
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  /** Every frame received so far, in arrival order. */
  received(): Frame[] {
    return [...this.frames];
  }

  /**
   * Wait for the response to `id`, returning everything that arrived up to and
   * including it. Ordering is the assertion that matters: notifications for a
   * turn must precede that turn's response.
   */
  async until(id: string | number, timeoutMs = 20_000): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.id === id);
      if (index >= 0) return this.frames.slice(0, index + 1);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for response ${String(id)}; got ${JSON.stringify(this.frames)} stderr=${this.stderr}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Drive the handshake and return the created session id. */
  async handshake(): Promise<string> {
    this.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await this.until(1);
    this.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmpProject, mcpServers: [] },
    });
    const frames = await this.until(2);
    return frames.at(-1)!.result!.sessionId as string;
  }

  /** Wait for a `session/update` notification of one kind, ignoring the rest. */
  async untilUpdate(kind: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = updates(this.frames).find((update) => update.sessionUpdate === kind);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${kind}; stderr=${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * The stored sessions the fixture seeded, newest first.
   *
   * Omitting `cwd` asks for every project, which is what a phone wants; passing
   * one scopes to that checkout.
   */
  async list(id: string | number = 90, cwd?: string): Promise<StoredSession[]> {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/list",
      params: cwd ? { cwd } : {},
    });
    const frames = await this.until(id);
    return frames.at(-1)!.result!.sessions as StoredSession[];
  }
}

let client: AcpClient | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-acp-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-acp-project-"));
  tmpOtherProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-acp-other-"));
});

afterEach(async () => {
  client?.kill();
  client = undefined;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  await fs.rm(tmpOtherProject, { recursive: true, force: true });
});

/** Session updates only, unwrapped to the `update` payload. */
function updates(frames: Frame[]): Record<string, unknown>[] {
  return frames
    .filter((frame) => frame.method === "session/update")
    .map((frame) => frame.params!.update!);
}

/** Updates a session announces on its own schedule, not as part of a turn. */
const OUT_OF_BAND_UPDATES = new Set([
  "available_commands_update",
  "usage_update",
  "session_info_update",
]);

/**
 * Conversation updates only.
 *
 * The command list and the context-usage report are announced on their own
 * schedule after a session opens, so an exact-match transcript assertion would
 * otherwise pass or fail on timing.
 */
function transcript(frames: Frame[]): Record<string, unknown>[] {
  return updates(frames).filter(
    (update) => !OUT_OF_BAND_UPDATES.has(update.sessionUpdate as string),
  );
}

/** Context-usage notifications only, in arrival order. */
function usageUpdates(frames: Frame[]): Record<string, unknown>[] {
  return updates(frames).filter((update) => update.sessionUpdate === "usage_update");
}

/** Every update of one kind, in arrival order. */
function updatesOfKind(frames: Frame[], kind: string): Record<string, unknown>[] {
  return updates(frames).filter((update) => update.sessionUpdate === kind);
}

describe("ACP mode over stdio", () => {
  it("negotiates initialize and creates a session", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const frames = await client.until(1);

    const initialize = frames.at(-1)!;
    expect(initialize.jsonrpc).toBe("2.0");
    expect(initialize.result).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      authMethods: [],
      agentInfo: { name: "ggcoder", title: "GG Coder", version: "0.0.0-test" },
    });
    // A client only offers resume and a session list when these are advertised,
    // and `{}` — not `true` — is how ACP spells "supported" for these two.
    expect(initialize.result!.agentCapabilities).toMatchObject({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
    });

    client.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: tmpProject } });
    const created = (await client.until(2)).at(-1)!;
    expect(created.result!.sessionId).toBe("acp-fixture-session");
  });

  it("lists sessions from every project, newest first, titled by their first user prompt", async () => {
    client = new AcpClient();
    await client.handshake();

    const sessions = await client.list();

    // No `cwd` means the whole machine, so the other checkout's session must be
    // here too — a phone asks "what have I been working on", not "what is in
    // this one directory". The empty seeded session must NOT appear: there is
    // nothing to resume.
    expect(sessions).toHaveLength(3);
    expect(sessions.map((entry) => entry.title)).toEqual([
      "other project: fix the parser",
      "newer: add the config panel",
      "older: rename the widget",
    ]);
    // Each entry carries its own project, which is what lets a client group by
    // checkout instead of showing one flat undifferentiated list.
    expect(sessions.map((entry) => entry.cwd)).toEqual([tmpOtherProject, tmpProject, tmpProject]);
    for (const entry of sessions) expect(Date.parse(entry.updatedAt)).not.toBeNaN();
    // Ids must be the ones the fixture actually wrote, or `session/load` is
    // addressing something that does not exist.
    expect(client.stderr).toContain(sessions[0]!.sessionId);
    expect(client.stderr).toContain(sessions[1]!.sessionId);
  });

  it("scopes the list to one project when a cwd is given", async () => {
    client = new AcpClient();
    await client.handshake();

    const scoped = await client.list(90, tmpProject);

    expect(scoped.map((entry) => entry.title)).toEqual([
      "newer: add the config panel",
      "older: rename the widget",
    ]);
    for (const entry of scoped) expect(entry.cwd).toBe(tmpProject);
  });

  it("replays a loaded session's transcript before answering, then resumes it", async () => {
    client = new AcpClient();
    await client.handshake();
    const [newest] = await client.list(90, tmpProject);

    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/load",
      params: { sessionId: newest!.sessionId, cwd: tmpProject, mcpServers: [] },
    });
    const frames = await client.until(91);
    const replay = frames.filter(
      (frame) =>
        frame.method === "session/update" &&
        !OUT_OF_BAND_UPDATES.has(frame.params!.update!.sessionUpdate as string),
    );

    // History must arrive BEFORE the response: a client draws a resumed session
    // with its live-turn renderer, so anything after the reply lands nowhere.
    expect(replay.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.id).toBe(91);
    for (const frame of replay) expect(frame.params!.sessionId).toBe(newest!.sessionId);

    expect(transcript(frames)).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        // Chunks carry the message they belong to, so a client can group them
        // into bubbles instead of guessing at boundaries.
        messageId: "hist-1",
        content: { type: "text", text: "newer: add the config panel" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "hist-2",
        content: { type: "text", text: "Reading the panel first." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "read(/panel.tsx)",
        name: "read",
        kind: "read",
        // A replayed call is settled; `in_progress` would spin forever.
        status: "completed",
        rawInput: { file_path: "/panel.tsx" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "panel source" } }],
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "hist-3",
        content: { type: "text", text: "Added the config panel." },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "hist-4",
        content: { type: "text", text: "after first compaction" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "hist-5",
        content: { type: "text", text: "First follow-up complete." },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "hist-6",
        content: { type: "text", text: "after second compaction" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "hist-7",
        content: { type: "text", text: "Second follow-up complete." },
      },
    ]);
    const replayText = transcript(frames)
      .map((update) => (update.content as { text?: string } | undefined)?.text ?? "")
      .join("\n");
    expect(replayText).not.toContain("replacement summary");

    // Resuming is worthless if the session cannot then be prompted, and the
    // client must keep addressing it by the id it asked to load.
    client.send({
      jsonrpc: "2.0",
      id: 92,
      method: "session/prompt",
      params: { sessionId: newest!.sessionId, prompt: [{ type: "text", text: "again" }] },
    });
    const turn = await client.until(92);
    expect(turn.at(-1)!.result).toEqual({ stopReason: "end_turn" });
    expect(
      turn
        .filter(
          (frame) =>
            frame.method === "session/update" &&
            !OUT_OF_BAND_UPDATES.has(frame.params!.update!.sessionUpdate as string),
        )
        .every((frame) => frame.params!.sessionId === newest!.sessionId),
    ).toBe(true);

    // Full replay is display-only: prompting still sees only generation 2.
    const contextStart = client.received().length;
    client.send({
      jsonrpc: "2.0",
      id: 93,
      method: "session/prompt",
      params: {
        sessionId: newest!.sessionId,
        prompt: [{ type: "text", text: "report loaded context" }],
      },
    });
    const contextFrames = (await client.until(93)).slice(contextStart);
    const contextText = transcript(contextFrames)
      .map((update) => (update.content as { text?: string } | undefined)?.text ?? "")
      .join("\n");
    expect(contextText).toContain("second replacement summary");
    expect(contextText).toContain("after second compaction");
    expect(contextText).not.toContain("newer: add the config panel");
  });

  it("loads a session listed under a different cwd than the one it is opened with", async () => {
    client = new AcpClient();
    await client.handshake();
    const [newest] = await client.list(90, tmpProject);

    // Exactly what pew2 does: its capability probe lists from its own working
    // directory, then resumes against the project the session belongs to. A
    // cwd-scoped lookup fails here, so this is the regression that matters.
    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/load",
      params: { sessionId: newest!.sessionId, cwd: os.tmpdir(), mcpServers: [] },
    });
    const frames = await client.until(91);

    expect(frames.at(-1)!.error).toBeUndefined();
    expect(transcript(frames)[0]).toEqual({
      sessionUpdate: "user_message_chunk",
      messageId: "hist-1",
      content: { type: "text", text: "newer: add the config panel" },
    });
  });

  it("replays a compaction summary when the parent checkpoint is missing", async () => {
    client = new AcpClient();
    await client.handshake();
    const stored = await client.list(90, tmpProject);
    const older = stored.find((entry) => entry.title === "older: rename the widget")!;

    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/load",
      params: { sessionId: older.sessionId, cwd: tmpProject, mcpServers: [] },
    });
    const frames = await client.until(91);

    expect(transcript(frames)).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "hist-1",
        content: {
          type: "text",
          text: "[Previous conversation summary]\n\nolder fallback summary",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "hist-2",
        content: { type: "text", text: "Recovered from summary." },
      },
    ]);
  });

  it("refuses to load a session that does not exist", async () => {
    client = new AcpClient();
    await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/load",
      params: { sessionId: "no-such-session", cwd: tmpProject, mcpServers: [] },
    });
    expect((await client.until(91)).at(-1)!.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("no-such-session"),
    });
  });

  it("advertises model and thinking selectors, and applies changes to both", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.until(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmpProject, mcpServers: [] },
    });
    const created = (await client.until(2)).at(-1)!;

    const initial = created.result!.configOptions as ConfigOption[];
    const model = initial.find((option) => option.id === "model")!;
    const thinking = initial.find((option) => option.id === "thinking")!;

    // Categories are what let a client place these correctly without knowing
    // anything about ggcoder.
    expect(model).toMatchObject({ category: "model", type: "select" });
    expect(thinking).toMatchObject({ category: "thought_level", type: "select" });
    expect(model.currentValue).toBe("claude-opus-5-5");
    expect(model.options.length).toBeGreaterThan(1);
    expect(model.options.some((option) => option.value === "claude-opus-5-5")).toBe(true);
    expect(thinking.currentValue).toBe("off");
    expect(thinking.options[0]).toMatchObject({ value: "off" });

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { sessionId: "acp-fixture-session", configId: "thinking", value: "high" },
    });
    const afterThinking = (await client.until(3)).at(-1)!.result!.configOptions as ConfigOption[];
    // The reply must carry the COMPLETE set, not just the field that changed.
    expect(afterThinking.map((option) => option.id).sort()).toEqual(["mode", "model", "thinking"]);
    expect(afterThinking.find((option) => option.id === "thinking")!.currentValue).toBe("high");

    client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: {
        sessionId: "acp-fixture-session",
        configId: "model",
        value: "gemini-3.1-flash-lite",
      },
    });
    const afterModel = (await client.until(4)).at(-1)!.result!.configOptions as ConfigOption[];
    expect(afterModel.find((option) => option.id === "model")!.currentValue).toBe(
      "gemini-3.1-flash-lite",
    );
    // Flash Lite's ceiling is `high`, so the ladder must shrink with the model
    // rather than keep offering a level it would silently ignore.
    const flashLiteLevels = afterModel.find((option) => option.id === "thinking")!.options;
    expect(flashLiteLevels.some((option) => option.value === "max")).toBe(false);
    expect(flashLiteLevels.at(-1)).toMatchObject({ value: "high" });
    // The level set before the switch is still legal here, so it must survive.
    expect(afterModel.find((option) => option.id === "thinking")!.currentValue).toBe("high");
  });

  it("clamps a thinking level the newly selected model cannot reach", async () => {
    client = new AcpClient();
    await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { sessionId: "acp-fixture-session", configId: "thinking", value: "max" },
    });
    await client.until(3);

    client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: {
        sessionId: "acp-fixture-session",
        configId: "model",
        value: "gemini-3.1-flash-lite",
      },
    });
    const options = (await client.until(4)).at(-1)!.result!.configOptions as ConfigOption[];
    // Reporting `max` here would be a control that lies: Flash Lite has no such tier,
    // so the session's real effort is `high` and the client must be told that.
    expect(options.find((option) => option.id === "thinking")!.currentValue).toBe("high");
  });

  it("advertises plan mode in both the config options and the modes block", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.until(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmpProject, mcpServers: [] },
    });
    const created = (await client.until(2)).at(-1)!.result!;

    // Two surfaces, one truth: spec clients (Zed) read `modes`; pew2 reads the
    // config option. They must agree or the two pickers would disagree.
    expect(created.modes).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default", description: "Full tool access" },
        { id: "plan", name: "Plan", description: "Read-only research until a plan is approved" },
      ],
    });
    const mode = (created.configOptions as ConfigOption[]).find((option) => option.id === "mode")!;
    expect(mode).toMatchObject({ category: "mode", type: "select", currentValue: "default" });
    expect(mode.options.map((option) => option.value)).toEqual(["default", "plan"]);
  });

  it("announces available commands after session/new, merging built-ins with project files", async () => {
    // A project command, and one whose name collides with a built-in template.
    const commandsDir = path.join(tmpProject, ".gg", "commands");
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(commandsDir, "deploy.md"),
      "---\nname: deploy\ndescription: Build and ship to staging\n---\n\nShip it.\n",
    );
    await fs.writeFile(
      path.join(commandsDir, "init.md"),
      "---\nname: init\ndescription: Shadowed by the built-in\n---\n\nNever runs.\n",
    );
    // A project file whose name collides with a REGISTRY command (the fixture
    // registers `/new`). The session resolves a template body before consulting
    // the registry, so this file really is what `/new` runs here.
    await fs.writeFile(
      path.join(commandsDir, "new.md"),
      "---\nname: new\ndescription: Project override of the registry command\n---\n\nRuns.\n",
    );

    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.until(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmpProject, mcpServers: [] },
    });
    const frames = await client.until(2);
    // The announcement must not overtake the response that names the session.
    expect(updates(frames).some((u) => u.sessionUpdate === "available_commands_update")).toBe(
      false,
    );

    const update = await client.untilUpdate("available_commands_update");
    const commands = update.availableCommands as {
      name: string;
      description: string;
      input?: { hint: string };
    }[];
    const byName = new Map(commands.map((command) => [command.name, command]));

    // A built-in the client could not have discovered by scanning the disk.
    expect(byName.get("expand")).toMatchObject({
      description: expect.any(String),
      input: { hint: expect.any(String) },
    });
    // A project file, carried with its own frontmatter description.
    expect(byName.get("deploy")!.description).toBe("Build and ship to staging");
    // Collisions resolve the way the session itself resolves them: a built-in
    // template beats a project file, and it is listed once.
    expect(commands.filter((command) => command.name === "init")).toHaveLength(1);
    expect(byName.get("init")!.description).toBe("Generate or update CLAUDE.md for this project");
    // ...but a project file beats a REGISTRY command, because that is the order
    // `resolveSlashInput` uses. Advertising the registry's `/new` here would
    // describe something the agent would never run.
    expect(commands.filter((command) => command.name === "new")).toHaveLength(1);
    expect(byName.get("new")!.description).toBe("Project override of the registry command");
    // A registry command with no collision is listed, with a hint parsed from
    // its usage rather than the template hint.
    expect(byName.get("quit")).toEqual({ name: "quit", description: "Exit the agent" });
    // Aliases are not separate commands: /quit ships `q` and `exit`, and only
    // the canonical name is advertised.
    expect(byName.has("q")).toBe(false);
    expect(byName.has("exit")).toBe(false);
  });

  it("switches mode via session/set_mode and tells the client with current_mode_update", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId, modeId: "plan" },
    });
    const frames = await client.until(3);
    expect(frames.at(-1)!.result).toEqual({});

    const notes = transcript(frames);
    expect(notes[0]).toEqual({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    // The full option set rides along so a client tracking config sees the
    // same truth the modes block would tell it.
    const configNote = notes.find((u) => u.sessionUpdate === "config_option_update")!;
    expect(
      ((configNote.configOptions as ConfigOption[]) ?? []).find((o) => o.id === "mode")!
        .currentValue,
    ).toBe("plan");

    // And back — via the config-option route pew2 actually uses.
    client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { sessionId, configId: "mode", value: "default" },
    });
    const back = (await client.until(4)).at(-1)!.result!.configOptions as ConfigOption[];
    expect(back.find((option) => option.id === "mode")!.currentValue).toBe("default");
  });

  it("rejects an unknown mode", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId, modeId: "yolo" },
    });
    expect((await client.until(3)).at(-1)!.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("yolo"),
    });
  });
  it("rejects config values the active model cannot honour", async () => {
    client = new AcpClient();
    await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { sessionId: "acp-fixture-session", configId: "model", value: "not-a-model" },
    });
    expect((await client.until(3)).at(-1)!.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("not-a-model"),
    });

    client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { sessionId: "acp-fixture-session", configId: "nonsense", value: "x" },
    });
    expect((await client.until(4)).at(-1)!.error).toMatchObject({ code: -32602 });
  });

  it("maps the event bus onto session/update notifications, then answers with a stopReason", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "world" }] },
    });
    const frames = await client.until(3);
    const turn = frames.filter((frame) => frame.method === "session/update" || frame.id === 3);

    // Every notification for the turn must arrive BEFORE its response, or a
    // client renders the finished turn with no content in it.
    expect(turn.at(-1)!.result).toEqual({ stopReason: "end_turn" });
    expect(turn.slice(0, -1).every((frame) => frame.method === "session/update")).toBe(true);

    for (const frame of frames.filter((f) => f.method === "session/update")) {
      expect(frame.params!.sessionId).toBe(sessionId);
    }

    expect(transcript(frames)).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "planning" } },
      // Both deltas belong to the same message, so they share an id; the tool
      // call below ends it, and anything after starts a new one.
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "Hello " },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "world" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read(/tmp/example.ts)",
        name: "read",
        kind: "read",
        status: "in_progress",
        rawInput: { file_path: "/tmp/example.ts" },
        // Drives "follow the agent": the client opens the file being read.
        locations: [{ path: "/tmp/example.ts" }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        rawOutput: { progress: 0.5 },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file contents" } }],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "bash(exit 1)",
        name: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "exit 1" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "boom" } }],
      },
    ]);
  });

  it("reports context usage after session/new, before any prompt runs", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    const usage = await client.untilUpdate("usage_update");
    // A fresh session must show its window immediately: a client that only
    // learns the size after the first reply cannot draw a context meter.
    expect(usage).toEqual({ sessionUpdate: "usage_update", used: 4200, size: 200_000 });
    const frame = client
      .received()
      .find((f) => f.params?.update?.sessionUpdate === "usage_update")!;
    expect(frame.params!.sessionId).toBe(sessionId);
  });

  it("reports context usage on session/load so a resumed conversation shows it", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.until(1);
    const [newest] = await client.list(90, tmpProject);

    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/load",
      params: { sessionId: newest!.sessionId, cwd: tmpProject, mcpServers: [] },
    });
    await client.until(91);

    const usage = await client.untilUpdate("usage_update");
    expect(usage).toEqual({ sessionUpdate: "usage_update", used: 4200, size: 200_000 });
    // Addressed to the id the client asked to load, not the session's internal
    // one, or the update lands on a session the client never heard of.
    const frame = client
      .received()
      .find((f) => f.params?.update?.sessionUpdate === "usage_update")!;
    expect(frame.params!.sessionId).toBe(newest!.sessionId);
  });

  it("reports context usage after each model response", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();
    await client.untilUpdate("usage_update");
    const beforeTurn = client.received().length;

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "world" }] },
    });
    const frames = await client.until(3);

    const turnUsage = usageUpdates(frames.slice(beforeTurn));
    expect(turnUsage).toEqual([{ sessionUpdate: "usage_update", used: 9200, size: 200_000 }]);
    // Like every other turn notification, it must precede the response.
    expect(frames.at(-1)!.id).toBe(3);
  });

  it("reports the post-compaction count, so a client can see the drop", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();
    await client.untilUpdate("usage_update");
    const beforeTurn = client.received().length;

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "compact me" }] },
    });
    const frames = await client.until(3);

    // Compaction is invisible on the wire except as a fall in `used` at an
    // unchanged `size`, so the emit right after it is the whole signal.
    expect(usageUpdates(frames.slice(beforeTurn))).toEqual([
      { sessionUpdate: "usage_update", used: 900, size: 200_000 },
      {
        sessionUpdate: "usage_update",
        used: 2400,
        size: 200_000,
        cost: { amount: 0.25, currency: "USD" },
      },
    ]);
  });

  it("forwards tool images over stdio live and when restoring saved conversations", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "show tool images" }] },
    });
    const live = updatesOfKind(await client.until(3), "tool_call_update");
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
    const expected = ["screenshot", "generate_image", "read"].map((name) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: `image-${name}`,
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Picture ready" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data } },
      ],
    }));
    expect(live).toEqual(expected);
    const saved = (await client.list(90, tmpProject)).find(
      (session) => session.title === "tool image history",
    );
    expect(saved).toBeDefined();
    const beforeReplay = client.received().length;
    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/load",
      params: { sessionId: saved!.sessionId, cwd: tmpProject, mcpServers: [] },
    });
    const replay = (await client.until(91)).slice(beforeReplay);
    expect(updatesOfKind(replay, "tool_call_update")).toEqual(expected);
    expect(replay.at(-1)!.id).toBe(91);
  });

  it("sends file edits as a real diff instead of the tool's prose", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "edit a file" }] },
    });
    const frames = await client.until(3);

    const completed = updatesOfKind(frames, "tool_call_update");
    // The BEFORE contents, captured while the tool was still running. Reading
    // the file twice after the fact would report "after" as both sides.
    expect(completed[0]).toMatchObject({
      toolCallId: "d1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: path.join(tmpProject, "diffed.txt"),
          oldText: "before\n",
          newText: "after\n",
        },
      ],
    });
    // A new file has no old side; ACP spells that as null, which clients render
    // as an all-additions diff.
    expect(completed[1]).toMatchObject({
      toolCallId: "d2",
      content: [
        {
          type: "diff",
          path: path.join(tmpProject, "created.txt"),
          oldText: null,
          newText: "brand new\n",
        },
      ],
    });

    // Relative tool arguments are resolved against the session cwd, since the
    // client is running somewhere else and cannot resolve them itself.
    const starts = updatesOfKind(frames, "tool_call");
    expect(starts[1]!.locations).toEqual([{ path: path.join(tmpProject, "created.txt") }]);
  });

  it("publishes an approved plan and advances it from [DONE:n] markers", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "approve a plan" }] },
    });
    const frames = await client.until(3);

    const plans = updatesOfKind(frames, "plan");
    expect(plans).toHaveLength(2);
    // On approval the whole plan appears, with the first step already active:
    // steps run in order, so that is what the agent is doing right now.
    expect(plans[0]).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "Wire the transport layer", priority: "medium", status: "in_progress" },
        { content: "Render the results", priority: "medium", status: "pending" },
        { content: "Ship the thing", priority: "medium", status: "pending" },
      ],
    });
    // The marker was split across two text deltas and still registered.
    expect(plans[1]).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "Wire the transport layer", priority: "medium", status: "completed" },
        { content: "Render the results", priority: "medium", status: "in_progress" },
        { content: "Ship the thing", priority: "medium", status: "pending" },
      ],
    });
  });

  it("names the session from its first prompt, once", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    for (const id of [3, 4]) {
      client.send({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: `turn ${id}` }] },
      });
      await client.until(id);
    }

    const infos = updatesOfKind(client.received(), "session_info_update");
    // Titled after the FIRST exchange and never renamed underneath the user.
    expect(infos).toHaveLength(1);
    expect(infos[0]!.title).toBe("turn 3");
    expect(Date.parse(infos[0]!.updatedAt as string)).not.toBeNaN();
  });

  it("resumes a stored session without replaying its transcript", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.until(1);
    const [newest] = await client.list(90, tmpProject);

    client.send({
      jsonrpc: "2.0",
      id: 91,
      method: "session/resume",
      params: { sessionId: newest!.sessionId, cwd: tmpProject, mcpServers: [] },
    });
    const frames = await client.until(91);

    expect(frames.at(-1)!.error).toBeUndefined();
    // The whole point of resume over load: the client already has the
    // transcript, so pushing it a second copy is what it asked to avoid.
    expect(transcript(frames)).toEqual([]);

    // The context is genuinely restored, not merely reported as restored.
    client.send({
      jsonrpc: "2.0",
      id: 92,
      method: "session/prompt",
      params: {
        sessionId: newest!.sessionId,
        prompt: [{ type: "text", text: "report loaded context" }],
      },
    });
    const answered = await client.until(92);
    const replied = updatesOfKind(answered, "agent_message_chunk")
      .map((update) => (update.content as { text: string }).text)
      .join("");
    // Generation 2, exactly as `session/load` restores it: the live context is
    // the newest checkpoint, not the pre-compaction transcript.
    expect(replied).toContain("after second compaction");
    expect(replied).not.toContain("newer: add the config panel");
  });

  it("closes an active session and refuses to close an unknown one", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/close",
      params: { sessionId: "not-a-session" },
    });
    const rejected = (await client.until(3)).at(-1)!;
    expect(rejected.error!.code).toBe(-32602);

    client.send({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId } });
    const closed = (await client.until(4)).at(-1)!;
    expect(closed.result).toEqual({});

    // Closing frees the session, so prompting the closed id is now a client
    // sequencing error rather than a silently ignored no-op.
    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "still there?" }] },
    });
    expect((await client.until(5)).at(-1)!.error!.code).toBe(-32602);
  });

  it("waits for a cancelled turn to unwind before closing the session", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hang" }] },
    });
    // Let the turn actually start, or close would tear down an idle session and
    // the race this guards against could never happen.
    await new Promise((resolve) => setTimeout(resolve, 300));

    client.send({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId } });
    expect((await client.until(4)).at(-1)!.result).toEqual({});
    // The cancelled turn resolves as cancelled, not as an error.
    expect((await client.until(3)).at(-1)!.result).toEqual({ stopReason: "cancelled" });

    // Close only SIGNALS the abort; the turn keeps unwinding and persists its
    // tail on a later tick. Disposing without waiting drops that write, and a
    // resumed session comes back missing its last exchange.
    const witness = JSON.parse(
      await fs.readFile(path.join(tmpProject, "dispose-witness.json"), "utf8"),
    );
    expect(witness.disposedMidTurn).toBe(false);
  });

  it("deletes a stored session, and succeeds when it is already gone", async () => {
    client = new AcpClient();
    await client.handshake();
    const before = await client.list(90, tmpProject);
    const target = before.find((entry) => entry.title === "older: rename the widget")!;

    client.send({
      jsonrpc: "2.0",
      id: 92,
      method: "session/delete",
      params: { sessionId: target.sessionId },
    });
    expect((await client.until(92)).at(-1)!.result).toEqual({});

    const after = await client.list(93, tmpProject);
    expect(after.map((entry) => entry.title)).not.toContain("older: rename the widget");

    // Idempotent by spec: the user's intent is already satisfied, so deleting
    // it again is a success, not an error.
    client.send({
      jsonrpc: "2.0",
      id: 94,
      method: "session/delete",
      params: { sessionId: target.sessionId },
    });
    expect((await client.until(94)).at(-1)!.result).toEqual({});
  });

  it("reports a refusal as its own stop reason", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "refuse" }] },
    });
    expect((await client.until(3)).at(-1)!.result).toEqual({ stopReason: "refusal" });
  });

  it("resolves a cancelled turn with stopReason cancelled rather than an error", async () => {
    client = new AcpClient();
    const sessionId = await client.handshake();

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hang" }] },
    });
    // Let the prompt actually start; cancelling before it does is a different
    // path and would make this test pass for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });

    const frames = await client.until(3);
    expect(frames.at(-1)!.result).toEqual({ stopReason: "cancelled" });
    // A notification must never be answered — an id here is a protocol violation.
    expect(frames.some((frame) => frame.id === null && frame.error)).toBe(false);

    // Cancel ends ONE turn, not the session. This catches a stale aborted
    // signal: AgentSession swallows that abort, so without re-arming this next
    // request deceptively returns end_turn but streams no answer.
    client.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "after cancel" }] },
    });
    const resumed = await client.until(4);
    expect(resumed.at(-1)!.result).toEqual({ stopReason: "end_turn" });
    expect(
      updates(resumed).some(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          (update.content as { text?: string } | undefined)?.text === "after cancel",
      ),
    ).toBe(true);
  });

  it("rejects unknown methods and prompts sent before a session exists", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.until(1);

    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "hi" }] },
    });
    expect((await client.until(2)).at(-1)!.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("session/new"),
    });

    // Unimplemented methods must be refused, not silently accepted, so a client
    // can fall back instead of hanging.
    client.send({ jsonrpc: "2.0", id: 3, method: "session/fork", params: {} });
    expect((await client.until(3)).at(-1)!.error).toMatchObject({ code: -32601 });
  });

  it("answers malformed input with a parse error and keeps serving", async () => {
    client = new AcpClient();
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await client.until(1);

    client.sendRaw("{ not json\n");
    client.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    const frames = await client.until(2);

    expect(frames.some((f) => f.id === null && f.error?.code === -32700)).toBe(true);
    expect(frames.at(-1)!.result!.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });

  it("disposes the session and exits cleanly when the client disconnects", async () => {
    client = new AcpClient();
    await client.handshake();
    client.end();

    expect(await client.exit).toBe(0);
    expect(client.stderr).toContain("disposed=true");
  });
  // Every test in this suite spawns a real agent child process and seeds its
  // session files, which costs seconds on a loaded CI runner. The headroom sits
  // on the suite rather than on whichever tests happened to time out last, so a
  // slow machine is never reported as a bug.
  //
  // Kept above the 20s harness budget in `until`/`untilUpdate` so a genuine hang
  // surfaces their diagnostic (pending frames + child stderr) instead of
  // vitest's bare "Test timed out".
}, 30_000);
