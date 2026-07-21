# Interface Craft Rulings

## Contents

1. Icons, never emoji
2. Uniform geometry and alignment
3. Reuse before invention
4. Motion without generic hover lift
5. Typography and Google Fonts loading
6. Contrast as a release requirement
7. Consistency and flow
8. UI copy punctuation
9. Final craft check

These are binding defaults for UI implementation and review. They reflect Ken's product taste, current accessibility guidance, current web-font delivery guidance, established design-system motion/grid practices, and the pinned observational corpus. Override one only when the user explicitly requests the exception or the existing product has a stronger documented rule.

## 1. Icons, never emoji

Do not use emoji as interface icons, bullets, status marks, empty-state decoration, or visual shorthand unless the user explicitly requests emoji.

1. Inspect the project for an existing icon system and reuse it.
2. If none exists and adding a dependency is allowed, choose one coherent stack-specific package. Default to Lucide for a restrained line system. Use Material Symbols when variable fill/weight/optical sizing fits an existing Google/Material language. Use Phosphor when the product needs a broader weight range and a softer illustrative voice.
3. Do not mix icon families within one product surface.
4. Do not hand-draw substitute SVGs when the selected package already has the icon.
5. Match icon stroke/fill weight, optical size, control size, and color role across repeated components.
6. Prefer visible text beside unfamiliar actions. Decorative icons are hidden from assistive technology. Icon-only buttons receive an accessible name on the button, a visible tooltip where useful, and at least a 44 by 44 CSS-pixel target.

Lucide's current accessibility guidance recommends visible labels in most cases, consistent icon treatment, keyboard access, adequate contrast, and a 44 by 44 target wrapper. Material Symbols provides variable fill, weight, grade, and optical-size axes; use those axes systematically rather than mixing arbitrary styles.

## 2. Uniform geometry and alignment

Uniformity means shared geometry, not equal visual importance.

- Establish container edges, columns, gutters, spacing tokens, control heights, border positions, and text baselines before styling individual sections.
- Repeated sections align to the same key lines. Cards in the same family share padding, header placement, border treatment, and action placement.
- Vertical dividers meet related horizontal boundaries cleanly. Avoid one-pixel drift, almost-aligned edges, arbitrary indents, and section widths that change without a content reason.
- Use one spacing rhythm. Prefer existing project tokens; otherwise derive a compact 4 or 8 pixel scale appropriate to density.
- Preserve alignment through responsive recomposition. Mobile may change order or layout, but repeated controls and content edges remain internally consistent.
- Break the grid only to express real hierarchy, media behavior, or editorial emphasis. A deliberate exception should be visible as an exception, not look accidental.

### Shared content rails and spacing ownership

Establish one page-shell or container primitive that owns the default max-width and responsive inline gutters. Reuse it for navigation, headers, breadcrumbs, main content, adjacent sections, and footers. A full-bleed background or divider may span the viewport, but its inner content returns to the shared rail. A navbar that is slightly wider or narrower than the page body, or neighboring sections with almost-matching edges, is a craft failure unless the user or content explicitly requires a different composition.

Use the project's spacing tokens for repeated section padding, stack gaps, grid gaps, and component insets. The parent layout owns spacing between siblings; each component owns its internal padding. Do not combine ad hoc child margins, wrapper padding, and arbitrary offsets until one section merely looks close to another. A deliberate nested rail, breakout, or asymmetric section needs a visible hierarchy or content reason and must resolve cleanly at every breakpoint.

Test by drawing vertical guides through navigation, header, main, repeated sections, and footer at narrow, intermediate, desktop, and wide sizes. Their inner edges and breakpoint changes must align exactly by default. Compare repeated vertical gaps and section padding side by side; equal roles use equal tokens.

### Control icon insets

A select, dropdown, or combobox chevron is part of the control anatomy, not decoration pasted onto its edge. Give every trailing icon a deliberate `inset-inline-end` that follows the control's horizontal-padding token. Reserve `padding-inline-end` for the outer inset, icon width, and a readable gap so labels, selected values, placeholders, loading indicators, clear buttons, and long or localized content never collide with it. An icon at `right: 0`, touching the border, or squeezed into an unreserved text area is a craft failure.

Keep the icon optically centered and preserve the full control hit area. For a decorative custom chevron over a native select, avoid stacking it over the browser indicator and ensure the overlay does not create a dead pointer zone. Use logical inline properties and verify RTL rather than hard-coding right-side geometry.

Test every control size with the longest plausible value, 200% text zoom, narrow width, RTL, disabled/error/loading states, and both native and custom rendering paths. The trailing inset should visually belong to the same spacing rhythm as the leading content inset.

Carbon's grid guidance uses consistent mini-unit multiples, key lines, fixed padding within breakpoints, and type aligned to box padding. Apply the principle through the project's own grid rather than copying Carbon's exact values.

## 3. Reuse before invention

Before creating any token, component, style, or interaction:

1. Search the project for the same semantic role.
2. Reuse the existing component and variant when it meets the need.
3. Extend the nearest primitive when the need is genuinely new.
4. Create a new primitive only when reuse or extension would distort semantics.

Do not duplicate button systems, card shells, form controls, modal behavior, status colors, spacing scales, icon wrappers, focus rings, or motion curves. Reuse class utilities and design tokens where they already exist. Same function means same label, icon, accessible name, state treatment, and placement across pages.

## 4. Motion without generic hover lift

Every interactive component must provide clear feedback for relevant hover, focus, press, selected, expanded, loading, success, and error states. Feedback should not feel abrupt when an interpolated transition improves comprehension.

Default motion behavior:

- Do not use generic `translateY` hover lift, bobbing, floating, card jumping, or indiscriminate scale-up.
- Prefer background, foreground, border, underline, icon fill/weight, opacity, and restrained shadow transitions.
- Press feedback should feel connected to activation. Prefer color, inset, fill, or a brief controlled compression only when it matches the material model.
- Animate state and continuity, not decoration. Do not add ambient or perpetual motion to make a static layout feel designed.
- Never use `transition: all`. Name the properties that are allowed to interpolate.
- Avoid animating layout properties such as `width`, `height`, `top`, and `left` unless spatial change is the meaning and performance is verified.
- Keep focus indication immediate and visible. A transition must never delay awareness of keyboard focus.

### No sticky pointer focus

Pointer focus must not masquerade as a persistent selected, active, or error state. Clicking or tapping a control, native select, combobox, card, or focusable container must not leave a focus ring, highlighted border, shadow, background, or ancestor `:focus-within` treatment stuck after activation, popup dismissal, or a click elsewhere. A genuine selected, expanded, validation, or drag state may persist, but it must use its own semantics and styling rather than an accidental focus treatment.

Prefer `:focus-visible` where it behaves correctly. For native controls or browser quirks that expose focus-visible after pointer activation, track the input modality locally and suppress only the pointer-originated focus treatment. Never solve this with a global `outline: none`, by hiding all focus, or by blurring controls in a way that breaks keyboard operation; keyboard-originated focus must remain immediate, visible, correctly ordered, and restored after overlays.

Test mouse and touch activation separately from Tab and Shift+Tab. Include opening and dismissing native dropdowns, selecting an option, clicking non-focusable blank space, clicking the next control, closing overlays, and switching back to keyboard navigation. No pointer-only highlight may remain after its interaction context ends.

Reuse existing motion tokens first. If none exist, begin with these restrained bands, then tune by component size and distance:

| Role | Typical duration | Use |
|---|---:|---|
| Immediate micro-feedback | 70 to 110 ms | button, toggle, icon fill, press |
| Standard state change | 140 to 200 ms | color, border, background, small disclosure |
| Entrance or panel continuity | 180 to 240 ms | menu, popover, drawer, inserted feedback |
| Exit | 120 to 180 ms | dismissal and removal |

For a neutral productive curve, Carbon documents `cubic-bezier(0.2, 0, 0.38, 0.9)` for standard productive motion, with separate entrance and exit curves. Use local easing when available.

The pinned observational corpus supports restrained hover treatment: Tesla and Lamborghini explicitly prefer color-only interactions over scale/translate; Vercel uses underline or surface changes; Linear uses a controlled color/surface state; Sanity uses a consistent interactive color. These are observations of selected surfaces, not universal brand rules. Refero content was not accessed because no authorized Refero MCP or user-provided export was available.

Reduced motion is mandatory. Under `prefers-reduced-motion: reduce`, remove non-essential travel, parallax, scale, and spatial choreography. Preserve state feedback through immediate color, border, text, icon, or opacity changes. WCAG 2.2 SC 2.3.3 treats disabling non-essential interaction animation as the accessible direction.

## 5. Typography that carries intent

Reuse the project's established type system first. For net-new web work without an established type system, choose an intentional family or pairing that matches the subject, language coverage, density, and reading mode.

Do not choose Arial, Helvetica, or a bare `system-ui` stack as the visible design direction for net-new aesthetic work. They remain acceptable technical fallbacks and may remain correct for an existing system or native-platform surface.

### Current Google Fonts inspiration

The following families were present in Google Fonts metadata fetched 14 July 2026. Popularity positions in that metadata included DM Sans 23, Manrope 37, Lora 43, Bricolage Grotesque 45, Plus Jakarta Sans 51, Space Grotesk 79, Instrument Serif 92, Geist 125, IBM Plex Mono 129, Source Serif 4 133, Instrument Sans 140, Newsreader 148, Geist Mono 149, and DM Mono 168. Popularity is discovery evidence, not a command to use the highest-ranked family.

| Pairing | Best fit | Role split |
|---|---|---|
| Instrument Sans + Instrument Serif | editorial brands, culture, thoughtful commerce | sans for UI/body, serif for display or pull quotes |
| Manrope + IBM Plex Mono | precise product UI, operations, technical SaaS | sans for interface, mono for data and technical labels |
| Plus Jakarta Sans + Source Serif 4 | trustworthy services, education, research | sans for navigation/UI, serif for long reading |
| DM Sans + DM Mono | clean application UI, data products | sans for hierarchy, mono for identifiers and code |
| Space Grotesk + Newsreader | modern editorial/product hybrids | grotesk for display/UI, serif for narrative |
| Bricolage Grotesque + Lora | playful or crafted consumer products | expressive sans for display, serif for supporting warmth |
| Geist + Geist Mono | restrained developer tools | sans for UI, mono for code/data |
| Noto Sans + Noto Serif | multilingual products | broad-script sans/serif system |

Use one family when role, weight, width, size, and tracking provide enough hierarchy. Add a second family only for a clear role contrast. Two families are usually sufficient; a third requires a specific content role.

### Loading Google Fonts

When network font loading is acceptable, connect the selected pair through the Google Fonts CSS API. Request only used families, styles, scripts, and weights. Use `display=swap`, preconnect to both Google Fonts origins, and test fallback metrics and layout shift.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap"
/>
```

Do not connect Google Fonts when privacy, offline operation, CSP, performance budgets, or project policy prohibit third-party font requests. Self-host approved WOFF2 files instead. Google and web.dev guidance recommends early discovery, preconnect for third-party font origins, explicit `font-display`, limited variants, and testing cumulative layout shift.

## 6. Contrast is a release requirement

Never use faint light-gray text on white, faint dark-gray text on black, or low-contrast borders/icons merely to look refined.

- Normal text meets at least 4.5:1 against its actual background.
- Large text meets at least 3:1.
- Meaningful icons, control boundaries, focus indicators, and graphical objects meet at least 3:1 against adjacent colors.
- Muted, secondary, placeholder, metadata, and disabled text remain intentionally legible. Disabled controls have a WCAG exception, but their meaning should not disappear.
- Do not round a failing ratio upward. W3C explicitly notes that 4.499:1 fails 4.5:1.
- Aim above the minimum for small, thin, long-form, or mission-critical text. Verify computed colors rather than judging from a screenshot alone.
- Do not use color as the only status cue. Pair color with text, shape, icon, or pattern.

## 7. Consistency and flow

A polished interface feels like one system from section to section, component to component, and page to page.

- Repeated navigation stays in the same relative order.
- Repeated functions keep the same component, label, icon, accessible name, and state behavior.
- Page templates share container widths, header logic, spacing cadence, and section transitions.
- A section should hand off to the next through intentional spacing, border, surface, continuation, or hierarchy. Avoid random background bands and arbitrary rhythm resets.
- Keep primary action placement predictable within a flow. Do not move the same action between card header, footer, and floating affordance without a reason.
- Preserve user orientation during loading, filtering, navigation, and responsive changes.
- Review adjacent screens together, not as isolated screenshots.

WCAG 2.2 SC 3.2.3 requires repeated navigation to keep the same relative order, and SC 3.2.4 requires components with the same function to be identified consistently. These accessibility requirements also reduce visual and cognitive friction for everyone.

## 8. UI copy punctuation

Do not generate em dashes in user-facing UI copy unless the user explicitly requests them or supplied brand/source copy already uses them and must remain unchanged.

Prefer a period, comma, colon, parentheses, or a rewritten sentence. Preserve exact quoted or legal source text. This is a product voice ruling, not a claim that em dashes are inaccessible.

## Final craft check

Before calling UI work complete, verify:

- no emoji used as UI imagery;
- one coherent icon family, with accessible names and target sizes;
- shared key lines, control heights, spacing, borders, and component geometry;
- existing components/tokens reused before new ones were created;
- every relevant interaction has purposeful, non-abrupt feedback;
- no generic hover lift or `transition: all`;
- reduced motion preserves state meaning;
- typography is intentional, loaded efficiently, and stable during fallback;
- all text and meaningful non-text contrast is measured;
- repeated navigation/actions remain consistent across sections and pages;
- generated UI copy contains no em dashes unless explicitly allowed.
