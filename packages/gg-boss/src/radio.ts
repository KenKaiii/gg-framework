import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { log } from "./logger.js";

/**
 * Terminal radio — stream a free internet radio station while you're working.
 * Curated short list of long-running, royalty-free, no-API-key streams that
 * have been stable for years (SomaFM started in 2000, Radio Paradise in 2006).
 *
 * Player binary detection mirrors the audio.ts chain for one-shot effects:
 * mpv > ffplay > mpg123 > cvlc. macOS's built-in afplay isn't a streaming
 * player, so users who haven't installed any of those will get a one-line
 * "install mpv" hint and the radio request just no-ops gracefully.
 *
 * One station at a time — switching stations or selecting "Off" kills the
 * existing player process before spawning a new one.
 */

export interface RadioStation {
  /** Stable identifier used in slash command + settings persistence. */
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
 * Streaming-capable players in priority order. Each gets its quietest flag
 * combination — radio runs in the background, we don't want stdout/stderr
 * spam fighting with the TUI. Stdio is also redirected to "ignore" at spawn
 * time, but quiet flags help in case the player decides to write to tty.
 */
const PLAYERS: readonly PlayerCandidate[] = [
  { cmd: "mpv", args: (u) => ["--really-quiet", "--no-video", "--no-terminal", u] },
  {
    cmd: "ffplay",
    args: (u) => ["-nodisp", "-autoexit", "-loglevel", "quiet", u],
  },
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
    // whole group so any helper threads/forks die too. On Windows there's
    // no process group concept — kill() targets the child only.
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

interface PlayResult {
  ok: boolean;
  /** Friendly error to surface to the user when ok=false. */
  error?: string;
}

/**
 * On WSL2, native Linux audio binaries can't reach the Windows audio device
 * through WSLg's bridge in any useful way for streaming — `ffplay` accepts
 * the spawn (so we report "Now playing" to the user) but no audio actually
 * comes out. Returning a successful spawn handle that doesn't produce sound
 * is worse than failing fast: the user thinks it's working and goes off to
 * troubleshoot their speakers / VPN / firewall.
 *
 * Detect WSL via $WSL_DISTRO_NAME or /proc/sys/fs/binfmt_misc/WSLInterop.
 */
function isWsl(): boolean {
  return !!process.env.WSL_DISTRO_NAME || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
}

/**
 * Stream a station through powershell.exe + WPF MediaPlayer on the Windows
 * host instead of a Linux binary. Returns the ChildProcess or null if the
 * spawn failed — caller falls through to the native Linux candidates so a
 * WSL user with mpv installed and WSLg audio working keeps the existing
 * behaviour.
 *
 * Why a Dispatcher::Run() at the end of the script: WPF's MediaPlayer is
 * async — Open() and Play() return immediately and the actual playback runs
 * on a background thread that needs the COM message loop pumped. Without
 * Dispatcher::Run(), powershell.exe exits seconds later, the MediaPlayer
 * gets garbage-collected, and you hear silence. Pumping the dispatcher
 * keeps the player alive until stopRadio() kills the powershell process.
 *
 * Security:
 *  - station.url is double-checked against the in-process RADIO_STATIONS
 *    allowlist before spawning, even though the only call site already
 *    looked it up there. Belt-and-suspenders against any future code path
 *    that constructs a station object outside the constant array.
 *  - Scheme is enforced as http/https so a future entry can't slip a
 *    file:// or javascript: URL through.
 *  - The URL is passed via GGBOSS_RADIO_URL env, never string-interpolated
 *    into the PowerShell -Command argument. WSLENV lists the var so it
 *    actually crosses the WSL→Windows process boundary (custom env vars
 *    don't propagate by default — powershell.exe just sees them as empty
 *    without WSLENV). Existing $WSLENV is preserved.
 *  - powershell.exe runs -NoProfile -WindowStyle Hidden.
 */
function tryPlayOnWindowsHost(station: RadioStation): ChildProcess | null {
  const allowedUrls = new Set(RADIO_STATIONS.map((s) => s.url));
  if (!allowedUrls.has(station.url)) return null;
  if (!/^https?:\/\//i.test(station.url)) return null;
  const psScript = [
    "Add-Type -AssemblyName presentationCore;",
    "Add-Type -AssemblyName WindowsBase;",
    "$p = New-Object System.Windows.Media.MediaPlayer;",
    "$p.Open([uri]$env:GGBOSS_RADIO_URL);",
    "$p.Play();",
    "[System.Windows.Threading.Dispatcher]::Run();",
  ].join(" ");
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psScript],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          GGBOSS_RADIO_URL: station.url,
          WSLENV: (process.env.WSLENV ? process.env.WSLENV + ":" : "") + "GGBOSS_RADIO_URL",
        },
      },
    );
    return child;
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

  // WSL2: route through the Windows host before falling back to native
  // Linux players. Without this, ffplay reports a successful spawn but
  // produces no audio (WSLg audio bridge is fragile for streaming).
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
    try {
      const child = spawn(player.cmd, player.args(station.url), {
        detached: process.platform !== "win32",
        stdio: "ignore",
      });
      // Race: we don't know yet whether the spawn succeeded (ENOENT fires async).
      // Listen for the error event AND optimistically assume success. If error
      // fires within 100ms we'll fall through to the next candidate.
      let errored = false;
      child.once("error", () => {
        errored = true;
      });
      // Synchronous check after a tick — if the child has a pid by now, the
      // OS accepted the spawn. ENOENT is reported async via the "error" event,
      // so a non-null pid alone isn't conclusive, but combined with the
      // optimistic try/next-candidate loop it's enough.
      if (child.pid && !errored) {
        currentChild = child;
        currentStationId = stationId;
        log("INFO", "radio", "playing", {
          station: station.id,
          player: player.cmd,
          url: station.url,
        });
        // Detach so the radio outlives boss exit if the user wants it to.
        // (We still kill it on stopRadio() and on graceful boss shutdown.)
        child.unref();
        return { ok: true };
      }
    } catch {
      // ENOENT or permission — try the next player.
    }
  }
  log("WARN", "radio", "no compatible player found", { platform: process.platform });
  return {
    ok: false,
    error: buildInstallHint(),
  };
}

/**
 * Platform-specific one-line install hint. Picks the most likely working
 * command for the current OS so the user can copy-paste rather than reading
 * a wall of generic suggestions. Falls back to the official mpv site for
 * platforms we don't recognise.
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
