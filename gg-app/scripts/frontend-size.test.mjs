import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root;
let dist;
let manifest;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "gg-frontend-size-"));
  dist = path.join(root, "gg-app/dist");
  mkdirSync(path.join(root, ".github/ci/baseline"), { recursive: true });
  mkdirSync(path.join(dist, ".vite"), { recursive: true });
  copyFileSync(
    new URL("../../.github/ci/size-gate.mjs", import.meta.url),
    path.join(root, ".github/ci/size-gate.mjs"),
  );
  writeFileSync(
    path.join(root, ".github/ci/baseline/sizes.json"),
    // The real file also carries the other artifacts and the startup gate's
    // entry: a re-baseline here must leave those as they are.
    JSON.stringify({
      artifacts: { "frontend:initial": { bytes: 35_000 }, sidecar: { bytes: 1 } },
      startup: { "cli-version": { ms: 12 } },
    }),
  );
  manifest = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["shared", "bridge"],
      dynamicImports: ["notes"],
    },
    shared: { file: "shared.js", imports: ["index.html"] },
    bridge: { file: "bridge.js", imports: ["shared"] },
    notes: { file: "notes.js" },
  };
  for (const [file, bytes] of Object.entries({
    "entry.js": 10_000,
    "shared.js": 20_000,
    "bridge.js": 5_000,
    "notes.js": 99_000,
  })) {
    writeFileSync(path.join(dist, file), Buffer.alloc(bytes));
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runGate(...flags) {
  writeFileSync(path.join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
  return spawnSync(
    process.execPath,
    [
      path.join(root, ".github/ci/size-gate.mjs"),
      "--only",
      "frontend:initial",
      ...flags,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("bundle-size reporting", () => {
  it("counts shared static chunks once, handles cycles, and excludes lazy notes", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("34.2KB");
  });

  // The budget is the baseline plus max(2%, 10KB): 35,000 + 10,240 here.
  it.each([
    [10_240, "ok"],
    [10_241, "OVER BUDGET"],
  ])("eager growth of %i bytes is %s", (extra, verdict) => {
    manifest.extra = { file: "extra.js" };
    manifest["index.html"].imports.push("extra");
    writeFileSync(path.join(dist, "extra.js"), Buffer.alloc(extra));
    const result = runGate();
    expect(result.status).toBe(verdict === "ok" ? 0 : 1);
    expect(result.stdout).toContain(verdict);
  });

  it("fails CI when the eager bundle outgrows its budget, and says how to re-baseline", () => {
    manifest["index.html"].imports.push("notes");
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OVER BUDGET");
    expect(result.stdout).toContain("+96.7KB");
    // 10,000 + 20,000 + 5,000 + 99,000 bytes, against 35,000 + 10,240.
    expect(result.stderr).toContain(
      "Budget exceeded for frontend:initial: 130.9KB against 44.2KB",
    );
    expect(result.stderr).toContain(
      "node .github/ci/size-gate.mjs --update --only frontend:initial",
    );
  });

  it("re-baselines instead of failing when asked to", () => {
    manifest["index.html"].imports.push("notes");
    const result = runGate("--update");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Baseline updated");
    const recorded = JSON.parse(
      readFileSync(path.join(root, ".github/ci/baseline/sizes.json"), "utf8"),
    );
    expect(recorded.artifacts["frontend:initial"].bytes).toBe(134_000);
    expect(recorded.artifacts.sidecar.bytes).toBe(1);
    expect(recorded.startup["cli-version"].ms).toBe(12);
  });

  it("fails CI when the eager bundle has no baseline to measure against", () => {
    writeFileSync(
      path.join(root, ".github/ci/baseline/sizes.json"),
      JSON.stringify({ artifacts: {} }),
    );
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no baseline (BLOCKING)");
  });

  it.each(["dist:ggcoder", "sidecar"])("reports %s growth without failing CI", (artifact) => {
    const target = artifact === "dist:ggcoder"
      ? path.join(root, "packages/ggcoder/dist/index.js")
      : path.join(root, "gg-app/src-tauri/sidecar/app-sidecar.mjs");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(200_000));
    if (artifact === "sidecar") {
      mkdirSync(path.join(root, "gg-app/src-tauri/sidecar/skills"));
    }
    writeFileSync(
      path.join(root, ".github/ci/baseline/sizes.json"),
      JSON.stringify({ artifacts: { [artifact]: { bytes: 35_000 } } }),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, ".github/ci/size-gate.mjs"), "--only", artifact],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("growth (informational)");
    expect(result.stdout).toContain("+161.1KB");
    expect(result.stderr).toBe("");
  });

  it("fails for an incomplete build instead of reporting a smaller bundle", () => {
    rmSync(path.join(dist, "shared.js"));
    expect(runGate().status).toBe(1);
  });

  it("fails if the manifest has no entry point", () => {
    manifest["index.html"].isEntry = false;
    expect(runGate().status).toBe(1);
  });
});
