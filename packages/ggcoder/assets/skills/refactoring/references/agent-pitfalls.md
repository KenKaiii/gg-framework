# Agent Pitfalls: How Refactors Drift

LLM agents fail refactoring in specific, repeated ways. Human seniors watch for these; here is the checklist. Run it over your own diff before closing any refactor.

## Drift modes (check each)

- **Error-handling drift** — the old code swallowed or narrowly caught; the rewrite broadens to `catch (e)` "to be safe", or converts errors to exceptions/returns. Observable behavior changed.
- **Boundary drift** — `>` becomes `>=`, `<` becomes `<=`, off-by-one in slices/loops, `length` vs `length-1`. Classic agent slip, invisible to typecheck.
- **Rounding and numeric drift** — reordered arithmetic that changes floating-point results; integer division appearing where float was; new formatting on numbers.
- **Ordering and concurrency drift** — Map/Set/object iteration order assumed where it wasn't guaranteed; sequential awaits parallelized with `Promise.all`; synchronous effects made async (or the reverse).
- **Null/undefined semantics drift** — old code crashed on null; new code defaults it. Or falsy-checks (`x || y`) "simplified" from explicit `!== undefined` where `0`/`""` are valid values.
- **Scope and visibility drift** — module-level state introduced where locals were; caching added for performance that changes identity or staleness semantics.
- **Silent feature addition** — validation, logging, or "improvements" smuggled in because the old code "looked wrong". The old behavior was the spec.
- **Flaky green** — a test fails, passes on rerun, and gets shrugged off. During a refactor, one flaky red invalidates the whole green: rerun it, and if it flakes, quarantine and fix the flakiness before trusting any suite result.

## Test-healing anti-pattern

The agent's tests go red; instead of reverting the code, it loosens the test. Any test-file change in a pure-refactor diff is a red flag requiring an explicit justification of the form: "this test asserted private internals; converted to assert observable behavior, in a separate prior commit." Loosened bounds, deleted assertions, added `.skip`, `any` casts in assertions — all count.

## Chesterton's Fence

Before deleting code that looks pointless: `git blame`, read the commit message, check issue/changelog references. Code that survives despite looking wrong often guards an incident. If history is unavailable and the reason is unknowable, flag it to the user instead of deleting.

## Layered verification, cheapest first

Escalate only as far as the risk level demands:

1. **Typecheck** — catches signature/shape drift for freer.
2. **Lint** — catches dead code, suspicious patterns, unintended scope.
3. **Unit + characterization suites** — the core proof; smallest relevant suite per step, full suite at close.
4. **Contract test at the changed boundary** — input/output fixtures frozen before the refactor, diffed after.
5. **Mutation spot-check** (high-risk boundaries only) — hand-mutate the refactored code (flip a comparison, drop a condition); tests must fail. If they don't, the net has holes: strengthen tests before trusting green.

## Closing self-review

Re-read your own full diff and answer, in the report:

- Which drift modes above did I check, and how do I know each is absent?
- Did I modify any test file? If yes, justify per the anti-pattern rule.
- What did the suites run, exactly (commands), and were they green on unmodified code first?
- What could I not verify, and what residual risk does the user hold?

"Can I prove nothing observable changed" — not "is the code nicer now".
