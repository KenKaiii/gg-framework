import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../auth-storage.js";
import {
  HERMES_PROXY_BASE_URL,
  HermesNotInstalledError,
  hermesProxyHealth,
  parseHermesDeviceCode,
  resolveHermesBinary,
} from "./runtime.js";
import { signInWithHermes } from "./sign-in.js";

// Fake hermes whose Nous Portal login lives in a file next to it, printing
// what the real `hermes auth add nous --type oauth --no-browser` prints.
const FAKE_HERMES = `
const fs = require("node:fs");
const state = process.env.FAKE_HERMES_STATE;
const args = process.argv.slice(2).join(" ");
if (args === "auth status nous") {
  console.log(fs.existsSync(state) ? "nous: logged in" : "nous: not logged in");
  process.exit(0);
}
if (args === "auth add nous --type oauth --no-browser") {
  if (process.env.FAKE_HERMES_LOGIN_FAIL === "1") {
    console.log("Login failed: Timed out waiting for device authorization.");
    process.exit(1);
  }
  console.log("To continue:");
  console.log("  1. Open: https://portal.nousresearch.com/manage-subscription?user_code=AB12-CD34");
  console.log("  2. If prompted, enter code: AB12-CD34");
  setTimeout(() => { fs.writeFileSync(state, "1"); console.log("Login successful!"); process.exit(0); }, 50);
}
`;

let dir: string;
let auth: AuthStorage;
let run: { binary: string; binaryArgs: string[]; env: NodeJS.ProcessEnv };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-hermes-signin-"));
  const script = path.join(dir, "fake-hermes.cjs");
  fs.writeFileSync(script, FAKE_HERMES);
  auth = new AuthStorage(path.join(dir, "auth.json"));
  run = {
    binary: process.execPath,
    binaryArgs: [script],
    env: { ...process.env, FAKE_HERMES_STATE: path.join(dir, "session") },
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function callbacks(log: string[]) {
  return {
    onOpenUrl: (url: string) => log.push(`url ${url}`),
    onPromptCode: async () => "",
    onStatus: (msg: string) => log.push(`status ${msg}`),
  };
}

describe("signInWithHermes", () => {
  it("runs Hermes's Portal sign-in and stores only the proxy address", async () => {
    const events: string[] = [];
    await signInWithHermes(auth, callbacks(events), run);

    expect(events).toContain(
      "url https://portal.nousresearch.com/manage-subscription?user_code=AB12-CD34",
    );
    expect(events.some((e) => e.includes("AB12-CD34 in your browser"))).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")) as Record<
      string,
      { accessToken: string; baseUrl: string }
    >;
    expect(Object.keys(stored)).toEqual(["nous"]);
    expect(stored.nous!.baseUrl).toBe(HERMES_PROXY_BASE_URL);
    expect(await auth.hasProviderAuth("nous")).toBe(true);
  });

  it("reuses the sign-in Hermes already holds without opening the browser", async () => {
    fs.writeFileSync(path.join(dir, "session"), "1");
    const events: string[] = [];
    await signInWithHermes(auth, callbacks(events), run);
    expect(events.some((e) => e.startsWith("url "))).toBe(false);
    expect(await auth.hasProviderAuth("nous")).toBe(true);
  });

  it("reports what Hermes said when the sign-in fails, and stores nothing", async () => {
    run.env.FAKE_HERMES_LOGIN_FAIL = "1";
    await expect(signInWithHermes(auth, callbacks([]), run)).rejects.toThrow(
      /Timed out waiting for device authorization/,
    );
    expect(await auth.hasProviderAuth("nous")).toBe(false);
  });

  it("says Hermes must be installed when it can't be found", async () => {
    await expect(
      signInWithHermes(auth, callbacks([]), { env: { PATH: "", HOME: dir, LOCALAPPDATA: dir } }),
    ).rejects.toBeInstanceOf(HermesNotInstalledError);
  });
});

describe("resolveHermesBinary", () => {
  it("finds the installer's location when it isn't on PATH", () => {
    const bin = path.join(dir, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "hermes"), "");
    expect(resolveHermesBinary({ PATH: "", HOME: dir }, "linux")).toBe(
      path.posix.join(dir, ".local", "bin", "hermes"),
    );
    expect(resolveHermesBinary({ PATH: "", HOME: path.join(dir, "nope") }, "linux")).toBeNull();
  });
});

describe("parseHermesDeviceCode", () => {
  it("reads the verification link and code, ignoring terminal colors", () => {
    expect(
      parseHermesDeviceCode(
        "\x1b[1mTo continue:\x1b[0m\n  1. Open: https://portal.example/x?user_code=Q\n  2. If prompted, enter code: Q1-W2\n",
      ),
    ).toEqual({ url: "https://portal.example/x?user_code=Q", code: "Q1-W2" });
    expect(parseHermesDeviceCode("Starting Hermes login…")).toBeNull();
  });
});

describe("hermesProxyHealth", () => {
  it("knows a Nous Portal proxy from anything else on the port", async () => {
    const answer = (body: unknown) => async () => Response.json(body);
    expect(
      await hermesProxyHealth(
        HERMES_PROXY_BASE_URL,
        answer({ status: "ok", upstream: "Nous Portal", authenticated: true }),
      ),
    ).toEqual({ nous: true, authenticated: true });
    expect(
      await hermesProxyHealth(HERMES_PROXY_BASE_URL, answer({ upstream: "xAI Grok OAuth" })),
    ).toEqual({ nous: false, authenticated: false });
    expect(
      await hermesProxyHealth(HERMES_PROXY_BASE_URL, async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBeUndefined();
  });
});
