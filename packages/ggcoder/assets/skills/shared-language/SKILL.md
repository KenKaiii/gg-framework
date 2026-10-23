---
name: shared-language
description: Use when domain terms drift (glossary, CONTEXT.md) or a hard-to-reverse decision needs an ADR (decision record). Do NOT use for renames.
---

# Shared Language

Two artifacts: the glossary (`CONTEXT.md`) and decision records (`docs/adr/`). On entry, read both if they exist, then act on the trigger: term settled → glossary; hard call made → offer ADR; change contradicts an ADR → surface it.

## The glossary — CONTEXT.md

At the repo root. **A glossary and nothing else**: `term — 1–3 line definition`, plus `Avoid: <synonyms>` where drift exists. No file paths, implementation, or history.

- Challenge fuzzy usage against it: "glossary says *cancellation* is pre-charge; this reads post-charge — which?"
- Test a candidate term with an invented edge case before recording it ("is a no-show a cancellation?").
- Update the moment a term settles; create the file lazily on the first settled term, never as an empty template.
- Code, tests, and UI use glossary terms verbatim. Code and glossary disagree → one is wrong; ask which.
- On creation, add to the repo's instruction file (AGENTS.md, or CLAUDE.md if that is what it uses): `Read CONTEXT.md before naming anything.` CONTEXT.md is not auto-loaded — that pointer is what makes it count in later sessions.

## Decision records — docs/adr/

Only when a decision is **hard to reverse**, **surprising without context**, and **a real tradeoff** — all three. Offer it; don't write unasked.

- Follow the repo's existing ADR format. None? Use the MADR 4 minimal shape: `NNNN-title-with-dashes.md` with Context and Problem Statement, Considered Options, Decision Outcome (chosen option + why), Consequences; `status: accepted` in front matter.
- Immutable once accepted — supersede, never edit: new ADR notes `Supersedes NNNN`; the old one's status becomes `superseded by NNNN` (the only allowed change).
- Before proposing a change that contradicts an ADR: honour it or raise the conflict. Never re-suggest a rejected option without new facts.

## Scaling: one agent or several

Main thread only. On a large repo, one read-only repo helper may inventory competing terms across packages (occurrences with file:line); the main thread decides and edits. Helper types, brief contents and merge rules come with the skill loader.

Sources (re-checked 22 October 2026): MADR 4.0.0, still the latest release (2024-09-17) — https://adr.github.io/madr/; ubiquitous language — https://martinfowler.com/bliki/UbiquitousLanguage.html
