import { describe, expect, it } from "vitest";
import { editTargetLabel, editTargetPaths } from "./edit-targets.js";

describe("editTargetPaths", () => {
  it.each([
    ["single-file form", { file_path: "a.ts", edits: [] }, ["a.ts"]],
    [
      "multi-file form",
      { files: [{ file_path: "a.ts" }, { file_path: "b.ts" }] },
      ["a.ts", "b.ts"],
    ],
    [
      "malformed entries skipped",
      { files: [{ file_path: "a.ts" }, null, { file_path: 3 }] },
      ["a.ts"],
    ],
    ["no args", undefined, []],
    ["empty path", { file_path: "" }, []],
  ])("%s", (_label, args, expected) => {
    expect(editTargetPaths(args as Record<string, unknown> | undefined)).toEqual(expected);
  });
});

describe("editTargetLabel", () => {
  it("shows the one file, or the first plus a count", () => {
    expect(editTargetLabel({ file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(
      editTargetLabel({ files: [{ file_path: "src/a.ts" }, { file_path: "src/b.ts" }] }, (p) =>
        p.toUpperCase(),
      ),
    ).toBe("SRC/A.TS +1 more");
    expect(editTargetLabel({})).toBe("");
  });
});
