import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

describe("gg-boss Ink dependency", () => {
  it("pins Ink to match GG Coder", () => {
    // Compare against ggcoder's actual spec instead of a hardcoded version:
    // both packages must resolve the SAME ink build (now the published
    // @kenkaiiii/ink fork via an npm alias) or their TUIs render differently.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageJson;
    const ggcoderPkg = JSON.parse(
      readFileSync(new URL("../../ggcoder/package.json", import.meta.url), "utf8"),
    ) as PackageJson;

    const ours = pkg.dependencies?.ink ?? pkg.devDependencies?.ink;
    const ggcoders = ggcoderPkg.dependencies?.ink ?? ggcoderPkg.devDependencies?.ink;
    expect(ours).toBeDefined();
    expect(ours).toBe(ggcoders);
  });
});
