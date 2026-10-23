---
name: evidence-led-ui
description: Use when building, changing or reviewing UI: pages, sections, components, layout, styling, visual polish, accessibility. Do NOT use for behaviour-only changes.
license: See LICENSES.md
compatibility: Full review requires filesystem inspection and rendered screenshots (deferred `screenshot` tool); web research and device tooling are optional and unavailable checks must be reported as unverified. Baseline rows, WCAG 3.0 status and ADA Title II dates re-verified 22 October 2026.
---

# Evidence-Led UI

Pick your mode, then follow only that section:

| Situation | Mode | Go to |
| --- | --- | --- |
| One control, state, border, icon inset, focus bug, or token tweak | Small edit | § Small-edit path |
| New screen/page/component, redesign, or "make it look less generic" | Build | § Build loop |
| "Review this UI", audit screens or flows, pre-ship look | Review | § Review mode |

Every mode obeys § Binding defaults. Preserve the project's visual language unless the user asked for a redesign.

## Small-edit path

Skip the design workflow, not verification:

1. Read the shared primitive, tokens, state rules, and callers. Reproduce the reported sequence before editing.
2. Focus, borders, glass, or dropdown icons: read `references/craft-rulings.md` § Control icon insets and § No sticky pointer focus. Find the rule that paints the defect before adding an override.
3. Fix the shared owner, not each screen. Check variants; remove superseded local treatments in scope. Added copy must pass § Copy must earn its space.
4. Run the applicable interaction regression matrix in `references/craft-rulings.md` via browser checks. Screenshots alone cannot pass interaction checks. Report actual evidence and unverified platforms.

## Build loop

One design thesis, one author. Do not blend directions.

1. **Inspect.** Read nearest routes, components, tokens, type, icons, motion, and states. Reuse the local system; add no library just for a look. React and nothing local fits: read `references/ui-libraries.md` and use `ui_registry`/`ui_adopt` (via `tool_search`) for real Bklit/Kokonut source, never a lookalike.
2. **Content first.** Write real headline, labels, section copy, and realistic data (longest, empty, 0/1/many) before layout. Rank it. Delete sections with nothing true to say. Never invent metrics, testimonials, logos, or ratings; label fixtures. Details: `references/direction.md` § 1.
3. **Read the job.** Surface type, audience, single job, risk, platform, constraints. Infer from the project and state the inference; ask only for genuine taste or product decisions. Net-new or redesign: read the matching section of `references/archetypes.md`.
4. **Write the thesis** using the template in `references/direction.md` § 2: signature, type roles, OKLCH colour tokens with intended contrast pairs, spacing/density, radius/material, imagery, motion, rejected defaults. Broad work goes in `DESIGN.md`.
5. **Slop check the thesis** against `references/anti-defaults.md`. Every tell is replaced or justified with "This belongs because…". Run the neighbour test (§ 7 there).
6. **Plan states:** loading, empty, error, retry, success, disabled, destructive; hover, focus-visible, press, selected, expanded, pending; keyboard order, overlays, narrow/wide, reduced motion, zoom/reflow, long and localized text. Apply the accessibility sections of `references/production-contract.md`; the full contract for forms, navigation, data/AI, native, or release work.
7. **Implement** the complete flow with real content. Decision-critical information and the primary action stay visible or one obvious action away on desktop and mobile.
8. **Verify rendered output** (§ Rendered verification loop).

## Rendered verification loop

1. Load `screenshot` via `tool_search`. Capture desktop (~1440 px) and mobile (~390 px), plus key states.
2. Compare each capture against the written thesis line by line, then against `references/anti-defaults.md`.
3. Score with `references/quality-rubric.md`. Measure contrast of real rendered pairs; record pass/fail/unverified for applicable contract checks.
4. Fix the weakest criterion and every contract failure. Remove one decorative idea that does not serve the job. Re-capture.
5. Stop after one revision unless the gate still fails. Gate: **20/24 or higher**, no zero in accessibility, consistency and flow, responsive behaviour, state completeness, or content authenticity, and no applicable WCAG A/AA failure. Small components: 2 on every applicable floor criterion.

No screenshot tool or browser available: say so, mark visual checks unverified, never claim the look was verified.

## Review mode

Inspect code and rendered output. Return findings ordered by impact, each with screenshot or file:line evidence, label (`RUNTIME` observed, `CODE` read in source, `DEDUCED`, `SNAPSHOT` dated source), and the fix. Separate floor defects (accessibility, states, broken layout) from aesthetic opportunities (slop tells). Recommend one resolved direction.

## Binding defaults

Details and fixes: `references/craft-rulings.md`.

- **No emoji UI.** One coherent icon family; reuse the project's.
- **Uniform geometry and one content rail.** Shared max-width, gutters, and breakpoint padding for nav, header, main, footer. Break alignment only for a stated content reason.
- **Control icon insets.** Chevrons and trailing icons get a deliberate inline-end inset plus reserved text padding; never touch the edge or overlap text; logical properties for RTL.
- **Reuse first.** Existing components, variants, tokens, focus rings, motion curves before new ones.
- **Focus is not selection or decoration.** Diagnose the painted layer; one shared focus treatment separate from borders, glass, selected, expanded, error. No stacked rings. Prefer native `:focus-visible`; custom modality handling needs a reproduced defect and the regression matrix.
- **No soft semantic tint-on-tint** unless requested or required by an existing variant.
- **Motion:** no generic hover lift, no `transition: all`, named properties, tokens, reduced-motion path.
- **Intentional type and colour:** see `references/direction.md`. Not Inter/violet-gradient by default on brand surfaces.
- **Copy must earn its space.** No automatic subtitles, helper paragraphs, or footer notes; supporting text adds information the interface lacks. Named-outcome CTAs.
- **No em dashes in UI copy** unless requested or exact supplied copy.
- **WCAG 2.2 Level AA is the accessibility floor** for every applicable A/AA criterion across complete flows; native apps add WCAG2ICT and platform rules. Stricter project or legal rules win. Accessibility is never traded for aesthetics or speed.
- **No unsupported accessibility claims.** Never say `ADA compliant`, `WCAG conformant`, or "accessible" from source review or scanners; that needs a defined scope, per-criterion evidence, manual keyboard and assistive-technology testing, and owner/legal review. Dated legal context: `references/production-contract.md` § 2.

## Scaling: one agent or several

- Stay single-threaded for small edits, builds, redesigns, and reviews of one or two flows you can render yourself. One thesis, one author; never split a design across children.
- Fan out a review of many screens, flows or apps: read-only repo helpers, one per disjoint flow, each owning ledger rows (flow × {slop tells, states, accessibility contract, responsive}) and capturing desktop and mobile screenshots; they read `references/anti-defaults.md`, `references/quality-rubric.md` and the accessibility sections of `references/production-contract.md`.
- One researcher for a dated legal or platform claim. Fixes stay on the main thread (or editors on disjoint files) against the single thesis.

Helper types, brief contents and merge rules come with the skill loader.

## Reference map

Load only what the task needs; resolve paths from the skill root.

- `references/direction.md`: content-first, thesis template, type, OKLCH colour, spacing, imagery, motion, stable Baseline features, INP practice.
- `references/anti-defaults.md`: slop tells with replacement moves and the neighbour test.
- `references/craft-rulings.md`: icons, geometry, insets, focus vs selection, regression matrix, type loading, contrast, copy rules.
- `references/production-contract.md`: pass/fail semantics, WCAG/ADA/EAA context, forms, performance, platform, trust, AI, release evidence.
- `references/quality-rubric.md`: rendered scoring gate.
- `references/ui-libraries.md`: Bklit/Kokonut adoption and Motion APIs.
- `references/archetypes.md`: surface-specific direction and upstream source slugs.
- `references/observed-patterns.md`: measured corpus observations; read only the section that answers a question; keep numerator/denominator with any claim.
- `references/methodology.md`, `references/provenance.md`, `LICENSES.md`: method, sources, standards status, licences, Refero boundary.

The raw corpus is not bundled; to audit one claim, read that source at the pinned upstream commit listed in `references/provenance.md`. Corpus frequencies are observations of public surfaces, not brand truth or a reason to pick a colour, font, or layout. Mobile/native has no corpus documents; use platform guidance. Refero only through an authorized MCP or user export.
