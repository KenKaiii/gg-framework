import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import { collectReferenceProjectFiles } from "./reference-project.js";
import { JsonRpcConnection, JsonRpcRequestError, type WireTracer } from "./jsonrpc.js";
import { getSafeToolEnv } from "../../tools/safe-env.js";
import { killProcessTree } from "../../utils/process.js";
import { log } from "../logger.js";
import type { LspServerSpec, ResolvedCommand } from "./servers.js";

/** LSP diagnostic shape (the subset we render). */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

/** Zero-based LSP text position. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** A resolved place in the workspace. */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** One symbol from `textDocument/documentSymbol`, flattened to a depth path. */
export interface LspSymbolEntry {
  name: string;
  kind: number;
  detail?: string;
  range: LspRange;
  /** Ancestor names, outermost first — `["ClassName"]` for a method. */
  containers: string[];
  /**
   * SymbolKind of each ancestor, parallel to `containers`. Lets a caller tell a
   * class member from a local variable buried in a function body — the two are
   * indistinguishable by name alone, and only one belongs in a file outline.
   * Empty when the server sent flat `SymbolInformation` (no hierarchy to read).
   */
  containerKinds: number[];
}

/**
 * Every navigation request answers with one of these. `unsupported` and
 * `timeout` are values rather than exceptions on purpose: a language server
 * that cannot answer must produce a statement the model can act on, not an
 * empty result that reads exactly like "this symbol has no references".
 */
export type LspRequestOutcome<T> =
  | { status: "ok"; value: T; warning?: string }
  | { status: "unsupported" }
  | { status: "timeout" }
  | { status: "failed"; message: string };

interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

interface DiagnosticWaiter {
  uri: string;
  resolve: (diagnostics: LspDiagnostic[] | null) => void;
}

interface ProgressParams {
  token: string | number;
  value?: { kind?: "begin" | "report" | "end" };
}

function progressTokenKey(token: string | number): string {
  return `${typeof token}:${String(token)}`;
}

const SERVER_CANCELLED = -32802;
const METHOD_NOT_FOUND = -32601;
/** Our own timeout code, raised by JsonRpcConnection when a request expires. */
const REQUEST_TIMED_OUT = -32803;
const PULL_POLL_INTERVAL_MS = 300;
/** Bounded stderr retained per server for failure diagnostics. */
const STDERR_TAIL_BYTES = 4000;
const ProjectInfoReply = z.object({
  success: z.literal(true),
  body: z.object({ configFileName: z.string(), languageServiceDisabled: z.boolean().optional() }),
});
const PARTIAL_REFERENCE_COVERAGE =
  "Reference coverage is partial: the configless project exceeded its indexing budget or could not be fully read. Use grep to check additional callers.";
const SHUTDOWN_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 1500;

/**
 * JSON-RPC wire tracer, enabled only by `GG_LSP_TRACE=1`.
 *
 * When a server accepts a document and then never publishes diagnostics, the
 * outcome (`timeout`) looks identical whether our `didOpen` never went out, the
 * server rejected it, or it answered about a URI we weren't watching. Only the
 * wire tells those apart. Opt-in because it is genuinely chatty, and params are
 * SUMMARIZED rather than dumped so a trace can never spill file contents into a
 * log.
 */
function wireTracer(serverId: string): WireTracer | undefined {
  if (process.env.GG_LSP_TRACE !== "1") return undefined;
  return (direction, message) => {
    const params = message.params as
      | {
          textDocument?: { uri?: string };
          uri?: string;
          diagnostics?: unknown[];
          message?: string;
        }
      | undefined;
    // `window/logMessage` / `window/showMessage` are the server's own
    // human-readable complaints ("cannot find tsserver", bad option, …) and are
    // frequently the only statement of what actually went wrong. Everything
    // else is summarized — never file contents.
    const isServerMessage =
      message.method === "window/logMessage" || message.method === "window/showMessage";
    log("DEBUG", "lsp", `${serverId} rpc ${direction}`, {
      method: message.method ?? `(response id=${String(message.id)})`,
      uri: params?.textDocument?.uri ?? params?.uri,
      // Counts only, never the diagnostics themselves.
      diagnostics: Array.isArray(params?.diagnostics) ? params.diagnostics.length : undefined,
      text: isServerMessage ? params?.message?.slice(0, 300) : undefined,
      error: message.error?.message,
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Normalize the several shapes LSP allows for a location reply: a bare
 * `Location`, an array of them, or `LocationLink[]` from a link-support server.
 */
function parseLocations(raw: unknown): LspLocation[] {
  if (raw === null || raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const locations: LspLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    // LocationLink prefers the selection range: it points at the name itself,
    // not the whole declaration body.
    const uri = (record.uri ?? record.targetUri) as string | undefined;
    const range = (record.range ?? record.targetSelectionRange ?? record.targetRange) as
      LspRange | undefined;
    if (typeof uri === "string" && range) locations.push({ uri, range });
  }
  return locations;
}

/**
 * Flatten either reply shape into one list. Hierarchical `DocumentSymbol`s
 * nest children; legacy `SymbolInformation`s are flat and carry a `location`
 * plus an optional `containerName`.
 */
function parseSymbols(raw: unknown): LspSymbolEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: LspSymbolEntry[] = [];
  const visit = (node: unknown, containers: string[], containerKinds: number[]): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string") return;
    const location = record.location as { range?: LspRange } | undefined;
    const range = (record.selectionRange ?? record.range ?? location?.range) as
      LspRange | undefined;
    if (!range) return;
    const containerName = record.containerName;
    const kind = typeof record.kind === "number" ? record.kind : 0;
    entries.push({
      name,
      kind,
      detail: typeof record.detail === "string" ? record.detail : undefined,
      range,
      containers:
        containers.length > 0
          ? containers
          : typeof containerName === "string" && containerName
            ? [containerName]
            : [],
      containerKinds,
    });
    const children = record.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child, [...containers, name], [...containerKinds, kind]);
    }
  };
  for (const node of raw) visit(node, [], []);
  return entries;
}

/** Collapse `Hover.contents` (string | MarkedString | MarkupContent | array). */
function parseHover(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const contents = (raw as Record<string, unknown>).contents;
  const render = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(render).filter(Boolean).join("\n");
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.value === "string") return record.value;
    }
    return "";
  };
  return render(contents).trim();
}

/**
 * Canonical cache key for a `file://` URI.
 *
 * Diagnostics live in a Map keyed by URI: we `set` what the server sends and
 * `get` what we built from the edited path, so the two must be the SAME STRING.
 * There is no single canonical spelling of a file URI, and on Windows we and
 * tsserver disagreed in two independent ways at once. Measured on CI:
 *
 *   we sent:      file:///c:/Users/RUNNER%7E1/…/main.ts
 *   server sent:  file:///c%3A/Users/RUNNER~1/…/main.ts
 *
 * `~` is an RFC 3986 unreserved character that `pathToFileURL` percent-encodes
 * and tsserver leaves literal; the drive colon is the reverse. Every lookup
 * missed, so the diagnostics arrived (the wire trace shows `diagnostics=1`)
 * and were then dropped on the floor — reported to the user as a clean file,
 * because LSP degrades silently by design. 8.3 short names like `RUNNER~1` are
 * not exotic: that IS the Windows temp path on GitHub runners, and `PROGRA~1`
 * and friends show up in real user paths.
 *
 * Fix: decode percent-escapes and lower-case the drive letter, so both
 * spellings collapse to one key. Used ONLY as a Map key — the URI actually put
 * on the wire is still the properly encoded one from `pathToFileURL`.
 *
 * Windows paths are also case-insensitive, but case is deliberately NOT folded:
 * both sides derive from the same path string, and folding would break the
 * genuinely case-sensitive POSIX servers that share this code.
 */
export function normalizeUri(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURI(uri);
    // decodeURI leaves %3A alone (`:` is reserved), so unescape it explicitly
    // rather than reaching for decodeURIComponent, which would also mangle any
    // literal `#`/`?` a filename is allowed to contain.
    decoded = decoded.replace(/%3A/gi, ":");
  } catch {
    // Malformed escape sequence — fall back to the raw URI rather than throwing
    // inside a notification handler.
  }
  return decoded.replace(
    /^(file:\/\/\/)([A-Za-z])(:)/,
    (_m, prefix: string, drive: string) => `${prefix}${drive.toLowerCase()}:`,
  );
}

/**
 * One language-server process bound to one project root. Owns document sync
 * (didOpen / didChange / didSave with per-uri version counters), the
 * push-diagnostics cache, and LSP 3.17 pull diagnostics with the
 * push-vs-pull race that the POC proved necessary for rust-analyzer.
 */
export class LspClient {
  private readonly proc: ChildProcess;
  private readonly conn: JsonRpcConnection;
  private readonly versions = new Map<string, number>();
  private readonly published = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticTails = new Map<string, Promise<void>>();
  private readonly uncertainDiagnostics = new Set<string>();
  private waiters: DiagnosticWaiter[] = [];
  private hasPullDiagnostics = false;
  /** Server capabilities from `initialize`; undefined until the handshake lands. */
  private serverCapabilities?: Record<string, unknown>;
  private readonly activeProgressTokens = new Set<string>();
  private sawProgress = false;
  private alive = true;

  private readonly initializationOptions: unknown;
  private stderrBuffer = "";
  private referenceProjectFiles: string | undefined;

  constructor(
    private readonly spec: LspServerSpec,
    private readonly rootPath: string,
    command: ResolvedCommand,
  ) {
    this.initializationOptions = command.initializationOptions ?? {};
    this.proc = spawn(command.command, command.args, {
      cwd: rootPath,
      // stderr was "ignore" — which made every server-side failure completely
      // unattributable. LSP degrades silently by design, so a server that boots
      // and then errors (a tsserver that can't start, a bad
      // initializationOptions path, an unsupported flag) produced exactly the
      // same empty output as a clean file, with nothing anywhere saying why.
      // Diagnosing the Windows timeout was blind for precisely this reason.
      // Pipe it and log it; the pipe MUST be drained either way, or a chatty
      // server eventually blocks on a full stderr buffer.
      stdio: ["pipe", "pipe", "pipe"],
      env: getSafeToolEnv(),
    });
    this.captureStderr();
    this.proc.on("error", () => this.markDead());
    this.proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        log("WARN", "lsp", `${spec.id} language server exited`, {
          code,
          signal,
          stderr: this.stderrTail(),
        });
      }
      this.markDead();
    });
    const { stdout, stdin } = this.proc;
    if (!stdout || !stdin) {
      // Cannot happen with "pipe" stdio, but guard instead of asserting.
      this.proc.kill("SIGKILL");
      throw new Error(`failed to open stdio pipes for ${spec.id} language server`);
    }
    this.conn = new JsonRpcConnection(stdout, stdin, wireTracer(spec.id));
    this.conn.onNotification("textDocument/publishDiagnostics", (params) => {
      const publish = params as PublishDiagnosticsParams;
      const uri = normalizeUri(publish.uri);
      if (publish.version !== undefined && publish.version !== this.versions.get(uri)) return;
      if (publish.version !== undefined) this.uncertainDiagnostics.delete(uri);
      this.published.set(uri, publish.diagnostics);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.uri !== uri) return true;
        waiter.resolve(publish.diagnostics);
        return false;
      });
    });
    this.conn.onNotification("$/progress", (params) => {
      const progress = params as ProgressParams;
      if (progress?.token === undefined) return;
      const key = progressTokenKey(progress.token);
      if (progress.value?.kind === "begin") {
        this.activeProgressTokens.add(key);
        this.sawProgress = true;
      } else if (progress.value?.kind === "end") this.activeProgressTokens.delete(key);
    });
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** True while the server reports indexing/analysis through LSP work progress. */
  get hasActiveProgress(): boolean {
    return this.activeProgressTokens.size > 0;
  }

  /**
   * True once the server has reported ANY work progress, even if it has since
   * ended. A server that loads a project this way can publish an empty
   * diagnostic set the instant loading finishes but before the open file has
   * actually been analysed, so an empty FIRST result from one is not yet
   * trustworthy. Servers that never report progress never pay for this.
   */
  get hasReportedProgress(): boolean {
    return this.sawProgress;
  }

  /**
   * Wait for the NEXT publishDiagnostics for `uri`, deliberately ignoring what
   * is already cached. Resolves null when none arrives inside `timeoutMs`,
   * which means "no correction came", not a failure.
   */
  awaitNextPublish(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    const key = normalizeUri(uri);
    if (!this.alive) return Promise.resolve(null);
    return new Promise<LspDiagnostic[] | null>((resolve) => {
      const waiter: DiagnosticWaiter = {
        uri: key,
        resolve: (diagnostics) => {
          clearTimeout(timer);
          resolve(diagnostics);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.waiters.push(waiter);
    });
  }

  /**
   * Drain the server's stderr into a bounded ring, and mirror it to the debug
   * log so a misbehaving server is diagnosable from `~/.gg/*.log` alone.
   * Bounded because a looping server can emit stderr without limit.
   */
  private captureStderr(): void {
    this.proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrBuffer = (this.stderrBuffer + text).slice(-STDERR_TAIL_BYTES);
      const trimmed = text.trim();
      if (trimmed) log("DEBUG", "lsp", `${this.spec.id} stderr`, { text: trimmed.slice(0, 500) });
    });
    // A read error must not take the process down; the server is still usable.
    this.proc.stderr?.on("error", () => {});
  }

  /** Most recent server stderr, for failure diagnostics. */
  stderrTail(): string {
    return this.stderrBuffer.trim().slice(-STDERR_TAIL_BYTES);
  }

  async initialize(timeoutMs: number): Promise<void> {
    // Wire value: keep it properly percent-encoded. `normalizeUri` is a cache
    // key helper, and a decoded root (`C:\Program Files\…` → a literal space)
    // is not a valid URI to hand a server at initialize.
    const rootUri = pathToFileURL(this.rootPath).href;
    const result = (await this.conn.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) || "Kleio Coder" }],
        initializationOptions: this.initializationOptions,
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { relatedInformation: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            // Navigation. `linkSupport` accepts LocationLink replies (which
            // carry a target selection range) and is normalized back to a plain
            // Location on our side.
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: true },
        },
      },
      timeoutMs,
    )) as { capabilities?: Record<string, unknown> } | null;
    this.hasPullDiagnostics = Boolean(result?.capabilities?.diagnosticProvider);
    this.serverCapabilities = result?.capabilities ?? {};
    this.conn.notify("initialized", {});
  }

  /**
   * Does the server advertise a capability? Unknown (no initialize result yet)
   * counts as advertised: some servers under-report and answer anyway, and a
   * real refusal still surfaces as `unsupported` from the request itself.
   */
  private advertises(capability: string): boolean {
    if (this.serverCapabilities === undefined) return true;
    return (
      this.serverCapabilities[capability] !== false &&
      this.serverCapabilities[capability] !== undefined
    );
  }

  /**
   * One navigation request, with LSP's three legible failure modes separated:
   * the server does not implement the method, it did not answer inside the
   * budget, or it errored. Silence is never reported as an empty result.
   */
  private async navigate<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    capability: string,
    parse: (raw: unknown) => T,
  ): Promise<LspRequestOutcome<T>> {
    if (!this.alive) return { status: "failed", message: "language server is not running" };
    if (!this.advertises(capability)) return { status: "unsupported" };
    try {
      const raw = await this.conn.request(method, params, timeoutMs);
      return { status: "ok", value: parse(raw) };
    } catch (error) {
      if (error instanceof JsonRpcRequestError) {
        if (error.code === METHOD_NOT_FOUND) return { status: "unsupported" };
        if (error.code === REQUEST_TIMED_OUT) return { status: "timeout" };
        return { status: "failed", message: error.message };
      }
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Where a symbol at `position` is defined. */
  definition(
    uri: string,
    position: LspPosition,
    timeoutMs: number,
  ): Promise<LspRequestOutcome<LspLocation[]>> {
    return this.navigate(
      "textDocument/definition",
      { textDocument: { uri }, position },
      timeoutMs,
      "definitionProvider",
      parseLocations,
    );
  }

  /** Every reference to the symbol at `position`, declaration included. */
  async references(
    uri: string,
    position: LspPosition,
    timeoutMs: number,
    includeDeclaration = true,
  ): Promise<LspRequestOutcome<LspLocation[]>> {
    const started = Date.now();
    const warning =
      this.spec.id === "typescript"
        ? await this.prepareReferenceProject(uri, timeoutMs)
        : undefined;
    const outcome = await this.navigate(
      "textDocument/references",
      { textDocument: { uri }, position, context: { includeDeclaration } },
      Math.max(1, timeoutMs - (Date.now() - started)),
      "referencesProvider",
      parseLocations,
    );
    return outcome.status === "ok" && warning ? { ...outcome, warning } : outcome;
  }

  /** Include unopened callers without creating configs or opening stale editor buffers. */
  private async prepareReferenceProject(
    uri: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const started = Date.now();
    const remaining = (): number => Math.max(1, timeoutMs - (Date.now() - started));
    const projectFileName = path.join(this.rootPath, ".gg-lsp-reference-project");
    try {
      const reply = await this.conn.request(
        "workspace/executeCommand",
        {
          command: "typescript.tsserverRequest",
          arguments: [
            "projectInfo",
            { file: fileURLToPath(uri), needFileNameList: false },
            { executionTarget: 0 },
          ],
        },
        remaining(),
      );
      const parsed = ProjectInfoReply.safeParse(reply);
      if (!parsed.success || parsed.data.body.languageServiceDisabled)
        return PARTIAL_REFERENCE_COVERAGE;
      const config = parsed.data.body.configFileName;
      if (
        !/[\\/]inferredProject\d+\*$/.test(config) &&
        path.normalize(config) !== path.normalize(projectFileName)
      )
        return undefined;
      const scan = await collectReferenceProjectFiles(
        this.rootPath,
        AbortSignal.timeout(Math.min(1000, remaining())),
      );
      const files = [...new Set([...scan.files, fileURLToPath(uri)])].sort();
      const signature = JSON.stringify(files);
      if (signature !== this.referenceProjectFiles) {
        const opened = await this.conn.request(
          "workspace/executeCommand",
          {
            command: "typescript.tsserverRequest",
            arguments: [
              "openExternalProject",
              {
                projectFileName,
                rootFiles: files.map((fileName) => ({ fileName })),
                options: { allowJs: true, checkJs: false, noEmit: true },
              },
              { executionTarget: 0 },
            ],
          },
          remaining(),
        );
        if (!z.object({ success: z.literal(true) }).safeParse(opened).success)
          return PARTIAL_REFERENCE_COVERAGE;
        this.referenceProjectFiles = signature;
        log("DEBUG", "lsp", "Prepared configless reference project", {
          server: this.spec.id,
          root: this.rootPath,
          files: files.length,
          complete: scan.complete,
          durationMs: Date.now() - started,
        });
      }
      return scan.complete ? undefined : PARTIAL_REFERENCE_COVERAGE;
    } catch {
      return PARTIAL_REFERENCE_COVERAGE;
    }
  }

  /** Flattened symbol outline for a whole document. */
  documentSymbols(uri: string, timeoutMs: number): Promise<LspRequestOutcome<LspSymbolEntry[]>> {
    return this.navigate(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      timeoutMs,
      "documentSymbolProvider",
      parseSymbols,
    );
  }

  /** Type/signature summary at `position`, as plain text. */
  hover(uri: string, position: LspPosition, timeoutMs: number): Promise<LspRequestOutcome<string>> {
    return this.navigate(
      "textDocument/hover",
      { textDocument: { uri }, position },
      timeoutMs,
      "hoverProvider",
      parseHover,
    );
  }

  /**
   * Sync `content` into the server's overlay for `filePath` — didOpen the
   * first time, didChange (full text) + didSave afterwards. Clears the
   * push-diagnostics cache for the uri so a subsequent collect waits for a
   * report computed against THIS content rather than a stale one.
   */
  syncDocument(filePath: string, content: string): string {
    // Two different strings on purpose: `uri` is the properly percent-encoded
    // form that goes ON THE WIRE (a literal space or `~` there would be an
    // invalid URI), while `key` is the decoded form used for our own bookkeeping
    // so it matches whatever spelling the server replies with.
    const uri = pathToFileURL(filePath).href;
    const key = normalizeUri(uri);
    this.published.delete(key);
    // A reply for a newer edit cannot satisfy an older edit's wait.
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.uri !== key) return true;
      waiter.resolve(null);
      return false;
    });
    const previousVersion = this.versions.get(key);
    if (previousVersion === undefined) {
      this.versions.set(key, 1);
      this.conn.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.spec.languageIdFor(extensionOf(filePath)),
          version: 1,
          text: content,
        },
      });
    } else {
      const version = previousVersion + 1;
      this.versions.set(key, version);
      this.conn.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
      this.conn.notify("textDocument/didSave", { textDocument: { uri }, text: content });
    }
    return uri;
  }

  /** Serialize document checks across sessions sharing this server, including unversioned publishers. */
  async withDocumentDiagnostics<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const key = normalizeUri(pathToFileURL(filePath).href);
    const previous = this.diagnosticTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => finished);
    this.diagnosticTails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.diagnosticTails.get(key) === tail) this.diagnosticTails.delete(key);
    }
  }

  documentVersion(uri: string): number | undefined {
    return this.versions.get(normalizeUri(uri));
  }

  /** After a timeout, an unversioned empty publish may belong to an earlier edit. */
  hasUncertainDiagnostics(uri: string): boolean {
    return this.uncertainDiagnostics.has(normalizeUri(uri));
  }

  /** Race push against supported pull requests, rejecting superseded document versions. */
  async collectDiagnostics(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    const version = this.documentVersion(uri);
    const cancelPush = new AbortController();
    const push = this.waitForPublish(uri, timeoutMs, cancelPush.signal);
    if (!this.hasPullDiagnostics) {
      const result = await push;
      if (result === null) this.uncertainDiagnostics.add(normalizeUri(uri));
      return this.documentVersion(uri) === version ? result : null;
    }

    let stopped = false;
    const pull = (async (): Promise<LspDiagnostic[] | null> => {
      const deadline = Date.now() + timeoutMs;
      while (!stopped && this.alive && Date.now() < deadline) {
        const items = await this.pullDiagnostics(uri, Math.max(1, deadline - Date.now()));
        if (items === "unsupported") return push;
        if (items !== "retry") {
          if (this.documentVersion(uri) === version)
            this.uncertainDiagnostics.delete(normalizeUri(uri));
          return items;
        }
        await sleep(PULL_POLL_INTERVAL_MS);
      }
      return push;
    })();

    try {
      const result = await Promise.race([push, pull]);
      if (result === null) this.uncertainDiagnostics.add(normalizeUri(uri));
      return this.documentVersion(uri) === version ? result : null;
    } finally {
      stopped = true;
      cancelPush.abort();
    }
  }

  /**
   * Graceful shutdown/exit handshake with SIGKILL fallback. Synchronous so it
   * is safe inside `process.on("exit")` handlers: the shutdown request and
   * exit notification are written immediately; the SIGKILL timer covers
   * servers that ignore them (and stdin EOF reaps them when we die first).
   */
  shutdown(): void {
    if (!this.alive) return;
    void this.conn.request("shutdown", null, SHUTDOWN_TIMEOUT_MS).catch(() => {});
    this.conn.notify("exit");
    const killTimer = setTimeout(() => {
      if (this.alive) this.terminate();
    }, KILL_GRACE_MS);
    killTimer.unref();
  }

  /**
   * Force-kill the server and everything it spawned, immediately.
   *
   * For a server that never completed the handshake, the polite
   * `shutdown`/`exit` sequence is pointless — it has already proven it isn't
   * answering — so skip straight to the kill.
   *
   * Uses `killProcessTree`, not `proc.kill()`: language servers spawn children
   * (typescript-language-server runs tsserver), Windows has no process groups,
   * and killing only the parent leaves those children alive holding file
   * handles in the project directory.
   */
  terminate(): void {
    this.conn.dispose();
    if (this.proc.pid !== undefined) killProcessTree(this.proc.pid);
    this.markDead();
  }

  private markDead(): void {
    this.alive = false;
    this.activeProgressTokens.clear();
    this.conn.dispose();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(null);
  }

  private waitForPublish(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LspDiagnostic[] | null> {
    // Both the cache and the waiter list are keyed by the normalized form, which
    // is what the publishDiagnostics handler stores under.
    const key = normalizeUri(uri);
    const cached = this.published.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!this.alive || signal?.aborted) return Promise.resolve(null);
    return new Promise<LspDiagnostic[] | null>((resolve) => {
      const waiter: DiagnosticWaiter = {
        uri: key,
        resolve: (diagnostics) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(diagnostics);
        },
      };
      const onAbort = () => waiter.resolve(null);
      const timer = setTimeout(onAbort, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private async pullDiagnostics(
    uri: string,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | "retry" | "unsupported"> {
    try {
      const report = (await this.conn.request(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        timeoutMs,
      )) as { kind?: string; items?: LspDiagnostic[] } | null;
      if (report?.kind === "full") return report.items ?? [];
      if (report?.kind === "unchanged")
        return this.published.get(normalizeUri(uri)) ?? "unsupported";
      return "unsupported";
    } catch (error) {
      if (error instanceof JsonRpcRequestError) {
        if (error.code === SERVER_CANCELLED) return "retry";
        if (error.code === METHOD_NOT_FOUND) return "unsupported";
      }
      return "unsupported";
    }
  }
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}
