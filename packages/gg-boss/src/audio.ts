import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Parse an MP3's duration in milliseconds by walking its frame headers. Pure
 * JS, no native deps. Handles CBR (sums frame sizes vs sample rate) and VBR
 * with a Xing/Info header (reads totalFrames directly). Returns null on any
 * parse failure — caller falls back to a sensible default in that case.
 *
 * Why we do this at runtime: the splash needs to stay visible for the full
 * audio duration so the user isn't dumped into the chat mid-jingle. Bundling
 * a hardcoded constant works until someone swaps the asset and forgets to
 * update the number; reading it from the file is robust to that.
 */
function readMp3DurationMs(file: string): number | null {
  try {
    const buf = fs.readFileSync(file);
    // Skip ID3v2 tag if present — first 10 bytes are "ID3" + version + flags
    // + size (synchsafe). Frame headers start after the tag.
    let i = 0;
    if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const tagSize =
        ((buf[6]! & 0x7f) << 21) |
        ((buf[7]! & 0x7f) << 14) |
        ((buf[8]! & 0x7f) << 7) |
        (buf[9]! & 0x7f);
      i = 10 + tagSize;
    }
    // Find first MPEG audio sync (11 bits set: 0xFFE).
    while (i + 4 < buf.length) {
      if (buf[i] === 0xff && (buf[i + 1]! & 0xe0) === 0xe0) break;
      i++;
    }
    if (i + 4 >= buf.length) return null;
    const h1 = buf[i + 1]!;
    const h2 = buf[i + 2]!;
    const versionBits = (h1 >> 3) & 0x03; // 11 = MPEG-1, 10 = MPEG-2, 00 = MPEG-2.5
    const layerBits = (h1 >> 1) & 0x03; // 01 = Layer III
    const bitrateIdx = (h2 >> 4) & 0x0f;
    const sampleRateIdx = (h2 >> 2) & 0x03;
    const padding = (h2 >> 1) & 0x01;
    const isMpeg1 = versionBits === 0x03;
    if (layerBits !== 0x01) return null; // only Layer III is bundled
    // Bitrate kbps tables for MPEG-1/2 Layer III
    const BR_V1: number[] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
    const BR_V2: number[] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
    const SR_V1: number[] = [44100, 48000, 32000, -1];
    const SR_V2: number[] = [22050, 24000, 16000, -1];
    const SR_V25: number[] = [11025, 12000, 8000, -1];
    const bitrate = (isMpeg1 ? BR_V1 : BR_V2)[bitrateIdx];
    const sampleRate = (isMpeg1 ? SR_V1 : versionBits === 0x02 ? SR_V2 : SR_V25)[sampleRateIdx];
    if (!bitrate || bitrate <= 0 || !sampleRate || sampleRate <= 0) return null;
    const samplesPerFrame = isMpeg1 ? 1152 : 576;

    // Look for a Xing/Info header inside the first frame (offset depends on
    // channel mode). If present, totalFrames * samplesPerFrame / sampleRate
    // gives an accurate VBR duration.
    const sideInfoOffset = isMpeg1 ? (((h2 >> 6) & 0x03) === 0x03 ? 17 : 32) : 9;
    const xingTagOffset = i + 4 + sideInfoOffset;
    if (xingTagOffset + 8 < buf.length) {
      const tag = buf.toString("ascii", xingTagOffset, xingTagOffset + 4);
      if (tag === "Xing" || tag === "Info") {
        const flags = buf.readUInt32BE(xingTagOffset + 4);
        if (flags & 0x01) {
          // totalFrames is the next 32-bit BE
          const totalFrames = buf.readUInt32BE(xingTagOffset + 8);
          if (totalFrames > 0) {
            return Math.round((totalFrames * samplesPerFrame * 1000) / sampleRate);
          }
        }
      }
    }

    // CBR fallback: bytes / (bitrate*1000/8) → seconds.
    const audioBytes = buf.length - i;
    const seconds = audioBytes / ((bitrate * 1000) / 8);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    void padding; // padding affects per-frame size, immaterial at file scale
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

/**
 * Duration of the bundled splash audio, in milliseconds. Read once from the
 * actual file so swapping the asset Just Works without anyone having to
 * remember to bump a constant. Falls back to 1500ms if parsing fails.
 */
export function getSplashAudioDurationMs(): number {
  const ms = readMp3DurationMs(splashAssetPath());
  return ms && ms > 0 ? ms : 1500;
}

/**
 * Resolve a bundled audio file by name. The build script copies everything
 * under `assets/` into `dist/` so the file lands inside the published tarball
 * when users `npm i -g`. Falls back to the source location during local dev
 * where dist hasn't been populated yet.
 */
function assetPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(here, name);
  if (fs.existsSync(dist)) return dist;
  return path.join(here, "..", "assets", name);
}

function splashAssetPath(): string {
  return assetPath("splash.mp3");
}

/**
 * Fire a candidate player as a detached child. Returns true if the spawn
 * actually started successfully (no immediate ENOENT). The audio process
 * outlives the splash unmount so playback can finish on its own. Stdio is
 * redirected to /dev/null so the player can't pollute the TUI.
 */
function trySpawn(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => {
        // ENOENT (binary not installed) or permission failure — let the next
        // candidate take a turn. Don't surface to the user.
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
      child.once("spawn", () => {
        if (!resolved) {
          resolved = true;
          // Detach so the parent process exiting doesn't kill the audio.
          child.unref();
          resolve(true);
        }
      });
      // Some Node versions fire neither immediately. After 50ms with no error,
      // assume success — the spawn went through.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.unref();
          resolve(true);
        }
      }, 50);
    } catch {
      resolve(false);
    }
  });
}

/**
 * `process.platform` reports `"linux"` on WSL2, but native Linux audio
 * binaries can't reach the Windows audio device through WSLg's bridge in
 * any useful timeframe — ffplay, for example, enumerates dead ALSA/Pulse
 * outputs for ~2 minutes before audio finally emerges from a 1.5s clip.
 * By the time it's audible, the splash animation is long gone and the
 * sound bursts out on top of whatever the user is doing now.
 *
 * Detect WSL via $WSL_DISTRO_NAME or /proc/sys/fs/binfmt_misc/WSLInterop.
 * Either is a robust signal — both are set by every WSL2 distro.
 */
function isWsl(): boolean {
  // Guard against false positives on native Windows: WSL env vars can leak
  // into a Windows shell that was launched from a WSL session, but
  // process.platform stays "win32" — in which case the existing win32 branch
  // already handles playback and we should not take this path.
  if (process.platform !== "linux") return false;
  return !!process.env.WSL_DISTRO_NAME || fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
}

/**
 * Play an MP3 from WSL2 by routing it through powershell.exe + WPF
 * MediaPlayer on the Windows host. End-to-end latency drops from ~120s
 * (ffplay on WSLg) to ~4s.
 *
 * Security:
 *  - The asset path is containment-checked against the gg-boss install
 *    directory before spawning anything. Today's call sites always pass
 *    a hardcoded asset path, but this gate fails closed if a future code
 *    path leaks an attacker-controlled string into `playFile()`.
 *  - The path is passed via `GGBOSS_AUDIO_PATH` env var, never string-
 *    interpolated into the PowerShell command. WSLENV lists the var name
 *    so it actually crosses the WSL→Windows process boundary (custom
 *    env vars don't propagate by default — that's a real WSL gotcha,
 *    powershell.exe just sees the var as empty without WSLENV).
 *  - PowerShell runs `-NoProfile -WindowStyle Hidden`, so no profile
 *    scripts execute and no window flashes.
 *
 * Returns true if the spawn succeeded — the caller falls through to the
 * native Linux candidates if this returns false (e.g. wslpath not on
 * PATH, or the install layout is unexpected).
 */
async function tryPlayOnWindowsHost(file: string): Promise<boolean> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const devAssets = path.resolve(here, "..", "assets");
    const resolved = path.resolve(file);
    // The bundled location is `dist/` (== here at runtime); the dev fallback
    // is `../assets/`. Anything outside both is rejected — even though every
    // current call site passes a hardcoded asset name, this gate fails closed
    // if a future code path leaks an attacker-controlled string in.
    const inDist = resolved === here || resolved.startsWith(here + path.sep);
    const inAssets = resolved === devAssets || resolved.startsWith(devAssets + path.sep);
    if (!inDist && !inAssets) {
      return false;
    }
    // 2s is generous for a path-translation call but bounds a misbehaving
    // wslpath so the splash flow can't hang on startup.
    const winPath = execFileSync("wslpath", ["-w", resolved], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    const script = [
      "Add-Type -AssemblyName presentationCore;",
      "$p = New-Object System.Windows.Media.MediaPlayer;",
      "$p.Open([uri]$env:GGBOSS_AUDIO_PATH);",
      "$p.Play();",
      // Same reason as the win32 branch: MediaPlayer is async, so we have
      // to keep powershell.exe alive long enough to actually emit audio.
      "Start-Sleep -Seconds 5;",
    ].join(" ");
    return new Promise<boolean>((resolve) => {
      let resolved2 = false;
      try {
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
          {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              GGBOSS_AUDIO_PATH: winPath,
              // WSLENV propagates listed vars across the WSL→Windows boundary.
              // Append rather than replace so we don't clobber existing rules.
              WSLENV: (process.env.WSLENV ? process.env.WSLENV + ":" : "") + "GGBOSS_AUDIO_PATH",
            },
          },
        );
        child.once("error", () => {
          if (!resolved2) {
            resolved2 = true;
            resolve(false);
          }
        });
        child.once("spawn", () => {
          if (!resolved2) {
            resolved2 = true;
            child.unref();
            resolve(true);
          }
        });
        setTimeout(() => {
          if (!resolved2) {
            resolved2 = true;
            child.unref();
            resolve(true);
          }
        }, 50);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

/**
 * Cross-platform fire-and-forget MP3 playback. Tries the most likely binary
 * for the host OS first, then a small chain of common Linux fallbacks.
 *
 * Platform notes:
 *  - macOS:   `afplay` ships with the OS, always works for MP3.
 *  - Windows: PowerShell + WPF MediaPlayer is built-in and supports MP3 via
 *             DirectShow / MediaFoundation. Doesn't pop up a window because
 *             the script runs sync inside powershell.exe with -NoProfile.
 *  - WSL2:    Same PowerShell trick as Windows, with the asset path crossed
 *             over via wslpath + WSLENV. Falls through to the Linux chain
 *             if PowerShell is unreachable.
 *  - Linux:   No single guaranteed binary. Try mpv → ffplay → mpg123 → cvlc.
 *             If none are installed, give up silently — Linux desktop audio
 *             is fragmented enough that we don't want to bloat the package
 *             with a bundled player.
 */
async function playFile(file: string): Promise<void> {
  if (!fs.existsSync(file)) return;
  const platform = process.platform;

  if (platform === "darwin") {
    await trySpawn("afplay", [file]);
    return;
  }

  if (platform === "win32") {
    // Escape single quotes in the path for the PowerShell -Command argument.
    const safe = file.replace(/'/g, "''");
    const script = [
      "Add-Type -AssemblyName presentationCore;",
      "$p = New-Object System.Windows.Media.MediaPlayer;",
      `$p.Open([uri]'${safe}');`,
      "$p.Play();",
      // Sleep so the powershell process stays alive long enough to actually
      // play the clip (MediaPlayer is async; if powershell exits the GC
      // tears the player down before sound plays). Match clip length + a beat.
      "Start-Sleep -Seconds 5;",
    ].join(" ");
    await trySpawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script]);
    return;
  }

  // WSL2: route through the Windows host before falling back to native Linux.
  if (isWsl() && (await tryPlayOnWindowsHost(file))) return;

  // Linux + everything else: walk the candidates.
  const linuxCandidates: { cmd: string; args: string[] }[] = [
    { cmd: "mpv", args: ["--really-quiet", "--no-video", file] },
    { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file] },
    { cmd: "mpg123", args: ["-q", file] },
    { cmd: "mpg321", args: ["-q", file] },
    { cmd: "cvlc", args: ["--play-and-exit", "--quiet", file] },
    { cmd: "paplay", args: [file] },
  ];
  for (const c of linuxCandidates) {
    const ok = await trySpawn(c.cmd, c.args);
    if (ok) return;
  }
}

export function playSplashAudio(): Promise<void> {
  return playFile(splashAssetPath());
}

/**
 * Play the worker-completion ping. Fires on every `worker_turn_complete`
 * event so the user gets an audio cue when they're not looking at the
 * terminal. Fire-and-forget — multiple completions can layer.
 */
export function playDoneAudio(): Promise<void> {
  return playFile(assetPath("done.mp3"));
}

/**
 * Play the all-clear chime. Fires once when the orchestrator transitions
 * from "had worker activity" to "all idle, nothing in queue, awaiting next
 * instruction". Distinct from done.mp3 (per-worker completion) — this is
 * the "everything's wrapped up" signal you want to hear from another room.
 */
export function playReadyAudio(): Promise<void> {
  return playFile(assetPath("ready.mp3"));
}
