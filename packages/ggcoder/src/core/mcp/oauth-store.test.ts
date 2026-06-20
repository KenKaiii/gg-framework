import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpOAuthStore } from "./oauth-store.js";
import { McpOAuthProvider, mcpOAuthRedirectUrl } from "./oauth-provider.js";

describe("McpOAuthStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-auth-"));
    file = path.join(dir, "mcp-auth.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty entry for an unknown server", async () => {
    const store = new McpOAuthStore(file);
    expect(await store.get("nope")).toEqual({});
    expect(await store.hasTokens("nope")).toBe(false);
  });

  it("patches and merges entries per server without clobbering others", async () => {
    const store = new McpOAuthStore(file);
    await store.patch("a", { state: "s1" });
    await store.patch("a", { codeVerifier: "v1" });
    await store.patch("b", { state: "s2" });

    expect(await store.get("a")).toEqual({ state: "s1", codeVerifier: "v1" });
    expect(await store.get("b")).toEqual({ state: "s2" });
  });

  it("reports tokens once saved and clears them on logout", async () => {
    const store = new McpOAuthStore(file);
    await store.patch("canva", {
      tokens: { access_token: "tok", token_type: "Bearer" },
    });
    expect(await store.hasTokens("canva")).toBe(true);

    await store.clear("canva");
    expect(await store.hasTokens("canva")).toBe(false);
    expect(await store.get("canva")).toEqual({});
  });

  it("persists across fresh store instances (separate sidecars)", async () => {
    await new McpOAuthStore(file).patch("x", { state: "shared" });
    expect(await new McpOAuthStore(file).get("x")).toEqual({ state: "shared" });
  });
});

describe("McpOAuthProvider", () => {
  let dir: string;
  let store: McpOAuthStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-prov-"));
    store = new McpOAuthStore(path.join(dir, "mcp-auth.json"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("advertises the fixed loopback redirect URI in client metadata", () => {
    const p = new McpOAuthProvider({ serverName: "canva", store });
    expect(p.redirectUrl).toBe(mcpOAuthRedirectUrl());
    expect(p.clientMetadata.redirect_uris).toEqual([mcpOAuthRedirectUrl()]);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
    expect(p.clientMetadata.grant_types).toContain("refresh_token");
  });

  it("generates a stable CSRF state and persists it", async () => {
    const p = new McpOAuthProvider({ serverName: "canva", store });
    const s1 = await p.state();
    const s2 = await p.state();
    expect(s1).toBe(s2);
    expect((await store.get("canva")).state).toBe(s1);
  });

  it("does NOT open a browser when no onRedirect is supplied (non-interactive)", () => {
    const p = new McpOAuthProvider({ serverName: "canva", store });
    // Should be a no-op (no throw, nothing to observe) — background connects rely on this.
    expect(() => p.redirectToAuthorization(new URL("https://example.com/authorize"))).not.toThrow();
  });

  it("invokes onRedirect with the authorize URL for interactive login", () => {
    let seen: URL | undefined;
    const p = new McpOAuthProvider({
      serverName: "canva",
      store,
      onRedirect: (url) => (seen = url),
    });
    p.redirectToAuthorization(new URL("https://mcp.canva.com/authorize?x=1"));
    expect(seen?.toString()).toBe("https://mcp.canva.com/authorize?x=1");
  });

  it("round-trips the PKCE code verifier", async () => {
    const p = new McpOAuthProvider({ serverName: "canva", store });
    await p.saveCodeVerifier("verifier-123");
    expect(await p.codeVerifier()).toBe("verifier-123");
  });

  it("throws a clear error when no code verifier is saved", async () => {
    const p = new McpOAuthProvider({ serverName: "canva", store });
    await expect(p.codeVerifier()).rejects.toThrow(/code verifier/i);
  });
});
