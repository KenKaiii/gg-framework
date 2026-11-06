import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type * as GgCore from "@kenkaiiii/gg-core";
import type { OAuthLoginCallbacks } from "../core/oauth/types.js";
import { handleAuthRoutes } from "./auth-routes.js";
import type { SessionRouteContext } from "./route-context.js";

const signIn = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
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
  const auth = {
    setCredentials: vi.fn(async () => {}),
    clearCredentials: vi.fn(async () => {}),
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
