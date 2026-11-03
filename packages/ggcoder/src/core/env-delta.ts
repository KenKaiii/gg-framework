import type { Message } from "@kenkaiiii/gg-ai";
import { renderLanguageGuidance, type SystemPromptEnvironment } from "../system-prompt.js";
import type { LanguageId } from "./language-detector.js";

/**
 * Keep the model's picture of its environment true without breaking the cache.
 *
 * The Environment section (working directory, extra roots, network allowlist)
 * is rendered ONCE into the cached system prompt. Some of those facts can
 * still change mid-session: `/set networkAllow ...` rewrites the allowlist in
 * settings, and nothing re-renders the prompt. The model then keeps reading
 * the old list, so it cannot explain why a fetch is being blocked — it argues
 * with a host it believes is allowed, or avoids one that now is.
 *
 * Re-rendering the prompt to fix that is the expensive answer: the Environment
 * section is the LAST cached section, so rewriting it invalidates everything
 * after it too (measured at ~10k tokens on a small conversation, ~120k on a
 * large one, to correct ~40 tokens of text). Instead, append the difference as
 * one short hidden message: correct facts at append-only cost, with every
 * cached byte before it left untouched.
 */

/** A stable identity for the facts we render, so an unchanged env is free. */
export function fingerprintEnvironment(env: SystemPromptEnvironment): string {
  return JSON.stringify({
    roots: [...(env.additionalRoots ?? [])],
    allow: [...(env.networkAllow ?? [])],
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function describeList(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.join(", ") : empty;
}

/**
 * The delta between what the prompt says and what is now true, or `null` when
 * they agree — the dedupe that keeps an unchanged environment at zero tokens.
 */
export function buildEnvDeltaMessage(
  rendered: SystemPromptEnvironment,
  current: SystemPromptEnvironment,
): Message | null {
  if (fingerprintEnvironment(rendered) === fingerprintEnvironment(current)) return null;

  const lines: string[] = [];
  const currentRoots = current.additionalRoots ?? [];
  if (!sameList(rendered.additionalRoots ?? [], currentRoots)) {
    lines.push(`- Additional roots are now: ${describeList(currentRoots, "(none)")}`);
  }

  const currentAllow = current.networkAllow ?? [];
  if (!sameList(rendered.networkAllow ?? [], currentAllow)) {
    lines.push(
      currentAllow.length > 0
        ? `- Network allowlist is now: ${describeList(currentAllow, "(none)")} (other hosts are blocked)`
        : "- The network allowlist no longer restricts hosts",
    );
  }

  if (lines.length === 0) return null;

  // Deliberately self-contained: it states the new facts instead of pointing at
  // "the Environment section above". A verbatim custom prompt (Ken's sessions)
  // has no such section, and this is the ONLY way those sessions ever hear
  // about an added root — their prompt is never rebuilt. Wording that referred
  // to a section the model cannot see is what kept them in the dark.
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content:
      "Environment update. These facts changed after your instructions were written, " +
      "and these values are now the correct ones:\n" +
      lines.join("\n") +
      "\nTrust them over anything earlier that disagrees. Do not restate this note; just proceed.",
  };
}

/**
 * Verify commands for languages that appeared after the system prompt was
 * cached (e.g. the previous task scaffolded a TypeScript project). Same
 * append-only idea as the environment update: re-rendering the prompt would
 * invalidate every cached byte after it. `null` when nothing renders.
 */
export function buildLanguageUpdateMessage(
  languages: Set<LanguageId>,
  cwd: string,
): Message | null {
  const sections = renderLanguageGuidance(languages, cwd);
  if (sections.length === 0) return null;
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content:
      "Project update: new languages are now in use, with these checks.\n\n" +
      sections.join("\n\n") +
      "\n\nDo not restate this note; just proceed.",
  };
}
