# Production UI Contract

## Contents

1. Semantics and interaction architecture
2. Accessibility beyond contrast
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

## 2. Accessibility beyond contrast

WCAG 2.2 Level AA is the web conformance floor. Project, platform, legal, or contractual requirements may be stricter.

- Keep a visible focus indicator and ensure sticky headers, footers, cookie bars, drawers, and overlays do not obscure the focused control.
- Pointer activation, native popup dismissal, and clicks elsewhere must not leave a focus ring, highlighted border, shadow, background, or container focus treatment stuck as a false selected or active state. Distinguish pointer from keyboard focus and distinguish focus from genuine selected, expanded, and error states; never suppress visible keyboard focus globally.
- WCAG 2.2 Target Size (Minimum) is 24 by 24 CSS pixels with defined exceptions. Default touch-oriented web controls to a 44 by 44 CSS-pixel hit area where layout permits. Native work follows its platform target guidance, such as 44 by 44 points on Apple platforms and 48 by 48 density-independent pixels in Material guidance.
- Provide a single-pointer alternative for every non-essential drag interaction. Reordering also needs keyboard and assistive-technology operation.
- Do not require users to re-enter information already supplied in the same process when it can be selected or populated. Preserve data across validation errors and recoverable navigation.
- Authentication must work with password managers, copy/paste, and accessible alternatives. Do not make memory, transcription, puzzles, or blocked paste the only route unless an applicable exception is verified.
- Announce important asynchronous status and validation changes without moving focus unnecessarily. Do not rely on color, motion, position, or an icon alone to communicate meaning.
- Verify text resizing to 200%, reflow at 320 CSS pixels where WCAG applies, keyboard operation, reduced motion, and forced-colors/high-contrast behavior.

Automated accessibility tooling is a defect detector, not proof of conformance. Manual keyboard, focus, zoom/reflow, and assistive-technology checks remain required for relevant flows.

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

1. representative desktop and narrow/mobile renders, plus native/adaptive sizes when applicable;
2. primary-flow keyboard completion, visible focus, focus return, and no obscured focus;
3. project accessibility-tool output plus manual semantics and status review;
4. 200% text, 320 CSS-pixel reflow where applicable, longest content, and one localization stress case;
5. reduced-motion and forced-colors/high-contrast results where supported;
6. loading, empty, error, retry, disabled, success, destructive, and offline/slow-network states that apply;
7. route, refresh, deep-link, Back/Forward or native-back behavior that applies;
8. measured performance evidence or an explicit unverified item with the exact missing measurement;
9. the project's supported browser, device, and input matrix.

A small component records only applicable evidence, but semantics, keyboard/focus, content extremes, and relevant states cannot be skipped. Report contract failures plainly and fix them before calling broad UI work complete.
