import type http from "node:http";
import { log } from "../core/logger.js";
import { readBody, json } from "./http.js";
import { loadShellTrusted, saveShellTrusted } from "./app-settings.js";
import { formatShellContext, parseShellRunBody, type ShellRunEnd } from "./shell-runs.js";
import { recordShellCommand, shellSuggestions } from "./shell-suggestions.js";
import type { SessionRouteContext } from "./route-context.js";

/** Saved with the session so a reopened window shows the same row. */
export function shellMarkerData(run: ShellRunEnd): Record<string, unknown> {
  return {
    runId: run.runId,
    command: run.command,
    cwd: run.cwd,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    cancelled: run.cancelled,
    output: run.displayTail,
    truncated: run.tailTruncated || run.displayTruncated,
    ...(run.error ? { error: run.error } : {}),
  };
}

/** A finished user command: hand it to the agent's next message, save it, tell the window. */
export function finishShellRun(ctx: SessionRouteContext, run: ShellRunEnd): void {
  ctx.session.addUserShellContext(run.runId, formatShellContext(run));
  void ctx.session.persistAppMarker("shell", shellMarkerData(run)).catch((err: unknown) => {
    log("WARN", "app-sidecar", "shell marker not saved", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  ctx.broadcast("shell_end", {
    id: run.runId,
    exitCode: run.exitCode,
    signal: run.signal,
    durationMs: run.durationMs,
    cancelled: run.cancelled,
    displayTruncated: run.displayTruncated,
    // Only needed when the window stopped receiving output partway.
    ...(run.displayTruncated ? { tail: run.displayTail } : {}),
    ...(run.error ? { error: run.error } : {}),
  });
}

/**
 * `!cmd` from the app's input. A command runs only when the user confirmed
 * this one, or has said this project may run their commands without asking.
 */
export function handleShellRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/shell/suggestions") {
    void shellSuggestions(ctx.cwd).then(
      (suggestions) => json(res, 200, { suggestions }),
      () => json(res, 200, { suggestions: [] }),
    );
    return true;
  }

  if (method === "GET" && url === "/shell/trust") {
    void loadShellTrusted(ctx.cwd).then(
      (trusted) => json(res, 200, { trusted }),
      () => json(res, 200, { trusted: false }),
    );
    return true;
  }

  if (method === "POST" && url === "/shell/trust") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let trusted: unknown;
      try {
        trusted = (JSON.parse(raw) as { trusted?: unknown }).trusted;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (typeof trusted !== "boolean") {
        json(res, 400, { error: "trusted must be true or false" });
        return;
      }
      try {
        await saveShellTrusted(ctx.cwd, trusted);
        json(res, 200, { trusted });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/shell/run") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      if (ctx.mode !== "code") {
        json(res, 403, { error: "commands run only in code mode" });
        return;
      }
      const parsed = parseShellRunBody(raw);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return;
      }
      if (!parsed.confirmed && !(await loadShellTrusted(ctx.cwd).catch(() => false))) {
        json(res, 403, { error: "confirmation_required" });
        return;
      }
      const started = ctx.shell.start(parsed.runId, parsed.command, ctx.cwd);
      if (!started.ok) {
        json(res, 409, { error: started.error });
        return;
      }
      log("INFO", "app-sidecar", "user shell command started", { id: parsed.runId });
      void recordShellCommand(ctx.cwd, parsed.command).catch((err: unknown) => {
        log("WARN", "app-sidecar", "shell history not saved", {
          message: err instanceof Error ? err.message : String(err),
        });
      });
      json(res, 202, { started: true, cwd: ctx.cwd });
    });
    return true;
  }

  if (method === "POST" && url === "/shell/cancel") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let id: unknown;
      try {
        id = (JSON.parse(raw) as { id?: unknown }).id;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (typeof id !== "string") {
        json(res, 400, { error: "id is required" });
        return;
      }
      json(res, 200, { cancelled: ctx.shell.cancel(id) });
    });
    return true;
  }

  return false;
}
