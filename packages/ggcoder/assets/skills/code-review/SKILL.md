---
name: code-review
description: Use when asked to review a diff, PR or finished work. Do NOT use mid-build.
---

# Code Review

**Route first:**

| Situation | Mode | Next |
|---|---|---|
| Small diff: one concern, ≲ ~400 changed lines, few files | **Single pass** | Method below; both axes yourself, spec first, then standards |
| Large diff, multi-package PR, or many unrelated concerns | **Fan-out** | Build the ledger, then `## Scaling` |
| Diff written by an agent (including you, this session) | Either mode **+ agent checks** | Also run `references/agent-diffs.md` |
| User asks "is it secure?" | Defer | Load the `bulletproof` skill — do not audit security here |

Two questions, kept separate because each contaminates the other:

1. **Spec axis** — does the change do what was asked, completely, and nothing unasked?
2. **Standards axis** — does it meet how this repo builds: design, correctness, error handling, tests, naming, dead code, scope?

## Method

1. **Pre-flight.** Resolve the exact ref/range (`git diff --stat <base>...<head>`) and confirm it is non-empty BEFORE review work — a bad ref must fail here. Read the motivating request/issue/task first; spec compliance cannot be judged without the spec. No spec available → say so and review standards only.
2. **Claims ledger.** List every claim from the PR description, commit messages, or the agent's "done" report ("adds X", "fixes Y", "tests pass", "no behaviour change"). Each row ends `verified (file:line or command output)` / `contradicted` / `unverifiable`. A claim with no matching hunk is a **[spec]** finding.
3. **Run what is cheap.** Typecheck, lint, affected tests — the commands CI uses. Record the actual result. Never write "tests pass" from reading.
4. **Read the whole diff, then the context.** Every changed line, plus callers of changed signatures (`code_nav references`). Start with design: does the change belong here, at this layer, now? (Google eng-practices ranks design first.)
5. **Spec pass, then standards pass.** Never interleave. Standards baseline below; agent failure modes in `references/agent-diffs.md`; test quality in `references/tests.md`.
6. **Report, then fix what the user selects.** Never auto-apply fixes mid-review.

## Findings format

One line each, anchored and actionable:

`[severity] [spec|standards] path/file.ts:42 — problem. Why it matters. Fix: concrete change.`

| Severity | Means | Example |
|---|---|---|
| **blocking** | Must change before merge | Wrong behaviour, missing requirement, deleted/weakened test, swallowed error, hallucinated API or package |
| **non-blocking** | Should change; may follow up | Duplicate helper, weak assertion on a non-critical path |
| **nit** | Optional polish | Naming, local readability |
| **question** | You cannot tell; author must answer | Unclear intent, unverifiable claim |

Rules:
- Keep **[spec]** and **[standards]** as two separate lists — never merge the lists into one ranking; the axes are not comparable and merging re-ranks by noise. Order by severity within each list.
- Every finding cites a `file:line` you re-opened yourself. No line → it is a **question**, not a finding.
- Comment on the code, not the author; say why.
- Skip what tooling already enforces — if lint/CI catches it, it is noise.
- Security: one line, `[defer → bulletproof] file:line — what looked risky`. Do not rate or fix it here.

## Standards baseline (when the repo defines none)

- **Design:** abstraction with one caller; logic in the wrong layer; new dependency where stdlib or an installed package does it.
- **Correctness:** boundary/off-by-one, null/empty handling, ordering/concurrency changes, error paths.
- **Errors:** I/O and external calls without handling; broad `catch` that swallows or logs-and-continues.
- **Tests:** behaviour change without a test; tests that assert internals or nothing (`references/tests.md`).
- **Hygiene:** dead code, commented-out blocks, debug prints, names that hide intent, secrets in the diff.
- **Suppression:** skipped tests, `as any`/`@ts-ignore`/`noqa`/`eslint-disable`, relaxed thresholds, `continue-on-error` in CI.
- **Scope:** files or refactors outside the request; config, lockfile, or CI changes nobody asked for.

## Verdict

- **works as asked** / **works with gaps** (name them) / **not ready** (blocking reasons).
- Claims ledger: N verified, N contradicted, N unverifiable.
- What you ran (commands + result) and **what was not checked**.

Never "looks good"/"LGTM" without stating what was and was not verified. Never certify a change safe or bug-free.

## Scaling: one agent or several

- Single-pass size: main thread only, never spawn.
- Larger, multi-package, or > ~15 files: build a coverage ledger (rows = lens: spec, standards, tests, agent checks × package/directory; each ends `checked-with-findings` / `checked-clean` / `not-checked(reason)`), then one read-only repo helper per row group. Brief each with the exact `git diff <base>...<head> -- <paths>` and the spec text verbatim (spec lens) or repo conventions (standards lens).
- Security-sensitive hunks: a security auditor briefed with the bulletproof skill root, then a verifier on its findings.
- High-stakes merge (release, > ~1,000 lines): one fresh-context verifier tries to disprove each blocking finding.
- Merging: dedupe, and keep spec and standards lists separate. Helper types, brief contents and merge rules come with the skill loader.

## Sources (SNAPSHOT, accessed 3 October 2026)

- Google eng-practices — https://google.github.io/eng-practices/review/reviewer/looking-for.html, …/reviewer/comments.html, …/reviewer/standard.html, …/developer/small-cls.html
- Conventional Comments (labels, blocking/non-blocking) — https://conventionalcomments.org/
- Mutation-testing concept — https://stryker-mutator.io/docs/
- Package hallucination — Spracklen et al., USENIX Security 2025 (arXiv:2406.10279); 2026 re-evaluation, not peer-reviewed (arXiv:2605.17062), via https://socket.dev/blog/slopsquatting-targets-across-frontier-llms
