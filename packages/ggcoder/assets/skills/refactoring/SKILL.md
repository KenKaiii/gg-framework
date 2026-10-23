---
name: refactoring
description: Use for behaviour-preserving restructuring behind an unchanged contract. Do NOT use for renames, bug fixes or behaviour changes.
license: Behavior-preservation methodology synthesized from public sources (Fowler's Refactoring catalog, Tidy First?, and community agent skills by bienhoang, wondelai, mattpocock, jeffallan, vasilyu1983), audited 2026-09-12.
---

# Refactoring

**Scope gate:** Decide from the requested behavior, not the word "refactor". A requested change to return values, error handling, or an API contract is implementation work: inspect the callers, change the contract and callers together, add regression coverage, run the checks. Do not manufacture a separate pure-rename stage merely to enter this skill. Existing authorization and safety controls still apply. For a genuine behavior-preserving refactor, use the gated loop below unchanged.

**Route first:**

| Situation | Mode | Next |
|---|---|---|
| Tidy code you are already touching, suite green | **In-the-small** | Execute loop, inline; keep cleanup to files you are touching |
| User wants a plan, architectural change, or competing approaches | **Plan-first** | Interview, verify claims in the repo, fix scope as in/out lists, check coverage (thin coverage is a question, not an assumption), then a plan of tiny commits that each leave the code working. No file paths or snippets in the plan; they go stale |
| No/red/unrunnable tests, or a migration bigger than one session | **Legacy** | `references/legacy.md` before any edit |
| Same mechanical change across >~10 files or >~500 lines | **Codemod** | `references/legacy.md` → Codemods |

Every observable behavior before the refactoring, bugs included, must exist after it. **Without tests, you're not refactoring — you're editing.**

## Governing rules

1. **Two hats.** Add function or restructure, never both in one change. If new behavior is required, finish and prove the structural change first.
2. **The baseline is a gate, not advice.** Before the first edit the suite runs green on unmodified code, or you build a safety net first (Legacy). Record what you ran. A suite that was already red tells you nothing.
3. **One named transformation per step** (Extract Function, Move Function, Introduce Parameter…). If you cannot name it, it is a rewrite.
4. **Red means revert, not debug.** After each step run the smallest relevant suite. Green ⇒ commit if per-step commits were agreed, message = transformation name. Red ⇒ undo that step at once and take a smaller step. Undo by reversing that step's edits; `git restore` only when every earlier step is committed, because without per-step commits it also wipes the earlier steps in those files.
5. **Never touch tests to get green.** Modifying, loosening, or deleting an assertion in a pure refactor destroys the proof. A test that asserts private internals gets converted to observable behavior first, as its own step.
6. **Smallest suite per step, full suite per finish**: full suite + typecheck + lint on the commands CI runs, including every package that imports what you touched.
7. **Prove it.** The closing question is "can I prove nothing observable changed?": suites run, before/after outputs, a mutation spot-check on critical boundaries. Say what you could not verify.
8. **Make the change easy, then make the easy change.** Preparatory refactoring is the highest-value kind. Do it, then stop.
9. **Public API surface is observable behavior.** Across a published boundary (exports, endpoints, file layout): deprecate-and-alias unless the user chose the break.
10. **Edit sources, not generated output** (`dist/`, vendored, generated files).

## Execute loop

1. **Baseline.** Run the suite on unmodified code; record green. Red or absent → Legacy. No VCS or a tree dirty with unrelated changes → say so and stop for direction.
2. **Commit checkpoint.** Ask once: "I'll commit each verified step on a branch — good?" If declined, keep steps small and report the step list at the end. Never commit without authorization.
3. **Pick one target** by risk-adjusted value: security → correctness → structure → duplication → naming; hotspots (churn × complexity) first. Smells and thresholds: `references/smells.md`.
4. **Apply one named transformation.** Mechanics in `references/smells.md`. Prefer language-aware tools (`code_nav`, IDE rename, AST codemods) over regex.
5. **Verify** per rule 4.
6. **Close** per rule 6. Report transformations applied, before/after, smells left and why, anything deferred. Check `references/agent-pitfalls.md` before closing.

## Risk sets the safety net

| Risk | Touching | Minimum net before editing |
|---|---|---|
| Low | Pure internals, no I/O | Unit tests + types |
| Medium | Module boundary, parsing, state | + contract tests at the seam |
| High | Money, auth, concurrency, migrations, data | + integration tests, a rollback plan, small phases |

Unsure whether behavior could change: **do not apply — ask.**

## When NOT to refactor

- No driver: nothing to add, nothing hurting.
- The code is about to be deleted or replaced.
- No safety net can be built and the risk is medium or higher: report and stop.
- The rewrite instinct ("let me start fresh"): that is a separate conversation with the user, not a refactor.

## Scaling: one agent or several

- In-the-small, or one package you can fully read: main thread only.
- A changed symbol with many callers across packages: impact map first, one read-only repo helper per package returning every caller/import/dynamic reference as file:line. A slice not checked → treat its callers as unknown and keep the public signature.
- Transformations run serialized in the main thread, one named step at a time, revert-on-red; never parallel edits on a shared tree.
- Helper types, brief contents and merge rules come with the skill loader.

## References

- `references/smells.md`: smell catalog, metrics thresholds, prioritization, transformation mechanics
- `references/legacy.md`: characterization tests, seams, branch-by-abstraction, parallel change, strangler fig, codemods
- `references/agent-pitfalls.md`: how agents break "behavior-preserving", and the layered proof that catches it
