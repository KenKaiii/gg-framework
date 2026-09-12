# Smells, Metrics, Prioritization

Detection and targeting material for the refactoring skill. Thresholds are heuristics for *where to look*, never rules that a file crossing one must be refactored.

## Metrics quick reference

Estimate without tooling: cyclomatic complexity ≈ count of decision points (`if`, `while`, `for`, `&&`, `||`, `case`, `catch`, ternary) + 1. Cognitive complexity adds weighting for nesting.

| Metric | Comfortable | Refactor signal |
|---|---|---|
| Cyclomatic complexity (function) | < 10 | 16+ |
| Cognitive complexity (function) | < 10 | 15+ |
| Function length | < 30 lines | 50+ (or one screen) |
| Class/module length | < 300 lines | 500+ |
| Parameters | ≤ 3 | 6+ (or booleans that change behavior) |
| Duplication | — | Same logic 3+ places (Rule of Three) |

## Smell catalog

Work top of list first within a risk band. Each entry: signal → usual transformation.

### Bloaters
- **Long method / function** — exceeds a screen, needs comments to explain sections → Extract Method; conditional blocks each become guard clauses or extracted methods.
- **God class / module** — knows everything, changes for every reason → Extract Class by responsibility; move features to the module that owns the data (Feature Envy fix).
- **Long parameter list** — callers pass the same cluster → Introduce Parameter Object; or pass the object the params came from.
- **Primitive obsession** — coordinates, money, IDs as bare strings/numbers everywhere → Introduce Value Object with validation at creation.

### Change preventers
- **Divergent change** — one module changed for many unrelated reasons → split by reason (Extract Class).
- **Shotgun surgery** — one change scattered across many files → Move Function/Field until one module owns the concept.
- **Parallel inheritance hierarchies** — two hierarchies that must move together → reference one from the other, or unify with a strategy.

### Dispensables
- **Duplicate code** — same logic 3+ places (Rule of Three: tolerate twice, extract on the third) → Extract Function, share it. Two occurrences with divergence is a bug factory.
- **Dead code** — unreached branches, unused exports, commented-out blocks → delete. Git history has it.
- **Speculative generality** — abstraction with one caller, flags always passed the same value, "we might need it" → inline and delete. Treat as aggressively as bloat; agents generate this smell by default.
- **Magic numbers** — unexplained literals → named constant placed where its meaning lives.

### Couplers
- **Feature envy** — method mostly reads another module's data → Move Function to the data.
- **Inappropriate intimacy** — modules poking each other's privates → Move Method/Field, or extract the shared concept.
- **Message chains** — `a.b().c().d()` → hide the chain behind a method on the object you know.
- **Middle man** — class that only forwards → remove it, let callers talk directly.

### Conditionals
- **Deep nesting** — 3+ levels → guard clauses, then Extract Method per branch; Replace Nested Conditional with Guard Clauses.
- **Complex switch repeated** — same switch on type in multiple places → Replace Conditional with Polymorphism (or a lookup table for the simple data case — do not build a class hierarchy to avoid an object literal).
- **Boolean-flag parameters** — `doThing(x, true)` → split into two named functions.

## Transformation mechanics (the load-bearing ones)

Each must be mechanically checkable — "does everything still compile/tests green" — before the next.

- **Extract Method/Function**: create the new function, copy code, pass locals as params, replace body with a call. Pitfall: extraction that captures mutable local state — pass state explicitly or take smaller slices.
- **Rename**: language-aware rename (LSP/IDE) only at any nontrivial scope; never textual find-replace on names shorter than the unique threshold. Renaming is the highest-value, lowest-risk transformation — do it early and often.
- **Move Function**: move, fix references, adjust visibility. Best when the function's data lives in the destination (Feature Envy).
- **Introduce Parameter Object**: group params into a record, migrate callers mechanically.
- **Replace Conditional with Polymorphism**: only after the switch is duplicated in 2+ places; introduce subtype per branch, migrate case by case, delete the switch last.
- **Replace Magic Number / Introduce Named Constant**: constant named by *meaning*, not value (`MAX_RETRIES`, not `THREE`).

## Prioritization

Order targets by **risk-adjusted value**:

1. **Security** — smells near auth, input handling, crypto.
2. **Correctness** — duplication with divergence, boundary-handling drift, shared mutable state.
3. **Hotspots** — churn × complexity. `git log --format=%H <path>` / blame frequency identifies churn; complexity from the table above. A moderately messy file nobody touches is not worth your risk budget.
4. **Structure** blocking the change the user actually wants (preparatory refactoring).
5. **Duplication, naming** — cheapest, do opportunistically in touched files.

Defer with a note when: no failing demand, near deletion, or the safety net cannot reach it this session.
