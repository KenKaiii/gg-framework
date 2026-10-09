/**
 * Hash-anchored line addressing — the pure, UI-free core shared by the hashline
 * benchmark and the opt-in anchor guard in the read/edit tools.
 *
 * Every line gets a short content+position hash. Anchors are UNIQUE by
 * construction (the line's index is folded into the hash, so blank/repeated
 * lines never collide), which is what lets an edit either resolve to exactly one
 * location or be rejected — never silently corrupt a file that drifted since the
 * model last read it.
 */
import { createHash } from "node:crypto";

/**
 * 4-hex-char anchor for a line. Position is folded into the hash so anchors are
 * UNIQUE by construction (blank lines and repeated lines no longer collide).
 * Resolution stays O(1) via a lookup map. `index` is the 0-based line index.
 */
export function lineHash(line: string, index: number): string {
  return createHash("sha1").update(`${index}:${line.trim()}`).digest("hex").slice(0, 4);
}

/** File rendered with `anchor│line` prefixes for the model to read. */
export function renderWithAnchors(file: string): string {
  return file
    .split("\n")
    .map((l, i) => `${lineHash(l, i)}│${l}`)
    .join("\n");
}

export interface AnchoredFile {
  /** File rendered with `anchor│line` prefixes for the model to read. */
  rendered: string;
  /** anchor → line index (0-based). Only UNIQUE anchors are resolvable. */
  anchorToIndex: Map<string, number>;
  /** anchors that collided (ambiguous → unresolvable, like a stale-file reject). */
  ambiguous: Set<string>;
  lines: string[];
}

export function anchorFile(file: string): AnchoredFile {
  const lines = file.split("\n");
  const counts = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const h = lineHash(l, i);
    const arr = counts.get(h) ?? [];
    arr.push(i);
    counts.set(h, arr);
  });
  const anchorToIndex = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const [h, idxs] of counts) {
    // Position-folded anchors are unique unless sha1 itself collides in 16 bits.
    if (idxs.length === 1) anchorToIndex.set(h, idxs[0]!);
    else ambiguous.add(h);
  }
  return { rendered: renderWithAnchors(file), anchorToIndex, ambiguous, lines };
}

/**
 * True when the line at `index` (0-based) still hashes to `hash`. Out-of-range
 * indices return false. This is the staleness gate the edit tool uses.
 */
export function verifyAnchor(lines: string[], index: number, hash: string): boolean {
  if (index < 0 || index >= lines.length) return false;
  return lineHash(lines[index]!, index) === hash;
}

/** Optional per-edit anchor guard: pin both endpoints of an edit by line+hash. */
export interface EditAnchor {
  /** 1-based line number of the first line of the edited span. */
  start_line: number;
  /** Content anchor of the first line (from a `read` with `anchors: true`). */
  start_hash: string;
  /** 1-based line number of the last line of the edited span. */
  end_line: number;
  /** Content anchor of the last line. */
  end_hash: string;
}

export type AnchorFailure = "out_of_range" | "hash_mismatch" | "reversed";

export type AnchorResolution =
  | {
      ok: true;
      /** 0-based index of the first line. */
      startIndex: number;
      /** 0-based index of the last line. */
      endIndex: number;
    }
  | { ok: false; reason: AnchorFailure };

/**
 * Resolve an anchor against the current file lines (0-based). Rejects the edit
 * if either endpoint is out of range, the range is reversed, or either hash no
 * longer matches — the corruption-avoidance property.
 */
export function resolveAnchoredEdit(lines: string[], anchor: EditAnchor): AnchorResolution {
  const startIndex = anchor.start_line - 1;
  const endIndex = anchor.end_line - 1;
  if (startIndex < 0 || endIndex < 0 || startIndex >= lines.length || endIndex >= lines.length) {
    return { ok: false, reason: "out_of_range" };
  }
  if (startIndex > endIndex) {
    return { ok: false, reason: "reversed" };
  }
  if (
    !verifyAnchor(lines, startIndex, anchor.start_hash) ||
    !verifyAnchor(lines, endIndex, anchor.end_hash)
  ) {
    return { ok: false, reason: "hash_mismatch" };
  }
  return { ok: true, startIndex, endIndex };
}
