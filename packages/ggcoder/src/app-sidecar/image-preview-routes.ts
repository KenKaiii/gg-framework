import { readCappedBodyBuffer } from "../utils/http-body.js";
import { screenPreview } from "../utils/image.js";
import { log } from "../core/logger.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

/** The largest image `POST /image-preview` takes: 64 MiB. */
const IMAGE_PREVIEW_MAX_BODY_BYTES = 64 * 1024 * 1024;

export function handleImagePreviewRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // An image the phone opens full size, made screen-sized (kleio-host's
  // voice show): a WebP of at most 2048 px, or 204 when the original is as
  // small already or can't be read, and goes as it is.
  if (method === "POST" && url === "/image-preview") {
    const started = Date.now();
    void readCappedBodyBuffer(req, res, IMAGE_PREVIEW_MAX_BODY_BYTES, {
      error: "too_large",
    }).then(async (bytes) => {
      if (bytes === null) return;
      const preview = await screenPreview(bytes);
      log("INFO", "app-sidecar", "image preview", {
        bytes: String(bytes.length),
        out: preview ? String(preview.length) : "-",
        ms: String(Date.now() - started),
      });
      if (!preview) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "image/webp",
        "content-length": String(preview.length),
      });
      res.end(preview);
    });
    return true;
  }

  return false;
}
