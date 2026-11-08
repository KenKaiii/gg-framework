# lint, check, snapshot

Motion does not run these as delivery gates. Use them only for targeted debugging of a concrete failure. `snapshot` captures still frames and zoomed crops; `validate`, `inspect` and `layout` are deprecated because `check` covers them.

## Discipline (motion-heavy work)

For a concrete problem during authoring or editing:

- Use `lint` for a static-code failure or `check --snapshots` for runtime/layout evidence, not both by default.
- Look at the returned images before changing the animation: a diagnostic must not become an alternative art direction.
- Treat layout errors as defects unless a snapshot proves the layering is intentional, in which case mark it with `data-layout-allow-overflow` / `data-layout-allow-overlap` / `data-layout-allow-occlusion` / `data-layout-allow-caption-zone` (caption band only).
- Existing meaningful motion assertions may remain, but GG does not require a new `*.motion.json` sidecar for every video. Use stills of the render for liveness, especially for canvas/WebGL. No detector or screenshot proves playback was watched.

## lint

```bash
hf lint                  # current directory
hf lint ./my-project     # specific project
hf lint --verbose        # info-level findings
hf lint --json           # machine-readable
```

Lints `index.html` and all files in `compositions/`. Reports errors (must fix), warnings (should fix), and info (with `--verbose`). Catches missing `data-composition-id`, overlapping tracks on the same `data-track-index`, unregistered timelines, and GSAP/CSS transform conflicts.

`<video>`/`<audio>` work at any nesting depth, including inside a `compositions/*.html` sub-composition or a wrapper `<div>`: the runtime discovers media with a flat DOM query and seeks/decodes it wherever it lives (`packages/core/src/runtime/{media,startResolver}.ts`). After a render, `snapshot` each scene that has a video and confirm the panel actually shows footage (a blank/black panel where a clip should play is a real bug, not a placeholder).

## check

```bash
hf check                    # current directory: the full browser gate
hf check ./my-project       # specific project
hf check --json             # agent-readable envelope {ok, lint, runtime, layout, motion, contrast, hdr, snapshots}
hf check --snapshots        # also write overview frames (annotated) + per-finding crops
hf check --samples 15       # denser timeline sweep (default 9)
hf check --at 1.5,4,7.25    # explicit hero-frame timestamps
hf check --at-transitions   # also sample every tween start/end boundary
hf check --tolerance 4      # allowed overflow px before reporting (default 2)
hf check --timeout 30000    # initial render-ready + navigation minimum in ms (defaults: 3000 / 10000)
hf check --no-contrast      # skip the WCAG audit while iterating
hf check --strict           # exit non-zero on warnings too (default: only errors)
```

One command, one Chrome boot. `check` runs the linter first and skips the browser entirely when lint reports errors. Then it loads the bundled composition once, wires runtime listeners before navigation, and sweeps one seek grid running every audit per sample:

- **Runtime**: JavaScript console errors, unhandled exceptions, failed network requests (media-file `ERR_ABORTED` filtered out), HTTP 4xx/5xx.
- **Layout**: text extending outside its container or the canvas, text clipped by its own box, held text overlaps and occlusion (with an approximate covered fraction), children escaping clipping containers.
- **Motion**: `*.motion.json` sidecar assertions against the same seeked timeline (see below).
- **Contrast**: WCAG AA on visible text, sampled at 5 grid points. Failures are **errors** and each finding carries the sampled fg/bg colors, measured vs required ratio, and a suggested compliant color in the same palette direction, so most contrast fixes need no screenshot at all.

Every finding carries a selector, the element's `data-*` identity, the composition source file, a bbox, and the sample time: jump straight from the JSON to the HTML you must edit and re-run.

**Severity is persistence-aware.** A dynamic issue observed at a single grid sample (an entrance/exit transient) demotes to info and never gates. Issues held across samples gate the exit code, a held `content_overlap` is an error, and a held, partially-visible `canvas_overflow` breaching ≥5% of the canvas promotes to warning. Coordinate-frame findings (`escaped_container`, `panel_out_of_canvas`, `connector_detached`) flag geometry computed in one frame but rendered in another — an element far outside its offset parent, a painted panel stuck across the canvas edge, a connector line detached from every node. Text drawn into a `<canvas>` has no DOM box, so `canvas_overflow` cannot see it; `canvas_content_at_edge` warns when a canvas's pixels show sharp content (drawn text, hard shapes) along the frame edge — mark intentional full-bleed art (particles, photos) with `data-layout-allow-overflow`. If a 3s+ composition shows zero geometry change across every sample, `check` fails with `sweep_static`: a frozen timeline makes every green verdict unreliable, so it refuses to pass. The fingerprint includes per-element opacity, so opacity-only reveals (code typing, staggered fades) count as motion — but only while they're still in flight at the sampled times. The classic trap is a reveal that completes early and then holds a static frame for the rest of the duration: every sample lands on the settled state and the run fails. For a source-backed recipe, preserve that early reveal and reading hold. Diagnose with samples at its actual action times and the rendered-pixel result. Do not spread the reveal, add a blinking element or introduce drift to appease a heuristic. Report an unresolved detector conflict honestly rather than changing locked choreography or claiming a pass.

**Escape hatches** (mark intent in the HTML, then re-run):

- `data-layout-allow-overflow` — overflow is intentional (entrance/exit travel).
- `data-layout-allow-overlap` — deliberate text layering (e.g. a demo cursor label over a heading). Applies only to the marked text block; it is not inherited. Mark the specific layering participant, never a scene/root wrapper, so unrelated descendant collisions remain auditable.
- `data-layout-allow-occlusion` — an element is meant to cover text.
- `data-layout-allow-caption-zone` — intentional lower-third / caption-band copy under `--caption-zone`. Applies to the marked element and every descendant (`closest`); silences only `caption_zone_collision` (not overflow/overlap/occlusion). Prefer the narrowest wrapper that owns the intentional band copy.
- `data-layout-ignore` — decorative element that should never be audited.

**Opt-in pipeline gates** (used by orchestrators; off by default):

```bash
hf check --caption-zone "x0=0;y0=.82;x1=1;y1=1;severity=error;seek=.25,1"
hf check --frame-check     # media (img/svg/video/canvas) out-of-frame detection
```

`--caption-zone` takes fractional band geometry (`x0/y0/x1/y1` required, 0-1 fractions of the composition's own canvas, portrait included) with optional `severity` and comma-separated `seek` fractions; it flags a text element's DOM box (`getBoundingClientRect`) that overlaps the band. Waive intentional lower-third copy with `data-layout-allow-caption-zone` on the element or its nearest wrapper (see Escape hatches). `--frame-check` reports media elements breaching the canvas beyond `max(120px, 6% of the min canvas dimension)`.

**Fixing contrast errors** — thresholds are 4.5:1 for normal text, 3:1 for large text (24px+, or 19px+ bold). The finding's `suggestedColor` already picks the nearest compliant color in the right direction (brighten on dark backgrounds, darken on light); apply an allowed correction, or resolve a conflict with locked source/brand colours before changing them. Look at a still of the changed moment; do not run the full diagnostic checklist.

## Motion verification (`*.motion.json` sidecar)

`check` verifies **motion intent** against the same seeked timeline the renderer uses — the closest automated proxy for "render the MP4 and watch it". It catches render-vs-preview bugs layout sampling can't: an entrance reveal the seek lands past, a broken stagger order, an element drifting off-frame mid-tween, a frozen shot.

Drop a `*.motion.json` sidecar next to the composition (matching the html basename when several compositions share a dir). `check` discovers it automatically — no flag, no authoring-framework changes. With no sidecar, `check` behaves exactly as before.

```json
{
  "duration": 6,
  "assertions": [
    { "kind": "appearsBy", "selector": "#headline", "bySec": 0.5 },
    { "kind": "before", "a": "#headline", "b": "#cta" },
    { "kind": "staysInFrame", "selector": ".card" },
    { "kind": "keepsMoving", "withinSelector": ".scene" }
  ]
}
```

| Assertion                      | Fails (code) when                                                           |
| ------------------------------ | --------------------------------------------------------------------------- |
| `appearsBy(selector, bySec)`   | not visible (opacity ≥ 0.5) by `bySec` — `motion_appears_late`              |
| `before(a, b)`                 | `a` does not first appear strictly before `b` — `motion_out_of_order`       |
| `staysInFrame(selector)`       | once visible, its box leaves the canvas — `motion_off_frame`                |
| `keepsMoving(withinSelector?)` | a fully-static window exceeds `maxStaticSec` (default 2s) — `motion_frozen` |

`duration`, `withinSelector`, and `maxStaticSec` are optional. Findings are **errors by default** and appear in the same human and `--json` output as layout findings. A selector that matches nothing is reported as `motion_selector_missing` rather than silently passing — a typo'd selector fails loudly. Use this in the feedback loop instead of eyeballing the render: assert what the motion is supposed to do, and let `check` tell you when the seek diverges from intent.

## snapshot

```bash
hf snapshot                       # 5 key frames as PNG
hf snapshot ./my-project          # specific project
hf snapshot --frames 10           # evenly-spaced N frames
```

Captures still PNGs from the composition for visual diffing, thumbnails, or attaching to a PR. Faster than rendering a video when you only need a few hero frames. Output lands in the project's snapshots directory. Not deprecated: it remains the standalone capture utility, while `check --snapshots` covers the gate's needs (overview frames annotated with labeled finding boxes, plus `finding-NN-<code>.png` crops for every error finding with a bbox).

### Zooming into a reported finding

`hyperframes check --snapshots` already writes a `finding-NN-<code>.png` crop for every error finding that carries a bbox, but the same zoom is available standalone once you know what to look at:

```bash
hf check --snapshots               # reports a finding, e.g. content_overlap on "#cta"
hf snapshot --zoom "#cta"           # crop the element to verify the defect, at 3x density
hf snapshot --zoom "100,50,400,300" --zoom-scale 2   # or an exact pixel region
# fix the composition HTML, then re-check:
hf check
```

`--zoom` takes a CSS selector or an exact `x,y,w,h` pixel region and always produces a real high-density crop (a raised `deviceScaleFactor`, never CSS zoom or a viewport resize), so the composition's layout — and its render determinism — is untouched. A selector matching nothing is a loud error, not a silent full-frame fallback, and a frame where the target has no visible box (collapsed or animated off-canvas) is skipped with a note instead of written as a sliver.

## Deprecated: validate, inspect, layout

All three keep working, print a deprecation notice on stderr, and mark `_meta.deprecated: true` in `--json`. Their functionality lives in `check`:

- `validate` (runtime errors + contrast) → `check` (contrast failures are now gating errors with fix payloads, not warnings).
- `inspect` / `layout` (layout sweep + motion sidecar) → `check` (same flags: `--samples`, `--at`, `--at-transitions`, `--tolerance`, `--strict`).

Migrate scripts by replacing the sequence with the single `check` invocation; scaffolded projects' `npm run check` already points there.
