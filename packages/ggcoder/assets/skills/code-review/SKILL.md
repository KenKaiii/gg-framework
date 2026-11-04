---
name: code-review
description: Use when asked to review a diff, PR or finished work. Do NOT use mid-build.
---

# Code Review

Two independent questions, kept separate because each contaminates the other:

1. **Spec axis** — does this change do what was asked, completely, with nothing asked that is missing?
2. **Standards axis** — does it meet how this repo builds: correctness, error handling, tests at real seams, naming, dead code, scope discipline?

## Method

1. **Pre-flight.** Resolve the exact ref and range and confirm the diff is non-empty BEFORE any review work — a bad ref must fail here, not two passes deep. Read the request or task that motivated the change first: spec-conformance cannot be judged without the spec.
2. **Split the passes.** On anything larger than a small diff, run the two axes as separate subagents — the spec brief pastes in the original request, the standards brief pastes in the repo's conventions. Separate contexts keep one axis from anchoring the other. Small diffs: run both passes yourself, in that order, never interleaved.
3. **Findings format.** Per finding: `file:line`, one-line problem, why it matters, the concrete fix. Label each **[spec]** or **[standards]**, and never merge the lists into one ranking — the axes are not comparable, and merging re-ranks by noise.
4. **Report, then fix what is selected.** Report first; fix what the user picks. Never auto-apply fixes mid-review.

Security findings belong to the `bulletproof` skill — note them and defer; do not audit them here.

## Standards baseline (when the repo defines none)

Missing error handling on I/O and external calls; load-bearing logic without tests, or tests asserting implementation details; dead code and commented-out blocks; names that hide intent; an abstraction used once; a new dependency where the standard library or an installed package would do; secrets in the diff; suppression of failing checks (skipped tests, `as any`, relaxed assertions).

Skip anything tooling already enforces — findings the linter or CI catches are noise.

## Verdict

End with the honest state: **works as asked** / **works with gaps** (name them) / **not ready** (blocking reasons). Never "looks good" without stating what was and was not verified.
