import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pruneOnnxRuntimePayloads } from "./prune-native-payloads.mjs";

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeNodeModules(abi, targets) {
  const root = mkdtempSync(join(tmpdir(), "prune-native-test-"));
  tempDirs.push(root);
  for (const target of targets) {
    const dir = join(root, "onnxruntime-node", "bin", abi, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "onnxruntime_binding.node"), "x");
  }
  return root;
}

const ALL = ["darwin/arm64", "darwin/x64", "linux/x64", "linux/arm64", "win32/x64", "win32/arm64"];

describe("pruneOnnxRuntimePayloads", () => {
  it.each(["napi-v3", "napi-v6"])("keeps only the target platform under %s", (abi) => {
    const root = fakeNodeModules(abi, ALL);

    expect(pruneOnnxRuntimePayloads(root, "darwin", "arm64")).toEqual([abi]);

    const runtimes = join(root, "onnxruntime-node", "bin", abi);
    expect(readdirSync(runtimes)).toEqual(["darwin"]);
    expect(readdirSync(join(runtimes, "darwin"))).toEqual(["arm64"]);
    expect(existsSync(join(runtimes, "darwin", "arm64", "onnxruntime_binding.node"))).toBe(true);
  });

  it("fails loudly when the binaries are not under bin/napi-v*", () => {
    const root = fakeNodeModules("prebuilds", ALL);
    expect(() => pruneOnnxRuntimePayloads(root, "linux", "x64")).toThrow(/layout changed/);
  });

  it("fails when the target platform has no payload", () => {
    const root = fakeNodeModules("napi-v6", ["linux/x64"]);
    expect(() => pruneOnnxRuntimePayloads(root, "win32", "arm64")).toThrow(/win32\/arm64/);
  });

  it("does nothing when onnxruntime-node was not copied", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-native-test-"));
    tempDirs.push(root);
    expect(pruneOnnxRuntimePayloads(root)).toEqual([]);
  });
});
