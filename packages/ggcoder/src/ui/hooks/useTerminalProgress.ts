import { useEffect } from "react";
import { useStdout } from "ink";

/**
 * Terminal progress bar via OSC 9;4 escape sequences.
 *
 * Supported terminals:
 * - iTerm2 ≥ 3.6.6
 * - Ghostty ≥ 1.2.0
 * - ConEmu (any version)
 *
 * Shows an indeterminate (pulsing) progress bar at the top of the terminal
 * window when the agent is actively running, and clears it when idle.
 */

// OSC 9;4 sub-commands
const PROGRESS_CLEAR = 0;
// const PROGRESS_SET = 1;
// const PROGRESS_ERROR = 2;
const PROGRESS_INDETERMINATE = 3;

function buildProgressSequence(subcommand: number, value: number | string = ""): string {
  // ESC ] 9 ; 4 ; <sub> ; <value> BEL
  return `\x1b]9;4;${subcommand};${value}\x07`;
}

function wrapForMultiplexer(sequence: string): string {
  if (process.env["TMUX"]) {
    const escaped = sequence.replaceAll("\x1b", "\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  if (process.env["STY"]) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
}

function isProgressReportingAvailable(): boolean {
  if (!process.stdout.isTTY) return false;

  // Windows Terminal interprets OSC 9;4 as notifications, not progress
  if (process.env["WT_SESSION"]) return false;

  // ConEmu supports OSC 9;4 for progress (all versions)
  if (process.env["ConEmuANSI"] || process.env["ConEmuPID"] || process.env["ConEmuTask"]) {
    return true;
  }

  const termProgram = process.env["TERM_PROGRAM"];
  const version = process.env["TERM_PROGRAM_VERSION"];
  if (!version) return false;

  // Parse semver-ish version
  const parts = version.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;

  function gte(a: number, b: number, c: number): boolean {
    if (major !== a) return major > a;
    if (minor !== b) return minor > b;
    return patch >= c;
  }

  // Ghostty 1.2.0+
  if (termProgram === "ghostty") return gte(1, 2, 0);

  // iTerm2 3.6.6+
  if (termProgram === "iTerm.app") return gte(3, 6, 6);

  return false;
}

const available = isProgressReportingAvailable();

// Re-assert the progress bar periodically while running.
// Terminal operations (tool output with escape sequences, Ink re-renders)
// can silently clear the OSC 9;4 progress state.  Without periodic
// re-assertion the bar disappears mid-run and never comes back.
const REASSERT_INTERVAL_MS = 5_000;

export function useTerminalProgress(isRunning: boolean, _hasActiveTools: boolean): void {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!available || !stdout) return;

    if (!isRunning) {
      stdout.write(wrapForMultiplexer(buildProgressSequence(PROGRESS_CLEAR)));
      return;
    }

    // Send immediately when the run starts
    const seq = wrapForMultiplexer(buildProgressSequence(PROGRESS_INDETERMINATE));
    stdout.write(seq);

    // Re-assert on an interval so the bar survives terminal resets
    const timer = setInterval(() => stdout.write(seq), REASSERT_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      stdout.write(wrapForMultiplexer(buildProgressSequence(PROGRESS_CLEAR)));
    };
  }, [stdout, isRunning]);

  // Clear on unmount
  useEffect(() => {
    return () => {
      if (!available || !stdout) return;
      stdout.write(wrapForMultiplexer(buildProgressSequence(PROGRESS_CLEAR)));
    };
  }, [stdout]);
}
