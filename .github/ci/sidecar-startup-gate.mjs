#!/usr/bin/env node
// sidecar-startup-gate — time from spawning packages/ggcoder/dist/app-sidecar.js
// to its GG_APP_LISTENING handshake (median of 3, throwaway HOME). The CLI
// gate (startup-gate.mjs) never loads the sidecar's boot path. The ceiling is a
// generous absolute 20s so the blocking Windows leg is not flaky; it catches
// pathological regressions (e.g. a blocking shell/network call before listen).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIDECAR = path.join(REPO_ROOT, "packages/ggcoder/dist/app-sidecar.js");
const RUNS = 3;
const CEILING_MS = 20_000;

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function once() {
  const home = mkdtempSync(path.join(os.tmpdir(), "gg-sidecar-gate-"));
  const started = performance.now();
  const child = spawn(process.execPath, [SIDECAR], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GG_APP_PORT: "0", GG_APP_CWD: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let exited = false;
  const exitPromise = new Promise((resolve) => child.on("exit", () => resolve((exited = true))));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no GG_APP_LISTENING")), CEILING_MS * 2);
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        if (/GG_APP_LISTENING \d+/.test(out)) {
          clearTimeout(timer);
          resolve(performance.now() - started);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar exited ${code} before listening`));
      });
    });
  } finally {
    killTree(child);
    if (!exited) await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
    // Windows: files stay held until the tree is gone; tolerate EBUSY.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}

const samples = [];
for (let i = 0; i < RUNS; i++) samples.push(await once());
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const ok = median <= CEILING_MS;
console.log(
  `startup sidecar listening: median ${median.toFixed(0)}ms (ceiling ${CEILING_MS}ms) ${ok ? "ok" : "FAIL"}`,
);
if (!ok) process.exit(1);
