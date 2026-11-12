import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGzip } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSessionReadStream } from "./session-storage.js";
import { missingSystemTools } from "../test-support/system-tools.js";

/**
 * Regression cover for a file-descriptor leak in archived session reads.
 *
 * `openSessionReadStream` returns `source.pipe(createGunzip())`. `.pipe()` does
 * not propagate destroy() upstream, so tearing down only the returned stream —
 * the intuitive cleanup, and what the session listing used to do — leaves the
 * source ReadStream's fd open with no reference able to close it.
 *
 * It leaked one fd per archived session per listing, and session listing walks
 * every session on the machine: a real install was found holding 814 stranded
 * descriptors across 211 archives. Nothing failed loudly, it just accrued until
 * the process hit its descriptor ceiling.
 *
 * The test asserts on real open descriptors rather than stream state, because
 * the bug is precisely that the stream object *looks* destroyed while its fd
 * is not.
 */
const noLsof =
  process.platform === "win32" || missingSystemTools("session-storage-fd-leak.test.ts", "lsof");

describe("openSessionReadStream fd hygiene", () => {
  let dir: string;
  let archivePath: string;

  const openFdCount = (): number => {
    // lsof is POSIX-only; these tests skip on Windows or where it is not installed.
    const out = execFileSync("lsof", ["-p", String(process.pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter((line) => line.includes(archivePath)).length;
  };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-session-fd-"));
    archivePath = path.join(dir, "leak-probe.jsonl.gz");

    await new Promise<void>((resolve, reject) => {
      const gzip = createGzip();
      const out = createWriteStream(archivePath);
      out.on("close", () => resolve());
      out.on("error", reject);
      gzip.on("error", reject);
      gzip.pipe(out);
      gzip.write(`${JSON.stringify({ type: "session", id: "probe" })}\n`);
      // Comfortably more than the reader consumes, so the early exit is real
      // and backpressure leaves the source mid-file rather than drained.
      for (let i = 0; i < 20_000; i++) {
        gzip.write(`${JSON.stringify({ type: "message", i, pad: "x".repeat(120) })}\n`);
      }
      gzip.end();
    });
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(noLsof)("leaves no descriptor behind when a partial read stops early", async () => {
    const before = openFdCount();

    for (let i = 0; i < 40; i++) {
      const { stream, close } = await openSessionReadStream(archivePath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        let lines = 0;
        for await (const _line of rl) {
          if (++lines > 5) break;
        }
      } finally {
        rl.close();
        close();
      }
    }

    // Destroy is synchronous to request but the 'close' event is not.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(openFdCount()).toBe(before);
  });

  it.skipIf(noLsof)("leaves no descriptor behind when the whole archive is read", async () => {
    const before = openFdCount();

    for (let i = 0; i < 10; i++) {
      const { stream, close } = await openSessionReadStream(archivePath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const _line of rl) {
          // Drain.
        }
      } finally {
        rl.close();
        close(); // Idempotent after a natural end-of-stream.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(openFdCount()).toBe(before);
  });

  it("yields the archive's decompressed contents", async () => {
    const { stream, close } = await openSessionReadStream(archivePath);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let header: unknown;
    try {
      for await (const line of rl) {
        header = JSON.parse(line);
        break;
      }
    } finally {
      rl.close();
      close();
    }
    expect(header).toEqual({ type: "session", id: "probe" });
  });
});
