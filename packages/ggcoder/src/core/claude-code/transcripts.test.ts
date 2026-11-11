import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeCodeTranscriptExists,
  holdClaudeCodeTranscript,
  pruneClaudeCodeTranscripts,
} from "./transcripts.js";

const DAY_MS = 86_400_000;
let configDir: string;
let project: string;

async function write(relative: string, ageDays: number): Promise<string> {
  const file = path.join(project, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "x".repeat(100));
  const at = new Date(Date.now() - ageDays * DAY_MS);
  await fs.utimes(file, at, at);
  return file;
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-cc-transcripts-"));
  project = path.join(configDir, "projects", "-tmp-proj");
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("pruneClaudeCodeTranscripts", () => {
  it("deletes an old transcript and keeps a recent one, a live one and everything else", async () => {
    const old = await write("old.jsonl", 8);
    const recent = await write("recent.jsonl", 6);
    const live = await write("live.jsonl", 30);
    const notATranscript = await write("old-notes.json", 30);
    const toolResult = await write(path.join("old", "tool-results", "result.jsonl"), 30);
    const outside = path.join(configDir, "settings.jsonl");
    await fs.writeFile(outside, "{}");
    await fs.utimes(outside, new Date(0), new Date(0));

    const release = holdClaudeCodeTranscript("live");
    try {
      expect(await pruneClaudeCodeTranscripts({ configDir })).toEqual({
        staleFiles: 1,
        deletedFiles: 1,
        freedBytes: 100,
      });
      expect(await exists(old)).toBe(false);
      for (const kept of [recent, live, notATranscript, toolResult, outside]) {
        expect(await exists(kept), kept).toBe(true);
      }
    } finally {
      release();
    }

    // Released (its chat closed), the old live transcript goes on the next pass.
    expect((await pruneClaudeCodeTranscripts({ configDir })).deletedFiles).toBe(1);
    expect(await exists(live)).toBe(false);
  });

  it("does nothing when Claude Code has never run or retention is off", async () => {
    const none = { staleFiles: 0, deletedFiles: 0, freedBytes: 0 };
    expect(await pruneClaudeCodeTranscripts({ configDir })).toEqual(none);
    const old = await write("old.jsonl", 30);
    expect(await pruneClaudeCodeTranscripts({ configDir, maxAgeDays: 0 })).toEqual(none);
    expect(await exists(old)).toBe(true);
  });
});

describe("claudeCodeTranscriptExists", () => {
  it("finds a transcript in any project directory, by exact session id only", async () => {
    await write("abc.jsonl", 0);
    expect(await claudeCodeTranscriptExists(configDir, "abc")).toBe(true);
    expect(await claudeCodeTranscriptExists(configDir, "missing")).toBe(false);
    expect(await claudeCodeTranscriptExists(configDir, "../-tmp-proj/abc")).toBe(false);
    expect(await claudeCodeTranscriptExists(configDir, "")).toBe(false);
  });
});
