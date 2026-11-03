import type http from "node:http";
import {
  type BrainEditResult,
  BRAIN_EDIT_BODY_MAX,
  editMemory,
  brainIdFromPath,
  editJiwa,
} from "../chat-agents/brain-edit.js";
import { readCappedBody } from "../utils/http-body.js";
import { json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * Add or edit a Brain entry from the Brain window: read a small body (an
 * oversized one gets a 413 here), save it with `save`, and answer with its
 * status. The store's onChange then tells every window, as after a delete.
 */
function saveBrainEntry<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  save: (raw: string) => Promise<BrainEditResult<T>>,
): void {
  void readCappedBody(req, res, BRAIN_EDIT_BODY_MAX)
    .then(async (raw) => {
      if (raw === null) return;
      const result = await save(raw);
      json(res, result.status, result.body);
    })
    .catch((error: unknown) => {
      if (res.headersSent) return;
      const reason = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: `Couldn't save to Brain: ${reason}` });
    });
}

export function handleBrainEditRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // Add and edit from the Brain window, through the same store methods,
  // limits and lock as the remember tool (chat-agents/brain-edit.ts).
  if (method === "POST" && url === "/memories") {
    saveBrainEntry(req, res, (raw) => editMemory(ctx.memoryStore, null, raw));
    return true;
  }

  if (method === "PATCH" && url.startsWith("/memories/")) {
    const id = brainIdFromPath(url, "/memories/");
    if (id === null) {
      json(res, 400, { error: "That isn't a valid memory id." });
      return true;
    }
    saveBrainEntry(req, res, (raw) => editMemory(ctx.memoryStore, id, raw));
    return true;
  }

  // Add and edit a Jiwa instruction, as set_jiwa does.
  if (method === "POST" && url === "/jiwa") {
    saveBrainEntry(req, res, (raw) => editJiwa(ctx.jiwaStore, null, raw));
    return true;
  }

  if (method === "PATCH" && url.startsWith("/jiwa/")) {
    const id = brainIdFromPath(url, "/jiwa/");
    if (id === null) {
      json(res, 400, { error: "That isn't a valid Jiwa instruction id." });
      return true;
    }
    saveBrainEntry(req, res, (raw) => editJiwa(ctx.jiwaStore, id, raw));
    return true;
  }

  return false;
}
