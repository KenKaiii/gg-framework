# Observed Patterns

## Evidence key

Unless a paragraph says otherwise, every count below comes from a deterministic extraction (version 1) of [`VoltAgent/awesome-design-md`](https://github.com/VoltAgent/awesome-design-md) at commit `664b3e78fd1a298ba11973822da988483256d4b4`. The raw files and generated data are not bundled; read the sources upstream. Fractions are **observed documents / relevant documents**; numeric distributions state their sample count. These are observations, not defaults.

## Theme is conditional, not a premium preset

The inferred primary theme is dark in **40/74**, mixed in **19/74**, and light in **15/74** analyses. The skew reflects a corpus rich in developer tools, AI products, and cinematic brands. Commerce is much less one-sided—light **5/12**, dark **4/12**, mixed **3/12**—so “dark equals premium” is not supported as a cross-product rule.

Aligned dark references: `sanity`, `voltagent`. Useful light contrast: `airbnb`.

## Surface separation favors restraint

Shadow policy is classified as subtle in **45/74**, absent in **28/74**, and merely mentioned in **1/74** analyses. This is stronger evidence for restrained elevation than for one universal “no shadows” rule. Use borders, tonal steps, spacing, or subtle shadows according to material logic and information density.

Examples: `vercel` and `linear.app` use precise containment; `airbnb` shows where soft elevation remains appropriate for a tactile consumer marketplace.

## Gradients are disputed, not forbidden

Gradients are positively mentioned in **35/74**, directly discouraged in **23/74**, and unclassified in **16/74** analyses. A blanket gradient ban contradicts the corpus. Gradients earn their place when they carry brand, light, depth, data, or media meaning; they fail when they merely signal “modern AI.”

Aligned use: `stripe`, `framer`. Contrast: `vercel`.

## Accent count is a range, not a palette recipe

Per-document accent-role extraction has **74 samples**: Q1 **3**, median **5**, Q3 **8**. These counts include shades and semantic variants, so they do not imply five competing CTA colors. Build a semantic hierarchy—canvas, surface, text, border, action, status—then reserve the highest-chroma signal for the screen’s single job.

The hue corpus is intentionally not averaged. Role and contrast matter more than a synthetic “average blue.”

## Spacing scales converge more than compositions

A spacing base was inferable in **73/74** documents: Q1 **4px**, median **4px**, Q3 **8px**. Section-spacing extraction has **434 samples**: Q1 **24px**, median **40px**, Q3 **64px**. Treat this as evidence for a coherent scale, not permission to paste a 4px system over an existing project.

Grid language appears in **73/74** analyses, full-bleed composition in **54/74**, single-column behavior in **44/74**, sidebars in **27/74**, asymmetry in **10/74**, split layouts in **10/74**, and masonry in **1/74**. “Uses a grid” is therefore not a signature. The signature must come from content-specific composition inside the grid.

## Radius is component-specific

Extracted radius values have **764 samples**: Q1 **4px**, median **12px**, Q3 **24px**. Pill language appears somewhere in **73/74**, while sharp-corner language appears in **16/74**. Because these counts include both uses and warnings, neither pills nor square corners should become a global default.

Constrain the local vocabulary by component role: controls may be compact, media cards may follow imagery, and badges may be pill-shaped without making every container a capsule. `kraken` explicitly limits buttons to 12px; `sanity` contrasts pill CTAs with 3–6px utility surfaces; `tesla` is a sharp, reduced contrast.

## Typography separation is selective

Explicit display/body family separation appears in **11/74** analyses. Font-family vocabulary per document has **74 samples** with median **4**, but that number includes fallbacks and suggested substitutes. The useful lesson is to assign roles deliberately, not to load four fonts.

Use a second family when it creates a subject-specific register, such as editorial versus utility, human versus technical, or display versus code. Keep one family when weight, width, scale, and tracking already provide sufficient hierarchy. Compare `sanity` (display plus mono technical voice) with `mastercard` (one-font discipline). For net-new type inspiration and current Google Fonts pairings, use `craft-rulings.md`; do not convert corpus frequency into a generic font default.

## Motion is underdocumented

Motion language appears in **41/74** analyses. Only **11 extracted duration samples** exist, with Q1 **200ms**, median **200ms**, and Q3 **225ms**. Reduced-motion language appears in **0/74**. That zero is a corpus gap, not evidence that reduced-motion support is optional.

Default to no ambient motion, not no feedback. Every relevant interaction should acknowledge hover, focus, press, selection, expansion, loading, success, or error without an abrupt or generic jump. Prefer short color, border, underline, icon, opacity, or restrained shadow transitions over scale/translate hover lift, and always provide a reduced-motion path.

## Interaction coverage drops after the happy path

Mentions by state are: pressed/active **67/74**, error **62/74**, focus **61/74**, hover **57/74**, disabled **46/74**, loading **8/74**, empty **1/74**. Keyboard language appears in only **8/74** analyses.

The corpus is strongest on styling and weak on product-state completeness. Implementation must add loading, empty, keyboard, and reduced-motion behavior even when the selected reference is silent.

## Archetype differences matter

- Application UI documents mention focus in **7/7** and motion in **5/7**; use interaction precision, not a landing-page spectacle.
- Dashboard/data-dense documents mention focus in **5/5** and keyboard behavior in **3/5**; prioritize scan paths and operability.
- Documentation/developer-tool documents are dark in **11/16**, but one is light and four are mixed; dark remains a tendency, not a requirement.
- Editorial/content documents mention motion in only **1/5** and asymmetry in **3/5**; pacing and hierarchy matter more than animated chrome.
- Commerce/marketplace documents show the broadest theme split and use subtle shadow policy in **8/12**; imagery, trust, and transaction clarity determine material treatment.
- Marketing/brand has **29/74** documents, so its patterns must not leak unexamined into product UI.
