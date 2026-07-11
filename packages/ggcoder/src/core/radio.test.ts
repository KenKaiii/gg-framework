import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const makeChild = (streams: Record<string, unknown> = {}) => ({
    pid: 987_654_321,
    exitCode: null,
    killed: false,
    once: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
    ...streams,
  });
  const child = makeChild();
  const ffmpegStdin = { on: vi.fn(), write: vi.fn() };
  const ffmpeg = makeChild({ stdin: ffmpegStdin });
  const ffplay = makeChild();
  const socket = {
    once: vi.fn((event: string, callback: () => void) => {
      if (event === "connect") callback();
      return socket;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  let preferredPlayer: "mpv" | "ffplay" = "mpv";
  return {
    child,
    ffmpeg,
    ffmpegStdin,
    ffplay,
    socket,
    usePlayer(player: "mpv" | "ffplay") {
      preferredPlayer = player;
    },
    spawn: vi.fn((command: unknown) => {
      const executable = String(command);
      if (executable.endsWith("/ffmpeg")) return ffmpeg;
      if (executable.endsWith("/ffplay")) return ffplay;
      return child;
    }),
    createConnection: vi.fn(() => socket),
    existsSync: vi.fn((candidate: unknown) => {
      const executable = String(candidate);
      if (preferredPlayer === "ffplay") {
        return executable.endsWith("/ffplay") || executable.endsWith("/ffmpeg");
      }
      return executable.endsWith("/mpv");
    }),
  };
});

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:net", () => ({ createConnection: mocks.createConnection }));

import { RADIO_STATIONS, getRadioVolume, playRadio, setRadioVolume, stopRadio } from "./radio.js";

afterEach(() => {
  stopRadio();
  setRadioVolume(70);
  mocks.usePlayer("mpv");
  vi.clearAllMocks();
});

describe("radio", () => {
  it("includes the verified SomaFM reggae stream", () => {
    expect(RADIO_STATIONS).toContainEqual(
      expect.objectContaining({
        id: "somafm-heavyweight-reggae",
        url: "https://ice5.somafm.com/reggae-128-mp3",
      }),
    );
  });

  it("keeps the player in the sidecar process group for reliable app-exit cleanup", () => {
    expect(playRadio("somafm-heavyweight-reggae")).toEqual({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/mpv$/),
      expect.arrayContaining(["--volume=70", "https://ice5.somafm.com/reggae-128-mp3"]),
      expect.objectContaining({ detached: false, stdio: "ignore" }),
    );
  });

  it("changes mpv volume over IPC without restarting the stream", () => {
    expect(playRadio("somafm-heavyweight-reggae")).toEqual({ ok: true });
    mocks.spawn.mockClear();

    expect(setRadioVolume(42)).toEqual({ ok: true });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.createConnection).toHaveBeenCalledWith(
      expect.stringMatching(/gg-radio-.+\.sock$/),
    );
    expect(mocks.socket.end).toHaveBeenCalledWith(
      `${JSON.stringify({ command: ["set_property", "volume", 42] })}\n`,
    );
  });

  it.runIf(process.platform === "darwin")(
    "changes native macOS volume without restarting or queueing audio",
    () => {
      mocks.usePlayer("ffplay");
      expect(playRadio("somafm-heavyweight-reggae")).toEqual({ ok: true });
      expect(mocks.spawn).toHaveBeenCalledWith(
        expect.stringMatching(/ffmpeg$/),
        expect.arrayContaining(["volume@radio=0.7", "audiotoolbox", "-"]),
        expect.objectContaining({ stdio: ["pipe", "ignore", "ignore"] }),
      );
      mocks.spawn.mockClear();

      expect(setRadioVolume(42)).toEqual({ ok: true });

      expect(getRadioVolume()).toBe(42);
      expect(mocks.ffmpegStdin.write).toHaveBeenCalledWith("cvolume@radio -1 volume 0.42\n");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("clamps app-wide volume to whole percentages", () => {
    expect(setRadioVolume(-1).ok).toBe(true);
    expect(getRadioVolume()).toBe(0);
    setRadioVolume(55.6);
    expect(getRadioVolume()).toBe(56);
    setRadioVolume(101);
    expect(getRadioVolume()).toBe(100);
  });
});
