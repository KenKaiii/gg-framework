# /goal system efficiency audit

Mandatory reference coverage: this audit is scoped to `[original-goal-prompt]`, which asked the agents to inspect the whole `/goal` system while actively using it, find issues/bottlenecks/over-engineering, simplify where useful, and improve speed/token efficiency. It also preserves the planner handoff requirement by explicitly tracking `GOAL_PLAN` evidence as part of the audit contract.

## Integrated candidate decision

Accepted content:

- The existing production overhead harness in `packages/ggcoder/src/core/goal-overhead-harness.ts` and verifier wrapper `packages/ggcoder/scripts/verify-goal-overhead-harness.ts` as the local/free measurement path.
- Source-backed findings from the existing Goal audit documents: `goal-system-map.md`, `goal-quality-audit.md`, `goal-remediation-plan.md`, `goal-remediation-report.md`, and `goal-system-audit.md`.
- Static candidate evidence from the measurement worker: simple-vs-complex stage/prompt/task/blocker/proof-gate signals.

Rejected content:

- Sibling candidate packets that only changed repo-root `fixes.md`, provider filtering, or unrelated Goal-run patches. They are stale/unrelated to this task's expected changed scope and were not integrated.
- A redundant untracked test-only overhead harness candidate. Its useful measured signals are included here and in `goal-system-overhead-inventory.json`; the current checkout already has a production harness script.

## Required Goal system files covered

| File | Covered concern | Efficiency signal |
| --- | --- | --- |
| `packages/ggcoder/src/ui/App.tsx` | UI lifecycle: start, continue, worker, verifier, worktree integration | orchestration branches, direct continuation plus synthetic-event paths |
| `packages/ggcoder/src/ui/prompt-routing.ts` | `/goal` command routing and planner-to-setup handoff | two setup stages before implementation, `GOAL_PLAN` collection/preservation |
| `packages/ggcoder/src/system-prompt.ts` | planner/setup/coordinator instructions | fixed prompt-token floor and repeated proof semantics |
| `packages/ggcoder/src/core/goal-controller.ts` | next-action decisions and completion gates | evidence/harness/verifier/final-audit proof-gate count |
| `packages/ggcoder/src/core/goal-store.ts` | durable state, tasks, evidence, verifier/audit records | durable state size and cross-process merge requirements |
| `packages/ggcoder/src/core/goal-worker.ts` | isolated worker process/system prompt/candidate packet | worker prompt size and process startup overhead |
| `packages/ggcoder/src/core/goal-worktree.ts` | isolated candidate worktree/integration checks | safety checks vs integration latency |
| `packages/ggcoder/src/core/goal-overhead-harness.ts` | synthetic local overhead measurement | stage, prompt, task, blocker, proof-gate signals |
| `packages/ggcoder/scripts/verify-goal-overhead-harness.ts` | local verifier for overhead harness | generates JSON proof artifact |
| `packages/ggcoder/package.json` | package-level verifier entrypoints | `verify:goal:overhead` exists; this task adds `goal:overhead-audit` |

## Measured/static overhead evidence

The intended experience for `[original-goal-prompt]` is: a user types `/goal <objective>`, the system preserves mandatory references and `GOAL_PLAN`, then agents move A-to-Z with the smallest local/free proof path that still prevents false completion.

Signals needed for goal-specific failures:

- **Stage count:** catches extra planner/setup/coordinator/worker loops before useful work.
- **Prompt characters:** approximates token overhead from mode prompts and worker instructions.
- **Task count:** catches over-decomposition for simple local work.
- **Blocker count:** catches optional/external prerequisites blocking local proof.
- **Required proof gates:** catches evidence/harness/verifier/audit multiplication beyond the needed durable proof.

Observed local/static harness signals recorded in `packages/ggcoder/docs/goal-system-overhead-inventory.json`:

| Scenario | Stage count | Prompt chars | Task count | Blocker count | Required proof gates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Simple local goal | 4 | 10,585 | 1 | 0 | 4 |
| Complex audit goal | 6 | 11,090 | 8 | 4 | 14 |
| Delta | +2 | +505 | +7 | +4 | +10 |

Interpretation: prompt characters only rise about 5% in the complex fixture because both paths already pay a high fixed setup/system/worker prompt floor. The larger scaling bottleneck is orchestration: complex goals add tasks, blockers, and proof gates quickly. For simple goals, the fixed prompt floor and multi-stage setup are the main overkill.

## Findings

### 1. Fixed prompt floor is high for simple goals

- Evidence: simple scenario still measured 10,585 prompt characters before/around a one-task local proof.
- Impact: high for latency/token use on simple `/goal` requests.
- Risk of change: medium; prompt compaction must preserve mandatory reference, proof, worker cleanup, and candidate-packet requirements.

### 2. Proof gates scale faster than useful work

- Evidence: required proof gates rose from 4 to 14 in the complex fixture, while measured prompt chars only rose by 505.
- Impact: high for wall-clock time and model turns.
- Risk of change: medium/high; verifier and final audit gates are essential and should be compacted, not removed.

### 3. Optional blockers can dominate local/free proof paths

- Evidence: complex fixture models 4 blockers/missing proof states, including external-style prerequisites that should not block local/free evidence.
- Impact: medium; blockers cause extra coordinator turns and user prompts.
- Risk of change: medium; true missing paid credentials must still pause with exact instructions.

### 4. Artifact/verifier naming drift slows final handoff

- Evidence: previous audit docs note drift between requested audit artifact names and existing artifacts, plus stale literal verifier expectations.
- Impact: medium; agents spend turns reconciling paths instead of implementing.
- Risk of change: low; adding a stable audit verifier alias and required strings is straightforward.

### 5. Current isolation/worktree safety is worth its overhead for risky integration

- Evidence: this task intentionally ran in an isolated candidate worktree and rejected unrelated sibling packets.
- Impact: positive safety, moderate latency.
- Risk of simplification: high if removed globally. Prefer fast-path only for explicitly safe single-checkout tasks; keep worktrees for integration or multi-worker Goals.

## Ranked quick wins/design changes

1. **Fast-path simple local Goals after setup quality is met** — Impact: high; Risk: medium. If a run has `[original-goal-prompt]` coverage, success criteria, exactly one local/free evidence path, no missing prerequisites, and a verifier command, let the controller run the worker/verifier without creating extra instrumentation tasks.
2. **Compact repeated Goal proof instructions** — Impact: high; Risk: medium. Move stable proof/candidate-packet language into a shorter referenced contract once durable Goal state already contains criteria/evidence/verifier metadata.
3. **Normalize artifact names and verifier aliases** — Impact: medium; Risk: low. Add a stable `goal:overhead-audit` script that verifies this report and the JSON inventory instead of relying on ad hoc path names.
4. **Classify blockers by required vs optional/local-free** — Impact: medium; Risk: medium. Missing paid services should block only when no local/free proof can observe the intended signal.
5. **Preserve verifier/final audit gates but reduce post-pass chatter** — Impact: medium; Risk: low. Once verifier output and final audit are durable and fresh, summaries can be compact pointers to artifacts.

## Verifier contract for this audit

The verifier for this integration must observe the actual failure signals, not just narrative claims. It should check that:

- `packages/ggcoder/docs/goal-system-efficiency-audit.md` exists and mentions `[original-goal-prompt]`, `GOAL_PLAN`, required source files, measured overhead signals, and ranked recommendations.
- `packages/ggcoder/docs/goal-system-overhead-inventory.json` is valid JSON and contains measured simple/complex overhead data.
- The package still exposes and can run the local overhead harness path when dependencies are installed.

This candidate adds `packages/ggcoder/scripts/verify-goal-overhead-audit.ts` and `package.json` script `goal:overhead-audit` for those checks.

## Residual risks

- This audit uses local/static harness evidence; it does not prove provider-backed live TUI latency with real model/network variability.
- Prompt-character counts are a proxy for tokens, not tokenizer-exact billing counts.
- The fast-path recommendations are design changes, not implemented behavior in this integration task.
- Local verifier execution in this worker initially failed because `node_modules`/`tsx` were absent in the isolated worktree; the script itself is still added for coordinator environments with dependencies installed.
