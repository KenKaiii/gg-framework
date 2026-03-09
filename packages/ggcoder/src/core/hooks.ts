import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { log } from "./logger.js";

// ── Types ────────────────────────────────────────────────────

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "Notification";

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number; // seconds, default 10
}

interface HookMatcherEntry {
  matcher?: string; // regex pattern for tool name, empty/missing = match all
  hooks: HookCommand[];
}

type HooksConfig = Partial<Record<HookEventName, HookMatcherEntry[]>>;

interface HookPayload {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
}

interface PreToolUseResult {
  permissionDecision?: "allow" | "deny";
  reason?: string;
}

// ── HookRunner ───────────────────────────────────────────────

export class HookRunner {
  private config: HooksConfig = {};
  private cwd: string;
  private sessionId: string;

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
  }

  async loadConfig(settingsPath: string): Promise<void> {
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.hooks && typeof parsed.hooks === "object") {
        this.config = parsed.hooks as HooksConfig;
      }
      log("INFO", "hooks", "Loaded hooks config", {
        events: String(Object.keys(this.config).length),
      });
    } catch {
      // Settings file missing or malformed — use empty config
      this.config = {};
    }
  }

  async runHooks(
    eventName: HookEventName,
    extra?: {
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      tool_output?: string;
    },
  ): Promise<PreToolUseResult | void> {
    const entries = this.config[eventName];
    if (!entries || entries.length === 0) return;

    const payload: HookPayload = {
      hook_event_name: eventName,
      session_id: this.sessionId,
      cwd: this.cwd,
      ...(extra?.tool_name != null && { tool_name: extra.tool_name }),
      ...(extra?.tool_input != null && { tool_input: extra.tool_input }),
      ...(extra?.tool_output != null && { tool_output: extra.tool_output }),
    };

    const blocking = eventName === "PreToolUse";
    let mergedResult: PreToolUseResult | undefined;

    for (const entry of entries) {
      if (!this.matchesPattern(entry.matcher, extra?.tool_name)) {
        continue;
      }

      for (const hook of entry.hooks) {
        if (hook.type !== "command") continue;

        const timeout = (hook.timeout ?? 10) * 1000;

        try {
          const output = await this.executeCommand(hook.command, payload, timeout, blocking);

          if (blocking && output) {
            try {
              const parsed = JSON.parse(output) as Record<string, unknown>;
              if (parsed.permissionDecision === "allow" || parsed.permissionDecision === "deny") {
                mergedResult = {
                  permissionDecision: parsed.permissionDecision as "allow" | "deny",
                  reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
                };
                // If any hook denies, short-circuit
                if (mergedResult.permissionDecision === "deny") {
                  return mergedResult;
                }
              }
            } catch {
              log("WARN", "hooks", `Failed to parse hook output as JSON`, {
                command: hook.command,
              });
            }
          }
        } catch {
          // Error already logged in executeCommand
        }
      }
    }

    return mergedResult;
  }

  /**
   * Run hooks synchronously — used for SessionEnd to ensure hooks complete
   * before the process exits.
   */
  runHooksSync(eventName: HookEventName): void {
    const entries = this.config[eventName];
    if (!entries || entries.length === 0) return;

    const payload = JSON.stringify({
      hook_event_name: eventName,
      session_id: this.sessionId,
      cwd: this.cwd,
    });

    for (const entry of entries) {
      if (!this.matchesPattern(entry.matcher, undefined)) continue;
      for (const hook of entry.hooks) {
        if (hook.type !== "command") continue;
        try {
          spawnSync(hook.command, [], {
            shell: true,
            cwd: this.cwd,
            input: payload,
            timeout: (hook.timeout ?? 10) * 1000,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Best-effort on exit
        }
      }
    }
  }

  private matchesPattern(pattern: string | undefined, toolName: string | undefined): boolean {
    if (!pattern || pattern.length === 0) return true;
    if (!toolName) return true; // Lifecycle events (Stop, SessionStart, etc.) match all entries
    try {
      const regex = new RegExp(pattern);
      return regex.test(toolName);
    } catch {
      log("WARN", "hooks", `Invalid regex pattern: ${pattern}`);
      return false;
    }
  }

  private executeCommand(
    command: string,
    payload: HookPayload,
    timeout: number,
    blocking: boolean,
  ): Promise<string | void> {
    return new Promise((resolve) => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => {
          ac.abort();
          log("WARN", "hooks", `Hook command timed out after ${timeout}ms`, { command });
        }, timeout);

        const child = spawn(command, [], {
          shell: true,
          cwd: this.cwd,
          signal: ac.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const payloadStr = JSON.stringify(payload);

        if (child.stdin) {
          child.stdin.write(payloadStr);
          child.stdin.end();
        }

        if (blocking) {
          const stdoutChunks: Buffer[] = [];

          child.stdout?.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
          });

          child.stderr?.on("data", (chunk: Buffer) => {
            log("WARN", "hooks", `Hook stderr: ${chunk.toString().trim()}`, { command });
          });

          child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
              log("WARN", "hooks", `Hook command exited with code ${String(code)}`, { command });
            }
            const output = Buffer.concat(stdoutChunks).toString("utf-8").trim();
            resolve(output || undefined);
          });

          child.on("error", (err) => {
            clearTimeout(timer);
            log("ERROR", "hooks", `Hook command failed: ${err.message}`, { command });
            resolve(undefined);
          });
        } else {
          // Fire-and-forget
          child.on("error", (err) => {
            clearTimeout(timer);
            log("ERROR", "hooks", `Hook command failed: ${err.message}`, { command });
          });

          child.on("close", () => {
            clearTimeout(timer);
          });

          resolve(undefined);
        }
      } catch (err) {
        log(
          "ERROR",
          "hooks",
          `Failed to spawn hook command: ${err instanceof Error ? err.message : String(err)}`,
          {
            command,
          },
        );
        resolve(undefined);
      }
    });
  }
}

// ── wrapToolsWithHooks ───────────────────────────────────────

export function wrapToolsWithHooks(tools: AgentTool[], hookRunner: HookRunner): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (args: unknown, context: ToolContext) => {
      const argsObj = (args != null && typeof args === "object" ? args : {}) as Record<
        string,
        unknown
      >;

      // 1. Run PreToolUse hook
      const preResult = await hookRunner.runHooks("PreToolUse", {
        tool_name: tool.name,
        tool_input: argsObj,
      });

      // 2. If denied, return error message without calling original execute
      if (preResult?.permissionDecision === "deny") {
        return `Tool use denied by hook: ${preResult.reason ?? "no reason given"}`;
      }

      // 3. Call original execute
      const result = await tool.execute(args, context);

      // 4. Run PostToolUse hook (fire-and-forget)
      hookRunner
        .runHooks("PostToolUse", {
          tool_name: tool.name,
          tool_input: argsObj,
          tool_output: typeof result === "string" ? result : JSON.stringify(result),
        })
        .catch(() => {});

      // 5. Return original result
      return result;
    },
  }));
}
