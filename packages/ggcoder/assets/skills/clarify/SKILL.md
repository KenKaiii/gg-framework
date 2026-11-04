---
name: clarify
description: Use when requirements are genuinely unsettled. Do NOT use for routine work.
---

# Clarify

Misalignment is the most expensive failure in software: the build succeeds and the thing is still wrong. This skill is a structured interview that settles every open decision **before** implementation. It is not permission-asking — it is decision-forcing.

## Two modes

**Quick gate** — mid-build, when you hit an unanswered decision that materially changes the result: batch every blocking question into ONE numbered list, each with your recommended answer, and keep building the parts that don't depend on it. Never stop a whole task at one branch point.

**Full interview** — the user asks to refine a plan, spec, or design. Run the rounds below.

## Rounds (full interview)

Work the decision tree from the top:

1. **Ask only the frontier.** A question belongs on the frontier when every decision it depends on is already settled. Asking "which database?" before "does this need persistence?" wastes a round; so does re-asking anything an earlier round settled.
2. **Batch the round.** Every frontier question in one message, numbered, each with `→ recommended: X` and a one-line reason. A recommendation is cheap for the user to confirm and expensive for them to derive.
3. **Never ask for facts.** Facts are yours: read the code, run the command, check the docs, delegate the wide search. If investigation can answer it, it is not a question — it is homework. Only decisions — taste, product calls, tradeoffs with real stakes — reach the user.
4. **Record what settled.** After each round, restate the settled decisions as one-line facts ("Settled: dark theme only") before asking the next round, so the record is unambiguous.
5. **Stop at empty frontier.** When a round produces no new questions, the session is done: restate the full decision list, then start building. The goal is settled decisions, not exhaustive documentation.

## Anti-patterns

- **Interrogation drip** — one question per reply across ten replies. Every reply costs the user a context switch; batching is the fix.
- **Homework outsourcing** — asking what you could have read. Burns trust and returns worse answers than the source.
- **Speculative depth** — questions about futures nobody has committed to. Ask when the decision is load-bearing for work you are about to do.
