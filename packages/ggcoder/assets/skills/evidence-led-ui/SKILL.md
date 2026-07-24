---
name: evidence-led-ui
description: Use for broad or design-sensitive web/mobile UI work: net-new pages/screens, redesigns, design-system work, visual polish, responsive or accessibility overhauls, and UI quality review/critique. Do NOT use for small UI edits that follow existing patterns (bug fixes, minor styling tweaks, wiring, copy changes, small component additions matching neighbors); just match the surrounding code for those. Also exclude database/API schemas, CLI output, standalone image/SVG generation, and description-only tasks.
license: See LICENSES.md
compatibility: Full review requires filesystem inspection and rendered screenshots; web research and browser/device tooling are optional and unavailable checks must be reported honestly.
---

# Evidence-Led UI

Use this skill for web or mobile interface creation, redesign, implementation, styling, and review.

## Governing rule

Inspect before inventing. Preserve the project's visual language unless the user explicitly requests a redesign. Treat corpus findings as conditional observations, not official brand truth, universal rules, or a house style.

Aesthetic distinction is contextual. Semantic structure, operability, responsive stability, performance, honest content, accessibility, and user trust are the non-negotiable floor.

## Binding craft defaults

Apply these on every UI task. Read `references/craft-rulings.md` when implementing or reviewing their details.

- **No emoji UI:** Never use emoji as icons, bullets, status marks, or decoration unless explicitly requested. Reuse the project icon system; otherwise use one coherent icon package.
- **Uniform geometry:** Align containers, columns, section edges, baselines, dividers, control heights, and repeated component anatomy. Break alignment only for a clear content reason.
- **One shared content rail:** Default navigation, header, main content, footer, and adjacent sections to the same max-width, inline gutters, and breakpoint padding. Full-bleed backgrounds may differ, but their inner content edges must align. Any different width or offset needs an explicit user or content reason, never one-off margin or padding.
- **No edge-hugging control icons:** Select, dropdown, and combobox chevrons and other trailing icons need a deliberate inline-end inset plus enough reserved text padding for the icon and gap. They must never touch the control edge or overlap content; use logical properties so the anatomy also works in RTL.
- **Reuse first:** Search for existing components, variants, tokens, utilities, icon wrappers, focus rings, and motion curves before creating new ones.
- **Purposeful feedback:** Relevant hover, focus, press, selected, expanded, loading, success, and error states need clear feedback. Avoid abrupt changes when a short transition improves continuity.
- **No soft semantic tint-on-tint:** Do not default badges, buttons, toasts, cards, selected states, or icon medallions to a low-opacity semantic-color background with saturated same-hue text or icons, with or without a matching border. Unless the user explicitly requests that treatment or an established system must be preserved, choose a product-specific alternative rather than imposing one universal replacement style.
- **No sticky pointer focus:** Clicking or tapping must not leave a focus ring, highlighted border, shadow, background, or container `:focus-within` treatment stuck after the interaction ends, a native popup closes, or the user clicks elsewhere. Preserve immediate, visible keyboard focus by distinguishing input modality instead of suppressing focus globally.
- **No generic hover lift:** Do not default to `translateY`, bobbing, floating, or scale-up on hover. Prefer color, border, underline, icon fill, opacity, or restrained shadow changes.
- **No `transition: all`:** Name transition properties, reuse duration/easing tokens, and provide a reduced-motion path.
- **Intentional type:** Reuse the existing type system. For net-new web work, select an appropriate modern family or pairing; do not use Arial, Helvetica, or bare `system-ui` as the aesthetic direction.
- **WCAG 2.2 Level AA is the accessibility floor:** Every web UI and complete user flow must meet every applicable Level A and Level AA success criterion, not a hand-picked subset. Native apps apply WCAG2ICT where relevant plus current platform accessibility requirements. Stricter project, contract, platform, or jurisdiction rules win; accessibility cannot be traded for aesthetics, scope, delivery speed, or a higher rubric score.
- **No unsupported accessibility claims:** Treat ADA as an equal-access legal obligation, not a badge earned by Lighthouse, axe, or another scanner. Never label a UI `ADA compliant` or `WCAG conformant` from source review or automated checks alone; a claim requires a defined scope, per-criterion evidence, manual keyboard and assistive-technology testing, and qualified legal or product-owner review when legal compliance is asserted.
- **Measured contrast:** Meet WCAG 2.2 contrast for text, controls, icons, focus, and meaningful graphics. Muted text must remain readable.
- **Consistent flow:** Repeated navigation and actions keep the same order, labels, icons, placement, and behavior across sections and pages.
- **No generated em dashes:** Do not write em dashes in user-facing UI copy unless explicitly requested or exact supplied source text must remain unchanged.

## Reference map

Resolve every path from the installed skill root. Load only what the task needs:

- `references/craft-rulings.md`: implementation detail for the binding defaults above.
- `references/production-contract.md`: binding pass/fail semantics, WCAG/ADA accessibility, forms, performance, resilience, platform, trust, AI, media, theme, and release checks. Read its accessibility sections for every implemented or reviewed UI; read the full contract for broad features, behavior changes, forms, navigation, data/AI interfaces, native work, performance work, or release review.
- `references/archetypes.md`: surface-specific direction and relevant source slugs. Read for net-new UI, redesigns, or unresolved visual direction.
- `references/observed-patterns.md`: measured corpus observations. Read only sections that answer a real design question.
- `references/anti-defaults.md`: transferable AI-generated patterns to challenge. Read for broad visual work or generic-looking output.
- `references/quality-rubric.md`: rendered scoring and revision gate. Read before critiquing broad output.
- `references/methodology.md`: extraction method, denominators, and limitations. Read only to audit evidence.
- `references/provenance.md` and `LICENSES.md`: sources, licenses, standards status, and Refero boundaries.

Do not load `data/observations.json` or the raw corpus by default. Open a raw source only to audit one claim or inspect one selected exemplar. Never load the full corpus into context.

## Workflow

### 1. Inspect the project

Inspect the nearest relevant routes, real content, shared components, semantic controls, tokens, theme, typography, icons, motion, screenshots, tests, responsive conventions, and existing states.

Reuse the local system. Do not add a design library merely to obtain a look. For a net-new project with no neighbors, derive direction from the brief and matching archetype rather than choosing a fashionable default.

### 2. Write a design read

Resolve:

- **Surface:** marketing, application UI, dashboard/data-dense, commerce/marketplace, editorial/content, documentation/developer tool, mobile/native, or one named hybrid with a clear leader.
- **Audience:** user, expertise, environment, and access needs.
- **Single job:** the one outcome this screen must make easiest.
- **Task and risk:** frequency, decision cost, error cost, and time pressure.
- **Content:** real hierarchy, density, variability, media, data, and longest plausible values.
- **Platform:** viewport/window, input modes, support policy, navigation behavior, and framework conventions.
- **Constraints:** existing tokens/assets, redesign scope, performance limits, and required tone.

Infer missing facts from the project and state the inference. Ask only when code cannot resolve a genuine product or taste decision.

### 3. Select evidence only when it helps

For broad net-new work or a redesign, read the matching archetype and usually choose two aligned source slugs plus one contrast. Record why each applies.

For a small change in an established system, local components and tokens may be sufficient. A frequency can support investigation, not automatically become a recommendation. Prefer local product evidence, then archetype evidence, then corpus-wide frequency.

Refero is optional. Use it only through an authorized Refero MCP or user-provided authorized export. Do not scrape Refero, call undocumented endpoints, or access disallowed routes.

### 4. Form one design thesis

State one compact direction:

- semantic color/type/icon/spacing/grid/motion roles and a reuse map;
- first glance, second glance, primary action, and supporting evidence;
- composition and uniform alignment rules;
- reasons for borders, surfaces, shadows, blur, gradients, or imagery;
- feedback, duration/easing, resting behavior, and reduced-motion equivalent;
- one memorable device grounded in the subject, content, or interaction.

One thesis leads. Do not combine several aesthetic directions into a mood-board compromise.

### 5. Run the anti-default check

For broad visual work, read `references/anti-defaults.md`. Flag emoji UI, mixed icon families, arbitrary misalignment, duplicated local styling, abrupt interaction, generic hover lift, soft semantic tint-on-tint treatments, generic type, generated em dashes, centered gradient heroes, glass cards, equal card grids, decorative eyebrows, random metric blocks, ubiquitous pills, dark-premium assumptions, fake terminals, floating screenshots, bento layouts, ambient motion, icon medallions, and invented proof.

Keep a flagged pattern only after completing: **“This belongs because…”** with a product-specific reason. Replace choices that could survive unchanged in an unrelated product.

### 6. Plan the complete task flow

Plan only relevant states, but include the complete primary path and recovery:

- loading, empty, error, retry, offline, success, disabled, and destructive outcomes;
- hover, focus-visible, press, selected, expanded, and pending feedback;
- keyboard order, accessible names/status, overlay focus, and drag alternatives;
- pointer-versus-keyboard focus behavior, including native popup dismissal and clicks onto non-focusable space;
- narrow, intermediate, desktop, wide/resizable, pointer, touch, and no-hover behavior;
- reduced motion, forced colors, zoom/reflow, long/localized/RTL text, missing media, and realistic data extremes;
- text alternatives and media equivalents, landmarks/headings, language, labels/instructions/errors, status announcements, timing, flashing, and sensory-independent instructions where applicable.

For every UI, read and apply the accessibility sections of `references/production-contract.md`. For broad behavior, forms, navigation, native, data/AI, performance, or release work, apply the full contract. A visual score cannot compensate for a relevant contract failure.

### 7. Document broad work

For a broad page, multi-screen feature, or redesign, create or update `DESIGN.md` with the design read, evidence, thesis, semantic tokens, reused primitives, craft system, components/states, responsive behavior, and applicable production checks. Keep a small component plan in work notes instead.

### 8. Implement the product

Use real project content and data. Label fixtures honestly. Never invent testimonials, customer logos, ratings, metrics, or claims as fact.

Reuse dependencies and primitives. Use one coherent icon system. Meet every applicable WCAG 2.2 Level A and AA criterion across the complete flow, including its states and responsive variants. Maintain semantic controls, visible keyboard focus, keyboard operation, assistive-technology output, measured contrast, readable line lengths, stable adaptive layout, and reduced-motion support. Pointer interaction must not leave a false focus, active, or selected-looking highlight behind. Implement the complete planned flow, not only its first screenshot.

The representative initial state must keep decision-critical information and the primary action visible or one obvious action away on desktop and mobile. Preserve selected context through master-detail recomposition. Keep demo, debug, and state-switching controls subordinate and non-obscuring.

### 9. Critique rendered output once

Capture representative desktop and narrow/mobile output. Score broad work with `references/quality-rubric.md`, record applicable production checks as pass/fail/unverified, remove one unnecessary decorative idea, revise the weakest criterion and any contract failure, then re-capture.

Default to one critique-and-revision cycle. Run another only when evidence still fails the score or production gate. If a check is unavailable, report it as unverified instead of looping or substituting more polish.

Broad work is complete at **20/24 or higher**, with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity, and only after applicable production checks pass. Any applicable WCAG Level A or AA failure blocks completion regardless of score. A small component must score 2 on every applicable quality-floor criterion and pass its accessibility contract checks.

## Review-only mode

Inspect the project and rendered output. Return findings ordered by impact, cite screenshot/code evidence, name the matching archetype when relevant, and recommend one resolved direction. Distinguish quality-floor defects from aesthetic opportunities.

## Evidence discipline

- Keep a numerator/denominator or numeric sample count with every corpus claim.
- Treat source slugs as observations of selected public surfaces, not official systems or permission to reproduce a brand.
- Never recommend a color, font, radius, theme, or layout solely because it is frequent.
- State corpus gaps plainly. Mobile/native has zero direct documents in this snapshot; use platform guidance and device testing.
- If local evidence conflicts with corpus evidence, follow the product and record why.
