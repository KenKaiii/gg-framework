---
name: tdd
description: Use when asked for test-first development. Do NOT use for post-build tests.
---

# TDD

Red → green, one slice at a time. This skill is the reference that makes the loop produce tests worth keeping — most of it applies on every cycle, so consult it before and during the loop, not after.

## Seams — agree before writing

A **seam** is the public boundary where behavior is observable: an exported function, an HTTP route, a CLI invocation. Tests live at seams; they never reach into internals.

Before the first test, write down the seams under test and confirm them with the user — which boundaries get tests and which stay untested is a decision, and settling it up front is what keeps effort on critical paths instead of every edge case. No test at an unagreed seam.

## The loop

1. **Red.** One failing test at an agreed seam, for the next smallest real behavior. Run it; watch it fail for the right reason.
2. **Green.** The least code that passes — nothing speculative. Run it.
3. **Repeat.** The next test responds to what the last cycle taught. Work in vertical slices, never layers: writing all tests then all implementation verifies *imagined* behavior and locks in structure before understanding.
4. **Refactor outside the loop.** Cleanup happens at a checkpoint after a green cycle or in a review pass — not interleaved guesswork inside red-green.

## Test quality rules

- **Expected values from an outside source of truth** — a known literal, a worked example, the spec. Never recompute the expected value the same way the code does; that test can only agree with itself and can never catch the bug.
- **Behavior, not structure.** Assert on what the interface does. A test that breaks under a refactor with unchanged behavior is coupled to implementation — rewrite it at the seam, never patch it with mocks of internals.
- **Real paths over mocks.** Exercise real code; mock only external boundaries (network, clock, filesystem) and only when they are slow or stateful.
- **Named like a spec.** "user can check out with an empty cart" — the name alone states the capability.

The loop inherits the verification gate: never claim a cycle green that you did not run.
