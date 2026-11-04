---
name: shared-language
description: Use when domain terms drift or a decision needs an ADR. Do NOT use for renames.
---

# Shared Language

A repo's terms are its compression. When you and the user mean the same thing by "reservation", every prompt, name, and doc gets shorter and sharper — and the agent stops spending thinking tokens re-deriving what a single word encodes. This skill builds and maintains that vocabulary.

## The glossary — CONTEXT.md

At the repo root. **A glossary and nothing else**: term — a one-to-three-line definition, no implementation details, no history. If a definition names a file path, it has become documentation; move that out.

- Challenge fuzzy terms against it: "the glossary defines *cancellation* as pre-charge; this change reads as post-charge — which is meant?"
- Stress-test a new term with an invented edge case before recording it ("is a no-show a cancellation?").
- Update **inline, the moment a term settles** — never batch glossary edits for "later"; later never comes.
- Name files, functions, variables, and tests with glossary terms verbatim. When code and glossary disagree, one of them is wrong — find out which.
- Create the file lazily on the first settled term, never as an empty template.
- On first creation, add one line to the repo's instruction file (AGENTS.md, or CLAUDE.md if that is what the repo uses): `Read CONTEXT.md before naming anything.` CONTEXT.md is not auto-loaded — the pointer is what makes the glossary ambient in every session.

## Decision records — docs/adr/

An ADR earns its file only when a decision is **hard to reverse**, **surprising without context**, and **a real tradeoff** — all three. One file per decision: title, 1–3 sentences of context, the decision, the main rejected alternative and why. Numbered; immutable once accepted — supersede, never edit.

Read the ADRs before proposing a change that contradicts one: honor it, or surface the conflict to the user. Never silently relitigate a recorded decision, and never re-suggest a rejected alternative without new facts.

## Integration

- During a clarify session: settled terms go to the glossary; qualifying hard calls get an ADR offer.
- Before naming anything: read the glossary if it exists.
