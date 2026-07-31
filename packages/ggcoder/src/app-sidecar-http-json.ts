import type http from "node:http";

export type AppSidecarJsonBodyErrorKind = "malformed" | "too-large" | "aborted";

export class AppSidecarJsonBodyError extends Error {
  constructor(readonly kind: AppSidecarJsonBodyErrorKind) {
    super(`JSON request body ${kind}`);
    this.name = "AppSidecarJsonBodyError";
  }
}

export function requestPathname(requestUrl: string): string {
  try {
    return new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return requestUrl;
  }
}

export function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

export async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  if (exceedsDeclaredContentLength(req.headers["content-length"], maxBytes)) {
    drainRequest(req);
    throw new AppSidecarJsonBodyError("too-large");
  }

  const chunks = await readRequestChunks(req, maxBytes);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppSidecarJsonBodyError("malformed");
  }
}

function exceedsDeclaredContentLength(value: string | undefined, maxBytes: number): boolean {
  return typeof value === "string" && /^\d+$/.test(value)
    ? BigInt(value) > BigInt(maxBytes)
    : false;
}

function readRequestChunks(req: http.IncomingMessage, maxBytes: number): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const rejectOnce = (error: Error, drain = false): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      if (drain) drainRequest(req);
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += buffer.byteLength;
      if (byteCount > maxBytes) {
        rejectOnce(new AppSidecarJsonBodyError("too-large"), true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunks);
    };
    const onError = (error: Error): void => rejectOnce(error);
    const onAborted = (): void => rejectOnce(new AppSidecarJsonBodyError("aborted"), true);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function drainRequest(req: http.IncomingMessage): void {
  if (req.readableEnded || req.closed) return;

  const ignoreDrainError = (): void => {};
  const cleanup = (): void => {
    req.off("error", ignoreDrainError);
    req.off("end", cleanup);
    req.off("close", cleanup);
  };

  req.on("error", ignoreDrainError);
  req.once("end", cleanup);
  req.once("close", cleanup);
  if (!req.destroyed) req.resume();
}
