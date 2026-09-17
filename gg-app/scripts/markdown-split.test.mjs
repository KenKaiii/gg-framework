import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps rich-text rendering outside startup and production JS chunks below the warning limit", () => {
  const out = mkdtempSync(path.join(tmpdir(), "gg-markdown-split-"));
  try {
    const build = spawnSync("pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      // Vitest sets NODE_ENV=test; measure the shipped React build instead.
      env: { ...process.env, NODE_ENV: "production" },
      timeout: 30_000,
    });
    expect(build.error).toBeUndefined();
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(out, ".vite/manifest.json"), "utf8"));
    expect(manifest["src/MarkdownRenderer.tsx"].isDynamicEntry).toBe(true);
    const initial = new Set();
    function visit(key) {
      if (initial.has(key)) return;
      initial.add(key);
      for (const imported of manifest[key].imports ?? []) visit(imported);
    }
    for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
    expect(initial.has("src/MarkdownRenderer.tsx")).toBe(false);
    for (const chunk of Object.values(manifest)) {
      if (chunk.file.endsWith(".js"))
        expect(statSync(path.join(out, chunk.file)).size, chunk.file).toBeLessThanOrEqual(500_000);
    }
    const initialBytes = [...initial].reduce(
      (bytes, key) => bytes + statSync(path.join(out, manifest[key].file)).size,
      0,
    );
    expect(initialBytes).toBeLessThan(600_000);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 35_000);
