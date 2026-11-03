import { daemonJson, daemonReadBody } from "./http.js";
import { resolveToolSchema } from "@kleio/ai";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleBrainRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // ── The Brain, for voice Kleio (daemon-level: a call has no window) ──
  // GET: the block text chat's system prompt gets, and the tools' JSON
  // schemas. POST /brain/tool { name, args }: runs one of those tools; its
  // own failure (a limit, a bad id) comes back as { error } for the model.
  if (method === "GET" && url === "/brain") {
    daemonJson(res, 200, {
      prompt: `${daemon.memoryStore.renderForPrompt()}\n\n${daemon.jiwaStore.renderForPrompt()}`,
      tools: daemon.brainTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: resolveToolSchema(t),
      })),
    });
    return true;
  }

  if (method === "POST" && url === "/brain/tool") {
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let name: unknown;
      let args: unknown;
      try {
        ({ name, args } = JSON.parse(raw) as { name?: unknown; args?: unknown });
      } catch {
        daemonJson(res, 400, { error: "Invalid JSON" });
        return;
      }
      const tool = daemon.brainTools.find((t) => t.name === name);
      if (!tool) {
        daemonJson(res, 404, { error: "No such Brain tool" });
        return;
      }
      try {
        const out = await tool.execute(tool.parameters.parse(args ?? {}), {
          signal: AbortSignal.timeout(10_000),
          toolCallId: `voice-${Date.now()}`,
        });
        daemonJson(res, 200, {
          result: typeof out === "string" ? out : JSON.stringify(out),
        });
      } catch (error) {
        // A limit, a bad id, bad arguments: plain words the model can act on.
        daemonJson(res, 422, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return true;
  }

  return false;
}
