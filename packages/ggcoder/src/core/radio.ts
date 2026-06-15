import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

/**
 * Internet radio — stream a free station while you work. Ported from gg-boss's
 * radio so the gg-app windows offer the same curated, royalty-free, no-API-key
 * streams (SomaFM started in 2000, Radio Paradise in 2006).
 *
 * Playback runs inside the per-window app sidecar process, so each window's
 * radio is fully independent — opening more windows never duplicates audio.
 *
 * Player binary detection: mpv > ffplay > mpg123 > cvlc. macOS's built-in
 * afplay isn't a streaming player, so users without any of those get a one-line
 * "install mpv" hint and the request no-ops gracefully.
 *
 * One station at a time — switching stations or selecting "off" kills the
 * existing player process before spawning a new one.
 */

export interface RadioStation {
  /** Stable identifier used by the picker + state. */
  id: string;
  /** Display name in the picker. */
  name: string;
  /** Short subtitle shown next to the name. */
  description: string;
  /** Direct stream URL — must be MP3/AAC/Ogg, anything mpv handles. */
  url: string;
}

export const RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: "somafm-groove-salad",
    name: "SomaFM · Groove Salad",
    description: "Chilled downtempo, ambient grooves",
    url: "http://ice1.somafm.com/groovesalad-128-mp3",
  },
  {
    id: "somafm-drone-zone",
    name: "SomaFM · Drone Zone",
    description: "Atmospheric textures with minimal beats",
    url: "http://ice1.somafm.com/dronezone-128-mp3",
  },
  {
    id: "radio-paradise",
    name: "Radio Paradise",
    description: "Eclectic mix — rock, electronica, jazz",
    url: "http://stream.radioparadise.com/mp3-128",
  },
  {
    id: "george-fm",
    name: "George FM",
    description: "NZ dance + electronic",
    url: "https://mediaworks.streamguys1.com/george_net_icy",
  },
];

interface PlayerCandidate {
  cmd: string;
  args: (url: string) => string[];
}

/**
 * Well-known directories where streaming players get installed but which a
 * GUI app's minimal PATH usually omits. macOS apps launched from Finder/Dock
 * inherit only `/usr/bin:/bin:/usr/sbin:/sbin` — not Homebrew (`/opt/homebrew/bin`
 * on Apple Silicon, `/usr/local/bin` on Intel) or MacPorts (`/opt/local/bin`),
 * so `spawn("mpv")` ENOENTs even when mpv is installed. We search these in
 * addition to PATH. Linux dirs cover the common package-manager prefixes.
 */
function extraPlayerDirs(): readonly string[] {
  switch (process.platform) {
    case "darwin":
      return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
    case "linux":
      return ["/usr/bin", "/usr/local/bin", "/bin", "/snap/bin"];
    default:
      return [];
  }
}

/**
 * Resolve a player command to a runnable path. Returns `cmd` unchanged when it
 * already resolves via PATH (the common dev case); otherwise probes the
 * well-known install dirs and returns the first absolute hit. Returns null when
 * the binary genuinely isn't installed anywhere we know to look.
 */
function resolvePlayerPath(cmd: string): string | null {
  // An explicit path is used as-is.
  if (cmd.includes(path.sep)) return existsSync(cmd) ? cmd : null;

  // 1) PATH (covers terminal launches + any inherited shell environment).
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // 2) Well-known dirs a GUI PATH typically omits.
  for (const dir of [...pathDirs, ...extraPlayerDirs()]) {
    const candidate = path.join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Streaming-capable players in priority order. Each gets its quietest flag
 * combination — radio runs in the background, we don't want stdout/stderr
 * spam. Stdio is also redirected to "ignore" at spawn time.
 */
const PLAYERS: readonly PlayerCandidate[] = [
  { cmd: "mpv", args: (u) => ["--really-quiet", "--no-video", "--no-terminal", u] },
  { cmd: "ffplay", args: (u) => ["-nodisp", "-autoexit", "-loglevel", "quiet", u] },
  { cmd: "mpg123", args: (u) => ["-q", u] },
  { cmd: "cvlc", args: (u) => ["--play-and-exit", "--quiet", u] },
];

let currentChild: ChildProcess | null = null;
let currentStationId: string | null = null;

export function getCurrentStation(): string | null {
  return currentStationId;
}

/**
 * Stop whatever's currently playing. Idempotent — safe to call when nothing
 * is playing. Sends SIGTERM (graceful), child cleans up the audio device.
 */
export function stopRadio(): void {
  if (!currentChild) return;
  try {
    // Detached children sit in their own process group on POSIX; kill the
    // whole group so any helper threads/forks die too. On Windows there's no
    // process group concept — kill() targets the child only.
    if (process.platform !== "win32" && currentChild.pid) {
      try {
        process.kill(-currentChild.pid, "SIGTERM");
      } catch {
        currentChild.kill("SIGTERM");
      }
    } else {
      currentChild.kill("SIGTERM");
    }
  } catch {
    // Already exited — nothing to do.
  }
  currentChild = null;
  currentStationId = null;
  log("INFO", "radio", "stopped");
}

export interface PlayResult {
  ok: boolean;
  /** Friendly error to surface to the user when ok=false. */
  error?: string;
}

/**
 * On WSL2, native Linux audio binaries can't reach the Windows audio device
 * through WSLg's bridge in any useful way for streaming — detect WSL and route
 * through the Windows host instead.
 */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  return !!process.env.WSL_DISTRO_NAME || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
}

/**
 * Stream a station through powershell.exe + WPF MediaPlayer on the Windows host
 * instead of a Linux binary. Returns the ChildProcess or null on spawn failure.
 * The URL is allowlist-checked, scheme-enforced, and passed via env (never
 * interpolated into the -Command string).
 */
function tryPlayOnWindowsHost(station: RadioStation): ChildProcess | null {
  const allowedUrls = new Set(RADIO_STATIONS.map((s) => s.url));
  if (!allowedUrls.has(station.url)) return null;
  if (!/^https?:\/\//i.test(station.url)) return null;
  const psScript = [
    "Add-Type -AssemblyName presentationCore;",
    "Add-Type -AssemblyName WindowsBase;",
    "$p = New-Object System.Windows.Media.MediaPlayer;",
    "$p.Open([uri]$env:GG_RADIO_URL);",
    "$p.Play();",
    "[System.Windows.Threading.Dispatcher]::Run();",
  ].join(" ");
  try {
    return spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        GG_RADIO_URL: station.url,
        WSLENV: (process.env.WSLENV ? process.env.WSLENV + ":" : "") + "GG_RADIO_URL",
      },
    });
  } catch {
    return null;
  }
}

/**
 * Spawn a streaming player for the given station. If one is already playing,
 * it's killed first. Returns ok=false with a hint if no compatible player is
 * installed — caller should surface the error to the user.
 */
export function playRadio(stationId: string): PlayResult {
  const station = RADIO_STATIONS.find((s) => s.id === stationId);
  if (!station) return { ok: false, error: `Unknown station: ${stationId}` };

  // Always stop the previous stream before starting a new one.
  stopRadio();

  if (isWsl()) {
    const child = tryPlayOnWindowsHost(station);
    if (child) {
      let errored = false;
      child.once("error", () => {
        errored = true;
      });
      if (child.pid && !errored) {
        currentChild = child;
        currentStationId = stationId;
        log("INFO", "radio", "playing", {
          station: station.id,
          player: "powershell.exe (wsl→host)",
          url: station.url,
        });
        child.unref();
        return { ok: true };
      }
    }
  }

  for (const player of PLAYERS) {
    // Resolve to an absolute path first so we find players in Homebrew/MacPorts
    // dirs that a GUI app's minimal PATH omits. Skip when not installed.
    const bin = resolvePlayerPath(player.cmd);
    if (!bin) continue;
    try {
      const child = spawn(bin, player.args(station.url), {
        detached: process.platform !== "win32",
        stdio: "ignore",
      });
      let errored = false;
      child.once("error", () => {
        errored = true;
      });
      if (child.pid && !errored) {
        currentChild = child;
        currentStationId = stationId;
        log("INFO", "radio", "playing", {
          station: station.id,
          player: player.cmd,
          url: station.url,
        });
        child.unref();
        return { ok: true };
      }
    } catch {
      // ENOENT or permission — try the next player.
    }
  }
  log("WARN", "radio", "no compatible player found", { platform: process.platform });
  return { ok: false, error: buildInstallHint() };
}

/**
 * Platform-specific one-line install hint so the user can copy-paste rather
 * than reading generic suggestions.
 */
function buildInstallHint(): string {
  const base =
    "Radio needs a streaming player. Install one of: mpv (recommended), ffplay, mpg123, or vlc.";
  switch (process.platform) {
    case "darwin":
      return `${base} On macOS: \`brew install mpv\` (or \`brew install ffmpeg\` for ffplay).`;
    case "linux":
      return `${base} On Linux (Debian/Ubuntu): \`sudo apt install mpv\`. Fedora: \`sudo dnf install mpv\`. Arch: \`sudo pacman -S mpv\`.`;
    case "win32":
      return `${base} On Windows: \`winget install mpv.mpv\` (or download from https://mpv.io).`;
    default:
      return `${base} See https://mpv.io for platform installation instructions.`;
  }
}
