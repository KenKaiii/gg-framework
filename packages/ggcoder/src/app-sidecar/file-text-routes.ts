import { fileTextExtension, FILE_TEXT_MAX_BODY_BYTES, fileText } from "../tools/file-text.js";
import { readCappedBodyBuffer } from "../utils/http-body.js";
import { log } from "../core/logger.js";
import { daemonJson } from "./http.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleFileTextRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // A file's readable text for Kleio's voice (through kleio-host): body = the
  // file's raw bytes, ?name= only picks the parser. A pure transform: no
  // path is ever opened. Never log the name or any text.
  if (method === "POST" && (url === "/file-text" || url.startsWith("/file-text?"))) {
    const started = Date.now();
    const name = new URL(url, `http://${daemon.host}`).searchParams.get("name");
    const ext = fileTextExtension(name);
    void readCappedBodyBuffer(req, res, FILE_TEXT_MAX_BODY_BYTES, { error: "too_large" }).then(
      async (bytes) => {
        if (bytes === null) {
          log("INFO", "app-sidecar", "file text", {
            ext: ext ?? "-",
            outcome: "too_large",
            ms: String(Date.now() - started),
          });
          return;
        }
        const out = await fileText(name, bytes);
        const fields = {
          ext: ext ?? "-",
          bytes: String(bytes.length),
          chars: String(out.ok ? out.text.length : 0),
          pages: String(out.ok ? (out.pages ?? "-") : "-"),
          outcome: out.ok ? "ok" : out.error,
          ms: String(Date.now() - started),
        };
        if (out.ok) {
          log("INFO", "app-sidecar", "file text", fields);
          daemonJson(res, 200, {
            text: out.text,
            ...(out.pages !== undefined ? { pages: out.pages } : {}),
          });
        } else {
          log(out.error === "unreadable" ? "ERROR" : "INFO", "app-sidecar", "file text", fields);
          const status = out.error === "unsupported" ? 415 : out.error === "unreadable" ? 422 : 400;
          daemonJson(res, status, { error: out.error });
        }
      },
    );
    return true;
  }

  return false;
}
