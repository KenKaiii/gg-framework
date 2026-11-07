import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type * as GgCore from "@kenkaiiii/gg-core";
import type { OAuthLoginCallbacks } from "../core/oauth/types.js";
import { handleAuthRoutes } from "./auth-routes.js";
import type { SessionRouteContext } from "./route-context.js";

const signIn = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const loginChatGPT = vi.hoisted(() => vi.fn());
const revokeChatGPTSignIn = vi.hoisted(() => vi.fn());
vi.mock("../core/oauth/openai.js", () => ({ loginChatGPT, revokeChatGPTSignIn }));
vi.mock("@kenkaiiii/gg-core", async () => {
  const actual = await vi.importActual<typeof GgCore>("@kenkaiiii/gg-core");
  return { ...actual, signInWithClaudeCode: signIn, signOutOfClaudeCode: signOut };
});

interface Reply {
  status: number;
  body: unknown;
}

function call(ctx: object, url: string, body: unknown): Promise<Reply> {
  let resolve: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as unknown });
    },
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  handleAuthRoutes(
    ctx as SessionRouteContext,
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    url,
    "POST",
  );
  return reply;
}

function authContext() {
  const events: { scope: "one" | "all"; type: string; data: unknown }[] = [];
  const stored: Record<string, unknown> = {};
  const auth = {
    stored,
    setCredentials: vi.fn(async (key: string, creds: unknown) => {
      stored[key] = creds;
    }),
    clearCredentials: vi.fn(async (key: string) => {
      delete stored[key];
    }),
    getCredentials: vi.fn(async (key: string) => stored[key]),
    takeLegacySignIn: vi.fn(async () => false),
  };
  const ctx = {
    auth,
    broadcast: (type: string, data: unknown) => events.push({ scope: "one", type, data }),
    broadcastAll: (type: string, data: unknown) => events.push({ scope: "all", type, data }),
    oauthInFlight: false,
    oauthInFlightProviders: new Set<string>(),
    pendingCode: null,
    authCallbacks: (): OAuthLoginCallbacks => ({
      onOpenUrl: (url) => events.push({ scope: "one", type: "auth_url", data: { url } }),
      onStatus: (message) => events.push({ scope: "one", type: "auth_status", data: { message } }),
      onPromptCode: async () => "",
    }),
  };
  return { ctx, auth, events };
}

describe("Anthropic sign-in route (Claude Code)", () => {
  it("streams download progress and the sign-in URL, then reports success", async () => {
    signIn.mockImplementation(async (_auth: unknown, cb: OAuthLoginCallbacks) => {
      cb.onStatus("Downloading Claude Code… 50% (70 of 139 MB)");
      cb.onOpenUrl("https://claude.com/cai/oauth/authorize?state=s");
      return { loggedIn: true };
    });
    const { ctx, auth, events } = authContext();
    const reply = await call(ctx, "/auth/oauth/start", { provider: "anthropic" });
    expect(reply.status).toBe(202);
    await vi.waitFor(() => expect(ctx.oauthInFlight).toBe(false));

    expect(signIn).toHaveBeenCalledWith(auth, expect.anything());
    expect(auth.setCredentials).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual([
      "auth_status",
      "auth_url",
      "auth_done",
      "auth_change",
      "models_change",
    ]);
    expect(events[0]!.data).toEqual({ message: "Downloading Claude Code… 50% (70 of 139 MB)" });
    expect(ctx.oauthInFlightProviders.size).toBe(0);
  });

  it("reports a failed download or sign-in to the window that started it", async () => {
    signIn.mockRejectedValue(new Error("Claude Code download failed (HTTP 503)."));
    const { ctx, events } = authContext();
    await call(ctx, "/auth/oauth/start", { provider: "anthropic" });
    await vi.waitFor(() => expect(ctx.oauthInFlight).toBe(false));
    expect(events).toEqual([
      {
        scope: "one",
        type: "auth_error",
        data: { provider: "anthropic", message: "Claude Code download failed (HTTP 503)." },
      },
    ]);
  });

  it("signs out of Claude Code but keeps the API key when only the sign-in is removed", async () => {
    const { ctx, auth } = authContext();
    const reply = await call(ctx, "/auth/logout", { provider: "anthropic", method: "oauth" });
    expect(reply.status).toBe(200);
    expect(signOut).toHaveBeenCalledWith(auth);
    expect(auth.clearCredentials).not.toHaveBeenCalled();
  });

  it("removes only the API key when asked", async () => {
    signOut.mockClear();
    const { ctx, auth } = authContext();
    await call(ctx, "/auth/logout", { provider: "anthropic", method: "apikey" });
    expect(signOut).not.toHaveBeenCalled();
    expect(auth.clearCredentials).toHaveBeenCalledWith("anthropic");
  });
});

describe("Continue with ChatGPT route", () => {
  it("stores the plan sign-in apart from the OpenAI API key", async () => {
    const creds = { accessToken: "plan", refreshToken: "r", expiresAt: 1, clientId: "oaiapp_x" };
    loginChatGPT.mockResolvedValue(creds);
    const { ctx, auth } = authContext();
    auth.stored["openai-chatgpt"] = { ...creds, idToken: "old-id-token" };
    await call(ctx, "/auth/oauth/start", { provider: "openai" });
    await vi.waitFor(() => expect(ctx.oauthInFlight).toBe(false));
    // The current sign-in's ID token goes back as a hint.
    expect(loginChatGPT).toHaveBeenCalledWith(expect.anything(), {
      previous: expect.objectContaining({ idToken: "old-id-token" }),
    });
    expect(auth.setCredentials).toHaveBeenCalledWith("openai-chatgpt", creds);
  });

  it("revokes the plan session at OpenAI before signing out, keeping the API key", async () => {
    revokeChatGPTSignIn.mockResolvedValue(true);
    const { ctx, auth } = authContext();
    const plan = { accessToken: "plan", refreshToken: "r", expiresAt: 1, clientId: "oaiapp_x" };
    auth.stored["openai-chatgpt"] = plan;
    auth.stored.openai = { accessToken: "sk-key", refreshToken: "", expiresAt: 1 };
    const reply = await call(ctx, "/auth/logout", { provider: "openai", method: "oauth" });
    expect(reply.body).toEqual({ ok: true, revoked: true });
    expect(revokeChatGPTSignIn).toHaveBeenCalledWith(plan);
    expect(auth.stored["openai-chatgpt"]).toBeUndefined();
    expect(auth.stored.openai).toBeDefined();
  });

  it("dismisses a retired sign-in without touching anything else", async () => {
    const { ctx, auth } = authContext();
    await call(ctx, "/auth/logout", { provider: "moonshot", method: "legacy" });
    expect(auth.takeLegacySignIn).toHaveBeenCalledWith("moonshot");
    expect(auth.clearCredentials).not.toHaveBeenCalled();
  });

  it("removes both Kimi keys on an API-key disconnect", async () => {
    const { ctx, auth } = authContext();
    await call(ctx, "/auth/logout", { provider: "moonshot", method: "apikey" });
    expect(auth.clearCredentials.mock.calls.map((c) => c[0])).toEqual(["kimi-code", "moonshot"]);
  });

  it("stores a Kimi Code plan key under its own storage key", async () => {
    const { ctx, auth } = authContext();
    await call(ctx, "/auth/apikey", { provider: "moonshot", key: "kc-key", variant: "kimi-code" });
    expect(auth.setCredentials).toHaveBeenCalledWith(
      "kimi-code",
      expect.objectContaining({ accessToken: "kc-key", refreshToken: "" }),
    );
  });

  it("refuses a sign-in for a provider that only takes keys", async () => {
    const { ctx } = authContext();
    const reply = await call(ctx, "/auth/oauth/start", { provider: "xai" });
    expect(reply.status).toBe(400);
  });
});
