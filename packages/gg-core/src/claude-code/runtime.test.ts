import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MANIFEST,
  claudeCodeAuthStatus,
  claudeCodeCallbackUrl,
  claudeCodeEnv,
  claudeCodePlatformKey,
  ensureClaudeCodeBinary,
  formatClaudeCodeInstallProgress,
  loginClaudeCode,
  resolveClaudeCodeBinary,
  type ClaudeCodeInstallProgress,
  type ClaudeCodeManifest,
} from "./runtime.js";
import { extractFileFromTarGz } from "./tar.js";

function tarHeader(name: string, size: number, type = "0", prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000755\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function entry(name: string, data: Buffer, type = "0", prefix = ""): Buffer {
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, type, prefix), data, pad]);
}

function paxEntry(pathValue: string): Buffer {
  const body = ` path=${pathValue}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
  return entry("PaxHeader", Buffer.from(`${len}${body}`), "x");
}

function tgz(...entries: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function integrity(data: Buffer): string {
  return "sha512-" + crypto.createHash("sha512").update(data).digest("base64");
}

function manifestFor(data: Buffer, version = "9.9.9"): ClaudeCodeManifest {
  return {
    sdkVersion: "0.0.1",
    claudeCodeVersion: version,
    platforms: {
      "test-x64": {
        url: "https://example.test/claude.tgz",
        integrity: integrity(data),
        bin: "claude",
      },
    },
  };
}

function fetchServing(data: Buffer, calls: { n: number }) {
  return (async () => {
    calls.n++;
    return new Response(new Blob([new Uint8Array(data)]).stream(), {
      status: 200,
      headers: { "content-length": String(data.length) },
    });
  }) as unknown as typeof fetch;
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gg-claude-code-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("extractFileFromTarGz", () => {
  it("extracts only the named entry, across ustar prefixes and pax paths", async () => {
    const binary = crypto.randomBytes(70_000);
    const archive = tgz(
      entry("package/README.md", Buffer.from("readme")),
      paxEntry("package/claude"),
      entry("ignored-short-name", binary),
      entry("LICENSE.md", Buffer.from("license"), "0", "package"),
    );
    const src = path.join(home, "a.tgz");
    fs.writeFileSync(src, archive);

    expect(await extractFileFromTarGz(src, "package/claude", path.join(home, "out"))).toBe(true);
    expect(fs.readFileSync(path.join(home, "out")).equals(binary)).toBe(true);
    expect(await extractFileFromTarGz(src, "package/LICENSE.md", path.join(home, "lic"))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(home, "lic"), "utf8")).toBe("license");
    expect(await extractFileFromTarGz(src, "package/nope", path.join(home, "nope"))).toBe(false);
    expect(fs.existsSync(path.join(home, "nope"))).toBe(false);
  });
});

describe("claudeCodePlatformKey", () => {
  it("maps platforms, including musl Linux, and rejects unsupported ones", () => {
    expect(claudeCodePlatformKey({ platform: "darwin", arch: "arm64", musl: false })).toBe(
      "darwin-arm64",
    );
    expect(claudeCodePlatformKey({ platform: "win32", arch: "x64", musl: false })).toBe(
      "win32-x64",
    );
    expect(claudeCodePlatformKey({ platform: "linux", arch: "x64", musl: false })).toBe(
      "linux-x64",
    );
    expect(claudeCodePlatformKey({ platform: "linux", arch: "arm64", musl: true })).toBe(
      "linux-arm64-musl",
    );
    expect(claudeCodePlatformKey({ platform: "linux", arch: "ia32", musl: false })).toBeNull();
    expect(claudeCodePlatformKey({ platform: "freebsd", arch: "x64", musl: false })).toBeNull();
  });

  it("the pinned manifest covers every key the detector can return", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      for (const arch of ["arm64", "x64"]) {
        for (const musl of platform === "linux" ? [false, true] : [false]) {
          const key = claudeCodePlatformKey({ platform, arch, musl })!;
          expect(CLAUDE_CODE_MANIFEST.platforms[key]?.integrity).toMatch(/^sha512-/);
        }
      }
    }
  });
});

describe("ensureClaudeCodeBinary", () => {
  it("downloads once, verifies, installs an executable binary and reports progress", async () => {
    const binary = Buffer.from("#!/bin/sh\necho claude\n");
    const archive = tgz(entry("package/claude", binary));
    const manifest = manifestFor(archive);
    const calls = { n: 0 };
    const progress: ClaudeCodeInstallProgress[] = [];
    const opts = { home, manifest, platformKey: "test-x64", fetch: fetchServing(archive, calls) };

    expect(resolveClaudeCodeBinary(opts)).toBeNull();
    const [a, b] = await Promise.all([
      ensureClaudeCodeBinary({ ...opts, onProgress: (p) => progress.push(p) }),
      ensureClaudeCodeBinary(opts),
    ]);
    expect(a).toBe(path.join(home, "9.9.9", "claude"));
    expect(b).toBe(a);
    expect(calls.n).toBe(1);
    expect(fs.readFileSync(a).equals(binary)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(a).mode & 0o111).not.toBe(0);
    expect(resolveClaudeCodeBinary(opts)).toBe(a);
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(["download", "verify", "extract"]),
    );
    expect(progress.at(-1)?.phase).toBe("extract");

    // Installed: no second download.
    await ensureClaudeCodeBinary(opts);
    expect(calls.n).toBe(1);
    expect(fs.readdirSync(home).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("discards a download whose checksum doesn't match and leaves no partial files", async () => {
    const archive = tgz(entry("package/claude", Buffer.from("real")));
    const tampered = tgz(entry("package/claude", Buffer.from("evil")));
    const opts = {
      home,
      manifest: manifestFor(archive),
      platformKey: "test-x64",
      fetch: fetchServing(tampered, { n: 0 }),
    };
    await expect(ensureClaudeCodeBinary(opts)).rejects.toThrow(/checksum/);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(resolveClaudeCodeBinary(opts)).toBeNull();
  });

  it("fails cleanly on an HTTP error or an archive without the binary", async () => {
    const httpFail = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const archive = tgz(entry("package/claude", Buffer.from("x")));
    await expect(
      ensureClaudeCodeBinary({
        home,
        manifest: manifestFor(archive),
        platformKey: "test-x64",
        fetch: httpFail,
      }),
    ).rejects.toThrow(/HTTP 503/);

    const noBinary = tgz(entry("package/README.md", Buffer.from("x")));
    await expect(
      ensureClaudeCodeBinary({
        home,
        manifest: manifestFor(noBinary),
        platformKey: "test-x64",
        fetch: fetchServing(noBinary, { n: 0 }),
      }),
    ).rejects.toThrow(/no claude binary/);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("removes older versions once the new one is installed", async () => {
    fs.mkdirSync(path.join(home, "1.0.0"));
    fs.mkdirSync(path.join(home, "config"));
    const archive = tgz(entry("package/claude", Buffer.from("x")));
    await ensureClaudeCodeBinary({
      home,
      manifest: manifestFor(archive),
      platformKey: "test-x64",
      fetch: fetchServing(archive, { n: 0 }),
    });
    expect(fs.readdirSync(home).sort()).toEqual(["9.9.9", "config"]);
  });

  it("keeps newer versions another app pinned", async () => {
    fs.mkdirSync(path.join(home, "9.9.10"));
    fs.mkdirSync(path.join(home, "10.0.0"));
    fs.mkdirSync(path.join(home, "9.9.8"));
    const archive = tgz(entry("package/claude", Buffer.from("x")));
    await ensureClaudeCodeBinary({
      home,
      manifest: manifestFor(archive),
      platformKey: "test-x64",
      fetch: fetchServing(archive, { n: 0 }),
    });
    expect(fs.readdirSync(home).sort()).toEqual(["10.0.0", "9.9.10", "9.9.9"]);
  });

  it("refuses platforms the manifest has no build for", async () => {
    const archive = tgz(entry("package/claude", Buffer.from("x")));
    await expect(
      ensureClaudeCodeBinary({ home, manifest: manifestFor(archive), platformKey: "plan9-x64" }),
    ).rejects.toThrow(/API key/);
  });
});

describe("formatClaudeCodeInstallProgress", () => {
  it("describes each phase plainly", () => {
    expect(
      formatClaudeCodeInstallProgress({
        phase: "download",
        receivedBytes: 52_428_800,
        totalBytes: 104_857_600,
      }),
    ).toBe("Downloading Claude Code… 50% (50 of 100 MB)");
    expect(formatClaudeCodeInstallProgress({ phase: "download", receivedBytes: 3_145_728 })).toBe(
      "Downloading Claude Code… 3 MB",
    );
    expect(formatClaudeCodeInstallProgress({ phase: "verify" })).toMatch(/Checking/);
  });
});

describe("claudeCodeEnv", () => {
  it("uses GG's own config dir and drops credentials Claude Code would prefer", () => {
    const env = claudeCodeEnv(
      { home },
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-x",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        NODE_OPTIONS: "-r x",
      },
    );
    expect(env).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: path.join(home, "config"),
      DISABLE_AUTOUPDATER: "1",
    });
  });
});

describe("claudeCodeCallbackUrl", () => {
  const manual =
    "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1";
  it("swaps in the localhost callback port read from a path-mangled capture", () => {
    const captured =
      "/private/tmp/https:/claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A49473%2Fcallback&state=s1";
    const url = new URL(claudeCodeCallbackUrl(manual, captured)!);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:49473/callback");
    expect(url.searchParams.get("state")).toBe("s1");
  });
  it("returns null without a port", () => {
    expect(claudeCodeCallbackUrl(manual, "garbage")).toBeNull();
  });
});

// A stand-in for the claude binary, run through Node so it works on every OS.
const FAKE_CLAUDE = `
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("auth status")) {
  const loggedIn = process.env.CLAUDE_CONFIG_DIR.endsWith("config") && !process.env.ANTHROPIC_API_KEY;
  console.log(JSON.stringify({ loggedIn, authMethod: "claude.ai", email: "a@b.c" }));
  process.exit(loggedIn ? 0 : 1);
}
if (args.startsWith("auth login")) {
  const manual = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1";
  process.stdout.write("Opening browser to sign in\\nIf the browser didn't open, visit: " + manual + "\\nPaste code here if prompted > ");
  if (process.env.FAKE_OPEN === "1") {
    spawnSync(process.env.BROWSER, [manual.replace("https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback", "http%3A%2F%2Flocalhost%3A5123%2Fcallback")]);
    setTimeout(() => { console.log("Login successful."); process.exit(0); }, 400);
  } else {
    process.stdin.on("data", (d) => {
      if (String(d).trim() === "code#s1") { console.log("Login successful."); process.exit(0); }
      process.stderr.write("Login failed: bad code\\n"); process.exit(1);
    });
  }
}
`;

describe("loginClaudeCode / claudeCodeAuthStatus", () => {
  let script: string;
  let saved: string | undefined;
  beforeEach(() => {
    script = path.join(home, "fake-claude.cjs");
    fs.writeFileSync(script, FAKE_CLAUDE);
    saved = process.env.FAKE_OPEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FAKE_OPEN;
    else process.env.FAKE_OPEN = saved;
  });

  it("reads status JSON with GG's config dir and without inherited API keys", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const status = await claudeCodeAuthStatus({
        home,
        binary: process.execPath,
        binaryArgs: [script],
      });
      expect(status).toEqual({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c" });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("reports logged out when the binary isn't installed", async () => {
    expect(await claudeCodeAuthStatus({ home, platformKey: "darwin-arm64" })).toEqual({
      loggedIn: false,
    });
  });

  it("hands the localhost sign-in URL to onOpenUrl without asking for a code", async () => {
    process.env.FAKE_OPEN = "1";
    const urls: string[] = [];
    let prompted = false;
    await loginClaudeCode(
      {
        onOpenUrl: (u) => urls.push(u),
        onPromptCode: async () => {
          prompted = true;
          return "";
        },
        onStatus: () => {},
      },
      { home, binary: process.execPath, binaryArgs: [script], browserWaitMs: 5_000 },
    );
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get("redirect_uri")).toBe(
      "http://localhost:5123/callback",
    );
    expect(prompted).toBe(false);
    expect(fs.readdirSync(home).filter((n) => n.startsWith(".open-url"))).toEqual([]);
  });

  it("falls back to the paste-code page and forwards the pasted code", async () => {
    process.env.FAKE_OPEN = "0";
    const urls: string[] = [];
    await loginClaudeCode(
      { onOpenUrl: (u) => urls.push(u), onPromptCode: async () => " code#s1 ", onStatus: () => {} },
      { home, binary: process.execPath, binaryArgs: [script], browserWaitMs: 50 },
    );
    expect(new URL(urls[0]!).searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
  });

  it("surfaces Claude Code's failure message", async () => {
    process.env.FAKE_OPEN = "0";
    await expect(
      loginClaudeCode(
        { onOpenUrl: () => {}, onPromptCode: async () => "wrong", onStatus: () => {} },
        { home, binary: process.execPath, binaryArgs: [script], browserWaitMs: 50 },
      ),
    ).rejects.toThrow("Login failed: bad code");
  });
});
