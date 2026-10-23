# Picking a Direction

## Contents

1. Content first
2. The thesis template
3. Type
4. Colour (OKLCH, measured)
5. Spacing, density, radius
6. Imagery
7. Motion
8. Platform features worth using (verified Baseline status)
9. Responsiveness and INP practice

Use for net-new UI, redesigns, or when the existing product leaves an axis free. If the project already has a system, preserve it and skip to § 8–9.

## 1. Content first

Before any layout:

1. Write the real headline, primary action label, and the copy for every section, in the user's vocabulary.
2. Gather or write realistic data: longest names, empty values, large numbers, 0/1/many items, localized strings.
3. Rank it: what must be seen first, second, and what is the one action.
4. Only then pick layout. If a section has nothing true to say, delete the section, do not design a container for it.

Fixtures must be labelled as fixtures. Never invent proof (`references/anti-defaults.md` § 4).

## 2. The thesis template

Write this before code (in `DESIGN.md` for broad work, in notes otherwise). Max ~12 lines.

```
Subject + audience + single job:
Signature (one memorable device, from the subject's world):
Type: display / body / utility roles, families, scale ratio
Colour: 4–6 named OKLCH tokens + intended contrast pairs
Space/density: base unit, scale, density mode
Radius + material: scale by role; surface model (flat / tonal / bordered / elevated)
Imagery: source and treatment, or "none"
Motion: the one orchestrated moment + feedback durations/easing
Alignment: rail width, grid, left/center rule
Rejected defaults: which slop tells this plan avoided and what replaced them
```

Then run the neighbour test from `references/anti-defaults.md` § 7 on the plan and revise once.

## 3. Type

- One family or two; if two, make them clearly different (e.g. a characterful display + a quiet text face, or a serif text + a grotesque UI face). Three only when a mono is needed for code.
- Choose from the subject: technical precision, warmth, editorial authority, playfulness. Name the reason in the thesis.
- Avoid Inter/Geist/system-ui as the identity of a marketing or brand surface. They remain fine for dense application chrome or when the project already uses them.
- Scale: one ratio (e.g. 1.2 for dense apps, 1.25–1.333 for marketing) mapped to named tokens; no ad-hoc sizes.
- Measure: body text under ~75 characters; serif body gets slightly more line-height.
- Use `text-wrap: balance` on headings and `text-wrap: pretty` on paragraphs as progressive enhancement.
- Tabular numerals (`font-variant-numeric: tabular-nums`) for columns of figures.
- Loading and font candidates: `references/craft-rulings.md` § 5.

## 4. Colour (OKLCH, measured)

- Start from one brand hue derived from the subject or existing brand. Not violet/indigo by default.
- Define tokens in `oklch()` (Baseline widely available). Build ramps by stepping lightness (L) at fixed hue; reduce chroma (C) near the light and dark ends so colours stay in gamut.
- Neutrals: tint toward the brand hue with very low chroma (about 0.005–0.02) instead of stock `slate`/`zinc`.
- Roles, not hues: `bg`, `surface`, `text`, `text-muted`, `border`, `accent`, `accent-contrast`, `focus`, `danger`, `success`. Components consume roles only.
- Accent covers a small share of the screen; status colours are reserved for status.
- Themes: `light-dark()` (Baseline newly available) or `prefers-color-scheme` tokens; tune dark neutrals separately rather than inverting.
- Contrast is measured, not eyeballed. WCAG 2.2 AA: 4.5:1 normal text, 3:1 large text, 3:1 for UI component boundaries, icons, and focus indicators against adjacent colours. Compute ratios from the resolved sRGB values (browser devtools, axe, or a script) for every text/background pair in both themes and record them. OKLCH lightness is a design aid, not a WCAG measurement.
- `color-mix()` (Baseline widely available) for hover/pressed derivations from tokens instead of new hard-coded values.

## 5. Spacing, density, radius

- One base unit (4 or 8 px) and a named scale; no off-scale values.
- Density by task: data-dense tools use compact rows and small gaps; marketing uses generous section spacing. Do not mix densities within one view without reason.
- Group with proximity first, then alignment, then borders, then fills. Shadows last and with one reason.
- Radius scale by role (e.g. inputs and buttons share one, overlays another, avatars full). Never one radius for everything by reflex.
- One shared content rail (`references/craft-rulings.md` § Shared content rails).

## 6. Imagery

Priority: real product UI at readable scale → real photography of the subject → real data visualised → typography alone. Generated or stock illustration only when requested. Every image needs dimensions (no layout shift), meaningful `alt` or empty `alt` if decorative, and responsive sources.

## 7. Motion

- One orchestrated moment per page at most (a load sequence or one reveal). Everything else is feedback to user action.
- Feedback: about 100–200 ms for hover/press, about 200–300 ms for panels; ease-out for entering, ease-in for leaving. Use tokens.
- Animate `transform` and `opacity`; name transitioned properties.
- Every motion has a `prefers-reduced-motion` path that keeps meaning.
- Auto-playing motion longer than 5 s needs pause/stop/hide (WCAG 2.2.2).

## 8. Platform features worth using (stable Baseline)

Stable rows only (SNAPSHOT, re-checked 22 Oct 2026). Baseline status moves monthly: for any feature not listed, or any "not yet Baseline" call, check https://webstatus.dev or the MDN compatibility table live before deciding, and record the date you checked.

| Feature | Baseline | Use by default? |
| --- | --- | --- |
| Container queries (size) | Widely available | Yes, for components that live in varying containers. |
| `:has()` | Widely available | Yes, for parent/state styling instead of JS class toggling. |
| `oklch()` / `oklab()`, `color-mix()` | Widely available | Yes, for tokens. |
| `<dialog>`, `inert` | Widely available | Yes, for modals and disabling background regions. |
| Subgrid | Widely available | Yes, for aligning card internals across a row. |
| Popover API | Newly available (Jan 2025) | Yes for menus/tooltips/popovers, with tested focus behaviour. |
| `text-wrap: balance`, `light-dark()`, `@starting-style`, `details name` | Newly available | Yes; content must work without the enhancement. |
| Same-document view transitions | Newly available (Oct 2025) | Yes as progressive enhancement with reduced-motion opt-out. |
| CSS anchor positioning | Newly available (Jan 2026, Firefox 147) | Yes for tooltips/menus when the support policy allows; keep a fallback position otherwise. |

"Newly available" means supported in current versions of all core browsers but not yet for 30 months; check the project's support policy before relying on it without a fallback.

## 9. Responsiveness and INP practice

Interaction to Next Paint (INP) is the Core Web Vital for responsiveness; "good" is 200 ms or less at the 75th percentile (web.dev, SNAPSHOT).

- Paint feedback first: update the pressed/pending state synchronously, then do heavy work after yielding (`await scheduler.yield()` where supported, otherwise `setTimeout`/`requestAnimationFrame` fallback).
- Keep event handlers small; debounce typing-driven filtering; virtualize long lists; avoid layout thrash (read then write).
- Prefer CSS state (`:has()`, `:focus-visible`, popover, `<details>`) over JS-driven re-renders for simple UI state.
- Use `content-visibility: auto` for long offscreen sections when it does not break find-in-page or anchors in the target browsers.
- Reserve space for images, ads, embeds, and async content to avoid layout shift.
- Report measurements as RUNTIME only when measured; otherwise say unmeasured.
