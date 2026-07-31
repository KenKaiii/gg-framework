import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import installerHtml from "../installer/dmg.html?raw";
import viteConfigSource from "../vite.config.ts?raw";
import tauriConfig from "../src-tauri/tauri.conf.json";
import updatePolicySource from "./update-policy.ts?raw";

describe("static Supah Coder branding", () => {
  it("brands the web document and installer surfaces", () => {
    expect(indexHtml).toContain("<title>Supah Coder</title>");
    expect(installerHtml).toContain("Supah Coder · the coding agent");
  });

  it("brands local fork build identity", () => {
    expect(viteConfigSource).toContain('const customBuildLabel = "Supah Coder Local Fork"');
  });

  it("pins native identity, installer hook, and official update discovery", () => {
    expect(tauriConfig.productName).toBe("GG Coder");
    expect(tauriConfig.identifier).toBe("com.ggcoder.app");
    expect(tauriConfig.bundle.windows.nsis.installerHooks).toBe("windows/nsis-hooks.nsh");
    expect(tauriConfig.plugins.updater.pubkey).not.toBe("");
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://github.com/KenKaiii/gg-framework/releases/latest/download/latest.json",
    ]);
  });

  it("routes local-patched installation through the source updater", () => {
    expect(updatePolicySource).toContain("await startLocalPatchedUpdate(sourceRoot)");
    expect(updatePolicySource).toContain('return "local-patched"');
  });
});
