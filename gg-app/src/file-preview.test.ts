// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { openProjectPath } = vi.hoisted(() => ({ openProjectPath: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath }));

import {
  autoPreviewEnabled,
  closeFilePreview,
  generatedPreviewPaths,
  openFilePreview,
  previewKindOf,
  previewOrOpenPath,
  setAutoPreview,
  subscribeFilePreview,
} from "./file-preview";

afterEach(() => {
  closeFilePreview();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("previewKindOf", () => {
  it("classifies documents by extension", () => {
    expect(previewKindOf("/p/report.MD")).toBe("markdown");
    expect(previewKindOf("out/shot.png")).toBe("image");
    expect(previewKindOf("file:///tmp/a.pdf")).toBe("pdf");
    expect(previewKindOf("C:\\v\\clip.mp4")).toBe("video");
    expect(previewKindOf("/p/logo.svg?v=2")).toBe("image");
  });
  it("leaves code and extensionless files to the editor", () => {
    expect(previewKindOf("src/App.tsx")).toBeNull();
    expect(previewKindOf("Makefile")).toBeNull();
    expect(previewKindOf("/p/.md")).toBe("markdown");
    expect(previewKindOf("README.md:12")).toBeNull();
    expect(previewKindOf("README.md#L3")).toBeNull();
  });
});

describe("previewOrOpenPath", () => {
  it("previews known kinds and opens the rest in the default app", () => {
    const seen = vi.fn();
    const stop = subscribeFilePreview(seen);
    previewOrOpenPath("/p/a.pdf");
    expect(seen).toHaveBeenLastCalledWith("/p/a.pdf");
    expect(openProjectPath).not.toHaveBeenCalled();
    previewOrOpenPath("/p/a.ts");
    expect(openProjectPath).toHaveBeenCalledWith("/p/a.ts");
    openFilePreview("/p/b.md");
    closeFilePreview();
    expect(seen).toHaveBeenLastCalledWith(null);
    stop();
  });
});

describe("auto-open setting", () => {
  it("is on until turned off", () => {
    expect(autoPreviewEnabled()).toBe(true);
    setAutoPreview(false);
    expect(autoPreviewEnabled()).toBe(false);
    setAutoPreview(true);
    expect(autoPreviewEnabled()).toBe(true);
  });
});

describe("generatedPreviewPaths", () => {
  it("takes a written document", () => {
    expect(generatedPreviewPaths("write", { file_path: "/p/report.md" }, "ok")).toEqual([
      "/p/report.md",
    ]);
    expect(generatedPreviewPaths("write", { file_path: "/p/a.ts" }, "ok")).toEqual([]);
  });
  it("ignores bookkeeping in hidden folders", () => {
    expect(generatedPreviewPaths("write", { file_path: "/p/.gg/plans/x.md" }, "")).toEqual([]);
    expect(
      generatedPreviewPaths("write", { file_path: "/Users/me/.gg/goals/g/MEMORY.md" }, ""),
    ).toEqual([]);
  });
  it("finds a rendered pdf or video in command output, never mentioned text", () => {
    const out = "Rendered /tmp/out/launch.mp4 (3s)\nsee /p/README.md and /tmp/out/launch.mp4";
    expect(generatedPreviewPaths("bash", {}, out)).toEqual(["/tmp/out/launch.mp4"]);
    expect(generatedPreviewPaths("bash", {}, "wrote report.pdf")).toEqual([]);
    expect(generatedPreviewPaths("read", {}, "/tmp/a.pdf")).toEqual([]);
  });
});
