---
name: clarify
description: Use when requirements are genuinely unsettled, or the user asks to be interviewed on a plan, spec or design. Do NOT use for routine work.
---

# Clarify

Decision-forcing, not permission-asking. Pick the mode:

- **Quick gate** (mid-build, a blocking decision appears) → one `ask_user` call with every blocking question; keep building everything that does not depend on the answer. Never halt the whole task at one branch point.
- **Full interview** (user asks to refine a plan/spec/design) → run the rounds below.

## Rules for every question

1. **Never ask for facts.** If reading code, running a command, or checking docs can answer it, do that instead. Only decisions reach the user: product calls, taste, tradeoffs with real stakes.
2. **Ask only the frontier.** A question is on the frontier when every decision it depends on is settled ("needs persistence?" before "which database?"). Never re-ask a settled decision.
3. **One `ask_user` call per round, never prose questions.** Each question: clickable options, your recommended option first and marked, a one-line reason, and the **default** you will apply if skipped ("Default if skipped: SQLite").
4. **Show behaviour choices as examples.** When options differ in behaviour, give one concrete case per option ("Given an empty cart, When checkout is pressed, Then …"). Examples expose disagreement that abstract wording hides.

## Full-interview rounds

1. Investigate first; list open decisions; keep only the frontier.
2. Ask the round (rule 3).
3. Record answers as one-line facts — `Settled: dark theme only`. Skipped questions settle to their stated default.
4. Repeat until a round yields no new frontier questions.
5. Close: print the decision list plus Given/When/Then acceptance examples for each load-bearing behaviour, then build (or hand back if the user only wanted the plan).

Hand-offs (shared-language skill): newly settled domain terms → glossary; a decision that is hard to reverse, surprising, and a real tradeoff → offer an ADR.

## Do not

- Drip one question per reply — batch the round.
- Ask about futures nobody has committed to; ask only what is load-bearing for work about to start.

## Scaling: one agent or several

Main thread only; the interview itself is never delegated. Fact-finding across several packages or the web may go to read-only repo helpers or a researcher. Helper types, brief contents and merge rules come with the skill loader.

Sources (accessed 3 October 2026): Given-When-Then — https://martinfowler.com/bliki/GivenWhenThen.html
