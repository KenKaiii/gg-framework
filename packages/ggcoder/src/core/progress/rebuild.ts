// One-time retroactive seeding from the existing ~/.gg/sessions store. Runs only when
// both progress.json and its backup are absent — existing users open the update already
// ranked instead of starting at Lurker.

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { getAppPaths } from "@kenkaiiii/gg-core";
import { xpForLevel } from "./ranks.js";
import { createEmptyProgress, dayKey } from "./store.js";
import type { ProgressFile } from "./types.js";

// Grandfathered XP spreads across a curve instead of clamping everyone onto one level.
// Full credit up to the level-15 floor; historical usage beyond that keeps earning at a
// diminished rate (mirrors the engine's DAILY_OVERCAP_FACTOR) so heavy prior users land
// anywhere from 15 up to a hard ceiling instead of all piling on exactly level 15.
const SEED_SOFT_CAP_LEVEL = 15;
const SEED_HARD_CAP_LEVEL = 25;
const SEED_OVERCAP_FACTOR = 0.25;
const XP_PER_HISTORICAL_PROMPT = 10;

/** Seed XP from a historical prompt count: full credit to level 15, 25% beyond, hard-capped at 25. */
export function seedXpForPrompts(totalPrompts: number): number {
  const softCap = xpForLevel(SEED_SOFT_CAP_LEVEL);
  const hardCap = xpForLevel(SEED_HARD_CAP_LEVEL);
  const raw = totalPrompts * XP_PER_HISTORICAL_PROMPT;
  const full = Math.min(raw, softCap);
  const overflow = Math.max(0, raw - softCap);
  return Math.min(hardCap, Math.round(full + overflow * SEED_OVERCAP_FACTOR));
}

interface SessionScan {
  userPrompts: number;
  oldestTimestamp: string | null;
}

/** Count user prompts + find the session header timestamp in one JSONL pass. */
function scanSessionFile(file: string): Promise<SessionScan> {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let userPrompts = 0;
    let oldestTimestamp: string | null = null;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve({ userPrompts, oldestTimestamp });
      rl.close();
      stream.destroy();
    };
    rl.on("line", (line) => {
      if (done || !line) return;
      try {
        const p = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          message?: { role?: string };
        };
        if (p.type === "session" && p.timestamp && !oldestTimestamp) {
          oldestTimestamp = p.timestamp;
        } else if (p.type === "message" && p.message?.role === "user") {
          userPrompts++;
        }
      } catch {
        // skip malformed line
      }
    });
    rl.on("close", finish);
    rl.on("error", finish);
    stream.on("error", finish);
  });
}

/**
 * Rebuild a progress file from session history. Returns null when there is no
 * history at all (fresh install → start at Lurker via createEmptyProgress).
 */
export async function rebuildFromSessions(sessionsDir?: string): Promise<ProgressFile | null> {
  const dir = sessionsDir ?? getAppPaths().sessionsDir;
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(dir);
  } catch {
    return null;
  }

  let totalPrompts = 0;
  let projectCount = 0;
  let oldest: string | null = null;

  for (const entry of projectDirs) {
    const projectDir = path.join(dir, entry);
    let files: string[];
    try {
      files = (await fs.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let projectPrompts = 0;
    for (const f of files) {
      const scan = await scanSessionFile(path.join(projectDir, f));
      projectPrompts += scan.userPrompts;
      if (scan.oldestTimestamp && (!oldest || scan.oldestTimestamp < oldest)) {
        oldest = scan.oldestTimestamp;
      }
    }
    if (projectPrompts > 0) {
      totalPrompts += projectPrompts;
      projectCount++;
    }
  }

  if (totalPrompts === 0) return null;

  const now = new Date();
  const file = createEmptyProgress(now);
  const seeded = seedXpForPrompts(totalPrompts);

  file.xp = seeded;
  file.totals.prompts = totalPrompts;
  // Historical projects are counted but their paths aren't rehashed — use opaque markers.
  file.totals.projects = Array.from({ length: projectCount }, (_, i) => `seed-${i}`);
  file.xpBySource.prompts = seeded;
  if (oldest) file.createdAt = oldest;
  // Seeding is not "activity today" — leave streak at zero, but keep dayXp clean.
  file.rolling.dayKey = dayKey(now);
  return file;
}
