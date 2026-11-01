import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { getAppPaths } from "../config.js";

// ── Settings Schema ────────────────────────────────────────

const SettingsSchema = z.object({
  autoCompact: z.boolean().default(true),
  compactThreshold: z.number().min(0.1).max(1.0).default(0.85),
  /** Absolute auto-compaction trigger in tokens. The trigger is
   *  min(compactThreshold × window, compactAtTokens). Unset = 400,000
   *  (DEFAULT_COMPACT_AT_TOKENS: keeps time-to-first-token down on 1M-window
   *  models); set higher to compact later. */
  compactAtTokens: z.number().int().min(20_000).optional(),
  /** Bash binary for the shell tool. `auto` = first bash on PATH (current
   *  behaviour); `system` = /bin/bash on macOS (faster spawn), same as auto
   *  elsewhere; anything else = an explicit path. */
  bashPath: z.string().min(1).default("auto"),
  defaultProvider: z
    .enum([
      "anthropic",
      "openai",
      "gemini",
      "glm",
      "moonshot",
      "minimax",
      "xiaomi",
      "deepseek",
      "openrouter",
      "huggingface",
      "sakana",
      "xai",
    ])
    .default("anthropic"),
  defaultModel: z.string().optional(),
  maxTokens: z.number().int().min(256).default(16384),
  thinkingEnabled: z.boolean().default(false),
  thinkingLevel: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  theme: z
    .enum([
      "auto",
      "dark",
      "light",
      "dark-ansi",
      "light-ansi",
      "dark-daltonized",
      "light-daltonized",
    ])
    .default("auto"),
  showTokenUsage: z.boolean().default(true),
  /** Legacy name: switches loop-break and re-grounding nudges (Ideal review
   *  itself was removed). Kept so existing settings files keep their meaning. */
  idealReviewEnabled: z.boolean().default(true),
  /** Append LSP diagnostics to edit/write tool results. */
  lspDiagnostics: z.boolean().default(true),
  /** Allow write/edit outside the workspace (cwd, tmpdir, ~/.gg). Off by
   *  default — outside writes return a guard error asking for user approval. */
  allowOutsideWorkspaceWrites: z.boolean().default(false),
  /** Network egress policy. "allowlist" enforces `networkAllow` on the agent's
   *  own web-fetch/web-search calls and blocks recognised network commands in
   *  bash. NOT an OS sandbox — a determined process can still reach the network
   *  (see core/network-guard.ts). Default "off" changes nothing. */
  networkMode: z.enum(["off", "allowlist"]).default("off"),
  /** Hosts allowed when networkMode is "allowlist". A leading `*.` wildcard
   *  matches subdomains (`*.github.com`). */
  networkAllow: z.array(z.string()).default([]),
  /**
   * OS-enforced command isolation for bash (filesystem + network), via
   * sandbox-runtime. `auto` isolates wherever the platform supports it and
   * degrades with a warning where it does not; `workspace` additionally fails
   * closed on hosts that cannot isolate.
   *
   * Opt-in, and deliberately so. Verified day-one breakage in the upstream
   * sandbox that we cannot fix from here:
   *   • Linux: pipes and redirections fail under seccomp — `echo hi | grep hi`
   *     returns "Permission denied" on /proc/self/fd/3 (upstream #261).
   *   • macOS: git over SSH fails the SOCKS handshake, because the ProxyCommand
   *     uses `nc`, which cannot do SOCKS5 auth (upstream sandbox-utils.ts).
   *   • `git config --global` is refused: ~/.gitconfig is a mandatory upstream
   *     write protection with no opt-out.
   *   • Corporate TLS interception and private registries need extra config.
   * Enabling it by default would break `git push` and piped commands for a
   * large share of users immediately after an update, with no obvious cause.
   */
  sandboxMode: z.enum(["auto", "workspace", "off"]).default("off"),
  /**
   * Unix sockets sandboxed commands may open (macOS; on Linux/WSL2 the seccomp
   * filter blocks AF_UNIX by syscall and cannot match paths). Empty by default:
   * `/var/run/docker.sock` is unauthenticated root-equivalent control of the
   * host, and the SSH agent socket signs whatever it is asked to. Set this only
   * to run `docker` (or similar) from sandboxed bash, and only knowing that the
   * socket is a full bypass of the isolation around it.
   */
  sandboxAllowUnixSockets: z.array(z.string()).default([]),
  /** Defer MCP tool schemas out of the prompt until discovered via tool_search.
   *  Cuts ~8k tokens/cache-miss turn with two MCP servers connected. */
  deferredMcpTools: z.boolean().default(true),
  /** Defer rarely reached BUILT-IN tool schemas the same way, leaving a one-line
   *  capability hint in the prompt that `tool_search` expands on demand. Trades
   *  per-request tokens against how reliably the model still finds the tool. */
  deferredBuiltinTools: z.boolean().default(true),
  /** Use the `rg` binary for `grep` content search when it is on PATH, falling
   *  back to the in-process scanner otherwise. */
  grepUseRipgrep: z.boolean().default(true),
  /** Opt into the 2026-07-28 MCP protocol revision. When on, a connect probes
   *  with `server/discover` and falls back to the 2025 `initialize` handshake,
   *  so a legacy server still connects. Off by default: the probe costs a round
   *  trip, and a legacy stdio server that ignores it pays the probe timeout. */
  mcpModernProtocol: z.boolean().default(false),
  /** Connect MCP servers declared in the OPENED REPO's `.gg/mcp.json`. That
   *  file is repo-controlled: a malicious repo can declare a stdio `command`
   *  that executes the moment the project opens. Off by default — enable only
   *  for repos you trust (global ~/.gg/mcp.json is always connected). */
  trustProjectMcpServers: z.boolean().default(false),
  /** Repo paths the user has individually trusted for project-scope MCP (the
   *  per-repo complement to the global `trustProjectMcpServers`). Stored as
   *  resolved absolute paths so symlink/relative mismatches can't flip the
   *  decision. */
  trustedProjects: z.array(z.string()).default([]),
  /** Max concurrent subagents per resolved child model. Unset = only the
   *  global limit applies. Can only REDUCE concurrency, never raise it. */
  subagentMaxPerModel: z.number().int().min(1).max(4).optional(),
  /** Per-input byte budgets for prompt-injected content (skills, MCP tool
   *  descriptions/schemas, project instructions, total prompt ceiling).
   *  Unset keys fall back to the built-in defaults (core/context-limits.ts). */
  contextLimits: z
    .object({
      skillDescriptionBytes: z.number().int().min(64).optional(),
      skillCatalogBytes: z.number().int().min(1024).optional(),
      mcpToolDescriptionBytes: z.number().int().min(64).optional(),
      mcpToolSchemaBytes: z.number().int().min(1024).optional(),
      projectContextBytes: z.number().int().min(1024).optional(),
      systemPromptCeilingBytes: z
        .number()
        .int()
        .min(16 * 1024)
        .optional(),
    })
    .optional(),
  enabledTools: z.array(z.string()).optional(),
  /** Delete session transcripts older than this many days at startup. 0 disables pruning. */
  sessionRetentionDays: z.number().int().min(0).default(30),
  /** Speed optimization profile.
   *  - "baseline": 5-min cache TTL, no pre-warm
   *  - "optimized": 1-h cache TTL, cache pre-warming on first prompt (default) */
  speedProfile: z.enum(["baseline", "optimized"]).default("optimized"),
  /** Hold an OS idle-sleep assertion while the desktop app's agent works
   *  (runs, autopilot, Ken, background sub-agents). The display may still sleep. */
  keepAwake: z.boolean().default(true),
  /** Pre-warm the Anthropic prompt cache (max_tokens: 1, identical prefix) when the
   *  desktop app signals the user is about to type after opening a chat / idling. */
  cachePrewarm: z.boolean().default(true),
  /** Codex (ChatGPT login) Responses-Lite request shape for gpt-5.6/gpt-6 models.
   *  Lite allows one tool call per response. `auto` turns it off (measured
   *  faster on gpt-6-astra, gpt-6.1-sol and gpt-6-luna); `on` restores it. */
  codexResponsesLite: z.enum(["auto", "on", "off"]).default("auto"),
  /** OpenAI strict tool schemas. Strict calls spell out every optional
   *  argument as null, costing output tokens and latency per call. `auto`
   *  turns it off (measured faster on all three gpt-6 models); `on` restores it. */
  codexStrictTools: z.enum(["auto", "on", "off"]).default("auto"),
  /** Release-age cooldown (days) for every package install the agent runs:
   *  versions younger than this are skipped. 0 disables. */
  packageCooldownDays: z.number().min(0).max(365).default(2),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  autoCompact: true,
  compactThreshold: 0.85,
  bashPath: "auto",
  defaultProvider: "anthropic",
  maxTokens: 16384,
  thinkingEnabled: false,
  theme: "auto",
  showTokenUsage: true,
  idealReviewEnabled: true,
  lspDiagnostics: true,
  allowOutsideWorkspaceWrites: false,
  networkMode: "off",
  networkAllow: [],
  sandboxMode: "off",
  sandboxAllowUnixSockets: [],
  deferredMcpTools: true,
  deferredBuiltinTools: true,
  grepUseRipgrep: true,
  mcpModernProtocol: false,
  trustProjectMcpServers: false,
  trustedProjects: [],
  sessionRetentionDays: 30,
  speedProfile: "optimized",
  keepAwake: true,
  cachePrewarm: true,
  codexResponsesLite: "auto",
  codexStrictTools: "auto",
  packageCooldownDays: 2,
};

// ── Settings Manager ───────────────────────────────────────

export class SettingsManager {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getAppPaths().settingsFile;
  }

  async load(): Promise<Settings> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const raw = JSON.parse(content);
      // Merge with defaults so new fields get default values
      this.settings = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...raw });
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.loaded = true;
    return this.settings;
  }

  async save(): Promise<void> {
    const content = JSON.stringify(this.settings, null, 2);
    await fs.writeFile(this.filePath, content, "utf-8");
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key];
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    this.settings[key] = value;
    await this.save();
  }

  getAll(): Settings {
    return { ...this.settings };
  }

  /** Whether the project at `cwd` is trusted for project-scope MCP. True when
   *  EITHER the global `trustProjectMcpServers` toggle is on OR the resolved
   *  cwd appears in `trustedProjects`. */
  isProjectTrusted(cwd: string): boolean {
    if (this.settings.trustProjectMcpServers) return true;
    const resolved = path.resolve(cwd);
    return this.settings.trustedProjects.includes(resolved);
  }

  /** Persist `cwd` as a trusted project (resolved absolute path, deduped) and
   *  save settings immediately. */
  async trustProject(cwd: string): Promise<void> {
    const resolved = path.resolve(cwd);
    if (!this.settings.trustedProjects.includes(resolved)) {
      this.settings.trustedProjects = [...this.settings.trustedProjects, resolved];
      await this.save();
    }
  }
}
