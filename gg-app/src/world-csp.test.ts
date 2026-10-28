import conf from "../src-tauri/tauri.conf.json?raw";
import worldHtml from "../../packages/gg-world/index.html?raw";
import { describe, expect, it } from "vitest";

// Production Tauri sends the app CSP with every HTML file it serves, World's sealed frame included. A policy that
// blocks World there leaves the World screen black in the shipped app only (the dev server sends no CSP).
const security = (JSON.parse(conf) as { app: { security: { csp: string; devCsp: string } } }).app
  .security;

const directive = (csp: string, name: string): string[] =>
  csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? [];

describe.each([
  ["csp", security.csp],
  ["devCsp", security.devCsp],
])("the app %s lets World run", (_name, csp) => {
  it("lets the app frame its own World page", () => {
    expect(directive(csp, "frame-ancestors")).toContain("'self'");
    expect(directive(csp, "frame-src")).toContain("'self'");
  });

  it("names the app's origins for World's scripts ('self' matches nothing in a sealed frame)", () => {
    expect(directive(csp, "script-src")).toEqual(
      expect.arrayContaining(["tauri://localhost", "http://tauri.localhost"]),
    );
  });

  it("lets World load its glTF textures and meshopt decoder", () => {
    expect(directive(csp, "connect-src")).toContain("blob:");
    expect(directive(csp, "script-src")).toContain("'wasm-unsafe-eval'");
  });

  it("keeps 'unsafe-inline' for World's runtime styles", () => {
    expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
  });
});

it("World's page has no inline <style> for Tauri to nonce (a nonce turns off 'unsafe-inline')", () => {
  expect(worldHtml).not.toMatch(/<style[\s>]/i);
});
