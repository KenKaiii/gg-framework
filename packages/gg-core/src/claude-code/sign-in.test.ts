import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../auth-storage.js";
import { signInWithClaudeCode, signOutOfClaudeCode } from "./sign-in.js";

// Fake claude binary whose login state lives in a file under CLAUDE_CONFIG_DIR.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const path = require("node:path");
const state = path.join(process.env.CLAUDE_CONFIG_DIR, "fake-session");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("auth status")) {
  const loggedIn = fs.existsSync(state);
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }));
  process.exit(loggedIn ? 0 : 1);
}
if (args.startsWith("auth logout")) {
  if (process.env.FAKE_LOGOUT_FAIL === "1") { process.stderr.write("boom\\n"); process.exit(1); }
  fs.rmSync(state, { force: true });
  process.exit(0);
}
if (args.startsWith("auth login")) {
  process.stdout.write("visit: https://claude.com/cai/oauth/authorize?state=s1\\n");
  process.stdin.on("data", () => { fs.writeFileSync(state, "1"); process.exit(0); });
}
`;

let home: string;
let auth: AuthStorage;
let run: { home: string; binary: string; binaryArgs: string[]; browserWaitMs: number };
const saved = process.env.FAKE_LOGOUT_FAIL;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gg-cc-signin-"));
  const script = path.join(home, "fake-claude.cjs");
  fs.writeFileSync(script, FAKE_CLAUDE);
  auth = new AuthStorage(path.join(home, "auth.json"));
  run = { home, binary: process.execPath, binaryArgs: [script], browserWaitMs: 20 };
});
afterEach(() => {
  if (saved === undefined) delete process.env.FAKE_LOGOUT_FAIL;
  else process.env.FAKE_LOGOUT_FAIL = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

function callbacks(log: string[]) {
  return {
    onOpenUrl: (url: string) => log.push(`url ${url}`),
    onPromptCode: async () => "code#s1",
    onStatus: (msg: string) => log.push(`status ${msg}`),
  };
}

describe("signInWithClaudeCode", () => {
  it("runs the browser sign-in and stores only the marker", async () => {
    const events: string[] = [];
    const status = await signInWithClaudeCode(auth, callbacks(events), run);
    expect(status.loggedIn).toBe(true);
    expect(events.some((e) => e.startsWith("url https://claude.com/"))).toBe(true);
    expect(await auth.hasClaudeCodeLogin()).toBe(true);
    expect(await auth.hasProviderAuth("anthropic")).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")) as object;
    expect(stored).toEqual({ "anthropic-claude-code": { via: "claude-code" } });
  });

  it("skips the browser when GG's Claude Code login is still signed in", async () => {
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.writeFileSync(path.join(home, "config", "fake-session"), "1");
    const events: string[] = [];
    await signInWithClaudeCode(auth, callbacks(events), run);
    expect(events.some((e) => e.startsWith("url "))).toBe(false);
    expect(await auth.hasClaudeCodeLogin()).toBe(true);
  });

  it("downloads Claude Code first when it is missing, reporting progress", async () => {
    const events: string[] = [];
    await expect(
      signInWithClaudeCode(auth, callbacks(events), {
        home,
        platformKey: "darwin-arm64",
        fetch: async () => new Response("nope", { status: 503 }),
      }),
    ).rejects.toThrow("HTTP 503");
    expect(events[0]).toBe("status Downloading Claude Code (one time)…");
    expect(await auth.hasClaudeCodeLogin()).toBe(false);
  });
});

describe("signOutOfClaudeCode", () => {
  it("logs Claude Code out and clears the marker", async () => {
    await signInWithClaudeCode(auth, callbacks([]), run);
    await signOutOfClaudeCode(auth, run);
    expect(await auth.hasClaudeCodeLogin()).toBe(false);
    expect(fs.existsSync(path.join(home, "config", "fake-session"))).toBe(false);
  });

  it("still clears the marker when claude auth logout fails", async () => {
    await signInWithClaudeCode(auth, callbacks([]), run);
    process.env.FAKE_LOGOUT_FAIL = "1";
    await signOutOfClaudeCode(auth, run);
    expect(await auth.hasClaudeCodeLogin()).toBe(false);
  });
});
