import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetRadioPlayer,
  recordRadioPlayer,
  reapOrphanedRadioPlayers,
  type PlayerRecord,
} from "./radio-players.js";

const URL_A = "https://ice1.somafm.com/groovesalad-128-mp3";
let dir: string;
let file: string;

function write(records: PlayerRecord[]): void {
  fs.writeFileSync(file, JSON.stringify(records));
}
function read(): PlayerRecord[] {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as PlayerRecord[]) : [];
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-radio-players-"));
  file = path.join(dir, "radio-players.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("radio player records", () => {
  it("records and forgets this process's players", () => {
    recordRadioPlayer(111, URL_A, { file });
    expect(read()).toEqual([{ pid: 111, ownerPid: process.pid, url: URL_A }]);
    forgetRadioPlayer(111, { file });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("kills an orphaned player still playing its station", async () => {
    write([{ pid: 222, ownerPid: 999_001, url: URL_A }]);
    const killTree = vi.fn();
    const killed = await reapOrphanedRadioPlayers({
      file,
      isAlive: (pid) => pid === 222,
      commandLine: async () => `ffplay -nodisp ${URL_A}`,
      killTree,
    });
    expect(killed).toEqual([222]);
    expect(killTree).toHaveBeenCalledWith(222);
    expect(read()).toEqual([]);
  });

  it("never kills a reused PID that isn't playing the recorded station", async () => {
    write([{ pid: 333, ownerPid: 999_002, url: URL_A }]);
    const killTree = vi.fn();
    const killed = await reapOrphanedRadioPlayers({
      file,
      isAlive: (pid) => pid === 333,
      commandLine: async () => "/usr/bin/some-other-program --flag",
      killTree,
    });
    expect(killed).toEqual([]);
    expect(killTree).not.toHaveBeenCalled();
    expect(read()).toEqual([]);
  });

  it("leaves players of a daemon that is still running", async () => {
    write([{ pid: 444, ownerPid: 999_003, url: URL_A }]);
    const killTree = vi.fn();
    const killed = await reapOrphanedRadioPlayers({
      file,
      isAlive: () => true,
      commandLine: async () => URL_A,
      killTree,
    });
    expect(killed).toEqual([]);
    expect(killTree).not.toHaveBeenCalled();
    expect(read()).toHaveLength(1);
  });

  it("ignores a corrupt record file", async () => {
    fs.writeFileSync(file, "not json");
    await expect(reapOrphanedRadioPlayers({ file, killTree: vi.fn() })).resolves.toEqual([]);
  });
});
