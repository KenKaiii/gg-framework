import type http from "node:http";
import { XIAOMI_CREDITS_KEY, dualAuthProvider } from "@kenkaiiii/gg-core";
import { loginAnthropic } from "../core/oauth/anthropic.js";
import { loginOpenAI } from "../core/oauth/openai.js";
import { loginGemini } from "../core/oauth/gemini.js";
import { loginKimi } from "../core/oauth/kimi.js";
import { loginXai } from "../core/oauth/xai.js";
import type { OAuthCredentials } from "../core/oauth/types.js";
import { AUTH_PROVIDERS, type AuthMethod } from "../core/auth-providers.js";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { AskUserResult } from "../core/ask-user.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

export function handleAuthRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // ── Provider auth (login) ───────────────────────────────
  if (method === "GET" && url === "/auth/status") {
    void ctx.authStatusPayload().then((payload) => json(res, 200, payload));
    return true;
  }

  if (method === "POST" && url === "/auth/apikey") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let provider = "";
      let key: string;
      let variant: string | undefined;
      try {
        const body = JSON.parse(raw) as { provider?: string; key?: string; variant?: string };
        provider = body.provider ?? "";
        key = (body.key ?? "").trim();
        variant = body.variant;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
      if (!meta || !meta.methods.includes("apikey")) {
        json(res, 400, { error: "provider does not support API key auth" });
        return;
      }
      if (!key) {
        json(res, 400, { error: "API key is required" });
        return;
      }
      // Providers with multiple API-key variants (currently only Xiaomi: Token
      // Plan vs. API Credits) store under the chosen variant's key/baseUrl,
      // defaulting to the first variant. Single-variant providers fall back to
      // the legacy provider-id storage key + flat apiKeyBaseUrl.
      const chosenVariant =
        meta.apiKeyVariants?.find((v) => v.key === variant) ?? meta.apiKeyVariants?.[0];
      const storageKey = chosenVariant?.key ?? provider;
      const baseUrl = chosenVariant?.baseUrl ?? meta.apiKeyBaseUrl;
      const creds: OAuthCredentials = {
        accessToken: key,
        refreshToken: "",
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100y
        ...(baseUrl ? { baseUrl } : {}),
      };
      await ctx.auth.setCredentials(storageKey, creds);
      // auth.json is shared by every window, so this is a global change:
      // close their login modals and refresh their provider lists too.
      ctx.broadcastAll("auth_done", { provider });
      // `auth_done` means "a login succeeded" (modals close on it).
      // `auth_change` means "auth.json changed" — which a DISCONNECT also is,
      // so connection state has one signal that covers both directions.
      ctx.broadcastAll("auth_change", { provider });
      // A newly connected provider unlocks its models. `/models` filters on
      // who is logged in, so every window's picker is now stale — without
      // this the new models don't appear until the session is reopened.
      ctx.broadcastAll("models_change", {});
      json(res, 200, { ok: true });
    });
    return true;
  }

  if (method === "POST" && url === "/auth/oauth/start") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let provider = "";
      try {
        provider = (JSON.parse(raw) as { provider?: string }).provider ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
      if (!meta || !meta.methods.includes("oauth")) {
        json(res, 400, { error: "provider does not support OAuth" });
        return;
      }
      if (ctx.oauthInFlight) {
        json(res, 409, { error: "a login is already in progress" });
        return;
      }
      // A login writes the shared ~/.gg/auth.json, so two windows racing the
      // same provider means two browser tabs and two token exchanges whose
      // writes clobber each other. The per-session flag above cannot see
      // that — guard the provider daemon-wide as well.
      if (ctx.oauthInFlightProviders.has(provider)) {
        json(res, 409, {
          error: `a ${meta.label} login is already in progress in another window`,
        });
        return;
      }
      ctx.oauthInFlight = true;
      ctx.oauthInFlightProviders.add(provider);
      json(res, 202, { accepted: true });
      void (async () => {
        const cb = ctx.authCallbacks();
        try {
          let creds: OAuthCredentials;
          let storageKey = provider;
          if (provider === "anthropic") creds = await loginAnthropic(cb);
          else if (provider === "openai") creds = await loginOpenAI(cb);
          else if (provider === "gemini") creds = await loginGemini(cb);
          else if (provider === "moonshot" || provider === "xai") {
            // Subscription OAuth (Kimi plan / SuperGrok-X Premium) stores under
            // a distinct key so it can coexist with the provider's API key.
            const dual = dualAuthProvider(provider);
            if (!dual) throw new Error(`No subscription storage key for ${provider}`);
            creds = provider === "moonshot" ? await loginKimi(cb) : await loginXai(cb);
            storageKey = dual.oauthKey;
          } else {
            throw new Error(`OAuth not implemented for ${provider}`);
          }
          await ctx.auth.setCredentials(storageKey, creds);
          // Terminal outcome of a GLOBAL change: every window's login modal
          // should close and its provider list refresh, not just the one
          // that started the flow.
          ctx.broadcastAll("auth_done", { provider });
          ctx.broadcastAll("auth_change", { provider });
          // The OAuth provider's models just became selectable everywhere.
          ctx.broadcastAll("models_change", {});
        } catch (err) {
          // Deliberately session-scoped: this is the outcome of ONE window's
          // attempt. Another window that never pressed Connect has nothing to
          // show an error about, and its modal correctly still offers login.
          ctx.broadcast("auth_error", {
            provider,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          ctx.oauthInFlight = false;
          ctx.oauthInFlightProviders.delete(provider);
          ctx.pendingCode = null;
        }
      })();
    });
    return true;
  }

  if (method === "POST" && url === "/auth/oauth/code") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let code: string;
      try {
        code = (JSON.parse(raw) as { code?: string }).code ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!ctx.pendingCode) {
        json(res, 409, { error: "no login is awaiting a code" });
        return;
      }
      ctx.pendingCode(code.trim());
      ctx.pendingCode = null;
      json(res, 200, { ok: true });
    });
    return true;
  }

  if (method === "POST" && url.startsWith("/mcp/elicit/")) {
    const id = decodeURIComponent(url.slice("/mcp/elicit/".length));
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let result: ElicitResult;
      try {
        const parsed = JSON.parse(raw) as {
          action?: string;
          content?: Record<string, unknown>;
        };
        if (
          parsed.action !== "accept" &&
          parsed.action !== "decline" &&
          parsed.action !== "cancel"
        ) {
          json(res, 400, { error: "action must be accept, decline, or cancel" });
          return;
        }
        result =
          parsed.action === "accept"
            ? ({ action: "accept", content: parsed.content ?? {} } as ElicitResult)
            : { action: parsed.action };
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      // Unknown id means it already timed out or was cancelled by an abort —
      // the tool call has moved on, so the answer has nowhere to go.
      if (!ctx.elicitations.settle(id, result)) {
        json(res, 409, { error: "no elicitation is awaiting a response" });
        return;
      }
      json(res, 200, { ok: true });
    });
    return true;
  }

  // Answer (or dismiss) an `ask_user` question band. The turn is blocked on
  // this, so both paths must land: "answer" carries the picked values,
  // "cancel" releases the tool call with no answer.
  if (method === "POST" && url.startsWith("/ask/")) {
    const id = decodeURIComponent(url.slice("/ask/".length));
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let result: AskUserResult;
      try {
        const parsed = JSON.parse(raw) as {
          action?: string;
          answers?: Record<string, unknown>;
        };
        if (parsed.action !== "answer" && parsed.action !== "cancel") {
          json(res, 400, { error: "action must be answer or cancel" });
          return;
        }
        if (parsed.action === "cancel") {
          result = { action: "cancel" };
        } else {
          // Only strings and string arrays are answers; anything else is a
          // malformed client, not a value to hand the model.
          const answers: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(parsed.answers ?? {})) {
            if (typeof value === "string") answers[key] = value;
            else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
              answers[key] = value as string[];
            }
          }
          result = { action: "answer", answers };
        }
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!ctx.asks.settle(id, result)) {
        json(res, 409, { error: "no question is awaiting an answer" });
        return;
      }
      json(res, 200, { ok: true });
    });
    return true;
  }

  if (method === "POST" && url === "/auth/logout") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let provider: string;
      let logoutMethod: AuthMethod | undefined;
      try {
        const body = JSON.parse(raw) as { provider?: string; method?: string };
        provider = body.provider ?? "";
        logoutMethod =
          body.method === "oauth" || body.method === "apikey" ? body.method : undefined;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const dual = dualAuthProvider(provider);
      // A dual-auth provider can be disconnected one method at a time: dropping
      // a spent API key should not sign the user out of their subscription, and
      // vice versa. Omitting `method` still clears everything (the plain
      // "Disconnect" action).
      if (logoutMethod !== "apikey") {
        await ctx.auth.clearCredentials(dual ? dual.oauthKey : provider);
      }
      if (logoutMethod !== "oauth") {
        // Non-dual providers store their only credential under the provider id,
        // so this covers both them and a dual provider's API key.
        await ctx.auth.clearCredentials(provider);
        // Xiaomi's API Credits credential lives under a distinct key — clear it
        // too so "disconnect" fully removes both the Token Plan and Credits keys.
        if (provider === "xiaomi") await ctx.auth.clearCredentials(XIAOMI_CREDITS_KEY);
      }
      ctx.broadcast("auth_done", { provider });
      json(res, 200, { ok: true });
    });
    return true;
  }

  return false;
}
