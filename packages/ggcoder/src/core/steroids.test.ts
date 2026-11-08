import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  MAX_ASSET_BYTES,
  extractBinary,
  findSteroidsBinary,
  installSteroids,
  parseStats,
  releaseTarget,
  verifySha256,
} from "./steroids.js";

/** Build a ustar entry; `declaredSize` lets a header lie about its payload. */
function tarEntry(name: string, body: Buffer, declaredSize = body.length): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(declaredSize.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write("        ", 148); // checksum field counts as spaces
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function tgz(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const BIN = process.platform === "win32" ? "steroids.exe" : "steroids";
const payload = Buffer.from("#!/bin/sh\necho steroids 9.9.9\n");

describe("parseStats", () => {
  it("reads the counts and the total size on disk", () => {
    const stats = [
      "  location     : /Users/me/.steroids",
      "  repositories : 514",
      "  documents    : 604849",
      "  source code  : 4.4GB raw",
      "  blobs.bin    : 1.4GB compressed",
      "  corpus.db    : 680.8MB (metadata + trigram index)",
      "  TOTAL ON DISK: 2.0GB",
      "  per repo     : 4.0MB",
    ].join("\n");
    expect(parseStats(stats)).toEqual({ repos: 514, documents: 604849, diskSize: "2.0GB" });
  });

  it("leaves the size out when stats has no total line", () => {
    expect(parseStats("  repositories : 0\n  documents    : 0\n")).toEqual({
      repos: 0,
      documents: 0,
    });
  });
});

describe("extractBinary", () => {
  it("extracts the single steroids entry", () => {
    expect(extractBinary(tgz(tarEntry(BIN, payload))).equals(payload)).toBe(true);
    // Nested path is fine; only the basename matters.
    expect(extractBinary(tgz(tarEntry(`dist/${BIN}`, payload))).equals(payload)).toBe(true);
  });

  it("rejects an archive with more than one entry", () => {
    const extra = tarEntry("README.md", Buffer.from("hi"));
    expect(() => extractBinary(tgz(tarEntry(BIN, payload), extra))).toThrow(/unexpected entry/);
    expect(() => extractBinary(tgz(tarEntry(BIN, payload), tarEntry(BIN, payload)))).toThrow(
      /more than one/,
    );
  });

  it("rejects an entry whose declared size exceeds the cap", () => {
    const lying = tarEntry(BIN, payload, MAX_ASSET_BYTES + 1);
    expect(() => extractBinary(tgz(lying))).toThrow(/larger than/);
  });

  it("rejects an archive with no binary", () => {
    expect(() => extractBinary(tgz())).toThrow(/no steroids binary/);
  });
});

describe("verifySha256", () => {
  const good = createHash("sha256").update(payload).digest("hex");
  const sums = `${good}  steroids-x.tar.gz\n${"0".repeat(64)}  other.tar.gz\n`;

  it("accepts a matching sum in either case", () => {
    expect(() => verifySha256(payload, sums, "steroids-x.tar.gz")).not.toThrow();
    expect(() =>
      verifySha256(
        payload,
        sums.toUpperCase().replace(/STEROIDS-X.TAR.GZ/, "steroids-x.tar.gz"),
        "steroids-x.tar.gz",
      ),
    ).not.toThrow();
  });

  it("rejects a mismatch or a missing entry", () => {
    expect(() => verifySha256(Buffer.from("tampered"), sums, "steroids-x.tar.gz")).toThrow(
      /checksum/,
    );
    expect(() => verifySha256(payload, sums, "missing.tar.gz")).toThrow(/no entry/);
    expect(() => verifySha256(payload, "", "steroids-x.tar.gz")).toThrow(/no entry/);
  });
});

describe("releaseTarget", () => {
  it("maps supported platforms and fails closed otherwise", () => {
    expect(releaseTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(releaseTarget("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(releaseTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(releaseTarget("win32", "arm64")).toBeNull();
    expect(releaseTarget("freebsd", "x64")).toBeNull();
  });
});

describe("findSteroidsBinary", () => {
  it("returns null when nothing is on PATH or in the install dir", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steroids-empty-"));
    expect(findSteroidsBinary({ pathEnv: "", installDir: empty })).toBeNull();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("finds the install-dir copy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steroids-bin-"));
    fs.writeFileSync(path.join(dir, BIN), payload);
    expect(findSteroidsBinary({ pathEnv: "", installDir: dir })).toBe(path.join(dir, BIN));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("installSteroids", () => {
  const target = "aarch64-apple-darwin";
  const asset = `steroids-${target}.tar.gz`;
  const prefix = "https://github.com/KenKaiii/agent-steroids/releases/download/v9.9.9/";

  function fakeFetch(archive: Buffer, sums: string): typeof fetch {
    const bodies: Record<string, Buffer | string> = {
      "https://api.github.com/repos/KenKaiii/agent-steroids/releases/latest": JSON.stringify({
        assets: [
          { name: asset, browser_download_url: prefix + asset },
          { name: "SHA256SUMS", browser_download_url: prefix + "SHA256SUMS" },
        ],
      }),
      [prefix + asset]: archive,
      [prefix + "SHA256SUMS"]: sums,
    };
    return (async (url: string | URL | Request) => {
      const body = bodies[String(url)];
      if (body === undefined) return new Response(null, { status: 404 });
      return new Response(typeof body === "string" ? body : new Uint8Array(body));
    }) as typeof fetch;
  }

  const archive = tgz(tarEntry(BIN, payload));
  const goodSum = createHash("sha256").update(archive).digest("hex");
  const probe = async (bin: string) => ({
    installed: true,
    connected: false,
    version: "9.9.9",
    repos: 0,
    documents: 0,
    path: bin,
  });

  it("writes nothing when the checksum does not match", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steroids-install-"));
    await expect(
      installSteroids({
        fetchFn: fakeFetch(archive, `${"0".repeat(64)}  ${asset}\n`),
        installDir: dir,
        platform: "darwin",
        arch: "arm64",
        probe,
      }),
    ).rejects.toThrow(/checksum/);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installs the binary when the checksum matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steroids-install-"));
    const status = await installSteroids({
      fetchFn: fakeFetch(archive, `${goodSum}  ${asset}\n`),
      installDir: dir,
      platform: "darwin",
      arch: "arm64",
      probe,
    });
    expect(status.installed).toBe(true);
    expect(status.path).toBe(path.join(dir, BIN));
    expect(fs.readFileSync(path.join(dir, BIN)).equals(payload)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([BIN]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses unsupported platforms with the cargo fallback", async () => {
    await expect(
      installSteroids({ fetchFn: fakeFetch(archive, ""), platform: "freebsd", arch: "x64" }),
    ).rejects.toThrow(/cargo install/);
  });
});
