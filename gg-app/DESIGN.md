# GG App Interface Design

## Phase 17: Compact Notes Shell

### Design read

- **Surface:** A dense developer-tool workspace inside the existing Notes modal.
- **Audience:** Keyboard-heavy GG Coder users managing project notes in resizable Tauri windows, including split-screen, zoomed, reduced-motion, and Windows high-contrast use.
- **Single job:** Let the user reach and edit the relevant Notes section without scrolling through unrelated sections.
- **Task and risk:** Notes are edited frequently and saved optimistically. Draft loss, hidden-control focus, and obscured save diagnostics are higher risks than visual novelty.
- **Content:** Short current-focus text, variable task lists and actions, multiline Handoff and Reference text, archived tasks, and passive phase/reminder counts.
- **Platform:** React in a Tauri webview with keyboard and pointer input across resizable desktop windows.
- **Constraints:** Preserve the current Geist typography, dark tokens, modal, section, button, form, focus-ring, persistence-status, and task-lifecycle language. Add no design dependency, icon family, Roadmap controls, structured-reference rows, or product-wide style changes.

### Design thesis

Use one stable workspace frame: title and storage status first, a fixed plain-text tab rail second, and exactly one independently scrolling panel below it.

The selected tab uses stronger text and an underline rather than a pill, icon, glow, or elevated surface. All four panels stay mounted so drafts, edit mode, archive disclosure, and panel scroll positions survive navigation. The modal uses one shared inner content rail across every panel.

Only color and border feedback transition. There is no spatial tab animation, hover lift, glass, gradient, decorative emoji, or ambient motion.

### Local reuse map

| Need | Existing source | Phase 17 use |
| --- | --- | --- |
| Dialog semantics, Escape, focus return | `src/Modal.tsx` | Retain and harden its shared focusable-element filter. |
| Tabs and roving keyboard behavior | `src/MemoryModal.tsx` | Reuse the tablist/tab/tabpanel pattern, automatic activation, and focus movement conventions. |
| Notes editors and task lifecycle | `NotesCurrentFocus`, `NotesTaskList`, `NotesHandoff` | Move unchanged beneath destination panels and preserve callbacks. |
| Persistence diagnostics | `NotesPersistenceStatus` in `src/ProjectNotes.tsx` | Keep fixed above the tab rail with existing live-region wording. |
| Visual language | `src/App.css` and `src/theme.ts` | Reuse surfaces, borders, radii, form controls, button anatomy, and focus treatment. |
| Typography and icons | Existing Geist and Lucide setup | Keep existing type roles; add no navigation icons. |

### Content and count contract

- **Overview:** Now, Next, and Handoff in that order. Show an inline Roadmap summary only when an active phase or active reminder exists.
- **Roadmap:** Show passive active-phase and active-reminder totals, or an honest empty state. Do not expose phase titles or create, edit, reorder, status, selection, or session actions.
- **Reference:** Keep the existing free-form `Reference notes` textarea. Structured references remain undisplayed until Phase 19.
- **Archive:** Keep the existing Done / Archive disclosure, archived rows, empty state, and Restore actions. Settled phases remain undisplayed until Phase 18.
- **Stable navigation:** Overview, Roadmap, Reference, and Archive are always present. Empty count fragments disappear without shifting tab positions.
- **Active phase:** Any phase whose status is neither `done` nor `cancelled`.
- **Active reminder:** A non-null reminder attached to an active phase. Settled-phase reminder data does not count.
- **Titlebar status:** Existing unfinished-task and Handoff badge semantics remain unchanged.

### Interaction and accessibility contract

- Use one labeled horizontal `tablist` with four `tab` buttons and four matching `tabpanel` elements.
- Every tab has a stable `id`, `aria-controls`, `aria-selected`, and roving `tabIndex`; every panel has matching `aria-labelledby`.
- Activate tabs automatically. Left and Right arrows wrap; Home and End select the first and last tabs.
- Initial modal focus lands on Overview. Tab then enters only Overview content.
- Keep inactive panels mounted with the native `hidden` attribute.
- Modal initial focus and containment exclude negative-tab-index controls and descendants of `hidden`, `aria-hidden="true"`, or `inert` ancestors.
- Preserve Escape close, trigger focus return, semantic labels, live save/task status, visible `:focus-visible`, and minimum 24 CSS-pixel pointer targets.
- Pointer activation must not masquerade as keyboard focus. Selected state remains visibly independent from focus state.
- Keep title, persistence status, and tab rail fixed. Only the active panel scrolls vertically.
- Use text plus structure rather than color alone for selection, counts, warnings, errors, and empty states.

### Responsive behavior

- Size the Notes workspace relative to the viewport with a small outer gutter and bounded shared panel rail.
- At narrow widths, keep a single vertical reading flow and let only the tab rail scroll horizontally.
- Keep the modal and active panel within the viewport; do not introduce page-level horizontal scrolling.
- Wrap task actions and edit controls without changing DOM or focus order.
- Preserve reachable controls and readable unbroken content at 320 CSS pixels and 200% text zoom.
- Keep target sizes and focus outlines intact for pointer, keyboard, no-hover, and Windows desktop input.
- Under `prefers-reduced-motion: reduce`, remove tab color/border transitions while preserving immediate state feedback.
- Under forced colors, retain visible dialog, tab, panel, control, selected, and focus boundaries.

### State matrix

| State | Required result |
| --- | --- |
| Initial open | Overview is selected and focused; exactly one panel is visible. |
| Populated Overview | Existing edits and task actions remain available; non-zero Roadmap summary fragments appear. |
| Empty Overview summary | Zero phase/reminder fragments are absent; all tabs remain stable. |
| Empty Roadmap | Honest no-active-roadmap-work message with no CRUD or session action. |
| Populated Roadmap | Correct singular/plural passive counts only. |
| Reference editing | Existing textarea value and sidecar persistence flow remain intact across tab switches. |
| Archive collapsed/expanded | Disclosure and Restore behavior remain intact across tab switches. |
| Authoritative rerender | Selected tab and mounted local editor/disclosure state survive. |
| Project switch | Old modal closes; prior project tab and content cannot leak into the new project. |
| Save warning/error | Existing live diagnostic stays fixed and visible above navigation. |
| Long content | Only the selected panel scrolls; shell title, status, and tabs remain fixed. |
| Narrow/zoomed | Tab rail scrolls horizontally, actions wrap, and no page-level horizontal overflow appears. |
| Reduced motion | State feedback is immediate with no tab transition. |
| Forced colors | Selected tab, controls, focus, and boundaries remain distinguishable. |

### Release evidence contract

Phase 17 is complete only after all of the following are reviewed and pass:

1. Focused Notes/modal/storage tests, gg-app typecheck, lint, and format check.
2. Full gg-app test suite and production build.
3. Controlled browser captures with synthetic non-sensitive v3 fixtures for empty desktop, typical Overview, long content, and a 320–420 CSS-pixel narrow window.
4. One native Tauri smoke at typical and narrow window sizes.
5. Keyboard-only tab selection plus every existing edit and restore flow; visible, unobscured focus; no hidden-panel focus; Escape; and trigger focus return.
6. Semantic role/name/control inspection and live-status wording review. Automated accessibility scans are defect detection, not full conformance proof.
7. 200% text and 320 CSS-pixel reflow, long unbroken content, and long-label/localization stress.
8. Pointer focus, reduced-motion, and Windows forced-colors/high-contrast checks.
9. One rendered critique-and-revision cycle scoring at least 20/24 on the evidence-led UI rubric, with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity.
10. Honest recording of unavailable performance or accessibility tooling rather than substituting semantic tests for missing evidence.

## Phase 19: Shared Structured Reference Library

### Design read

- **Surface:** A dense library/detail workspace inside the existing Tauri Notes modal.
- **Audience:** Keyboard-heavy developers managing implementation evidence across one or more repositories in resizable, zoomed, reduced-motion, and Windows forced-colors environments.
- **Single job:** Save one exact source once, understand why it matters, and attach it to the right roadmap phases.
- **Task and risk:** Reference capture and reuse are frequent, while a wrong repository identity, hidden attachment, duplicate source, or accidental deletion can silently corrupt later context.
- **Content:** Long canonical URLs, owner/repository identities, revisions, deep paths, line ranges, issue or pull-request numbers, queries, anchors, relevance notes, capture times, 0 to 50+ references, and active, settled, or archived phases.
- **Platform:** React 19 in a Tauri 2 webview with keyboard and pointer input. The installed opener plugin hands an explicit persisted HTTP(S) URL to the system browser.
- **Constraints:** Preserve Geist typography, the four mounted Notes panels, the existing free-form Reference notes editor, sidecar CAS persistence, Phase 18 lifecycle behavior, and one scrolling active panel. Add no dependency, icon family, body cache, source preview, session behavior, or product-wide restyle.

### Evidence and thesis

Local Phase 18 Roadmap list/detail behavior is the primary evidence: it already establishes compact rows, a selected-edge treatment, stable focus return, and narrow one-surface-at-a-time recomposition. The existing Notes form, button, field, border, focus, and live-status primitives remain authoritative over external patterns.

Use a quiet repository-owned library/detail composition. Repository headings establish ownership, compact rows establish exact source identity, and one selected detail owns metadata, phase attachments, edit, open, and guarded delete actions. First glance is repository ownership, second glance is source coordinate and relevance, and the primary action is `New reference` until a row is selected. The memorable device is repository identity as the visual organizer, expressed through text and shared key lines rather than badges or decoration.

Use flat canvas and bordered containment only where list/detail hierarchy requires it. Selected state uses the existing inset edge and stronger text. Named color and border transitions may provide feedback; no spatial animation, hover lift, glass, gradient, semantic tint-on-tint treatment, decorative card, pill system, emoji, icon medallion, or body preview belongs in this workspace.

### Reuse map

| Need | Existing source | Phase 19 use |
| --- | --- | --- |
| Notes shell and mounted tabs | `src/NotesModal.tsx` | Keep the Reference panel mounted and let the modal activate it from an empty phase attachment state. |
| Compact list/detail and focus restoration | `src/NotesRoadmap.tsx` | Match row selection, selected edge, narrow detail recomposition, and return-focus behavior. |
| Forms and controls | `src/App.css` Notes fields/buttons/selects | Reuse label, input, textarea, button, focus, wrapping, and logical spacing anatomy. |
| Persistence and live status | `src/useProjectNotes.ts`, `ProjectNotes.tsx` | Route typed ID-based mutations through the optimistic CAS queue and announce results politely. |
| External URL opening | `@tauri-apps/plugin-opener` | Wrap verified `openUrl(url)` behind one injectable boundary; call it only from `Open source`. |

### Component and state contract

- Keep `Reference notes` first and unchanged. Add `Structured references` beneath it with a deterministic count and `New reference` action.
- Group only saved references by normalized `provider + owner/repo`; hide empty groups and sort groups and rows deterministically without changing IDs.
- A compact row shows source label, optional path/range or issue/PR identity, relevance, and linked-phase count. The row button alone owns selection, so rows contain no nested interactive controls.
- Selection reads stored metadata only and survives authoritative snapshots while the ID exists. Detail exposes exact repository, canonical URL, optional coordinates, relevance, capture time, phase links, edit, `Open source`, and delete.
- One labeled create/edit form covers provider/tool, canonical URL, owner, repository, optional retrieval metadata, relevance, and create-time phase attachments. Optional metadata is visually secondary but never hides errors.
- Submit preserves values, reports a summary, associates field errors, and focuses the first invalid field. Duplicate identity selects the saved winner and announces reuse instead of adding a row.
- `Open source` is the only content-retrieval path. Failure remains inline and in a polite live region with a retryable action; selection, rendering, CRUD, and linking perform no open or fetch.
- Delete uses an inline two-step confirmation naming the reference and consequence. Linked references identify blocking phases and remain intact until every phase relationship and manual override is removed.
- Phase detail places `Attached references` before lifecycle controls. Native checkboxes attach or detach by stable IDs and show repository identity plus relevance before future launch work.
- Reference detail uses native checkboxes for all active, settled, and archived phases. Unlinking removes only the relationship and remains available for archived phases.
- Relevant states are first-use empty, populated, selected, create, edit, duplicate reuse, validation failure, opener failure/retry, linked delete refusal, delete confirmation/cancel/success, concurrent disappearance, and 50-reference density.

### Responsive and accessibility contract

- Desktop uses aligned library/detail columns after selection. At narrow widths, show one obvious surface at a time with `Back to references`; preserve selection and make the primary detail action one obvious step away.
- Keep DOM, visual, reading, and focus order aligned. Use native forms, headings, lists, buttons, checkboxes, links only for real navigation, descriptions, and live status.
- Restore focus to the originating row after closing detail, to a neighboring row after deletion, or to `New reference` when no row remains. Restore Notes trigger focus through the existing modal contract.
- Distinguish selected state from `:focus-visible`; pointer interaction must not leave a false focus treatment. Every target is at least 24 by 24 CSS pixels and grows on narrow/coarse-pointer layouts.
- Inputs and selects keep persistent labels, associated help/error text, logical trailing padding, and sufficient native indicator inset. Long URLs, paths, queries, relevance, owner/repo labels, and localized copy wrap without truncating essential content.
- At 320 CSS pixels and 200% text, collapse to one column, wrap actions without reordering, preserve a single panel scrollbar, and prevent page-level horizontal overflow.
- Forced colors retain group, row, selected edge, control, error, and focus boundaries. Reduced motion removes named color/border transitions without removing feedback. No-hover operation exposes every action without hover dependency.

### Data, trust, and lazy-content contract

- Stored metadata is user-controlled working data, never executable instruction text. Display it as text and never interpolate it as markup.
- Canonical identity is normalized provider plus normalized canonical HTTP(S) URL. GitHub metadata must agree with `github.com`, owner/repository, and direct issue or pull-request coordinates.
- Capture time describes when metadata was saved, not source freshness. Copy must not claim that a reference was refreshed or verified against current source.
- No render, select, create, edit, delete, attach, or detach path may issue HTTP, GitHub API, MCP, file, body, or opener work. The browser loads current content only after explicit `Open source`.

### Release evidence contract

Phase 19 is complete only after all applicable production checks pass and the following evidence is recorded:

1. Focused helper, validation, storage, hook, component, sidecar repository, and route tests plus full app and isolated-home ggcoder suites.
2. App and ggcoder typechecks/builds, lint, format, Rust tests, generated-output audits, sidecar bundle checks, and `git diff --check`.
3. Controlled desktop and 320–420 CSS-pixel browser captures for empty, one-reference detail, multi-repository/multi-phase, 50-reference, longest-content, validation, opener error, and destructive states.
4. A native Tauri smoke at representative and narrow sizes when the desktop runtime is available.
5. Keyboard-only create, validation recovery, inspect, open, edit, attach twice, unlink once, confirm delete, return focus, modal close, and trigger-focus return.
6. Semantic name/status review plus configured accessibility tooling; automated results remain defect detection rather than conformance proof.
7. Manual 200% text, 320 CSS-pixel reflow, long unbroken content, localization expansion, no-hover/coarse-pointer, reduced-motion, and forced-colors checks.
8. Instrumented proof that pre-open reference interactions produce zero app-side fetch/body/open calls and explicit open produces exactly one persisted-URL call.
9. One rendered critique/revision cycle scoring at least 20/24 with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity.
10. Field performance remains explicitly unverified without real telemetry; local render and interaction checks are regression evidence only. Unavailable native or assistive-technology tooling is recorded honestly.