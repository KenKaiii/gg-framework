import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_PLAN_BASE_URL,
  ChatGPTPlanNotEnabledError,
  getChatGPTHostId,
  loginChatGPT,
  refreshChatGPTToken,
  revokeChatGPTSignIn,
} from "./openai.js";
import type { OAuthLoginCallbacks } from "./types.js";

const originalFetch = globalThis.fetch;
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key";
const PLAN_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

function signIdToken(claims: Record<string, unknown>, key = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

interface FakeAuthServer {
  fetch: ReturnType<typeof vi.fn>;
  /** Form bodies posted to each endpoint path. */
  posts: Map<string, URLSearchParams[]>;
}

/** OpenAI's auth server: JWKS, token and revoke endpoints. The ID token echoes the nonce. */
function fakeAuthServer(opts: {
  scope?: string;
  idTokenClaims?: (nonce: string) => Record<string, unknown>;
}): { server: FakeAuthServer; setNonce: (nonce: string) => void } {
  let nonce = "";
  const posts = new Map<string, URLSearchParams[]>();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/jwks.json") {
      const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" };
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    const form = new URLSearchParams(String(init?.body ?? ""));
    posts.set(url.pathname, [...(posts.get(url.pathname) ?? []), form]);
    if (url.pathname === "/api/accounts/oauth/revoke") return new Response("", { status: 200 });
    const clientId = form.get("client_id")!;
    const claims = opts.idTokenClaims?.(nonce) ?? {
      iss: "https://auth.openai.com",
      aud: clientId,
      sub: "user-sub-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
    };
    return new Response(
      JSON.stringify({
        access_token: "plan-access",
        refresh_token: "plan-refresh",
        id_token: signIdToken(claims),
        expires_in: 3600,
        scope: opts.scope ?? PLAN_SCOPES,
      }),
      { status: 200 },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { server: { fetch: fetchMock, posts }, setNonce: (n) => (nonce = n) };
}

/** Paste the callback URL the browser would land on, built from the opened authorize URL. */
function pasteCallbacks(
  query: (auth: URL) => string,
  setNonce: (nonce: string) => void,
): { callbacks: OAuthLoginCallbacks; authUrl: () => URL; prompts: string[] } {
  let opened: URL | undefined;
  const prompts: string[] = [];
  return {
    prompts,
    authUrl: () => opened!,
    callbacks: {
      onOpenUrl: (url) => {
        opened = new URL(url);
        setNonce(opened.searchParams.get("nonce")!);
      },
      onStatus: () => {},
      onPromptCode: async (message) => {
        prompts.push(message);
        return `${opened!.searchParams.get("redirect_uri")}?${query(opened!)}`;
      },
    },
  };
}

let dir: string;
let files: { hostIdFile: string; registrationFile: string };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-chatgpt-signin-"));
  files = {
    hostIdFile: path.join(dir, "openai-host-id"),
    registrationFile: path.join(dir, "openai-chatgpt-client.json"),
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const firstRegistration = (auth: URL) =>
  `code=abc123&state=${auth.searchParams.get("state")}&client_id=oaiapp_issued&scope=${encodeURIComponent(PLAN_SCOPES)}`;

describe("Continue with ChatGPT", () => {
  it("registers GG Coder on first sign-in and saves the issued client", async () => {
    const { server, setNonce } = fakeAuthServer({});
    const holder = pasteCallbacks(firstRegistration, setNonce);

    const creds = await loginChatGPT(holder.callbacks, files);

    const auth = holder.authUrl();
    expect(auth.origin + auth.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(auth.searchParams.get("agent_name_hint")).toBe("GG Coder");
    expect(auth.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(auth.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(auth.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(auth.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    // No Codex identity anywhere.
    expect(auth.toString()).not.toMatch(/codex|originator/);

    const exchange = server.posts.get("/api/accounts/oauth/token")![0]!;
    expect(exchange.get("client_id")).toBe("oaiapp_issued");
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
    expect(exchange.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));

    expect(creds).toMatchObject({
      accessToken: "plan-access",
      refreshToken: "plan-refresh",
      accountId: "user-sub-1",
      clientId: "oaiapp_issued",
      baseUrl: CHATGPT_PLAN_BASE_URL,
    });
    expect(creds.scopes).toContain("chatgpt.tokens.use.direct");
    expect(JSON.parse(await fs.readFile(files.registrationFile, "utf-8"))).toEqual({
      clientId: "oaiapp_issued",
      subject: "user-sub-1",
    });
  }, 20_000);

  it("reuses the issued client and host ID on a later sign-in", async () => {
    const first = fakeAuthServer({});
    const one = pasteCallbacks(firstRegistration, first.setNonce);
    const firstCreds = await loginChatGPT(one.callbacks, files);

    const second = fakeAuthServer({});
    const two = pasteCallbacks(
      (auth) => `code=def456&state=${auth.searchParams.get("state")}`,
      second.setNonce,
    );
    await loginChatGPT(two.callbacks, { ...files, previous: firstCreds });

    const auth = two.authUrl();
    expect(auth.searchParams.get("client_id")).toBe("oaiapp_issued");
    expect(auth.searchParams.get("agent_name_hint")).toBeNull();
    expect(auth.searchParams.get("id_token_hint")).toBe(firstCreds.idToken);
    expect(auth.searchParams.get("ext_agent_host_id")).toBe(
      one.authUrl().searchParams.get("ext_agent_host_id"),
    );
    expect(second.server.posts.get("/api/accounts/oauth/token")![0]!.get("client_id")).toBe(
      "oaiapp_issued",
    );
  }, 20_000);

  it("fails with a clear choice when plan use wasn't granted, and revokes the session", async () => {
    const { server, setNonce } = fakeAuthServer({ scope: "openid profile email offline_access" });
    const holder = pasteCallbacks(firstRegistration, setNonce);

    await expect(loginChatGPT(holder.callbacks, files)).rejects.toThrow(ChatGPTPlanNotEnabledError);
    await expect(fs.stat(files.registrationFile)).rejects.toThrow();
    expect(server.posts.get("/api/accounts/oauth/revoke")).toHaveLength(1);
  }, 20_000);

  it("treats a declined consent as plan use not enabled", async () => {
    const { setNonce } = fakeAuthServer({});
    const holder = pasteCallbacks(
      (auth) => `error=access_denied&state=${auth.searchParams.get("state")}`,
      setNonce,
    );
    await expect(loginChatGPT(holder.callbacks, files)).rejects.toThrow(
      /Allow Use your ChatGPT plan, or add an OpenAI API key/,
    );
  }, 20_000);

  it("rejects an ID token with the wrong nonce or a forged signature", async () => {
    const wrongNonce = fakeAuthServer({
      idTokenClaims: () => ({
        iss: "https://auth.openai.com",
        aud: "oaiapp_issued",
        sub: "s",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "someone-else",
      }),
    });
    await expect(
      loginChatGPT(pasteCallbacks(firstRegistration, wrongNonce.setNonce).callbacks, files),
    ).rejects.toThrow(/nonce/);

    const forged = fakeAuthServer({});
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    forged.server.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/jwks.json") {
        const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID };
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          id_token: signIdToken({ sub: "s" }, other.privateKey),
          scope: PLAN_SCOPES,
        }),
        { status: 200 },
      );
    });
    await expect(
      loginChatGPT(pasteCallbacks(firstRegistration, forged.setNonce).callbacks, files),
    ).rejects.toThrow(/signature/);
  }, 20_000);

  it("treats an unfinished registration (no issued client) as incomplete", async () => {
    const { setNonce } = fakeAuthServer({});
    const holder = pasteCallbacks(
      (auth) => `code=abc123&state=${auth.searchParams.get("state")}`,
      setNonce,
    );
    await expect(loginChatGPT(holder.callbacks, files)).rejects.toThrow(/didn't finish/);
  }, 20_000);
});

describe("Continue with ChatGPT on a headless host", () => {
  // Regression for #20: the paste route is offered at once, not after the listener lapses.
  it("offers the paste prompt immediately", async () => {
    const { setNonce } = fakeAuthServer({});
    const startedAt = Date.now();
    const holder = pasteCallbacks(firstRegistration, setNonce);
    await loginChatGPT(holder.callbacks, files);
    expect(holder.prompts[0]).toContain("SSH/headless");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  it("rejects a pasted callback whose state belongs to another attempt", async () => {
    const { setNonce } = fakeAuthServer({});
    const holder = pasteCallbacks(() => "code=abc&state=not-mine&client_id=x", setNonce);
    await expect(loginChatGPT(holder.callbacks, files)).rejects.toThrow(/state mismatch/i);
  }, 20_000);

  it("re-asks when the paste isn't a callback URL", async () => {
    const { setNonce } = fakeAuthServer({});
    let attempt = 0;
    let opened: URL | undefined;
    const prompts: string[] = [];
    const callbacks: OAuthLoginCallbacks = {
      onOpenUrl: (url) => {
        opened = new URL(url);
        setNonce(opened.searchParams.get("nonce")!);
      },
      onStatus: () => {},
      onPromptCode: async (message) => {
        prompts.push(message);
        attempt++;
        if (attempt === 1) return "oops wrong clipboard";
        return `${opened!.searchParams.get("redirect_uri")}?${firstRegistration(opened!)}`;
      },
    };
    const creds = await loginChatGPT(callbacks, files);
    expect(attempt).toBe(2);
    expect(prompts[1]).toContain("wasn't a callback URL");
    expect(creds.accountId).toBe("user-sub-1");
  }, 20_000);
});

describe("ChatGPT plan tokens", () => {
  it("refreshes with the issued client ID and the resource", async () => {
    const { server } = fakeAuthServer({});
    const creds = await refreshChatGPTToken({ refreshToken: "r1", clientId: "oaiapp_issued" });
    const form = server.posts.get("/api/accounts/oauth/token")![0]!;
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("oaiapp_issued");
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.get("scope")).toBeNull();
    expect(creds.accessToken).toBe("plan-access");
    expect(creds.refreshToken).toBe("plan-refresh");
  });

  it("refuses to refresh without an issued client (an auth failure, so the sign-in is cleared)", async () => {
    await expect(refreshChatGPTToken({ refreshToken: "r1" })).rejects.toThrow(/\(401\)/);
  });

  it("revokes the refresh token on sign-out", async () => {
    const { server } = fakeAuthServer({});
    expect(await revokeChatGPTSignIn({ refreshToken: "r1", clientId: "oaiapp_issued" })).toBe(true);
    const form = server.posts.get("/api/accounts/oauth/revoke")![0]!;
    expect(form.get("token")).toBe("r1");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("oaiapp_issued");
  });

  it("reports an unconfirmed revoke after retrying a server error", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await revokeChatGPTSignIn({ refreshToken: "r", clientId: "c" }, { backoffMs: 1 })).toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps one host ID per machine, owner-only", async () => {
    const first = await getChatGPTHostId(files.hostIdFile);
    expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(await getChatGPTHostId(files.hostIdFile)).toBe(first);
    if (process.platform !== "win32") {
      expect((await fs.stat(files.hostIdFile)).mode & 0o777).toBe(0o600);
    }
  });
});
