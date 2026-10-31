import type http from "node:http";
import { isValidHfRepoId } from "../hf-pull.js";
import {
  AUTH_PROVIDERS,
  GATEWAY_SYNC_PROVIDERS,
  fetchGatewayCatalog,
  parseLocalModelId,
  writeGatewayCacheEntry,
} from "@kenkaiiii/gg-core";
import {
  LocalEndpointError,
  addCustomEndpoint,
  removeCustomEndpoint,
} from "../core/local-endpoint-store.js";
import { clearRuntimeModels, registerRuntimeModels } from "../core/model-registry.js";
import { log } from "../core/logger.js";
import { startServeMode } from "../modes/serve-mode.js";
import { installSteroids, probeSteroids } from "../core/steroids.js";
import { loadTelegramConfig, saveTelegramConfig, verifyBotToken } from "../core/telegram-config.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

export function handleIntegrationRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // ── Telegram config (mirrors `ggcoder telegram`) ─────────
  // ── Local models ──────────────────────────────────────
  // GET returns the last scan (cheap, no probing) so opening the modal is
  // instant; POST /local/scan is the explicit refresh.
  if (method === "GET" && url === "/local") {
    json(res, 200, ctx.localStatePayload());
    return true;
  }

  if (method === "POST" && url === "/local/scan") {
    void ctx
      .scanLocalModels(true)
      .then(() => {
        ctx.broadcast("models_change", { local: ctx.localStatePayload() });
        json(res, 200, ctx.localStatePayload());
      })
      .catch((err: unknown) => {
        ctx.broadcastError("error", "local model scan failed", err);
        json(res, 500, { error: "Local model scan failed — see the sidecar log." });
      });
    return true;
  }

  // ── Gateway model sync (OpenRouter, or any endpoint it's pointed at) ──
  // Replaces the provider's static catalog with the models its own endpoint
  // serves, so context window, output cap, thinking levels and price come from
  // the thing actually answering requests.
  if (method === "POST" && url === "/models/sync") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let provider = "";
      try {
        provider = (JSON.parse(raw) as { provider?: string }).provider ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!GATEWAY_SYNC_PROVIDERS.includes(provider)) {
        json(res, 400, { error: `${provider || "that provider"} has no syncable model catalog.` });
        return;
      }
      const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
      const baseUrl = (await ctx.auth.getStoredBaseUrl(provider)) ?? meta?.apiKeyBaseUrl;
      if (!baseUrl) {
        json(res, 400, { error: `No base URL configured for ${provider}.` });
        return;
      }
      const creds = await ctx.auth.resolveCredentials(provider).catch(() => undefined);
      try {
        const catalog = await fetchGatewayCatalog({
          provider,
          baseUrl,
          apiKey: creds?.accessToken,
        });
        clearRuntimeModels((m) => m.provider === provider);
        registerRuntimeModels(catalog.models);
        await writeGatewayCacheEntry(provider, {
          baseUrl: catalog.baseUrl,
          syncedAt: Date.now(),
          models: catalog.models,
        });
        log("INFO", "models", "gateway catalog synced", {
          provider,
          baseUrl: catalog.baseUrl,
          count: String(catalog.models.length),
        });
        // The picker is shared by every window, so this is a global change.
        ctx.broadcastAll("models_change", {});
        json(res, 200, {
          ok: true,
          provider,
          baseUrl: catalog.baseUrl,
          count: catalog.models.length,
          skippedNoTools: catalog.skippedNoTools,
        });
      } catch (err) {
        json(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/local/endpoints") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { label?: string; baseUrl?: string; apiKey?: string };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      try {
        const endpoint = await addCustomEndpoint({
          baseUrl: body.baseUrl ?? "",
          ...(body.label ? { label: body.label } : {}),
          ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        });
        await ctx.scanLocalModels(true);
        ctx.broadcast("models_change", { local: ctx.localStatePayload() });
        json(res, 200, {
          endpoint: { id: endpoint.id, label: endpoint.label },
          ...ctx.localStatePayload(),
        });
        void ctx.trophies.count("localEndpoints", ctx.sessionId);
      } catch (err) {
        // Validation errors are the user's typo, not a system fault — 400 with
        // the exact reason, and nothing in the transcript.
        if (err instanceof LocalEndpointError) {
          json(res, 400, { error: err.message });
          return;
        }
        ctx.broadcastError("error", "add local endpoint failed", err);
        json(res, 500, { error: "Could not save the endpoint — see the sidecar log." });
      }
    });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/local/endpoints/")) {
    const id = decodeURIComponent(url.slice("/local/endpoints/".length));
    void (async () => {
      try {
        await removeCustomEndpoint(id);
        clearRuntimeModels(
          (m) => m.provider === "local" && parseLocalModelId(m.id)?.endpointId === id,
        );
        await ctx.scanLocalModels(true);
        ctx.broadcast("models_change", { local: ctx.localStatePayload() });
        json(res, 200, ctx.localStatePayload());
      } catch (err) {
        if (err instanceof LocalEndpointError) {
          json(res, 400, { error: err.message });
          return;
        }
        ctx.broadcastError("error", "remove local endpoint failed", err);
        json(res, 500, { error: "Could not remove the endpoint — see the sidecar log." });
      }
    })();
    return true;
  }

  // ── Hugging Face search & pull (the "Add from Hugging Face" modal) ──
  if (method === "GET" && url === "/hf/pull") {
    json(res, 200, ctx.hfPull ? { active: ctx.hfPullPayload(ctx.hfPull) } : { active: null });
    return true;
  }

  if (method === "POST" && url === "/hf/search") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { query?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      // Strip control characters and cap length — this goes into a URL query.
      const query = String(body.query ?? "")
        // eslint-disable-next-line no-control-regex -- stripping control characters is the point
        .replace(/[\u0000-\u001f]/g, "")
        .trim()
        .slice(0, 100);
      if (!query) {
        json(res, 400, { error: "Type something to search for." });
        return;
      }
      try {
        json(res, 200, { models: await ctx.hfSearch(query) });
      } catch (err) {
        ctx.broadcastError("error", "hugging face search failed", err);
        json(res, 502, {
          error: `Hugging Face search failed — ${err instanceof Error ? err.message : "network error"}.`,
        });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/hf/pull") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { repo?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const repo = String(body.repo ?? "").trim();
      if (!isValidHfRepoId(repo)) {
        json(res, 400, { error: 'Expected a Hugging Face repo like "org/model".' });
        return;
      }
      try {
        json(res, 200, await ctx.startHfPull(repo));
        void ctx.trophies.count("modelsPulled", ctx.sessionId);
      } catch (err) {
        const status =
          err instanceof Error && "status" in err && typeof err.status === "number"
            ? err.status
            : 502;
        if (status >= 500) ctx.broadcastError("error", "hugging face pull failed", err);
        json(res, status, { error: err instanceof Error ? err.message : "Pull failed." });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/hf/pull/cancel") {
    json(res, 200, { ok: ctx.cancelHfPull() });
    return true;
  }

  if (method === "GET" && url === "/telegram") {
    void loadTelegramConfig().then((cfg) => {
      if (!cfg) {
        json(res, 200, { configured: false });
        return;
      }
      // Never return the raw token to the webview — a short masked preview is
      // enough to show "already set".
      const t = cfg.botToken;
      const tokenPreview = t.length > 14 ? `${t.slice(0, 10)}\u2026${t.slice(-4)}` : "set";
      json(res, 200, { configured: true, userId: cfg.userId, tokenPreview });
    });
    return true;
  }

  if (method === "POST" && url === "/telegram") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let botTokenInput: string;
      let userIdInput: string;
      try {
        const body = JSON.parse(raw) as { botToken?: string; userId?: string | number };
        botTokenInput = (body.botToken ?? "").trim();
        userIdInput = String(body.userId ?? "").trim();
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      // Keep the existing token when the field is left blank (the webview shows
      // a masked preview, not the real token).
      const existing = await loadTelegramConfig();
      const botToken = botTokenInput || existing?.botToken || "";
      if (!botToken) {
        json(res, 400, { error: "Bot token is required." });
        return;
      }
      const userId = userIdInput ? parseInt(userIdInput, 10) : existing?.userId;
      if (!userId || Number.isNaN(userId)) {
        json(res, 400, { error: "A numeric Telegram user ID is required." });
        return;
      }
      const verified = await verifyBotToken(botToken);
      if (!verified.ok) {
        json(res, 400, { error: "Invalid bot token — Telegram rejected it." });
        return;
      }
      await saveTelegramConfig({ botToken, userId });
      json(res, 200, { ok: true, userId, username: verified.username ?? null });
      void ctx.trophies.count("telegramSetups", ctx.sessionId);
    });
    return true;
  }

  // ── Serve lifecycle (mirrors `ggcoder serve`) ───────────
  if (method === "GET" && url === "/serve") {
    void loadTelegramConfig().then((cfg) =>
      json(res, 200, { running: ctx.serveController !== null, configured: cfg !== null }),
    );
    return true;
  }

  if (method === "POST" && url === "/serve/start") {
    void (async () => {
      if (ctx.serveController) {
        json(res, 200, { running: true });
        return;
      }
      const cfg = await loadTelegramConfig();
      if (!cfg) {
        json(res, 400, { error: "Telegram isn't set up yet. Open Serve settings first." });
        return;
      }
      const st = ctx.session.getState();
      try {
        ctx.serveController = await startServeMode({
          provider: st.provider,
          model: st.model,
          cwd: ctx.cwd,
          version: "app",
          thinkingLevel: ctx.session.getThinkingLevel() ?? undefined,
          telegram: { botToken: cfg.botToken, userId: cfg.userId },
          embedded: true,
        });
        ctx.broadcast("serve_change", { running: true });
        log("INFO", "app-sidecar", "serve started", { userId: cfg.userId });
        json(res, 200, { running: true });
        void ctx.trophies.count("remoteStarts", ctx.sessionId);
      } catch (err) {
        ctx.serveController = null;
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (method === "POST" && url === "/serve/stop") {
    void (async () => {
      if (ctx.serveController) {
        await ctx.serveController.stop().catch(() => {});
        ctx.serveController = null;
        ctx.broadcast("serve_change", { running: false });
        log("INFO", "app-sidecar", "serve stopped");
      }
      json(res, 200, { running: false });
    })();
    return true;
  }

  // ── Agent Steroids (local code corpus) ───────────────────────────────
  if (method === "GET" && url === "/steroids") {
    void probeSteroids().then((status) => json(res, 200, status));
    return true;
  }

  if (method === "POST" && url === "/steroids/install") {
    void installSteroids()
      .then((status) => {
        ctx.broadcast("steroids_change", status);
        log("INFO", "app-sidecar", "steroids installed", { version: status.version });
        json(res, 200, status);
      })
      .catch((err: unknown) => {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  }

  return false;
}
