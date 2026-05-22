import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type {
  ClipInfo,
  Frame,
  FrameRange,
  HostCapabilities,
  MarkerInfo,
  TimelineState,
} from "../../../types.js";
/* HostCapabilities is the runtime answer to "can the agent talk to Resolve
right now?" — we deliberately do NOT cache it. A cached `isAvailable: true`
outlives a closed-Resolve session and silently lies. checkReachable() is a
sync env-var stat (~0.1ms), so re-running it on every host_info call is
free and always truthful. */
import { HostUnsupportedError, type FusionCompArgs, type VideoHost } from "../types.js";
import { toResolveColor } from "../../marker-colors.js";
import { findPython, ResolveBridge, resolveEnv } from "./bridge.js";

/**
 * DaVinci Resolve adapter.
 *
 * Drives Resolve through a long-lived Python sidecar (see ./bridge.ts and
 * ./bridge-source.ts). The sidecar imports DaVinciResolveScript and exposes
 * a JSON-line RPC over stdin/stdout. One process is shared across the whole
 * session — first call pays the spawn cost (~300ms), all subsequent calls
 * are sub-50ms round trips.
 *
 * Requirements:
 *   - Resolve Studio (free version does not expose the API externally)
 *   - DaVinci Resolve running with a project + timeline open
 *   - Preferences → System → General → "External scripting using" set to Local
 *   - Python 3 on PATH (python3 / python / py -3 — auto-detected)
 *
 * Capability map (verified against Resolve 20 API docs):
 *   - canMoveClips: false (API only supports append-to-end)
 *   - canScriptColor: true (nodes, LUTs, CDLs, primary corrections)
 *   - canScriptAudio: false at gg-editor's tool level (Resolve exposes some
 *     Fairlight APIs, but not the full mix/EQ/ducking pipeline we need yet)
 *   - canTriggerAI: partial / Studio-sensitive (Smart Reframe and similar calls
 *     may require Studio and runtime confirmation)
 *   - preferredImportFormat: edl (also FCPXML, AAF, DRT)
 */
export class ResolveAdapter implements VideoHost {
  readonly name = "resolve" as const;
  readonly displayName = "DaVinci Resolve";

  private bridge = new ResolveBridge();

  async capabilities(): Promise<HostCapabilities> {
    // Re-checked on every call — see top-of-file comment.
    const reachable = this.checkReachable();
    return {
      canMoveClips: false,
      canScriptColor: true,
      canScriptAudio: false,
      canTriggerAI: true,
      preferredImportFormat: "edl",
      isAvailable: reachable.ok,
      unavailableReason: reachable.ok ? undefined : reachable.reason,
      warnings: [
        "Resolve scripting is version-sensitive; installed Resolve Developer/Scripting docs are the authority on this machine.",
        "Fine-grained trim/move/keyframe editing is not exposed as direct Resolve API calls; prefer EDL/FCPXML rebuilds for bulk timeline mutation.",
        "Some Resolve AI/Fairlight operations are Studio-, page-, or project-state-sensitive; verify with host_eval or a named tool before promising A-Z automation.",
      ],
      // Resolve uses Blackmagic's first-party Python scripting API — no
      // deprecation pressure, unlike the Adobe CEP/UXP situation.
      runtime: "native",
    };
  }

  async getTimeline(): Promise<TimelineState> {
    return this.bridge.call<TimelineState>("get_timeline");
  }

  async addMarker(marker: MarkerInfo): Promise<void> {
    // Normalize lowercase / mixed-case names to Resolve's Title-Case form.
    // Numeric color (Premiere style) doesn't apply here — Resolve uses names.
    const color = typeof marker.color === "string" ? toResolveColor(marker.color) : "Blue";
    await this.bridge.call("add_marker", {
      frame: marker.frame,
      note: marker.note,
      color,
      durationFrames: marker.durationFrames ?? 1,
    });
  }

  async cutAt(_track: number, _frame: Frame): Promise<void> {
    // Resolve's Python API does not expose a direct razor. The agent should
    // fall back to either:
    //   (a) writing a fresh EDL/FCPXML and calling importTimeline(), or
    //   (b) the (not yet implemented) accessibility-hotkey path.
    throw new HostUnsupportedError(
      "resolve",
      "cutAt",
      "Resolve's API has no scriptable razor. Use importTimeline() with a fresh EDL " +
        "(write an EDL containing the cut points) or set the playhead and send ⌘B via " +
        "the accessibility-hotkey path (not yet implemented).",
    );
  }

  async rippleDelete(_track: number, _range: FrameRange): Promise<void> {
    throw new HostUnsupportedError(
      "resolve",
      "rippleDelete",
      "Not exposed via the Resolve API. Use importTimeline() with a rebuilt EDL.",
    );
  }

  async appendClip(track: number, mediaPath: string): Promise<ClipInfo> {
    return this.bridge.call<ClipInfo>("append_clip", { track, mediaPath });
  }

  async importTimeline(filePath: string): Promise<void> {
    await this.bridge.call("import_timeline", { filePath });
  }

  async render(opts: { preset: string; output: string }): Promise<void> {
    await this.bridge.call("render", opts);
  }

  async getMarkers(): Promise<MarkerInfo[]> {
    return this.bridge.call<MarkerInfo[]>("get_markers");
  }

  async createTimeline(opts: {
    name: string;
    fps: number;
    width?: number;
    height?: number;
  }): Promise<void> {
    await this.bridge.call("create_timeline", opts);
  }

  async importToMediaPool(paths: string[], bin?: string): Promise<void> {
    await this.bridge.call("import_to_media_pool", { paths, bin });
  }

  async setClipSpeed(clipId: string, speed: number): Promise<void> {
    await this.bridge.call("set_clip_speed", { clipId, speed });
  }

  async applyLut(clipId: string, lutPath: string, nodeIndex?: number): Promise<void> {
    await this.bridge.call("apply_lut", { clipId, lutPath, nodeIndex });
  }

  async setPrimaryCorrection(
    clipId: string,
    cdl: {
      slope?: [number, number, number];
      offset?: [number, number, number];
      power?: [number, number, number];
      saturation?: number;
      nodeIndex?: number;
    },
  ): Promise<void> {
    await this.bridge.call("set_primary_correction", { clipId, ...cdl });
  }

  async copyGrade(sourceClipId: string, targetClipIds: string[]): Promise<void> {
    await this.bridge.call("copy_grade", { sourceClipId, targetClipIds });
  }

  async listRenderPresets(): Promise<string[]> {
    return this.bridge.call<string[]>("list_render_presets");
  }

  async replaceClip(clipId: string, mediaPath: string): Promise<void> {
    await this.bridge.call("replace_clip", { clipId, mediaPath });
  }

  async cloneTimeline(newName: string): Promise<{ name: string }> {
    return this.bridge.call<{ name: string }>("clone_timeline", { newName });
  }

  async saveProject(): Promise<void> {
    await this.bridge.call("save_project");
  }

  async addTrack(kind: "video" | "audio" | "subtitle"): Promise<{ track: number }> {
    return this.bridge.call<{ track: number }>("add_track", { kind });
  }

  async setClipVolume(clipId: string, volumeDb: number): Promise<void> {
    await this.bridge.call("set_clip_volume", { clipId, volumeDb });
  }

  async insertClipOnTrack(opts: {
    mediaPath: string;
    track: number;
    recordFrame: number;
    sourceInFrame?: number;
    sourceOutFrame?: number;
    mediaKind?: "video" | "audio";
  }): Promise<ClipInfo> {
    return this.bridge.call<ClipInfo>("insert_clip_on_track", opts);
  }

  async smartReframe(
    clipId: string,
    opts: {
      aspect: "9:16" | "1:1" | "4:5" | "16:9" | "4:3";
      frameInterest?: "all" | "keyframes" | "reference-frame";
      referenceFrame?: number;
    },
  ): Promise<void> {
    await this.bridge.call("smart_reframe", { clipId, ...opts });
  }

  async importSubtitles(
    srtPath: string,
  ): Promise<{ imported: boolean; attached: boolean; note?: string }> {
    return this.bridge.call("import_subtitles", { srtPath });
  }

  async openPage(
    name: "media" | "cut" | "edit" | "fusion" | "color" | "fairlight" | "deliver",
  ): Promise<void> {
    await this.bridge.call("open_page", { name });
  }

  async executeCode(code: string): Promise<{ result: unknown; stdout?: string }> {
    return this.bridge.call<{ result: unknown; stdout?: string }>("execute_code", { code });
  }

  async executeFusionComp(args: FusionCompArgs): Promise<unknown> {
    return this.bridge.call("fusion_comp", args as unknown as Record<string, unknown>);
  }

  /**
   * Optional: explicitly close the bridge (e.g. on CLI shutdown). The bridge
   * also dies when the parent process exits, so this is mostly for tests.
   */
  shutdown(): void {
    this.bridge.kill();
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Pre-flight reachability check. Validates the env we'd hand to the bridge
   * before we try to spawn it, so capabilities() can report a clear reason
   * without paying the spawn cost.
   */
  private checkReachable(): { ok: true } | { ok: false; reason: string } {
    const env = resolveEnv();
    const apiPath = env.RESOLVE_SCRIPT_API;
    const libPath = env.RESOLVE_SCRIPT_LIB;

    if (!apiPath || !existsSync(apiPath)) {
      return {
        ok: false,
        reason:
          `RESOLVE_SCRIPT_API not found (looked at ${apiPath ?? "<unset>"}). ` +
          `Install DaVinci Resolve Studio or set RESOLVE_SCRIPT_API to its Developer/Scripting dir.`,
      };
    }
    if (!libPath || !existsSync(libPath)) {
      return {
        ok: false,
        reason: `RESOLVE_SCRIPT_LIB not found (looked at ${libPath ?? "<unset>"}).`,
      };
    }

    // The Modules dir is what actually gets put on PYTHONPATH. Sanity-check it.
    const modules = join(apiPath, "Modules");
    if (!existsSync(modules)) {
      return {
        ok: false,
        reason: `Resolve API Modules dir missing at ${modules}. Reinstall Resolve Studio.`,
      };
    }

    if (!findPython()) {
      return {
        ok: false,
        reason:
          platform() === "win32"
            ? "Python 3 not on PATH. Install from python.org or the Microsoft Store; verify 'python --version' or 'py -3 --version'."
            : "Python 3 not on PATH. Install via Homebrew (macOS) or your package manager (Linux); verify 'python3 --version'.",
      };
    }

    return { ok: true };
  }
}
