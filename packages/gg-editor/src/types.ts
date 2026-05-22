// ── Frame & timecode ────────────────────────────────────────

export type Frame = number;

export interface FrameRange {
  start: Frame;
  end: Frame;
}

// ── Timeline state ──────────────────────────────────────────

export interface ClipInfo {
  id: string;
  track: number;
  trackKind: "video" | "audio";
  startFrame: Frame;
  endFrame: Frame;
  name: string;
  sourcePath?: string;
}

export interface MarkerInfo {
  frame: Frame;
  note: string;
  /**
   * Color may be a name (Resolve: "Blue", "Red", ...) or a numeric index
   * (Premiere: 0..7 mapping to green/red/purple/orange/yellow/white/blue/cyan).
   * Tools that filter by color accept either form.
   */
  color?: string | number;
  durationFrames?: number;
}

export interface TimelineState {
  name: string;
  frameRate: number;
  durationFrames: Frame;
  clips: ClipInfo[];
  markers: MarkerInfo[];
}

// ── Host capabilities ───────────────────────────────────────

/**
 * Which scripting runtime an adapter is using to talk to the host. Useful for
 * surfacing deprecation notices (Adobe CEP / ExtendScript end Sept 2026) and
 * routing version-sensitive ops.
 *
 *   - 'uxp'        Adobe UXP plugin (Premiere 25.6+) — the only forward path.
 *   - 'cep'        Adobe CEP / ExtendScript panel — deprecated, EOL Sept 2026.
 *   - 'osascript'  macOS AppleScript → ExtendScript fallback. Same EOL.
 *   - 'native'     Direct API (Resolve Python bridge) — not deprecated.
 */
export type HostRuntime = "uxp" | "cep" | "osascript" | "native";

export interface HostCapabilities {
  /** Can clips be moved on the timeline (not only appended)? */
  canMoveClips: boolean;
  /** Can color grades / nodes be applied via script? */
  canScriptColor: boolean;
  /** Can audio mixer / fades be controlled via script? */
  canScriptAudio: boolean;
  /** Can AI features (Magic Mask, Voice Isolation, etc.) be triggered? */
  canTriggerAI: boolean;
  /** Preferred timeline interchange format for bulk operations. */
  preferredImportFormat: "edl" | "fcpxml" | "aaf" | "xml";
  /** Host/product version if cheaply detectable; undefined when not probed. */
  version?: string;
  /** Capability honesty notes the agent should surface before risky/limited workflows. */
  warnings?: string[];
  /** Whether the host is reachable right now (process running, API enabled). */
  isAvailable: boolean;
  /** Why a host is unavailable, if relevant. */
  unavailableReason?: string;
  /**
   * Active scripting runtime. Resolved lazily — may be undefined before the
   * first real bridge call (capabilities() probes reachability but doesn't
   * always commit to a transport).
   */
  runtime?: HostRuntime;
  /**
   * Free-form deprecation note surfaced to the agent + UI. Set when the active
   * runtime is on a known sunset path (currently Adobe CEP / ExtendScript,
   * which Adobe is removing in September 2026).
   */
  deprecationNotice?: string;
}

// ── CLI config ──────────────────────────────────────────────

export type HostName = "resolve" | "premiere" | "none";

export interface EditorConfig {
  /** Forced host, or undefined to auto-detect. */
  host?: HostName;
  /** Working directory for media files / EDL output / renders. */
  cwd: string;
  /** LLM provider. */
  provider: "anthropic" | "openai" | "glm" | "moonshot";
  /** LLM model. */
  model: string;
}
