import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveShell } from "./shell.js";
import { prepareSandboxLaunch, SANDBOX_ENV_PATCH, type SandboxPolicy } from "./sandbox.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { localOperations, type ToolOperations } from "../tools/operations.js";
import { killProcessTree } from "../utils/process.js";
import { log } from "./logger.js";

/**
 * A live Node.js debugging session driven over the V8 inspector protocol
 * (Chrome DevTools Protocol). The program runs under `node --inspect-brk`
 * bound to loopback on a random port; this class connects, sets breakpoints,
 * steps, and reads real runtime state — so the agent can see the value that
 * broke instead of guessing from source and print-and-rerun loops.
 *
 * Node only, no new dependency: Node 22+ ships both the inspector and a global
 * WebSocket. `.ts` files work when run by Node's own type stripping, which
 * keeps line numbers; loaders that transpile (tsx, ts-node) shift lines.
 */

export type PauseOnExceptions = "none" | "uncaught" | "all";

export interface DebugLaunchOptions {
  cwd: string;
  program: string;
  args?: readonly string[];
  nodeArgs?: readonly string[];
  pauseOnExceptions?: PauseOnExceptions;
  breakpoints?: ReadonlyArray<{ file: string; line: number; condition?: string }>;
  sandboxPolicy?: SandboxPolicy;
  ops?: ToolOperations;
  /** How long to wait for the inspector to come up. */
  startTimeoutMs?: number;
}

export type StopState =
  { kind: "paused" } | { kind: "exited"; code: number | null } | { kind: "running" };

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
}

interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: Array<{ name: string; type: string; value?: string; subtype?: string }>;
  entries?: Array<{ key?: ObjectPreview; value: ObjectPreview }>;
}

interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  url: string;
  scopeChain: Array<{ type: string; object: RemoteObject; name?: string }>;
  this: RemoteObject;
}

interface PausedState {
  reason: string;
  data?: RemoteObject;
  hitBreakpoints: string[];
  callFrames: CallFrame[];
}

interface Breakpoint {
  id: string;
  /** The URL-pattern breakpoint first, then one per script bound by exact URL. */
  cdpIds: string[];
  /** The pattern the first CDP breakpoint was set with. */
  urlRegex: string;
  /** The target file, comparable with `samePath`. */
  target: string;
  /** As the caller wrote it, for display. */
  file: string;
  line: number;
  condition?: string;
  boundLines: number[];
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_VALUE_CHARS = 200;
const MAX_PROPERTIES_PER_SCOPE = 40;
const COMMAND_TIMEOUT_MS = 10_000;
/** Scope types worth showing; `global` is thousands of builtins. */
const SHOWN_SCOPES = new Set(["local", "closure", "block", "catch", "module", "script", "with"]);
/** Inspector chatter Node writes to stderr; not the program's output. */
const INSPECTOR_NOISE_RE =
  /^(Debugger listening on .*|For help, see: .*|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)\r?\n?/gm;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Quote one argument for the shell `resolveShell` picked. */
function quoteArg(value: string, cmdFallback: boolean): string {
  if (cmdFallback)
    return /^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Symlink-resolved path; the input unchanged when it does not exist (yet). */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Every spelling Node may load `p` under. Node's module loader resolves
 * symlinks with the JS `fs.realpathSync`, which keeps Windows 8.3 short names
 * (`C:\Users\RUNNER~1`) that the native resolver expands — so the as-given,
 * JS-resolved and native-resolved forms can all differ.
 */
function pathForms(p: string): string[] {
  const forms = new Set([p, realPath(p)]);
  try {
    forms.add(fs.realpathSync(p));
  } catch {
    // does not exist (yet); the as-given form stands
  }
  return [...forms].sort();
}

/** Comparable form of a path: fully resolved, case-folded where the filesystem is. */
function comparablePath(p: string): string {
  const real = realPath(p);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Windows paths are case-insensitive; CDP's urlRegex takes no flags, so spell it out. */
function caseInsensitive(pattern: string): string {
  return pattern.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

function truncate(text: string, max = MAX_VALUE_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line rendering of a value the inspector returned. */
export function formatRemoteObject(object: RemoteObject): string {
  if (object.type === "undefined") return "undefined";
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === "string") return truncate(JSON.stringify(String(object.value ?? "")));
  if (object.subtype === "null") return "null";
  if (object.type === "number" || object.type === "boolean") return String(object.value);
  if (object.type === "bigint") return object.description ?? String(object.value);
  if (object.type === "function") return truncate(`ƒ ${object.description?.split("\n")[0] ?? ""}`);
  if (object.preview) return truncate(formatPreview(object.preview));
  return truncate(object.description ?? object.type);
}

function formatPreview(preview: ObjectPreview): string {
  const more = preview.overflow ? ", …" : "";
  if (preview.entries) {
    const entries = preview.entries.map((entry) =>
      entry.key
        ? `${formatPreview(entry.key)} => ${formatPreview(entry.value)}`
        : formatPreview(entry.value),
    );
    return `${preview.description ?? preview.type} {${entries.join(", ")}${more}}`;
  }
  if (preview.type !== "object") return preview.description ?? preview.type;
  const parts = preview.properties.map((p) => {
    const value = p.type === "string" ? JSON.stringify(p.value ?? "") : (p.value ?? p.type);
    return preview.subtype === "array" ? value : `${p.name}: ${value}`;
  });
  if (preview.subtype === "array")
    return `${preview.description ?? "Array"} [${parts.join(", ")}${more}]`;
  const prefix =
    preview.description && preview.description !== "Object" ? `${preview.description} ` : "";
  return `${prefix}{${parts.join(", ")}${more}}`;
}

/** File path for an inspector script URL, or undefined for node: internals and evals. */
export function urlToPath(url: string): string | undefined {
  if (url.startsWith("file://")) {
    try {
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(url) ? url : undefined;
}

export class NodeDebugSession {
  private readonly pending = new Map<number, Pending>();
  private readonly scripts = new Map<string, string>();
  private readonly breakpoints = new Map<string, Breakpoint>();
  private readonly stopWaiters = new Set<() => void>();
  /** In-flight exact-URL breakpoint bindings (see `bindToScript`). */
  private readonly binding = new Set<Promise<void>>();
  private nextMessageId = 1;
  private nextBreakpoint = 1;
  private paused: PausedState | undefined;
  private exitCode: number | null | undefined;
  private output = "";
  private outputDropped = false;
  private outputRead = 0;

  private constructor(
    /** The cwd as the program was launched in it. */
    private readonly launchCwd: string,
    /** `launchCwd` fully resolved, for displaying paths relative to it. */
    private readonly cwd: string,
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
  ) {}

  /** Start `node --inspect-brk <program>`, attach, set breakpoints, run to the first stop. */
  static async launch(options: DebugLaunchOptions): Promise<NodeDebugSession> {
    const ops = options.ops ?? localOperations;
    const program = path.resolve(options.cwd, options.program);
    // Probe for the shell form first: quoting depends on which shell runs it.
    const probe = resolveShell("node");
    const command = [
      "node",
      "--inspect-brk=127.0.0.1:0",
      ...(options.nodeArgs ?? []),
      program,
      ...(options.args ?? []),
    ]
      .map((arg, index) => (index === 0 ? arg : quoteArg(arg, probe.isCmdFallback)))
      .join(" ");
    const launch = await prepareSandboxLaunch(
      resolveShell(command),
      options.cwd,
      options.sandboxPolicy ?? { mode: "off", allowedDomains: [] },
    );
    const child = ops.spawn(launch.file, launch.args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.sandboxed ? { ...getSafeToolEnv(), ...SANDBOX_ENV_PATCH } : getSafeToolEnv(),
    });
    child.on("error", () => {}); // 'close' below owns failure handling

    let early = "";
    // Filled once connected; the stream and exit handlers below are wired
    // first so no output or exit is missed while the inspector comes up.
    const attached: { session?: NodeDebugSession } = {};
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`the inspector did not start within ${options.startTimeoutMs ?? 10_000}ms`),
        );
      }, options.startTimeoutMs ?? 10_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        if (attached.session) {
          attached.session.appendOutput(text);
          return;
        }
        early += text;
        const match = /Debugger listening on (ws:\/\/\S+)/.exec(early);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (attached.session) attached.session.markExited(code);
        else
          reject(
            new Error(`node exited (code ${code}) before the inspector started:\n${early.trim()}`),
          );
      });
    }).catch((error: unknown) => {
      if (child.pid && child.exitCode === null) killProcessTree(child.pid);
      throw error;
    });

    const socket = new WebSocket(wsUrl);
    const session = new NodeDebugSession(options.cwd, realPath(options.cwd), child, socket);
    attached.session = session;
    session.appendOutput(early);
    try {
      await session.connect();
      await session.initialize(options);
    } catch (error) {
      session.stop();
      throw error;
    }
    return session;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("could not connect to the Node inspector")),
        { once: true },
      );
      this.socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
      this.socket.addEventListener("close", () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("the debug connection closed"));
        }
        this.pending.clear();
        this.wakeStopWaiters();
      });
    });
  }

  private async initialize(options: DebugLaunchOptions): Promise<void> {
    await this.send("Runtime.enable");
    await this.send("Debugger.enable");
    // Stepping skips Node internals and dependencies; breakpoints set in them still hit.
    await this.send("Debugger.setBlackboxPatterns", { patterns: ["^node:", "/node_modules/"] });
    await this.send("Debugger.setPauseOnExceptions", {
      state: options.pauseOnExceptions ?? "uncaught",
    });
    for (const bp of options.breakpoints ?? []) {
      await this.setBreakpoint(bp.file, bp.line, bp.condition);
    }
    // --inspect-brk holds the program before its first line until this call;
    // it then pauses there ("Break on start"), after breakpoints are armed.
    await this.send("Runtime.runIfWaitingForDebugger");
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "Debugger.scriptParsed": {
        const url = String(params.url ?? "");
        this.scripts.set(String(params.scriptId), url);
        for (const bp of this.breakpoints.values()) this.bindToScript(bp, url);
        break;
      }
      case "Debugger.paused":
        this.paused = {
          reason: String(params.reason ?? "other"),
          ...(params.data ? { data: params.data as RemoteObject } : {}),
          hitBreakpoints: (params.hitBreakpoints as string[] | undefined) ?? [],
          callFrames: (params.callFrames as CallFrame[] | undefined) ?? [],
        };
        this.wakeStopWaiters();
        break;
      case "Debugger.resumed":
        this.paused = undefined;
        break;
      case "Debugger.breakpointResolved": {
        const cdpId = String(params.breakpointId);
        const location = params.location as { lineNumber: number } | undefined;
        for (const bp of this.breakpoints.values()) {
          if (
            bp.cdpIds.includes(cdpId) &&
            location &&
            !bp.boundLines.includes(location.lineNumber + 1)
          ) {
            bp.boundLines.push(location.lineNumber + 1);
          }
        }
        break;
      }
      case "Runtime.executionContextDestroyed":
        // The program finished; Node now waits for us to disconnect before exiting.
        if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
        break;
    }
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("the program is no longer running"));
    }
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no reply within ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private appendOutput(text: string): void {
    const clean = text.replace(INSPECTOR_NOISE_RE, "");
    if (!clean) return;
    this.output += clean;
    if (this.output.length > MAX_OUTPUT_BYTES) {
      const drop = this.output.length - MAX_OUTPUT_BYTES;
      this.output = this.output.slice(drop);
      this.outputRead = Math.max(0, this.outputRead - drop);
      this.outputDropped = true;
    }
  }

  private markExited(code: number | null): void {
    this.exitCode = code;
    this.paused = undefined;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    this.wakeStopWaiters();
  }

  private wakeStopWaiters(): void {
    for (const wake of this.stopWaiters) wake();
    this.stopWaiters.clear();
  }

  get isPaused(): boolean {
    return this.paused !== undefined;
  }

  get hasExited(): boolean {
    return this.exitCode !== undefined;
  }

  state(): StopState {
    if (this.exitCode !== undefined) return { kind: "exited", code: this.exitCode };
    return this.paused ? { kind: "paused" } : { kind: "running" };
  }

  /** Wait until the program pauses or exits, up to `timeoutMs`. */
  async waitForStop(timeoutMs: number, signal?: AbortSignal): Promise<StopState> {
    const deadline = Date.now() + timeoutMs;
    // Loop because the connection closes a moment before the process reports
    // its exit: that wake alone must not read as "still running".
    while (!this.paused && this.exitCode === undefined && !signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          this.stopWaiters.delete(done);
          resolve();
        };
        // After the socket closes nothing but the child's exit can wake us.
        const timer = setTimeout(
          done,
          this.socket.readyState === WebSocket.OPEN ? remaining : Math.min(remaining, 50),
        );
        signal?.addEventListener("abort", done, { once: true });
        this.stopWaiters.add(done);
      });
    }
    return this.state();
  }

  /** Resume (or step) and wait for the next stop. */
  async resume(
    how: "continue" | "step_over" | "step_into" | "step_out",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<StopState> {
    if (!this.paused) throw new Error("the program is not paused");
    const method = {
      continue: "Debugger.resume",
      step_over: "Debugger.stepOver",
      step_into: "Debugger.stepInto",
      step_out: "Debugger.stepOut",
    }[how];
    // Breakpoints being bound to just-loaded scripts must land before it runs on.
    await Promise.all(this.binding);
    this.paused = undefined;
    await this.send(method);
    return this.waitForStop(timeoutMs, signal);
  }

  async pause(timeoutMs: number, signal?: AbortSignal): Promise<StopState> {
    if (!this.paused) await this.send("Debugger.pause");
    return this.waitForStop(timeoutMs, signal);
  }

  async setBreakpoint(file: string, line: number, condition?: string): Promise<Breakpoint> {
    // Node reports scripts by real path; a symlinked project dir (macOS /var
    // → /private/var) would otherwise never match and never bind.
    // Resolve against the cwd the program was launched in, not its real path,
    // so the as-given spelling (Windows 8.3 short names) stays among the forms.
    const forms = pathForms(path.resolve(this.launchCwd, file));
    // Scripts load as file:// URLs (ESM, modern CJS) or bare paths (older CJS).
    const alternatives = forms
      .flatMap((abs) => [pathToFileURL(abs).href, abs])
      .map((form) => escapeRegex(form));
    const body = alternatives.join("|");
    const urlRegex = `^(?:${process.platform === "win32" ? caseInsensitive(body) : body})$`;
    const result = (await this.send("Debugger.setBreakpointByUrl", {
      lineNumber: line - 1,
      urlRegex,
      ...(condition ? { condition } : {}),
    })) as { breakpointId: string; locations: Array<{ lineNumber: number }> };
    const bp: Breakpoint = {
      id: `bp${this.nextBreakpoint++}`,
      cdpIds: [result.breakpointId],
      urlRegex,
      target: comparablePath(forms[0] ?? file),
      file,
      line,
      ...(condition ? { condition } : {}),
      boundLines: [...new Set(result.locations.map((l) => l.lineNumber + 1))],
    };
    this.breakpoints.set(bp.id, bp);
    for (const url of new Set(this.scripts.values())) this.bindToScript(bp, url);
    await Promise.all(this.binding);
    return bp;
  }

  /**
   * Also bind `bp` by the exact URL of a loaded script that is the target file
   * but that the URL pattern missed — Node can name a script in a spelling no
   * path form predicts (Windows short names, drive-letter case, URL encoding).
   * The file itself, resolved on disk, decides whether it is the same script.
   */
  private bindToScript(bp: Breakpoint, url: string): void {
    const file = urlToPath(url);
    if (!file || new RegExp(bp.urlRegex).test(url)) return;
    if (comparablePath(file) !== bp.target) return;
    const task = (async () => {
      try {
        const result = (await this.send("Debugger.setBreakpointByUrl", {
          lineNumber: bp.line - 1,
          url,
          ...(bp.condition ? { condition: bp.condition } : {}),
        })) as { breakpointId: string; locations: Array<{ lineNumber: number }> };
        // Removed while this was in flight: drop the binding it just made.
        if (!this.breakpoints.has(bp.id)) {
          await this.send("Debugger.removeBreakpoint", { breakpointId: result.breakpointId });
          return;
        }
        bp.cdpIds.push(result.breakpointId);
        for (const location of result.locations) {
          if (!bp.boundLines.includes(location.lineNumber + 1)) {
            bp.boundLines.push(location.lineNumber + 1);
          }
        }
      } catch (error) {
        // Already bound at that URL, or the session closed; the pattern stands.
        log("WARN", "debug", "could not bind breakpoint to script", {
          breakpoint: bp.id,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.binding.add(task);
    void task.finally(() => this.binding.delete(task));
  }

  async removeBreakpoint(id: string): Promise<boolean> {
    const bp = this.breakpoints.get(id);
    if (!bp) return false;
    this.breakpoints.delete(id);
    for (const breakpointId of bp.cdpIds) {
      await this.send("Debugger.removeBreakpoint", { breakpointId });
    }
    return true;
  }

  listBreakpoints(): Breakpoint[] {
    return [...this.breakpoints.values()];
  }

  private frame(index: number): CallFrame {
    if (!this.paused) throw new Error("the program is not paused");
    const frame = this.paused.callFrames[index];
    if (!frame) {
      throw new Error(`no frame ${index}; the stack has ${this.paused.callFrames.length} frames`);
    }
    return frame;
  }

  private frameLocation(frame: CallFrame): string {
    const url = frame.url || this.scripts.get(frame.location.scriptId) || "";
    const file = urlToPath(url);
    // Both sides through the same resolver: Node may report a script under a
    // spelling (symlink, Windows short name) that differs from the real cwd.
    const shown = file ? path.relative(this.cwd, realPath(file)) || file : url || "<anonymous>";
    return `${shown}:${frame.location.lineNumber + 1}:${(frame.location.columnNumber ?? 0) + 1}`;
  }

  /** `#0 parseUser (src/user.ts:12:5)` lines, innermost first. */
  stack(limit = 20): string {
    if (!this.paused) throw new Error("the program is not paused");
    const frames = this.paused.callFrames.slice(0, limit).map((frame, index) => {
      return `#${index} ${frame.functionName || "<anonymous>"} (${this.frameLocation(frame)})`;
    });
    const more = this.paused.callFrames.length - frames.length;
    return frames.join("\n") + (more > 0 ? `\n… ${more} more frames` : "");
  }

  /** Source lines around a frame's position, the current line marked. */
  sourceSnippet(index = 0, context = 3): string {
    const frame = this.frame(index);
    const file = urlToPath(frame.url || this.scripts.get(frame.location.scriptId) || "");
    if (!file) return "";
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    } catch {
      return "";
    }
    const current = frame.location.lineNumber;
    const start = Math.max(0, current - context);
    const end = Math.min(lines.length, current + context + 1);
    const width = String(end).length;
    return lines
      .slice(start, end)
      .map((text, offset) => {
        const lineNo = start + offset;
        const marker = lineNo === current ? ">" : " ";
        return `${marker} ${String(lineNo + 1).padStart(width)} | ${truncate(text, 160)}`;
      })
      .join("\n");
  }

  /** Visible variables of a frame, scope by scope, innermost first. */
  async variables(index = 0): Promise<string> {
    const frame = this.frame(index);
    const sections: string[] = [];
    for (const scope of frame.scopeChain) {
      if (!SHOWN_SCOPES.has(scope.type) || !scope.object.objectId) continue;
      const result = (await this.send("Runtime.getProperties", {
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      })) as { result: Array<{ name: string; value?: RemoteObject }> };
      const props = result.result.filter((p) => p.value);
      if (props.length === 0) continue;
      const shown = props.slice(0, MAX_PROPERTIES_PER_SCOPE).map((p) => {
        return `  ${p.name} = ${p.value ? formatRemoteObject(p.value) : "?"}`;
      });
      if (props.length > shown.length) shown.push(`  … ${props.length - shown.length} more`);
      const label = scope.name ? `${scope.type} (${scope.name})` : scope.type;
      sections.push(`${label}:\n${shown.join("\n")}`);
    }
    if (frame.this.type !== "undefined") {
      sections.push(`this = ${formatRemoteObject(frame.this)}`);
    }
    return sections.join("\n") || "(no local variables)";
  }

  /** Evaluate in a paused frame, or in the global context while running. */
  async evaluate(expression: string, index = 0): Promise<string> {
    const params = { expression, generatePreview: true, silent: true };
    const result = (
      this.paused
        ? await this.send("Debugger.evaluateOnCallFrame", {
            ...params,
            callFrameId: this.frame(index).callFrameId,
          })
        : await this.send("Runtime.evaluate", params)
    ) as { result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text: string } };
    if (result.exceptionDetails) {
      const thrown = result.exceptionDetails.exception;
      return `Threw: ${thrown ? (thrown.description ?? formatRemoteObject(thrown)) : result.exceptionDetails.text}`;
    }
    return formatRemoteObject(result.result);
  }

  /** Why and where the program is paused. */
  pauseSummary(): string {
    if (!this.paused) return "";
    const top = this.paused.callFrames[0];
    const where = top ? `${top.functionName || "<anonymous>"} (${this.frameLocation(top)})` : "?";
    const hit = [
      ...new Set(
        this.paused.hitBreakpoints
          .map(
            (cdpId) => [...this.breakpoints.values()].find((bp) => bp.cdpIds.includes(cdpId))?.id,
          )
          .filter((id): id is string => id !== undefined),
      ),
    ];
    let reason: string;
    switch (this.paused.reason) {
      case "Break on start":
        reason = "on the first line";
        break;
      case "exception":
      case "promiseRejection": {
        const thrown = this.paused.data;
        const what = thrown
          ? (thrown.description?.split("\n")[0] ?? formatRemoteObject(thrown))
          : "";
        reason = `on an exception${what ? `: ${truncate(what, 300)}` : ""}`;
        break;
      }
      default:
        reason = hit.length > 0 ? `at breakpoint ${hit.join(", ")}` : `(${this.paused.reason})`;
    }
    return `Paused ${reason} in ${where}`;
  }

  /** Program output since the last call. */
  readNewOutput(): string {
    const fresh = this.output.slice(this.outputRead);
    this.outputRead = this.output.length;
    const dropped = this.outputDropped ? "[earlier output dropped; last 1 MiB kept]\n" : "";
    this.outputDropped = false;
    return fresh ? dropped + fresh : "";
  }

  /** Kill the program and close the connection. Safe to call twice. */
  stop(): void {
    try {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    } catch {
      // Already closing.
    }
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      killProcessTree(this.child.pid);
    }
    log("INFO", "debugger", "Debug session stopped", { pid: String(this.child.pid ?? "") });
  }
}
