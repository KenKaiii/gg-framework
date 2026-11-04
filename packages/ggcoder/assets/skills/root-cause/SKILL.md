---
name: root-cause
description: Use when a bug resists the obvious fix or is flaky. Do NOT use when the cause is obvious.
---

# Root-Cause

The discipline: build a feedback loop before theorizing, then let evidence kill hypotheses. Everything else is mechanical. Each phase has a gate — do not pass a gate that has not been met.

## Phase 1 — Build the loop

Construct ONE command that reproduces the failure on demand. Cheapest construction that works, in order: failing test → request script (curl) → CLI invocation → headless browser script → recorded trace replay → minimal harness → bisect → differential run (old vs new).

Exit gate — the command must be **red-capable** (fails while the bug lives), **deterministic** (same input, same result), **fast** (seconds, not minutes), and **agent-runnable** (no manual UI steps). Run it red. No red command, no Phase 2.

## Phase 2 — Shrink it

Strip the repro to the smallest input and config that still fails. Each removal teaches what is irrelevant; what survives is implicated. Already minimal? Say so and move on.

## Phase 3 — Hypotheses

List 3–5 hypotheses, one sentence each, each falsifiable by a specific observation ("stale cache after config reload — clearing the cache between runs makes it disappear"). Rank by likelihood × cheapness to test. Show the user the list before testing — non-blocking.

## Phase 4 — One variable

Test one hypothesis at a time, cheapest first. Tag debug output `[DBG-xxxx]` with a random suffix per investigation so removal is one grep. Never change two things between runs of the loop.

## Phase 5 — Regression test before fix

With the winning hypothesis, write the failing regression test FIRST, at a real seam. If no correct seam exists to test this behavior, that absence is itself the finding — the module boundary is wrong. Record it and test at the nearest honest boundary. No test suite in the project and none requested? Keep the repro script as the regression check — never introduce a suite unasked.

## Phase 6 — Close out

If the ask was "why", stop at the answer: report the root cause and the fix it implies — change code only when the user asks for the fix. Otherwise: fix. Run the loop green, run the regression test, remove every `[DBG-xxxx]` line (grep the tag), and state the root cause in one sentence in the commit or report: cause → mechanism → symptom.

Hard rules: if the same fix attempt fails three times, stop patching — the hypothesis list is wrong, not the code; return to Phase 3. Redact secrets from any log line quoted or committed.
