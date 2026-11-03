import { readBody, json } from "./http.js";
import {
  decodePcm16,
  DICTATION_MAX_SECONDS,
  trimToSpeech,
  DICTATION_SAMPLE_RATE,
  DictationUnavailableError,
} from "@kleio/core";
import { log } from "../core/logger.js";
import { dictationUnavailableReply } from "../core/dictation-reply.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleTranscribeRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // Dictation (iPhone and Mac apps): `{ audio }` is base64 16 kHz mono 16-bit
  // PCM, answered with `{ text }` ("" when nothing was said). Like /enhance it
  // touches no session state, so it is allowed mid-run. The text is never
  // logged. When the speech model can't be got ready, 503 (502 when Hugging
  // Face erred) with plain words for the reason.
  if (method === "POST" && url === "/transcribe") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let audio: unknown;
      try {
        audio = (JSON.parse(raw) as { audio?: unknown }).audio;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (typeof audio !== "string") {
        json(res, 400, { error: "missing audio" });
        return;
      }
      const decoded = decodePcm16(audio);
      if (!decoded.ok) {
        if (decoded.error === "too_long") {
          json(res, 413, {
            error: `Recordings can be up to ${DICTATION_MAX_SECONDS / 60} minutes long.`,
          });
        } else {
          json(res, 400, { error: "The recording could not be read." });
        }
        return;
      }
      const speech = trimToSpeech(decoded.value);
      if (!speech) {
        json(res, 200, { text: "" });
        return;
      }
      // The phone gave up (timeout, app closed): skip a queued clip.
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) gone.abort();
      });
      const started = Date.now();
      try {
        const text = await ctx.dictation.transcribe(speech, gone.signal);
        log("INFO", "app-sidecar", "dictation transcribed", {
          audioSeconds: (speech.length / DICTATION_SAMPLE_RATE).toFixed(1),
          elapsedMs: String(Date.now() - started),
          chars: String(text.length),
        });
        json(res, 200, { text });
      } catch (err) {
        if (gone.signal.aborted) return;
        if (err instanceof DictationUnavailableError) {
          // Why is already in the log (gg-core's dictation lines); the
          // device gets plain words for the reason.
          log("WARN", "app-sidecar", "dictation unavailable", {
            reason: err.reason,
            elapsedMs: String(Date.now() - started),
          });
          const reply = dictationUnavailableReply(err.reason);
          json(res, reply.status, { error: reply.error });
          return;
        }
        log("ERROR", "app-sidecar", "dictation failed", {
          message: err instanceof Error ? err.message : String(err),
          elapsedMs: String(Date.now() - started),
        });
        json(res, 500, { error: "Couldn't transcribe that recording. Try again." });
      }
    });
    return true;
  }

  return false;
}
