import { describe, expect, it } from "vitest";
import { gitignoreDirGlobs } from "./find.js";

describe("gitignoreDirGlobs", () => {
  it("prunes unanchored, anchored and dir-only lines", () => {
    expect(gitignoreDirGlobs(["dist/", "/bench/", "target", "a/b"])).toEqual([
      "**/dist/*/**",
      "**/dist/.*/**",
      "bench/*/**",
      "bench/.*/**",
      "**/target/**",
      "a/b/**",
    ]);
  });
  it("disables pruning when any negation exists", () => {
    expect(gitignoreDirGlobs(["dist/", "!dist/keep"])).toEqual([]);
  });
  it("skips escapes, whitespace and bare wildcards", () => {
    expect(gitignoreDirGlobs(["a\\ b", "x y", "*", "/", "**"])).toEqual([]);
  });
});
