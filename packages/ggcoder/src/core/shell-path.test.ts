import path from "node:path";
import { describe, expect, it } from "vitest";
import { countAddedPathDirs } from "./shell-path.js";

const join = (...dirs: string[]) => dirs.join(path.delimiter);

describe("countAddedPathDirs", () => {
  it("counts directories, not characters", () => {
    const before = join("/usr/bin", "/bin");
    const after = join("/opt/homebrew/bin", "/usr/bin", "/bin", "/Users/me/.local/bin");
    expect(countAddedPathDirs(before, after)).toBe(2);
  });

  it("ignores reordering, duplicates and empty entries", () => {
    const before = join("/usr/bin", "", "/bin", "/usr/bin");
    expect(countAddedPathDirs(before, join("/bin", "/usr/bin"))).toBe(0);
    expect(countAddedPathDirs("", join("/bin", "/bin"))).toBe(1);
  });
});
