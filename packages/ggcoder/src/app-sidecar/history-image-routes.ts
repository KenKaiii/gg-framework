import type { AgentSession } from "../core/agent-session.js";
import { historyImageRef, appToolImages } from "../utils/image.js";
import { json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

/** The most image refs one `GET /history-images` asks for. */
const HISTORY_IMAGES_MAX = 8;

/** An image ref (historyImageRef): 64 lowercase hex characters. */
const HISTORY_IMAGE_REF = /^[0-9a-f]{64}$/;

/** Every tool image in `messages`, by ref. */
function historyImagesOf(
  messages: ReturnType<AgentSession["getMessages"]>,
): Map<string, { data: string; mediaType: string }> {
  const images = new Map<string, { data: string; mediaType: string }>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const result of msg.content) {
      if (typeof result.content === "string") continue;
      for (const block of result.content) {
        if (block.type === "image") images.set(historyImageRef(block.data), block);
      }
    }
  }
  return images;
}

export function handleHistoryImageRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // Some of this chat's tool images, as an app scrolls to them: the previews
  // of up to HISTORY_IMAGES_MAX refs from `GET /history?images=refs`. A ref
  // not in this chat is left out.
  if (method === "GET" && url.startsWith("/history-images?")) {
    const refs = (
      new URLSearchParams(url.slice("/history-images?".length)).get("refs") ?? ""
    ).split(",");
    if (refs.length > HISTORY_IMAGES_MAX || !refs.every((ref) => HISTORY_IMAGE_REF.test(ref))) {
      json(res, 400, { error: `refs: 1 to ${HISTORY_IMAGES_MAX} image refs` });
      return true;
    }
    void (async () => {
      if (refs.some((ref) => !ctx.historyImages.has(ref))) {
        ctx.historyImages = historyImagesOf(ctx.session.getMessages());
      }
      const images: Record<string, string> = {};
      for (const ref of refs) {
        const block = ctx.historyImages.get(ref);
        const [image] = block ? await appToolImages([block], undefined) : [];
        if (image) images[ref] = image.src;
      }
      json(res, 200, { images });
    })().catch((error: unknown) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  return false;
}
