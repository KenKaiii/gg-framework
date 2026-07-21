# Rendered UI Quality Rubric

## Contents

- Scoring and independent production-contract gate
- Criteria 1–4: specificity, hierarchy, composition, consistency and flow
- Criteria 5–8: typography, material logic, state completeness, responsive behavior
- Criteria 9–12: accessibility, motion, content authenticity, visual distinctiveness
- Required critique loop

## Scoring

Capture the implemented UI at a representative desktop viewport and a narrow mobile viewport. Score each criterion **0, 1, or 2** from rendered evidence, not source-code intent.

- **0 — broken or absent:** blocks completion, contradicts the brief, or has no evidence.
- **1 — usable but generic/incomplete:** the core works, but hierarchy, states, or specificity remain weak.
- **2 — resolved:** clear, product-specific, responsive, and testable.

Maximum: **24 points**. Ship broad UI work only at **20/24 or higher**, with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity, and only after the applicable checks in `production-contract.md` pass. The contract is an independent release gate; rubric points cannot offset semantics, accessibility, performance, resilience, or trust failures. A small component may score only applicable criteria, but every applicable quality-floor criterion must score 2 and its contract checks must pass.

## 1. Brief specificity

- **0:** Audience, task, and single job are unclear.
- **1:** Screen addresses the requested domain but could serve a neighboring product unchanged.
- **2:** Hierarchy, controls, content, and signature visibly support the named audience and job.

**Test:** Cover the logo. State the product and task from the screenshot alone.

## 2. Information hierarchy

- **0:** Primary action or reading order is ambiguous.
- **1:** A primary path exists, but multiple elements compete at the same level.
- **2:** First glance, second glance, and action sequence are deliberate; subordinate content remains available without competing.

**Test:** At 50% zoom or with a blurred screenshot, identify the first three attention stops.

## 3. Composition

- **0:** Layout breaks, clips, ignores shared key lines, uses arbitrary modules, or lets navigation, header, main, section, and footer rails drift without a content reason.
- **1:** Grid is stable but generic, repetitive, or weakly related to content; some section edges, spacing tokens, or component geometry drift.
- **2:** Scale, shared content rails, key lines, alignment, whitespace, and asymmetry/symmetry express content relationships and remain deliberate across viewports.

**Test:** Draw vertical and horizontal guides through navigation, header, main, repeated sections, and footer at every representative breakpoint. Full-bleed outer surfaces may differ, but their inner content edges must align by default. Compare repeated margins, padding, and gaps side by side; equal roles use equal tokens unless an exception communicates real hierarchy.

## 4. Consistency and flow

- **0:** Repeated functions change labels, icons, placement, geometry, or behavior; sections/pages feel independently invented.
- **1:** Most patterns repeat, but spacing cadence, icon treatment, controls, actions, or section transitions contain visible inconsistencies.
- **2:** Existing primitives are reused; one icon family, spacing rhythm, component anatomy, navigation order, action placement, and surface logic carry through the full flow.

**Test:** Compare adjacent sections and pages side by side. Trace one repeated action through every occurrence, then inspect container edges, control heights, icon weight, spacing, borders, labels, and state behavior. For selects, dropdowns, and comboboxes, verify the trailing icon has intentional edge inset and reserved text clearance at every size, in RTL, and with the longest plausible value. Flag any low-opacity semantic background paired with saturated same-hue text or icons; it fails unless the user requested it or exact established-system reuse is required.

## 5. Typography

- **0:** Text is unreadable, clipped, visually generic by neglect, or lacks a usable hierarchy.
- **1:** Type is legible but role assignment, family choice, measure, leading, loading, fallback, or pairing is inconsistent.
- **2:** Display, body, utility, and code roles are intentional; the chosen family/pairing fits the product; line lengths, wrapping, localization, requested weights, fallback metrics, and loading behavior are resolved.

**Test:** Inspect the longest real heading and paragraph at desktop and mobile. Disable web fonts, throttle loading, and compare fallback layout shift. Confirm every loaded family/style/weight has a used role.

## 6. Material and surface logic

- **0:** Borders, shadows, blur, gradients, and radii conflict or obscure content.
- **1:** Treatments are consistent but decorative or over-applied.
- **2:** Every surface has a clear containment/elevation reason; radius vocabulary is constrained by component role; effects reinforce subject matter.

**Test:** Name why each elevation level exists. Remove any level without a distinct reason.

## 7. State completeness

- **0:** A critical loading, empty, error, focus, form, offline, or disabled state is missing, unusable, loses work, or changes abruptly without adequate feedback.
- **1:** Happy-path interaction works, but secondary states, feedback, timing, recovery, or layout continuity are generic or incomplete.
- **2:** Relevant loading, empty, error, validation, retry, offline, focus, hover/press, selected, expanded, pending, disabled, destructive, and success states are coherent, preserve work and layout, and provide purposeful feedback.

**Test:** Trigger each relevant state with realistic content length and failure wording. Confirm preservation, recovery, duplicate-submission behavior, status announcement, and that any transition improves continuity rather than decoration. Test pointer and keyboard focus separately, including native dropdown dismissal and clicks onto non-focusable space; no pointer-only highlight may stick, and keyboard focus must remain visible.

## 8. Responsive behavior

- **0:** Content clips, overlaps, becomes unreachable, breaks reading/focus order, or loses its primary action.
- **1:** Layout stacks but hierarchy, density, localization, navigation, or input behavior degrades.
- **2:** Mobile, intermediate, wide, and resizable layouts deliberately recompose; target sizes, ordering, sticky regions, safe areas, input modes, content priority, and localization remain sound.

**Test:** Inspect at 320px, a representative phone width, 768px, and a wide desktop width; zoom browser text to 200% where applicable; stress long text and one RTL/localization case; verify no-hover and coarse-pointer behavior.

## 9. Accessibility quality floor

- **0:** Keyboard path, focus, semantics, contrast, labels, icon meaning, status, drag-only operation, or target sizes block use.
- **1:** Basics exist but focus order/visibility, text/non-text contrast, motion, icon labels, status cues, composite-widget behavior, forced colors, or assistive naming has gaps.
- **2:** Native semantics or verified APG behavior, visible and unobscured focus, keyboard operation, meaningful labels/status, WCAG 2.2 target minimums with platform-appropriate touch targets, reduced motion, forced colors, text contrast of at least 4.5:1 (3:1 for large text), and meaningful non-text contrast of at least 3:1 are verified.

**Test:** Complete the primary task by keyboard; inspect accessible names and status; verify overlay focus and drag alternatives; measure text, icon, control, and focus contrast; run project accessibility tooling; test 200% text/reflow, `prefers-reduced-motion`, and forced colors; verify color is not the only cue.

## 10. Motion purpose

- **0:** Relevant interaction feedback is missing or abrupt, or motion distracts, loops, shifts layout, uses generic hover lift, relies on `transition: all`, or ignores reduced motion.
- **1:** Motion is restrained but timing, easing, property choice, or state coverage is inconsistent.
- **2:** Every relevant interaction has purposeful feedback; named properties and shared tokens communicate state or continuity; resting surfaces are calm; generic lift is absent; reduced motion preserves meaning.

**Test:** For every transition, finish “This feedback explains…” and identify the property, duration, easing token, and reduced-motion behavior. Remove movement without an answer.

## 11. Content authenticity

- **0:** Fabricated claims, metrics, testimonials, logos, ratings, or misleading product states appear as real.
- **1:** Content is plausible but generic, repetitive, visibly placeholder-like, or inconsistent with the product voice.
- **2:** Copy and data are real, supplied, or honestly labeled fixtures; labels, units, dates, errors, and punctuation follow one product voice; generated UI copy avoids em dashes unless explicitly allowed.

**Test:** Trace every factual claim and number to project content, user input, or an explicitly marked fixture. Search generated UI copy for em dashes and verify every retained one is required source text or explicitly requested.

## 12. Visual distinctiveness

- **0:** Screen is indistinguishable from a generic template, uses emoji or mixed icon styles, or could belong to an unrelated AI-generated product.
- **1:** Brand tokens are present, but typography, composition, icon language, and motifs remain transferable.
- **2:** One coherent icon family and intentional typography support a memorable signature that emerges from the subject, content, or interaction without compromising usability.

**Test:** Remove logo and accent color. Identify the remaining product-specific signature, type voice, and icon language.

## Required critique loop

1. Capture desktop and mobile screenshots.
2. Score every applicable criterion and record one line of evidence per score.
3. Run the applicable `production-contract.md` checks and record pass, fail, or a specific unverified item.
4. Identify the lowest-scoring criterion; ties resolve in this order: accessibility, consistency and flow, state completeness, responsive behavior, hierarchy, authenticity, then aesthetics.
5. Remove one unnecessary decorative idea.
6. Revise the weakest criterion and every contract failure.
7. Re-capture, re-score, and re-check affected contract evidence.
8. Report the final score and any unverified item honestly.
