# Provenance and Boundaries

## Contents

- Included corpus and nature of observations
- Refero boundary
- Accessibility standards
- UI craft research
- Production-practice research
- Design-process references
- Skill-architecture research
- Refresh policy

## Included corpus

- **Source:** [`VoltAgent/awesome-design-md`](https://github.com/VoltAgent/awesome-design-md)
- **Pinned commit:** [`664b3e78fd1a298ba11973822da988483256d4b4`](https://github.com/VoltAgent/awesome-design-md/tree/664b3e78fd1a298ba11973822da988483256d4b4)
- **Archive:** `https://codeload.github.com/VoltAgent/awesome-design-md/tar.gz/664b3e78fd1a298ba11973822da988483256d4b4`
- **Retrieved:** 2026-07-13
- **License:** MIT, copyright 2026 VoltAgent; retained at `corpus/awesome-design-md/LICENSE`
- **Included:** all 74 `design-md/*/DESIGN.md` files present in the pinned archive
- **Excluded:** upstream previews, screenshots, media, fonts, website assets, private requests, and non-`DESIGN.md` content

Every copied document has its own SHA-256, category, byte count, and parser status in `data/corpus-manifest.json`. The analyzer verifies hashes before producing observations.

The pinned archive contains 74 documents. This differs from both the initial planning estimate of 75 and the upstream README badge of 73 at that commit. The manifest records the discrepancy rather than silently modifying the corpus.

## Nature of the observations

The upstream files analyze public brand and product surfaces. They are not official design-system publications from the named brands and do not grant rights to brand names, trademarks, proprietary fonts, or media. This skill uses them as observational text evidence, not as authority to reproduce a brand.

The derived references are an original synthesis. Quantitative claims point to the pinned commit and deterministic extraction; judgment and runtime recommendations are stated separately.

## Refero boundary

[`styles.refero.design`](https://styles.refero.design/) advertises a DESIGN.md reference library and a Refero MCP. No Refero pages, files, API responses, screenshots, or metadata are copied into this skill.

As fetched on 2026-07-13, [`styles.refero.design/robots.txt`](https://styles.refero.design/robots.txt):

- disallows named AI agents—including GPTBot, ClaudeBot, anthropic-ai, and Google-Extended—from `/`;
- allows the general user agent but disallows `/api/`, `/admin/`, `/extract/`, and `/playground/`.

Therefore this skill must not bulk-scrape Refero, call undocumented Refero endpoints, or mirror its catalog. Refero may be used only through an authorized Refero MCP or a user-provided export the user is entitled to share. Live access is optional; the skill works without it.

## Accessibility standards and ADA context

- **Web conformance floor:** [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/), W3C Recommendation dated 12 December 2024 in the current publication fetched 2026-07-21. The [W3C WCAG overview](https://www.w3.org/WAI/standards-guidelines/wcag/) encourages the latest version and states that WCAG 2.2 conformance is backward compatible with WCAG 2.1 and 2.0.
- **Native application guidance:** [WCAG2ICT](https://www.w3.org/TR/wcag2ict-22/) explains how Level A and AA criteria apply to non-web software. It is informative guidance, not a normative standard, and native work still needs platform and product-specific accessibility requirements.
- **U.S. ADA context:** The Department of Justice [ADA web accessibility guidance](https://www.ada.gov/resources/web-guidance/) explains equal access and effective communication under Titles II and III. The current [Title II web and mobile app rule fact sheet](https://www.ada.gov/resources/2024-03-08-web-rule/) names WCAG 2.1 Level AA as its technical standard and documents scope, exceptions, and compliance timing. These sources were checked 2026-07-21.
- **Not the conformance target:** [W3C Accessibility Guidelines (WCAG) 3.0](https://www.w3.org/TR/wcag-3.0/) is a W3C Working Draft dated 3 March 2026. W3C says publication as a Working Draft does not imply endorsement and that it is inappropriate to cite as anything other than work in progress.

WCAG 2.2 Level AA is the default engineering floor because it includes and extends WCAG 2.1, but technical WCAG conformance alone does not prove compliance with the ADA or another law. Project, procurement, contractual, platform, and jurisdictional requirements may exceed this floor. Use the current official standard and obtain qualified product or legal review before making a legal-compliance claim.

## UI craft research checked 14 July 2026

The binding rulings in `references/craft-rulings.md` use these current sources:

- [WCAG 2.2 SC 1.4.3, Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): 4.5:1 normal text and 3:1 large text;
- [WCAG 2.2 SC 1.4.11, Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html): 3:1 for meaningful control/state/graphic cues;
- [WCAG 2.2 SC 2.3.3, Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html): unnecessary interaction motion can be disabled and user reduced-motion preferences should be supported;
- [WCAG 2.2 SC 3.2.3, Consistent Navigation](https://www.w3.org/WAI/WCAG22/Understanding/consistent-navigation.html) and [SC 3.2.4, Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html): repeated navigation order and repeated function identity stay predictable;
- [Lucide accessibility guidance](https://lucide.dev/guide/advanced/accessibility): visible labels in most cases, consistent icon usage, contrast, keyboard feedback, accessible icon buttons, and 44 by 44 target wrappers;
- [Material Symbols guide](https://developers.google.com/fonts/docs/material_symbols): coherent variable fill, weight, grade, and optical-size axes, plus subset guidance;
- [Carbon motion](https://carbondesignsystem.com/elements/motion/overview/): productive versus expressive motion, named easing roles, and duration scaled to motion size;
- [Carbon 2x Grid](https://carbondesignsystem.com/elements/2x-grid/overview/): shared units, key lines, consistent padding, and breakpoint integrity;
- [Google Fonts CSS API](https://developers.google.com/fonts/docs/getting_started) and [web.dev font practices](https://web.dev/articles/font-best-practices): explicit families/weights, `font-display`, early discovery, preconnect for third-party origins, and layout-shift testing;
- [Google Fonts metadata](https://fonts.google.com/metadata/fonts), fetched 14 July 2026: current family availability and popularity ordering used for the inspiration list.

The motion recommendations were also checked against the pinned local corpus. Several observed systems use color, underline, border, surface, icon, or opacity feedback instead of generic scale/translate hover lift. These remain independent observations, not official brand guidance.

Refero content was not accessed for this update because no authorized Refero MCP or user-provided export was available. The existing Refero boundary remains unchanged.

## Production-practice research checked 21 July 2026

The pass/fail contract in `references/production-contract.md` was checked against current primary guidance:

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), its [conformance requirements](https://www.w3.org/TR/WCAG22/#conformance-reqs), [How to Meet WCAG 2](https://www.w3.org/WAI/WCAG22/quickref/), and [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/): all applicable Level A and AA criteria across full pages and complete processes, plus focus not obscured, target size minimum, dragging alternatives, redundant entry, and accessible authentication;
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) and its dialog, menu button, combobox, and keyboard-interface patterns: native semantics first and complete keyboard/focus behavior for custom composites;
- [WAI Forms Tutorial](https://www.w3.org/WAI/tutorials/forms/): labels, grouping, instructions, validation, notifications, and accessible custom controls;
- the [WHATWG HTML Standard for dialog](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element) and [popover](https://html.spec.whatwg.org/multipage/popover.html), plus [MDN Popover API guidance](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API): modal versus non-modal top-layer behavior and the semantics authors must still provide;
- [web.dev Web Vitals](https://web.dev/articles/vitals): current LCP, INP, and CLS thresholds and 75th-percentile field measurement; [LCP optimization](https://web.dev/articles/optimize-lcp), [MDN lazy loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading), and the existing font sources support the media/font performance rules;
- [web.dev Baseline](https://web.dev/baseline), [MDN container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries), [subgrid](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Subgrid), [logical properties](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_logical_properties_and_values), and [forced colors](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors): support-policy-led progressive enhancement and resilient layout;
- [W3C Internationalization Quick Tips](https://www.w3.org/International/quicktips/): Unicode, language declaration, semantic content, and international layout/content preparation;
- [Design Tokens Format Module 2025.10](https://www.designtokens.org/TR/2025.10/format/): a stable DTCG Final Community Group Report and interoperability option that is explicitly not a W3C Standard;
- current [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) and [Android adaptive-layout guidance](https://developer.android.com/develop/ui/compose/layouts/adaptive): platform controls, accessibility settings, safe areas, resizable/adaptive windows, and native conventions;
- [W3C Ethical Web Principles](https://www.w3.org/TR/ethical-web-principles/) and the [FTC dark-pattern report](https://www.ftc.gov/reports/bringing-dark-patterns-light): user control, privacy, non-deceptive consent, and avoidance of manipulative flows;
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): current authentication and credential-flow constraints where a UI exposes those features;
- [OpenAI Apps SDK UX principles](https://developers.openai.com/apps-sdk/concepts/ux-principles) and the [Microsoft HAX Toolkit](https://www.microsoft.com/en-us/haxtoolkit/): focused conversational value, clear action boundaries, privacy, expectation-setting, recovery from AI failure, and human oversight for AI-facing surfaces.

These are implementation references, not claims that every listed browser API or platform convention applies to every project. The local support matrix, product requirements, and stricter jurisdictional obligations decide applicability.

## Design-process references consulted

The synthesis considered public patterns from:

- [Anthropic `frontend-design`](https://github.com/anthropics/skills/tree/main/skills/frontend-design): brief-first direction and deliberate visual choices;
- [Leonxlnx `taste-skill`](https://github.com/Leonxlnx/taste-skill): detection of recurring generic landing-page patterns;
- [NextLevelBuilder `ui-ux-pro-max-skill`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill): broad heuristic/reference organization.

No source skill text is bundled or renamed. This skill rejects fixed palette/font/radius bans, perpetual-motion defaults, and landing-page rules applied to product UI. See `LICENSES.md` for attribution status.

## Skill-architecture research checked 14 July 2026

The package structure was checked against the [Agent Skills specification](https://agentskills.io/specification), [Anthropic skill-authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md), [OpenAI Skills guidance](https://platform.openai.com/docs/guides/tools-skills), and [Agent Skills evaluation guidance](https://agentskills.io/skill-creation/evaluating-skills): loader-visible name/description metadata, a concise directly actionable `SKILL.md`, references one level from the root, focused on-demand documents, self-contained scripts, explicit validation, and evaluation-driven iteration. The installed GG Coder loader reads `name` and `description`; the portable `license` and `compatibility` fields are retained for other Agent Skills clients and safely ignored by GG Coder.

`SKILL.md` remains below the recommended 500-line limit. Reference files over 100 lines include a contents overview so an agent preview exposes the file's scope. Detailed corpus data stays out of runtime context unless a specific claim requires it. The existing external A/B artifacts are unscored and predate the current contracts, so they are benchmark inputs rather than evidence that the current skill improves quality.

## Refresh policy

A corpus refresh must be explicit:

1. choose and record a new upstream commit;
2. replace only the licensed `DESIGN.md` snapshot and upstream license;
3. regenerate every hash and parser status;
4. rerun analysis and inspect changed denominators/outliers;
5. update synthesis claims and examples;
6. rerun validation.

Do not fetch “latest” silently at runtime. Reproducibility is more important than invisible freshness.
