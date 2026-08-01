import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACP_PROTOCOL_VERSION } from "./acp-mode.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "acp-stdio-agent.mjs",
);

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
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", FIXTURE, tmpProject, tmpOtherProject],
      {
        // Run from the package root so `tsx` resolves; the project directory is
        // passed explicitly rather than inherited from the test runner.
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          GG_DISABLE_TELEMETRY: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;

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

/**
 * Conversation updates only.
 *
 * The command list is announced on its own schedule after a session opens, so
 * an exact-match transcript assertion would otherwise pass or fail on timing.
 */
function transcript(frames: Frame[]): Record<string, unknown>[] {
  return updates(frames).filter((update) => update.sessionUpdate !== "available_commands_update");
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
      sessionCapabilities: { list: {}, resume: {} },
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
        frame.params!.update!.sessionUpdate !== "available_commands_update",
    );

    // History must arrive BEFORE the response: a client draws a resumed session
    // with its live-turn renderer, so anything after the reply lands nowhere.
    expect(replay.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.id).toBe(91);
    for (const frame of replay) expect(frame.params!.sessionId).toBe(newest!.sessionId);

    expect(transcript(frames)).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "newer: add the config panel" },
      },
      {
        sessionUpdate: "agent_message_chunk",
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
        content: { type: "text", text: "Added the config panel." },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "after first compaction" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First follow-up complete." },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "after second compaction" },
      },
      {
        sessionUpdate: "agent_message_chunk",
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
            frame.params!.update!.sessionUpdate !== "available_commands_update",
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
        content: {
          type: "text",
          text: "[Previous conversation summary]\n\nolder fallback summary",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
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
    expect(model.currentValue).toBe("claude-opus-5");
    expect(model.options.length).toBeGreaterThan(1);
    expect(model.options.some((option) => option.value === "claude-opus-5")).toBe(true);
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
        value: "claude-haiku-4-5-20251001",
      },
    });
    const afterModel = (await client.until(4)).at(-1)!.result!.configOptions as ConfigOption[];
    expect(afterModel.find((option) => option.id === "model")!.currentValue).toBe(
      "claude-haiku-4-5-20251001",
    );
    // Haiku's ceiling is `high`, so the ladder must shrink with the model rather
    // than keep offering a level it would silently ignore.
    const haikuLevels = afterModel.find((option) => option.id === "thinking")!.options;
    expect(haikuLevels.some((option) => option.value === "max")).toBe(false);
    expect(haikuLevels.at(-1)).toMatchObject({ value: "high" });
    // The level set before the switch is still legal here, so it must survive.
    expect(afterModel.find((option) => option.id === "thinking")!.currentValue).toBe("high");
  }, 20_000);

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
        value: "claude-haiku-4-5-20251001",
      },
    });
    const options = (await client.until(4)).at(-1)!.result!.configOptions as ConfigOption[];
    // Reporting `max` here would be a control that lies: Haiku has no such tier,
    // so the session's real effort is `high` and the client must be told that.
    expect(options.find((option) => option.id === "thinking")!.currentValue).toBe("high");
  }, 20_000);

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
      path.join(commandsDir, "commit.md"),
      "---\nname: commit\ndescription: Check, review, commit and push\n---\n\nRun the checks.\n",
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
    expect(byName.get("bullet-proof")).toMatchObject({
      description: "Audit exploitable weaknesses",
      input: { hint: expect.any(String) },
    });
    // A project file, carried with its own frontmatter description.
    expect(byName.get("commit")!.description).toBe("Check, review, commit and push");
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
    // Aliases are not separate commands.
    expect(byName.has("bp")).toBe(false);
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
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read(/tmp/example.ts)",
        name: "read",
        kind: "read",
        status: "in_progress",
        rawInput: { file_path: "/tmp/example.ts" },
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
  }, 20_000);

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
  }, 20_000);

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
});
