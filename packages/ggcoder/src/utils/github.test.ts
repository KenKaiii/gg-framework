import { describe, expect, it } from "vitest";
import { parseGitHubSlug } from "./github.js";

describe("parseGitHubSlug", () => {
  it("parses https remotes", () => {
    expect(parseGitHubSlug("https://github.com/kenkaiiii/gg-coder")).toBe("kenkaiiii/gg-coder");
    expect(parseGitHubSlug("https://github.com/kenkaiiii/gg-coder.git")).toBe("kenkaiiii/gg-coder");
    expect(parseGitHubSlug("https://user@github.com/o/r.git")).toBe("o/r");
    expect(parseGitHubSlug("http://github.com/o/r/")).toBe("o/r");
  });

  it("parses ssh remotes", () => {
    expect(parseGitHubSlug("git@github.com:kenkaiiii/gg-coder.git")).toBe("kenkaiiii/gg-coder");
    expect(parseGitHubSlug("git@github.com:o/r")).toBe("o/r");
    expect(parseGitHubSlug("ssh://git@github.com/o/r.git")).toBe("o/r");
  });

  it("rejects non-GitHub remotes and junk", () => {
    expect(parseGitHubSlug("https://gitlab.com/o/r.git")).toBeNull();
    expect(parseGitHubSlug("git@bitbucket.org:o/r.git")).toBeNull();
    expect(parseGitHubSlug("https://github.com/onlyowner")).toBeNull();
    expect(parseGitHubSlug("")).toBeNull();
    expect(parseGitHubSlug("not a url")).toBeNull();
  });
});
