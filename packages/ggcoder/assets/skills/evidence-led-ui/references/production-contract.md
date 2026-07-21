# Production UI Contract

## Contents

1. Semantics and interaction architecture
2. WCAG and ADA accessibility conformance
3. Forms, errors, and user control
4. Responsive and international resilience
5. Performance and visual stability
6. Modern platform features and progressive enhancement
7. Tokens and component contracts
8. Trust, privacy, and high-consequence flows
9. Native mobile and adaptive windows
10. Conditional content types
11. Required release evidence

This is a binding, pass/fail quality floor for implemented web and native UI. Apply every relevant section. Mark a section not applicable only when the product surface genuinely does not contain that behavior. A visual-rubric score cannot compensate for a contract failure.

## 1. Semantics and interaction architecture

- Use native elements and platform controls before custom widgets. A navigation action is a link; an in-place action is a button. Preserve meaningful headings, landmarks, lists, tables, labels, and DOM reading order.
- Add ARIA only when native semantics are insufficient. Custom dialogs, menus, tabs, comboboxes, trees, grids, and similar composite widgets must follow the matching WAI-ARIA Authoring Practices pattern and keyboard model.
- Keep visual, DOM, focus, and screen-reader order aligned. CSS reordering must not create a different task sequence.
- Modal work uses the platform dialog primitive when suitable; non-modal top-layer content uses the Popover API when suitable. Manage initial focus, containment for modal UI, Escape/close behavior, background inertness, and focus return. A popover does not automatically supply menu or dialog semantics.
- Preserve browser and platform navigation. Meaningful destinations and shareable state need stable URLs or routes; Back, Forward, refresh, deep links, and native back behavior must not discard work or trap the user.

## 2. WCAG and ADA accessibility conformance

WCAG 2.2 Level AA is the default technical floor for web UI. Conformance means every applicable Level A and Level AA success criterion across full pages, complete processes, responsive variants, and all relevant states, not a selected checklist of visible issues. Native apps apply WCAG2ICT where relevant plus current platform accessibility requirements. Any stricter project, procurement, contract, platform, or jurisdiction requirement wins.

ADA is a civil-rights and equal-access obligation, not a technical certification. WCAG 2.2 Level AA is the engineering baseline, but meeting it does not by itself establish full ADA compliance. When ADA applies, verify the current Title II or Title III obligations, scope, exceptions, effective-communication duties, and alternative arrangements with the responsible product or legal owner. Never claim `ADA compliant` or `WCAG conformant` without evidence for a defined scope.

- Define the conformance scope before broad implementation: routes/screens, complete user processes, content types, components and states, supported technologies, and the browser, device, input, and assistive-technology matrix. Audit against the current official [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/), criterion by criterion; this summary is not a substitute. Track every applicable Level A and AA criterion as pass, fail, or not applicable with a rationale and evidence.
- Satisfy all five WCAG conformance requirements: the claimed level, full pages, every page in each complete process, only accessibility-supported uses of technology, and non-interference from any non-conforming content. One unresolved applicable failure blocks conformance.
- Use native semantics and controls first. Supply meaningful text alternatives for informative images, controls, and graphics; mark decoration as decorative. Preserve programmatic information and relationships, headings, landmarks, lists, tables, meaningful sequence, page and passage language, reading order, and a bypass route for repeated blocks.
- Provide the required alternatives for every prerecorded or live media type, including synchronized captions, transcripts or equivalent alternatives, and audio description where the criterion requires it. Autoplaying audio needs an immediate pause, stop, or independent volume control. Do not use images of text when styled real text can communicate the same information.
- Give every page or screen a descriptive title. Link purpose must be clear in context; headings and labels describe topic or purpose; users have more than one way to locate pages when required. Keep repeated navigation, component identification, and help mechanisms consistent.
- Every function works by keyboard without a trap or timing race. Focus order follows meaning; focus is visible, not obscured, and restored after overlays. Keyboard shortcuts, character-key commands, and custom composite widgets follow the applicable WCAG and WAI-ARIA keyboard requirements.
- Pointer activation, native popup dismissal, and clicks elsewhere must not leave a focus ring, highlighted border, shadow, background, or container focus treatment stuck as a false selected or active state. Distinguish pointer from keyboard focus and distinguish focus from genuine selected, expanded, and error states; never suppress visible keyboard focus globally.
- Meet WCAG 2.2 contrast and appearance criteria in every theme and state: at least 4.5:1 for normal text, 3:1 for large text, and 3:1 for meaningful non-text controls, state indicators, focus cues, and graphics where the criterion applies. Never use color, shape, position, sound, motion, or another single sensory cue as the only instruction or status signal.
- Content revealed by hover or focus must be dismissible, hoverable, and persistent where required. Text spacing overrides must not break content. Audio, animation, and visual effects cannot make text unreadable or block operation.
- WCAG 2.2 Target Size (Minimum) is 24 by 24 CSS pixels with defined exceptions. Default touch-oriented web controls to a 44 by 44 CSS-pixel hit area where layout permits. Native work follows its platform target guidance, such as 44 by 44 points on Apple platforms and 48 by 48 density-independent pixels in Material guidance.
- Provide a single-pointer alternative for every non-essential drag interaction. Reordering also needs keyboard and assistive-technology operation. Do not require path-based gestures, multipoint gestures, or device motion when a simpler accessible input can perform the task. Support pointer cancellation, and ensure an accessible name contains the visible label so speech-input users can target the control.
- Give every control a programmatic name that includes its visible label, and expose role, value, state, instructions, requirements, and errors correctly. Announce important asynchronous status and validation changes without moving focus unnecessarily. Do not over-announce streaming or frequently updating content.
- Do not trigger an unexpected context change merely on focus or input. Identify common input purposes programmatically, make required fields and formats explicit, identify errors in text, suggest corrections when known, and prevent or confirm consequential legal, financial, test, and data changes where WCAG requires it.
- Preserve use at 200% text resize and at 320 CSS-pixel reflow where WCAG applies, without loss, overlap, two-dimensional scrolling except for allowed content, or essential truncation. Support required orientation, browser zoom, text spacing, reduced motion, forced colors/high contrast, and user font or platform text scaling.
- Users can pause, stop, hide, extend, or adjust time limits and moving, blinking, auto-updating, or autoplaying content where required. Do not ship content that violates flash thresholds. Reduced-motion alternatives preserve information and task completion.
- Do not require users to re-enter information already supplied in the same process when it can be selected or populated. Preserve data across validation errors and recoverable navigation. Authentication must work with password managers, copy/paste, and accessible alternatives; memory, transcription, puzzles, or blocked paste cannot be the only route unless an applicable exception is verified.
- Include first-party, embedded, vendor-supplied, document/PDF, and authenticated content in scope unless a verified legal and standards exception applies. An exception does not erase ADA duties for effective communication, reasonable modification, or equal access; route those decisions to the responsible legal or product owner.
- Accessibility overlays, injected widgets, and a separate `accessible version` do not substitute for fixing the primary experience. Use an alternate route only when the governing standard and law permit it and it provides genuinely equivalent, current information and functionality. Provide a discoverable way to report accessibility barriers when the product has a public support or feedback surface.

Automated accessibility tooling is a defect detector, not proof of conformance. Run the project's scanner, then manually verify semantics, keyboard use, focus, zoom/reflow, contrast, media alternatives, and representative assistive-technology output across the primary flow and high-risk states. Record the tested tool/browser/assistive-technology combinations. Unavailable checks remain `unverified`, never silently pass, and block a conformance claim.

## 3. Forms, errors, and user control

- Every control has a persistent programmatic label. Associate help, units, requirements, and errors with the field; placeholder text is an example, never the only label.
- Use the correct input type, `autocomplete`, `inputmode`, and semantic grouping. Keep browser autofill, password-manager, paste, and native validation affordances working unless the product has a verified reason to replace them.
- Select, dropdown, and combobox indicators must have a deliberate logical trailing inset and reserved content padding for the icon width and gap. They fail when the indicator touches the edge, overlaps text or adjacent actions, duplicates the native indicator, or creates a dead pointer zone; verify long values, narrow widths, zoom, and RTL.
- Validate at a helpful time. Do not show errors before the user can reasonably act. On submit, summarize errors when the form is long, focus or link to the first problem, preserve values, and explain how to recover.
- Async actions expose pending, success, failure, retry, and duplicate-submission behavior. Do not silently lose work or replace the whole layout with a spinner.
- Match safeguards to consequence. Prefer undo for cheap reversible actions; use explicit confirmation for destructive, expensive, security-sensitive, or irreversible actions. State the object and consequence in concrete language.

## 4. Responsive and international resilience

- Use viewport queries for page composition and container queries for reusable components when the support policy permits. Use Grid, Flexbox, and `subgrid` to maintain key lines instead of JavaScript layout or breakpoint-specific duplication.
- Navigation, header, main content, adjacent sections, and footer must reuse a shared content rail, responsive gutters, and spacing tokens by default. Full-bleed outer surfaces may differ, but inner edges must align. Any width, offset, margin, or padding exception needs an explicit content or user reason and must remain coherent at every breakpoint.
- Prefer logical properties and flow-relative alignment. Declare document language and direction, use locale-aware number/date/plural formatting, and avoid sentence construction by string concatenation.
- Test right-to-left layout when localization is relevant, long German-like expansion, short labels, CJK text, long unbroken values, dynamic type or 200% text, and missing media. Essential content must not depend on truncation.
- Account for safe areas, on-screen keyboards, dynamic viewport units, orientation, window resizing, no-hover input, coarse pointers, and split-screen or large-screen layouts where the platform can expose them.
- Avoid fixed heights for content-bearing regions. Preserve reading and action order when columns collapse or modules move.

## 5. Performance and visual stability

For web surfaces, use current Core Web Vitals as the shared target at the 75th percentile, segmented by mobile and desktop: LCP at or below 2.5 seconds, INP at or below 200 milliseconds, and CLS at or below 0.1. Use field data when available and project-appropriate lab checks to prevent regressions.

- Reserve media and embed dimensions. Provide responsive image sources and sizes; do not lazy-load the likely LCP image; lazy-load suitable below-the-fold media.
- Load only used font families, scripts, styles, and weights. Make the selected loading strategy explicit and test fallback layout shift.
- Keep initial JavaScript and hydration proportional to the interaction. Prefer CSS for layout and visual state; avoid main-thread work that delays input feedback.
- Skeletons match final geometry. Loading, font swaps, banners, validation, and async results must not unexpectedly move the current target.
- Animate named properties only. When movement is necessary, prefer compositor-friendly properties and avoid layout-thrashing animation, while still obeying the no-generic-hover-lift and reduced-motion rules.
- Record a measured result or an honest unverified status. A Lighthouse score alone is not field performance evidence.

## 6. Modern platform features and progressive enhancement

- Set a browser and device support policy from project evidence. Prefer features in the project's Baseline/support range; use feature detection and a simpler fallback for newer capabilities.
- Use native `dialog`, Popover, `inert`, constraint validation, and other platform primitives when their semantics match the job and the support policy allows them. Do not choose a new API merely because it is fashionable.
- Treat View Transitions and similar enhancements as optional continuity layers. Navigation and state changes must still work without them and under reduced motion.
- Preserve the essential task when scripts, media, fonts, animation, clipboard access, or a preferred input mode are unavailable whenever progressive enhancement is feasible for the product.

## 7. Tokens and component contracts

- Reuse the host system first. For a net-new scalable system, separate primitive values from semantic roles and component tokens; define modes without duplicating meaning.
- Do not introduce soft semantic tint-on-tint as the default status variant: low-opacity semantic backgrounds paired with saturated same-hue text or icons, with or without matching borders. Derive a replacement from the host aesthetic and preserve non-color status cues; retain the treatment only when explicitly requested or exact established-system reuse is required.
- The Design Tokens Community Group 2025.10 format is a stable interoperability option, not a W3C Standard and not a mandatory migration target. Use it only when tools need a portable source of truth.
- Each shared component documents anatomy, semantic element, variants, sizes, content limits, states, keyboard behavior, responsive behavior, and accessibility name/description rules.
- Keep one source of truth. Generated platform outputs must not become competing hand-edited token stores.

## 8. Trust, privacy, and high-consequence flows

- Do not use deceptive hierarchy, disguised ads, preselected consent, confirm-shaming, forced continuity, hidden costs, or an easier opt-in than opt-out path.
- Show total cost, renewal terms, data use, permissions, and destructive consequences before commitment. Keep consent granular and revocable where the product requires it.
- Do not expose secrets or sensitive personal data in screenshots, examples, analytics labels, URLs, notifications, or error copy.
- High-consequence health, finance, safety, identity, and legal interfaces require domain review, conservative defaults, traceable calculations, and clear escalation or correction routes.

## 9. Native mobile and adaptive windows

- Follow current Apple Human Interface Guidelines or Material/Android guidance for the actual target instead of styling a web layout to resemble a phone.
- Respect system bars, safe areas, Dynamic Type or platform font scaling, platform navigation/back behavior, input methods, permissions, haptics, and reduced-motion/accessibility settings.
- Build adaptive layouts for compact, medium, expanded, resizable, split-screen, keyboard, pointer, and touch contexts that the target platform supports.
- Prefer platform components and conventions unless a custom control has a tested product need and complete accessibility behavior.

## 10. Conditional content types

- Data visualization provides a text summary or accessible data alternative, meaningful names, keyboard access where interactive, non-color encoding, readable labels, and truthful scales.
- Tables use actual table semantics when relationships are tabular. Dense grids need an explicit keyboard and virtualization accessibility strategy.
- Search, filtering, pagination, and master-detail layouts preserve useful query/selection state and orientation. On narrow screens, keep decision-critical detail and the primary action visible or one obvious action away; do not strand the initial state at a list when task completion requires its detail. Announce result changes appropriately and distinguish no results from errors and first-use emptiness.
- AI, chat, and agent surfaces distinguish user, model, tool, source, pending, completed, interrupted, and failed content. Streaming work provides stop/cancel and recovery, preserves useful partial output, and avoids announcing every token to assistive technology.
- Consequential AI actions expose scope and destination before execution, request confirmation or permission at the point of risk, show progress and outcome, support correction or undo where possible, and never imply certainty, provenance, or successful action without evidence.
- Media surfaces provide captions or transcripts when required, meaningful alternatives, keyboard-operable controls, no surprise audio, and motion/autoplay behavior that respects user preferences.
- If multiple themes are supported, use semantic tokens and native `color-scheme` behavior, prevent a wrong-theme flash where feasible, persist the user's explicit choice, and verify contrast, focus, media, and system-control rendering in every mode.

## Required release evidence

For every broad implementation, record:

1. the defined accessibility conformance scope plus a WCAG 2.2 Level A/AA criterion matrix or an explicit changed-scope audit with pass, fail, and justified not-applicable results;
2. representative desktop and narrow/mobile renders, plus native/adaptive sizes when applicable;
3. primary-flow keyboard completion, visible focus, focus return, no traps, and no obscured focus;
4. project accessibility-tool output plus manual semantics, accessible-name, reading-order, media-alternative, and status review;
5. primary-flow output from at least one representative screen-reader or native assistive-technology combination in the supported matrix;
6. 200% text, 320 CSS-pixel reflow where applicable, browser zoom or platform text scaling, longest content, and one localization stress case;
7. reduced-motion and forced-colors/high-contrast results where supported;
8. loading, empty, error, retry, disabled, success, destructive, and offline/slow-network states that apply;
9. route, refresh, deep-link, Back/Forward or native-back behavior that applies;
10. measured performance evidence or an explicit unverified item with the exact missing measurement;
11. a first-party, embedded, vendor, document/PDF, and authenticated-content inventory with any exception and responsible owner recorded;
12. the accessibility-feedback route and remediation owner when the product has a public support surface;
13. the project's supported browser, device, input, and assistive-technology matrix.

A broad implementation is not complete while an applicable WCAG Level A or AA criterion is failed or unverified. A small component records only applicable evidence, but semantics, accessible naming, keyboard/focus, assistive-technology output, content extremes, and relevant states cannot be skipped. Report failures plainly and fix them before calling the UI accessible. Never turn partial evidence into an ADA-compliance or WCAG-conformance claim.
