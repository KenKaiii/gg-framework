import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { findMotionBundle } from "../core/skills.js";

const run = promisify(execFile);

async function binPath(script: string): Promise<string> {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("motion bundle missing");
  return path.join(bundle.root, "bin", script);
}

/** Run a bundled helper with the current Node; resolves with exit code and output. */
async function runHelper(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [await binPath(script), ...args], {
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-helpers-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("score-synth", () => {
  const score = {
    bpm: 120,
    duration: 8,
    seed: 3,
    chords: ["Am", "F"],
    sections: [
      { name: "intro", from: 0, energy: 0.3 },
      { name: "drop", from: 4, energy: 1 },
    ],
    hits: [
      { beat: 2, sfx: "pop" },
      { bar: 3, sfx: "sting" },
    ],
  };

  it("renders identical music, sfx and a beat-aligned tempo map for the same score", async () => {
    const scorePath = path.join(tmp, "score.json");
    await fs.writeFile(scorePath, JSON.stringify(score));

    const first = await runHelper("score-synth.mjs", [scorePath, path.join(tmp, "a")]);
    const second = await runHelper("score-synth.mjs", [scorePath, path.join(tmp, "b")]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    for (const file of ["music.wav", "sfx.wav"]) {
      const a = await fs.readFile(path.join(tmp, "a", file));
      const b = await fs.readFile(path.join(tmp, "b", file));
      expect(a.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(a.length).toBeGreaterThan(48000 * 2 * 2 * 7);
      expect(a.equals(b)).toBe(true);
    }
    const map = JSON.parse(await fs.readFile(path.join(tmp, "a", "tempo-map.json"), "utf8")) as {
      beats: number[];
      bars: number[];
      hits: { t: number; sfx: string }[];
    };
    expect(map.beats.slice(0, 4)).toEqual([0, 0.5, 1, 1.5]);
    expect(map.bars.slice(0, 3)).toEqual([0, 2, 4]);
    expect(map.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ t: 1, sfx: "pop" }),
        expect.objectContaining({ t: 6, sfx: "sting" }),
      ]),
    );
  });

  /** RMS level in dBFS of the left channel of a 16-bit stereo WAV between two times. */
  async function level(file: string, from: number, to: number): Promise<number> {
    const wav = await fs.readFile(file);
    let sum = 0;
    const first = Math.round(from * 48000);
    const last = Math.round(to * 48000);
    for (let i = first; i < last; i++) sum += (wav.readInt16LE(44 + i * 4) / 32768) ** 2;
    return 10 * Math.log10(sum / (last - first) + 1e-12);
  }

  async function synth(
    body: Record<string, unknown>,
    out: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const scorePath = path.join(tmp, `${out}.json`);
    await fs.writeFile(scorePath, JSON.stringify(body));
    return runHelper("score-synth.mjs", [scorePath, path.join(tmp, out)]);
  }

  it("scores hits from the composition's exported cues, sorted with the score's own", async () => {
    await fs.writeFile(
      path.join(tmp, "cues.json"),
      JSON.stringify({
        version: 1,
        composition: "index.html",
        cues: [
          { t: 2.28, sfx: "impact", gain: 1, pan: 0, name: "landing" },
          { t: 0.4, sfx: "click", gain: 0.6, pan: -0.2 },
        ],
      }),
    );

    const result = await synth({ ...score, cues: "cues.json" }, "cued");

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hits: 4, cueHits: 2, room: "room" });
    const map = JSON.parse(await fs.readFile(path.join(tmp, "cued", "tempo-map.json"), "utf8")) as {
      hits: { t: number; sfx: string; source?: string; name?: string }[];
    };
    expect(map.hits).toEqual([
      { t: 0.4, sfx: "click", source: "cue" },
      { t: 1, sfx: "pop" },
      { t: 2.28, sfx: "impact", source: "cue", name: "landing" },
      { t: 6, sfx: "sting" },
    ]);
  });

  it("puts every sound in one room, and none leaves it dry", async () => {
    const body = { bpm: 120, duration: 4, music: false, hits: [{ t: 1, sfx: "snap" }] };
    expect((await synth({ ...body, room: "none" }, "dry")).code).toBe(0);
    expect((await synth(body, "wet")).code).toBe(0);

    // After the snap itself has died away, only the room's echo is left.
    expect(await level(path.join(tmp, "dry", "sfx.wav"), 1.35, 1.7)).toBeLessThan(-100);
    const tail = await level(path.join(tmp, "wet", "sfx.wav"), 1.35, 1.7);
    const hit = await level(path.join(tmp, "wet", "sfx.wav"), 1, 1.06);
    expect(tail).toBeGreaterThan(-70);
    expect(tail).toBeLessThan(hit - 6);
  });

  it("ducks the music under a heavy hit and barely under a click", async () => {
    const body = {
      bpm: 120,
      duration: 8,
      style: "cinematic",
      room: "none",
      sections: [{ name: "bed", from: 0, energy: 0.6 }],
      hits: [
        { t: 5.1, sfx: "impact" },
        { t: 3.1, sfx: "click" },
      ],
    };
    expect((await synth({ ...body, duck: 1 }, "flat")).code).toBe(0);
    expect((await synth({ ...body, duck: 0.5 }, "ducked")).code).toBe(0);
    const drop = async (from: number, to: number): Promise<number> =>
      (await level(path.join(tmp, "flat", "music.wav"), from, to)) -
      (await level(path.join(tmp, "ducked", "music.wav"), from, to));

    expect(await drop(5.12, 5.4)).toBeGreaterThan(4.5);
    expect(await drop(3.1, 3.2)).toBeLessThan(1.5);
    // Before the hit and once it has released, the bed is untouched.
    expect(Math.abs(await drop(4.6, 5))).toBeLessThan(0.01);
    expect(Math.abs(await drop(6, 6.4))).toBeLessThan(0.01);
  });

  it("plays every material sound at its time and lets it die away", async () => {
    const names = ["tap", "press", "knock", "chime", "thud", "plip", "tick", "snap"];
    for (const sfx of names) {
      expect(
        (
          await synth(
            { bpm: 120, duration: 2, music: false, room: "none", hits: [{ t: 0.5, sfx }] },
            sfx,
          )
        ).code,
      ).toBe(0);
      const file = path.join(tmp, sfx, "sfx.wav");
      // Sounds at its time, silent before it, and has died away within 1.4 s.
      expect(await level(file, 0.1, 0.45), sfx).toBeLessThan(-100);
      expect(await level(file, 0.5, 0.56), sfx).toBeGreaterThan(-40);
      expect(await level(file, 1.9, 2), sfx).toBeLessThan(-60);
    }
  });

  it("keeps close contacts dry and lets distant sounds fill the room", async () => {
    const tailOf = async (sfx: string, send?: number): Promise<number> => {
      const out = `${sfx}-${send ?? "own"}`;
      const hit = { t: 0.5, sfx, ...(send === undefined ? {} : { send }) };
      expect(
        (await synth({ bpm: 120, duration: 3, music: false, room: "hall", hits: [hit] }, out)).code,
      ).toBe(0);
      const file = path.join(tmp, out, "sfx.wav");
      return (await level(file, 1.1, 1.6)) - (await level(file, 0.5, 0.56));
    };

    // The same tap, sent near and far: the far one leaves a much louder tail.
    expect((await tailOf("tap", 0.9)) - (await tailOf("tap", 0.05))).toBeGreaterThan(10);
    // Left to its own distance, a tap sits close.
    expect((await tailOf("tap", 0.9)) - (await tailOf("tap"))).toBeGreaterThan(6);
  });

  it("keeps the stronger of two sounds that land together, and reports the merge", async () => {
    const result = await synth(
      {
        bpm: 120,
        duration: 4,
        music: false,
        hits: [
          { t: 1, sfx: "click" },
          { t: 1.03, sfx: "impact" },
          { t: 1.02, sfx: "riser" },
          { t: 2, sfx: "tap" },
          { t: 2.2, sfx: "tap" },
        ],
      },
      "merge",
    );

    expect(result.code).toBe(0);
    const map = JSON.parse(
      await fs.readFile(path.join(tmp, "merge", "tempo-map.json"), "utf8"),
    ) as {
      hits: { t: number; sfx: string }[];
      merged: { t: number; sfx: string; into: string }[];
    };
    expect(map.hits.map((h) => `${h.t} ${h.sfx}`)).toEqual([
      "1.02 riser",
      "1.03 impact",
      "2 tap",
      "2.2 tap",
    ]);
    expect(map.merged).toEqual([{ t: 1, sfx: "click", into: "impact" }]);
  });

  it("reports hits the music buries and the music volume that frees them", async () => {
    const body = {
      bpm: 120,
      duration: 8,
      style: "pulse",
      sections: [{ name: "loud", from: 0, energy: 1 }],
      duck: 1,
      // The impact sets the effects level, so the quiet key stays quiet.
      hits: [
        { t: 2, sfx: "impact", gain: 1.5 },
        { t: 4.25, sfx: "tap", gain: 0.05, name: "quiet key" },
      ],
    };
    expect((await synth(body, "buried")).code).toBe(0);
    expect(
      (await synth({ ...body, hits: [{ t: 4.25, sfx: "impact", gain: 1.5 }] }, "clear")).code,
    ).toBe(0);
    type Balance = {
      buried: { t: number; sfx: string; name?: string; db: number }[];
      musicVolume: number;
      threshold: number;
    };
    const read = async (dir: string): Promise<Balance> =>
      (
        JSON.parse(await fs.readFile(path.join(tmp, dir, "tempo-map.json"), "utf8")) as {
          balance: Balance;
        }
      ).balance;

    const buried = await read("buried");
    expect(buried.buried).toEqual([
      expect.objectContaining({ t: 4.25, sfx: "tap", name: "quiet key" }),
    ]);
    expect(buried.buried[0]?.db).toBeLessThan(buried.threshold);
    expect(buried.musicVolume).toBeLessThan(1);
    expect(buried.musicVolume).toBeGreaterThanOrEqual(0.2);
    const clear = await read("clear");
    expect(clear).toMatchObject({ buried: [], musicVolume: 1 });
  });

  it("plays a lo-fi bed that leans on swung eighths, the same every time", async () => {
    // 80 bpm: a beat is 0.75 s, so the "and" of beat two lands at 1.2 s when swung
    // and would land at 1.125 s if straight.
    const lofi = {
      bpm: 80,
      duration: 8,
      seed: 2,
      style: "lofi",
      key: "F",
      scale: "major",
      sections: [{ name: "groove", from: 0, energy: 0.8 }],
    };
    expect((await synth(lofi, "lofi-a")).code).toBe(0);
    expect((await synth(lofi, "lofi-b")).code).toBe(0);

    const music = path.join(tmp, "lofi-a", "music.wav");
    expect(
      (await fs.readFile(music)).equals(await fs.readFile(path.join(tmp, "lofi-b", "music.wav"))),
    ).toBe(true);
    // A new sound starts on the swung position: the level jumps across it...
    const rise = async (t: number): Promise<number> =>
      (await level(music, t + 0.012, t + 0.052)) - (await level(music, t - 0.045, t - 0.005));
    expect(await rise(1.2)).toBeGreaterThan(3);
    // ...and nothing starts on the straight one.
    expect(await rise(1.125)).toBeLessThan(1);
    // Vinyl keeps the bed from ever falling to digital silence between notes.
    let quietest = 0;
    for (let t = 0.2; t < 7.5; t += 0.05)
      quietest = Math.min(quietest, await level(music, t, t + 0.02));
    expect(quietest).toBeGreaterThan(-70);
  });

  it("comes home on the first chord and breathes out instead of stopping", async () => {
    const body = {
      bpm: 120,
      duration: 8,
      style: "cinematic",
      room: "none",
      chords: ["Am", "F", "C", "G"],
      sections: [{ name: "bed", from: 0, energy: 0.6 }],
    };
    expect((await synth({ ...body, ending: "cut" }, "cut")).code).toBe(0);
    expect((await synth(body, "resolve")).code).toBe(0);

    const music = (dir: string): string => path.join(tmp, dir, "music.wav");
    // Against its own opening, the resolving ending is far quieter in the last moments.
    const fall = async (dir: string): Promise<number> =>
      (await level(music(dir), 7.6, 7.95)) - (await level(music(dir), 1, 3));
    expect(await fall("resolve")).toBeLessThan((await fall("cut")) - 8);
    const map = JSON.parse(
      await fs.readFile(path.join(tmp, "resolve", "tempo-map.json"), "utf8"),
    ) as {
      ending: string;
    };
    expect(map.ending).toBe("resolve");
  });

  it("turns the camera's motion into air, silent while the camera holds still", async () => {
    const values = Array.from({ length: 4 * 50 + 1 }, (_, i) => (i >= 50 && i < 150 ? 3000 : 0));
    await fs.writeFile(
      path.join(tmp, "cues.json"),
      JSON.stringify({ version: 1, cues: [], air: { rate: 50, start: 0, values } }),
    );
    const body = { bpm: 120, duration: 4, music: false, room: "none", cues: "cues.json" };
    const result = await synth(body, "air");
    expect((await synth({ ...body, air: false }, "still")).code).toBe(0);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).cameraAir).toBeGreaterThan(0.5);
    const file = path.join(tmp, "air", "sfx.wav");
    expect(await level(file, 0.2, 0.9)).toBeLessThan(-100);
    expect(await level(file, 1.5, 2.8)).toBeGreaterThan(-45);
    expect(await level(file, 3.5, 3.9)).toBeLessThan(-100);
    // With the air turned off there is nothing left to write.
    await expect(fs.access(path.join(tmp, "still", "sfx.wav"))).rejects.toThrow();
  });

  it.each([
    [{ ...score, ending: "fade" }, "unknown ending"],
    [{ ...score, hits: [{ t: 1, sfx: "tap", send: 2 }] }, "send must be 0..1"],
    [{ ...score, bpm: 10 }, "bpm"],
    [{ ...score, duration: 0 }, "duration"],
    [{ ...score, hits: [{ t: 1, sfx: "airhorn" }] }, "unknown sfx"],
    [{ ...score, room: "cathedral" }, "unknown room"],
    [{ ...score, duck: 2 }, "duck must be 0..1"],
    [{ ...score, cues: "missing.json" }, "Could not read cues"],
  ])("rejects an invalid score with a clear message (%#)", async (bad, message) => {
    const scorePath = path.join(tmp, "bad.json");
    await fs.writeFile(scorePath, JSON.stringify(bad));

    const result = await runHelper("score-synth.mjs", [scorePath, path.join(tmp, "out")]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it("rejects a cue outside the score or with an unknown sound, naming the cue", async () => {
    for (const [cue, message] of [
      [{ t: 9, sfx: "click", name: "late" }, "cue 0 (late): t 9 is outside"],
      [{ t: 1, sfx: "airhorn" }, 'cue 0: unknown sfx "airhorn"'],
    ] as const) {
      await fs.writeFile(path.join(tmp, "cues.json"), JSON.stringify({ version: 1, cues: [cue] }));
      const result = await synth({ ...score, cues: "cues.json" }, "bad-cue");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
  });

  type Mud = {
    windows: { from: number; to: number; share: number; bus: string }[];
    share: number;
    threshold: number;
  };
  const readMud = async (out: string): Promise<Mud> =>
    (JSON.parse(await fs.readFile(path.join(tmp, out, "tempo-map.json"), "utf8")) as { mud: Mud })
      .mud;

  it("flags the low-mid pile-up of a deliberately muddy score in its own windows", async () => {
    const hits = Array.from({ length: 17 }, (_, i) => ({
      t: Number((4 + i * 0.06).toFixed(2)),
      sfx: "knock",
      send: 1,
    }));
    const body = { style: "minimal", bpm: 100, duration: 8, key: "A", room: "none", hits };
    expect((await synth(body, "mud-a")).code).toBe(0);
    expect((await synth(body, "mud-b")).code).toBe(0);
    const mud = await readMud("mud-a");
    expect(mud).toEqual(await readMud("mud-b"));
    expect(mud.windows.map((w) => w.from)).toEqual([4, 4.5]);
    for (const w of mud.windows) {
      expect(w.bus).toBe("effects");
      expect(w.share).toBeGreaterThan(mud.threshold);
    }
    expect(mud.share).toBeGreaterThan(0.2);
  });

  it.each(["pulse", "cinematic", "minimal", "lofi"])(
    "keeps a normal %s score clear of mud",
    async (style) => {
      expect((await synth({ ...score, style, duration: 6 }, `clean-${style}`)).code).toBe(0);
      const mud = await readMud(`clean-${style}`);
      expect(mud.windows).toEqual([]);
      expect(mud.share).toBeLessThan(mud.threshold);
    },
  );
});

describe("motion-check rendered-pixel gate", () => {
  const progress = "frame=80\nout_time_us=10000000\nprogress=end\n";

  async function analyze(
    text: string,
    slideshowRequested = false,
    holds: unknown = [],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const script = `
      import { pathToFileURL } from 'node:url';
      const { parseMotionOutput } = await import(pathToFileURL(process.argv[1]).href);
      const { text, slideshowRequested, holds } = JSON.parse(process.argv[2]);
      const result = parseMotionOutput(text, slideshowRequested, holds);
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    `;
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          await binPath("motion-check.mjs"),
          JSON.stringify({ text, slideshowRequested, holds }),
        ],
        { timeout: 10_000 },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("accepts a complete moving-pixel decode without a DOM motion spec", async () => {
    const result = await analyze(progress);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      method: "rendered-pixels",
      samples: 80,
      duration: 10,
      visualReviewRequired: true,
    });
  });

  it("rejects a frozen opening even when the rest moves", async () => {
    const result = await analyze(
      "lavfi.freezedetect.freeze_start=0\nlavfi.freezedetect.freeze_duration=3\nlavfi.freezedetect.freeze_end=3\n" +
        progress,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      freezes: [{ start: 0, end: 3, duration: 3 }],
    });
  });

  it("rejects a frozen ending with no freeze_end event", async () => {
    const result = await analyze("lavfi.freezedetect.freeze_start=7\n" + progress);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      freezes: [{ start: 7, end: 10, duration: 3 }],
    });
  });

  it.each([
    "",
    "frame=0\nout_time_us=0\nprogress=end\n",
    "frame=80\nout_time_us=10000000\nprogress=continue\n",
    "frame=NaN\nout_time_us=10000000\nprogress=end\n",
    "lavfi.freezedetect.freeze_start=oops\n" + progress,
    "lavfi.freezedetect.freeze_start=20\n" + progress,
    "lavfi.freezedetect.freeze_duration=3\n" + progress,
    "lavfi.freezedetect.freeze_end=3\n" + progress,
    "frame=80\nout_time_us=1000000000\nprogress=end\n",
    JSON.stringify({ ok: true, motion: { enabled: false, samples: 0 } }),
  ])("rejects missing, truncated or malformed evidence (%#)", async (text) => {
    const result = await analyze(text);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("error");
  });

  it("allows an explicitly requested slideshow but never skipped analysis", async () => {
    const allowed = await analyze("lavfi.freezedetect.freeze_start=0\n" + progress, true);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({
      slideshowRequested: true,
      freezes: [{ start: 0, end: 10, duration: 10 }],
    });
    const skipped = await analyze("", true);
    expect(skipped.code).toBe(1);
  });

  it("accepts a declared reading pause and reports it without hiding pixel evidence", async () => {
    const hold = { start: 7, end: 10, reason: "Read the final phrase" };
    const result = await analyze("lavfi.freezedetect.freeze_start=7\n" + progress, false, [hold]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      holds: [hold],
      freezes: [{ start: 7, end: 10, duration: 3 }],
      unexpectedFreezes: [],
      visualReviewRequired: true,
    });
  });

  it("still rejects a freeze outside a declared hold", async () => {
    const result = await analyze("lavfi.freezedetect.freeze_start=5\n" + progress, false, [
      { start: 7, end: 10, reason: "Read the final phrase" },
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      unexpectedFreezes: [{ start: 5, end: 10, duration: 5 }],
    });
  });

  it.each([
    null,
    [{ start: 7, end: 10, reason: "" }],
    [{ start: 7, end: 10, reason: "  " }],
    [{ start: "7", end: 10, reason: "Read" }],
    [{ start: 7, end: 11, reason: "Read" }],
    [{ start: -1, end: 10, reason: "Read" }],
    [{ start: 0, end: 10, reason: "Everything is a hold" }],
    [{ start: 10, end: 7, reason: "Read" }],
    [{ start: 7, end: 10, reason: "Read", ignoreAll: true }],
    [
      { start: 6, end: 9, reason: "Read" },
      { start: 7, end: 10, reason: "Read" },
    ],
  ])("rejects malformed, unbounded or overlapping hold declarations (%#)", async (holds) => {
    const result = await analyze("lavfi.freezedetect.freeze_start=7\n" + progress, false, holds);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("error");
  });

  it("names a stale hold and where pixels actually freeze so the plan is fixed once", async () => {
    const stale = { start: 1, end: 2.5, reason: "Read the premise" };
    const kept = { start: 6, end: 10, reason: "Final payoff" };
    const result = await analyze("lavfi.freezedetect.freeze_start=5.5\n" + progress, false, [
      stale,
      kept,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "Stale hold declaration: no detected freeze overlaps its window",
      staleHolds: [stale],
      freezes: [{ start: 5.5, end: 10, duration: 4.5 }],
    });
  });

  it("rejects stale hold declarations and incomplete analysis even with holds", async () => {
    const holds = [{ start: 7, end: 10, reason: "Read the final phrase" }];
    for (const text of [progress, "frame=80\nout_time_us=10000000\nprogress=continue\n"]) {
      const result = await analyze(text, false, holds);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toHaveProperty("error");
    }
  });

  it.each([
    ["{", "JSON"],
    [" ".repeat(64 * 1024 + 1), "exceeds 64 KiB"],
    [JSON.stringify({ version: 2, holds: [] }), "Expected hold plan version 1"],
    [
      JSON.stringify({
        version: 1,
        videoSha256: "0".repeat(64),
        holds: [{ start: 7, end: 10, reason: "Read" }],
      }),
      "different render",
    ],
  ])("rejects invalid or wrong-render hold files before decoding (%#)", async (content, error) => {
    const video = path.join(tmp, "render.mp4");
    const holds = path.join(tmp, "holds.json");
    await fs.writeFile(video, "not decoded in this boundary test");
    await fs.writeFile(holds, content);
    // If validation accidentally reaches FFmpeg, Node cannot decode this input.
    // The assertion requires the specific pre-decode validation error instead.
    const result = await runHelper("motion-check.mjs", [video, "--holds", holds], {
      ...process.env,
      HYPERFRAMES_FFMPEG_PATH: process.execPath,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(error);
  });

  it("rejects missing files and the obsolete report/spec interface", async () => {
    const missing = await runHelper("motion-check.mjs", [path.join(tmp, "missing.mp4")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Motion verification failed");
    const obsolete = await runHelper("motion-check.mjs", ["check.json", "index.motion.json"]);
    expect(obsolete.code).toBe(1);
    expect(obsolete.stderr).toContain("usage: motion-check.mjs");
  });
});

// Real FFmpeg encodes and decodes; the Windows runner has stretched these well past 5 s.
describe("flash-check (WCAG 2.3.1)", { timeout: 60_000 }, () => {
  const flashReport = z.object({
    ok: z.boolean(),
    general: z.object({ maxFlashesPerSecond: z.number() }),
    red: z.object({ maxFlashesPerSecond: z.number() }),
  });
  // Black/white levels in limited-range video, as rendered exports encode them.
  const swap = (hz: number, area = "1") =>
    `color=c=black:s=320x180:r=30:d=3,geq=lum='if(lt(mod(T*${hz},1),0.5)*${area},235,16)':cb=128:cr=128`;
  it.each([
    { name: "one full-frame flash a second", source: swap(1), ok: true, general: 1 },
    { name: "three full-frame flashes a second", source: swap(3), ok: true, general: 3 },
    { name: "four full-frame flashes a second", source: swap(4), ok: false, general: 4 },
    {
      name: "a flash filling one corner of the frame",
      source: swap(5, "between(X,0,110)*between(Y,0,62)"),
      ok: false,
      general: 5,
    },
    {
      name: "a small flashing patch (about 2% of the frame)",
      source: swap(5, "between(X,140,180)*between(Y,75,105)"),
      ok: true,
      general: 0,
    },
    {
      name: "a light pulse that never gets dark",
      source:
        "color=c=black:s=320x180:r=30:d=3,geq=lum='if(lt(mod(T*5,1),0.5),235,222)':cb=128:cr=128",
      ok: true,
      general: 0,
    },
    {
      name: "fast camera-style motion",
      source: "testsrc2=s=320x180:r=60:d=3,scroll=h=0.02",
      ok: true,
    },
    {
      name: "saturated red flashing",
      source:
        "color=c=black:s=320x180:r=30:d=3,geq=r='if(lt(mod(T*5,1),0.5),255,0)':g=0:b=0,format=yuv420p",
      ok: false,
      red: 5,
    },
  ])("$name", async ({ source, ok, general, red }) => {
    const video = path.join(tmp, "video.mp4");
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      source,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    const result = await runHelper("flash-check.mjs", [video]);
    const report = flashReport.parse(JSON.parse(result.stdout));
    expect(report.ok).toBe(ok);
    expect(result.code).toBe(ok ? 0 : 1);
    if (general !== undefined) expect(report.general.maxFlashesPerSecond).toBe(general);
    if (red !== undefined) expect(report.red.maxFlashesPerSecond).toBe(red);
  });
  it("rejects a missing file instead of reporting it safe", async () => {
    const result = await runHelper("flash-check.mjs", [path.join(tmp, "missing.mp4")]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Flash verification failed");
  });
});

describe("hyperframes launcher", () => {
  it("refuses skill installs so bundled skills never drift", async () => {
    const result = await runHelper("hyperframes.mjs", ["skills", "update"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("bundled with GG Motion");
  });

  it("runs the pinned CLI version the skills were bundled for", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");

    const result = await runHelper("hyperframes.mjs", ["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(bundle.version);
  });

  it("keeps the privacy opt-outs in the launcher source", async () => {
    const source = await fs.readFile(await binPath("hyperframes.mjs"), "utf8");

    expect(source).toContain('"--describe", "false"');
    expect(source).toContain('"--skip-vision"');
    expect(source).toContain("HYPERFRAMES_NO_TELEMETRY");
    // `add` would otherwise overwrite whatever the user had copied.
    expect(source).toContain('[...args, "--no-clipboard"]');
  });
});

describe("contact-sheet", () => {
  it("fails clearly when the frames folder is missing", async () => {
    const result = await runHelper("contact-sheet.mjs", [
      path.join(tmp, "nope"),
      path.join(tmp, "sheet.jpg"),
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Frames folder not found");
  });
});

describe("reveal", () => {
  type Reveal = { ok: boolean; revealed?: string; cmd?: string; args?: string[]; error?: string };
  const parse = (stdout: string): Reveal => JSON.parse(stdout) as Reveal;

  it.each([
    ["darwin", "open", (file: string) => ["-R", file]],
    ["win32", "explorer.exe", (file: string) => [`/select,"${file}"`]],
    ["linux", "xdg-open", (file: string) => [path.dirname(file)]],
  ])("selects a finished video in the %s file manager", async (platform, cmd, expected) => {
    // A space in the folder name, as in the real "GG Motion" workspace.
    const file = path.join(tmp, "GG Motion", "brag.mp4");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "");

    const result = await runHelper("reveal.mjs", [file, "--dry-run", "--platform", platform]);

    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toMatchObject({
      ok: true,
      revealed: file,
      cmd,
      args: expected(file),
    });
  });

  it("opens a folder itself rather than its parent", async () => {
    const result = await runHelper("reveal.mjs", [tmp, "--dry-run", "--platform", "darwin"]);

    expect(parse(result.stdout)).toMatchObject({ ok: true, cmd: "open", args: [tmp] });
  });

  it("reports a missing file instead of opening anything", async () => {
    const result = await runHelper("reveal.mjs", [path.join(tmp, "nope.mp4"), "--dry-run"]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout)).toMatchObject({ ok: false });
    expect(parse(result.stdout).error).toContain("Not found");
  });

  it("only accepts a platform override on a dry run", async () => {
    const result = await runHelper("reveal.mjs", [tmp, "--platform", "linux"]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout).error).toContain("only works with --dry-run");
  });
});

describe("fonts", () => {
  type FontsResult = {
    ok: boolean;
    error?: string;
    specimen?: string;
    families?: Array<{ family: string; use?: string }>;
    installed?: string[];
    head?: string;
  };
  const parse = (stdout: string): FontsResult => JSON.parse(stdout) as FontsResult;

  it("ships every listed family with its woff2 files and OFL license", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const manifest = JSON.parse(
      await fs.readFile(path.join(bundle.root, "fonts", "fonts.json"), "utf8"),
    ) as Array<{ family: string; dir: string; license: string; files: Array<{ file: string }> }>;

    expect(manifest.length).toBeGreaterThanOrEqual(12);
    for (const entry of manifest) {
      expect(entry.license).toBe("OFL-1.1");
      const license = await fs.readFile(
        path.join(bundle.root, "fonts", entry.dir, "OFL.txt"),
        "utf8",
      );
      expect(license).toContain("SIL Open Font License");
      for (const file of entry.files) {
        const bytes = await fs.readFile(path.join(bundle.root, "fonts", entry.dir, file.file));
        // woff2 magic number: every file must be a real font, not an HTML error page.
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      }
    }
    const list = parse((await runHelper("fonts.mjs", ["list"])).stdout);
    expect(list.families?.map((f) => f.family)).toEqual(manifest.map((f) => f.family));
    // Title, body and handwritten faces the product asked for, each with a usage hint.
    for (const family of ["Unbounded", "Sora", "Short Stack", "Finger Paint"]) {
      expect(list.families?.find((f) => f.family === family)?.use).toBeTruthy();
    }
    await expect(fs.access(list.specimen ?? "")).resolves.toBeUndefined();
  });

  it("installs chosen families into a project and keeps earlier ones", async () => {
    const first = await runHelper("fonts.mjs", ["add", tmp, "mona sans", "Fraunces"]);
    const second = await runHelper("fonts.mjs", ["add", tmp, "Martian Mono"]);

    expect(first.code).toBe(0);
    expect(parse(second.stdout).installed).toEqual(["Mona Sans", "Fraunces", "Martian Mono"]);
    // The page-ready block uses paths from the project folder and covers every installed family.
    const head = parse(second.stdout).head ?? "";
    expect(head).toMatch(/^<style>\n[\s\S]*\n<\/style>$/);
    expect(head).toContain('url("assets/fonts/fraunces/fraunces-italic.woff2")');
    for (const family of ["Mona Sans", "Fraunces", "Martian Mono"]) {
      expect(head).toContain(`font-family: "${family}";`);
    }
    const css = await fs.readFile(path.join(tmp, "assets", "fonts", "fonts.css"), "utf8");
    expect(css).toContain('font-family: "Mona Sans";');
    expect(css).toContain("font-stretch: 75% 125%;");
    expect(css).toContain('url("fraunces/fraunces-italic.woff2")');
    expect(css).toContain('font-family: "Martian Mono";');
    await expect(
      fs.access(path.join(tmp, "assets", "fonts", "mona-sans", "OFL.txt")),
    ).resolves.toBeUndefined();
  });

  it("rejects families outside the bundle instead of writing anywhere", async () => {
    const result = await runHelper("fonts.mjs", ["add", tmp, "../../etc"]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout).error).toContain("Unknown family");
    await expect(fs.access(path.join(tmp, "assets"))).rejects.toThrow();
  });
});

describe("three", () => {
  type ThreeResult = {
    ok: boolean;
    error?: string;
    version?: string;
    installed?: string;
    addons?: string[];
    importmap?: string;
  };
  const parse = (stdout: string): ThreeResult => JSON.parse(stdout) as ThreeResult;

  it("vendors a self-contained Three.js whose addon imports all resolve offline", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const root = path.join(bundle.root, "vendor", "three");
    const manifest = JSON.parse(await fs.readFile(path.join(root, "three.json"), "utf8")) as {
      version: string;
      addons: string[];
    };

    await expect(fs.readFile(path.join(root, "LICENSE"), "utf8")).resolves.toContain("MIT");
    const core = await fs.readFile(path.join(root, "build", "three.module.min.js"), "utf8");
    expect(core).toContain(manifest.version.replace(/^0\./, "").split(".")[0] ?? "");
    for (const addon of manifest.addons) {
      const file = path.join(root, "addons", addon);
      // Doc comments quote example imports (`three/addons/...`); only real
      // import statements matter.
      const source = (await fs.readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Addons may import only "three" (the importmap) or files that ship
      // beside them; anything else would fetch from the network or 404.
      for (const match of source.matchAll(
        /^\s*(?:import|export)\s+(?:[^;]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
      )) {
        const spec = match[1] ?? "";
        if (spec === "three" || spec === "three/webgpu" || spec === "three/tsl") {
          expect(spec, `${addon} imports ${spec}`).toBe("three");
          continue;
        }
        expect(spec.startsWith("."), `${addon} imports ${spec}`).toBe(true);
        await expect(
          fs.access(path.join(path.dirname(file), spec)),
          `${addon} → ${spec}`,
        ).resolves.toBeUndefined();
      }
    }
  });

  it("installs the library into a project with an importmap that points at it", async () => {
    const result = await runHelper("three.mjs", ["add", tmp]);
    const out = parse(result.stdout);

    expect(result.code).toBe(0);
    expect(out.version).toBe("0.181.2");
    expect(out.importmap).toContain('"three": "./assets/vendor/three/build/three.module.min.js"');
    expect(out.importmap).not.toMatch(/https?:/);
    for (const rel of ["build/three.module.min.js", "build/three.core.min.js", "LICENSE"]) {
      await expect(
        fs.access(path.join(tmp, "assets", "vendor", "three", rel)),
      ).resolves.toBeUndefined();
    }
    await expect(
      fs.access(path.join(tmp, "assets", "vendor", "three", "addons", "postprocessing", "Pass.js")),
    ).resolves.toBeUndefined();
  });

  it("refuses a missing project instead of creating one", async () => {
    const result = await runHelper("three.mjs", ["add", path.join(tmp, "nope")]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout).error).toContain("Project folder not found");
  });
});
