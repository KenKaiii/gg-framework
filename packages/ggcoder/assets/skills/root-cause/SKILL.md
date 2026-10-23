---
name: root-cause
description: Use when a bug resists the obvious fix or is flaky. Do NOT use when the cause is obvious.
---

# Root-Cause

Build a feedback loop, then let evidence kill hypotheses. Each phase has a gate. Keep a hypothesis log as working notes (`H# | prediction | experiment | result | verdict`); show it in the final answer when the ask was "why", otherwise summarise it in one line.

## Phase 1 — Build the loop

ONE command that reproduces the failure on demand. Cheapest first: failing test → curl/script → CLI run → headless browser script → trace replay → minimal harness.

Gate: **red-capable**, **deterministic**, **fast** (seconds), **agent-runnable**. Run it red. No red command, no Phase 2.

- **Flaky?** Run it N times (e.g. 20–50) and record the fail rate; that rate is the signal. Vary one thing at a time (order, seed, parallelism, timing) until it is deterministic or the rate moves.
- **Worked before?** With a known-good commit and the loop as a script: `git bisect start <bad> <good>`, then `git bisect run <script>` (exit 0 = good, 125 = skip untestable commit, any other 1–127 = bad). Always `git bisect reset` after. Ask first if the tree has uncommitted work.

## Phase 2 — Shrink it

Remove input, config, and code until removing anything more makes it pass (delta debugging: halve, test, keep the failing half). What survives is implicated. Already minimal? Say so.

## Phase 3 — Hypotheses

3–5 falsifiable one-liners, each naming the observation that would kill it. Rank by likelihood × cheapness. Show the list (non-blocking).

## Phase 4 — One variable

Test one hypothesis at a time, cheapest first. Never change two things between runs. Instrument boundaries (inputs, outputs, timing), not everything; prefer existing logging/tracing or the debugger. Tag new debug output `[DBG-xxxx]` (random suffix) so removal is one grep.

## Phase 5 — Regression test before fix

Write the failing regression test FIRST at a real seam. No honest seam? Record that as a finding and test at the nearest honest boundary. No suite and none requested? Keep the repro script as the check — never introduce a suite unasked.

## Phase 6 — Close out

If the ask was "why", stop at the answer and the fix it implies — change code only when the user asks for the fix. Otherwise fix, run the loop green (flaky: N runs, zero failures), run the regression test, grep-remove every `[DBG-xxxx]`, and state the cause in one sentence: cause → mechanism → symptom. Label claims `RUNTIME` / `CODE` / `DEDUCED`.

Hard rules: three failed fixes → the hypothesis list is wrong; return to Phase 3. Redact secrets from any quoted or committed log line.

## Scaling: one agent or several

- Reproduction, shrinking, and experiments: main thread only — one variable at a time.
- Wide codebase (several packages could own the bug): in Phase 3 you may send one read-only repo helper per hypothesis; brief = symptom, repro command, paths, "return file:line evidence for/against; do not run or edit". Treat replies as `CODE` leads to re-open, not verdicts. Helper types, brief contents and merge rules come with the skill loader.

Sources (accessed 3 October 2026): https://git-scm.com/docs/git-bisect; https://www.debuggingbook.org/html/DeltaDebugger.html
