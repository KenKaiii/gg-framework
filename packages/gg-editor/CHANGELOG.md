# Changelog

## 0.7.32

### Patch Changes

- Updated dependencies [1c37b11]
  - @kenkaiiii/ggcoder@4.11.3
  - @kenkaiiii/gg-ai@4.11.3
  - @kenkaiiii/gg-agent@4.11.3

## 0.7.31

### Patch Changes

- Updated dependencies [a2da1f8]
  - @kenkaiiii/ggcoder@4.11.2
  - @kenkaiiii/gg-ai@4.11.2
  - @kenkaiiii/gg-agent@4.11.2

## 0.7.30

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.11.1
  - @kenkaiiii/gg-ai@4.11.1
  - @kenkaiiii/gg-agent@4.11.1

## 0.7.29

### Patch Changes

- @kenkaiiii/ggcoder@4.11.0
- @kenkaiiii/gg-ai@4.11.0
- @kenkaiiii/gg-agent@4.11.0

## 0.7.28

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.10.2
  - @kenkaiiii/gg-ai@4.10.2
  - @kenkaiiii/gg-agent@4.10.2

## 0.7.27

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.10.1
  - @kenkaiiii/gg-ai@4.10.1
  - @kenkaiiii/gg-agent@4.10.1

## 0.7.26

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.10.0
  - @kenkaiiii/gg-agent@4.10.0
  - @kenkaiiii/ggcoder@4.10.0

## 0.7.25

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.9.1
  - @kenkaiiii/gg-ai@4.9.1
  - @kenkaiiii/gg-agent@4.9.1

## 0.7.24

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.9.0
  - @kenkaiiii/gg-ai@4.9.0
  - @kenkaiiii/gg-agent@4.9.0

## 0.7.23

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.7
  - @kenkaiiii/gg-ai@4.8.7
  - @kenkaiiii/gg-agent@4.8.7

## 0.7.22

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.6
  - @kenkaiiii/gg-ai@4.8.6
  - @kenkaiiii/gg-agent@4.8.6

## 0.7.21

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.5
  - @kenkaiiii/gg-ai@4.8.5
  - @kenkaiiii/gg-agent@4.8.5

## 0.7.20

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.4
  - @kenkaiiii/gg-ai@4.8.4
  - @kenkaiiii/gg-agent@4.8.4

## 0.7.19

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.3
  - @kenkaiiii/gg-ai@4.8.3
  - @kenkaiiii/gg-agent@4.8.3

## 0.7.18

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.2
  - @kenkaiiii/gg-ai@4.8.2
  - @kenkaiiii/gg-agent@4.8.2

## 0.7.17

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.8.1
  - @kenkaiiii/gg-ai@4.8.1
  - @kenkaiiii/gg-agent@4.8.1

## 0.7.16

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.8.0
  - @kenkaiiii/gg-agent@4.8.0
  - @kenkaiiii/ggcoder@4.8.0

## 0.7.15

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.7.0
  - @kenkaiiii/gg-ai@4.7.0
  - @kenkaiiii/gg-agent@4.7.0

## 0.7.14

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.3
  - @kenkaiiii/gg-agent@4.6.3
  - @kenkaiiii/ggcoder@4.6.3

## 0.7.13

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.2
  - @kenkaiiii/gg-agent@4.6.2
  - @kenkaiiii/ggcoder@4.6.2

## 0.7.12

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1
  - @kenkaiiii/gg-agent@4.6.1
  - @kenkaiiii/ggcoder@4.6.1

## 0.7.11

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0
  - @kenkaiiii/ggcoder@4.6.0
  - @kenkaiiii/gg-agent@4.6.0

## 0.7.10

### Patch Changes

- Updated dependencies
  - @kenkaiiii/ggcoder@4.5.0
  - @kenkaiiii/gg-ai@4.5.0
  - @kenkaiiii/gg-agent@4.5.0

## 0.7.9

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-ai@4.4.0
  - @kenkaiiii/ggcoder@4.4.0
  - @kenkaiiii/gg-agent@4.4.0

All notable changes to `@kenkaiiii/gg-editor` are tracked here.

## [Unreleased] — Cleanup: remove unused execution modes

### Removed

- **Dry-run mode** — deleted `src/tools/dry-run.ts` and the `dryRun` option on `createEditorTools`. Users run interactively in chat and stop the agent themselves; the rehearsal layer was unused dead weight. Drops `HOST_MUTATING_TOOLS`, the dry-run wrapper, and the system-prompt dry-run banner.
- **Director-Executor mode** — deleted the entire `src/director/` directory (`director.ts`, `executor.ts`, `delegate-tool.ts`, `director-prompt.ts`, `types.ts`, tests). The two-agent planner/doer split was never wired into the CLI and isn't needed for interactive chat-driven editing.
- Removed corresponding exports from `src/index.ts`.
- Removed `--no-tui`, `--host`, `--cwd`, `--provider`, `--model`, `--director`, `--dry-run` from README CLI flags section (none were ever parsed by `cli.ts`; only auth subcommands and `continue` are real).
- Removed `--host none` from README examples — host is auto-detected.

### Tests

- 7 tests removed (4 delegate-tool, 3 dry-run/HOST_MUTATING). 315/315 passing.

## [Unreleased prior] — Depth pass round 3: marker palette expansion + wrapper coverage

### Marker color taxonomy

- New `core/marker-colors.ts` consolidating Resolve's 16-color palette, Premiere's 8-index map, and a hue-family snap mapping for Resolve-only colors. Single source of truth — previously duplicated in `tools/get-markers.ts` and `core/hosts/premiere/bridge-source.ts`.
- `add_marker` enum expanded from 6 → 18 colors (8 universal + 10 Resolve-only). Premiere snaps Resolve-only hues to closest of its 8 indices: pink/rose→red, fuchsia/lavender→purple, sky→cyan, mint→green, lemon/sand→yellow, cocoa→red (warm-brown), cream→white. Verified against samuelgursky/davinci-resolve-mcp.
- Resolve adapter normalises mixed-case input via `toResolveColor()` (lowercase agent input → Title-Case Resolve form). Previously failed silently for `"blue"` because Resolve only accepts `"Blue"`.

### Tool wrapper coverage

- New `tools/host-tools.test.ts` (13 tests) — every host-mutation tool wrapper exercised against `NoneAdapter`. Verifies error-formatting contract: `cut_at`, `ripple_delete` (incl. validation pre-check), `add_marker`, `append_clip`, `set_clip_speed`, `get_timeline`, `get_markers`, `create_timeline`, `import_to_media_pool`, `open_page`, `import_subtitles`, `import_edl`. Previously zero coverage.
- Vision module: extracted `clampScore` and `clampWhy` to public exports + 9 new tests covering range clamping, decimal rounding, string-coerce, non-finite defaults, 80-char truncation.
- Marker-colors module (7 tests): canonical 16-color list integrity, Premiere-index uniqueness, every Resolve color resolves to a valid Premiere index, hue-snap correctness for the 6 most ambiguous colors, `toResolveColor` normalisation.

### Verifications (no fix needed)

- **Reformat presets** verified against social platform sources (elixir-image/image, AJaySi/ALwrity, Aitum/obs-vertical-canvas, Flux-AI-Pro): 9:16=1080×1920, 1:1=1080×1080, 4:5=1080×1350, 16:9=1920×1080. All match exactly.
- **whisper.cpp tokens schema** verified against innovatorved/whisper.api fixture. Our `regroupTokensIntoSegments` correctly reads `transcription[i].offsets.from/to` (ms) and trims leading-space token text.
- **Jaccard math** verified against spotify/echoprint-server, Yomguithereal/fog: standard `|A∩B|/|A∪B|` formula, our empty-set behaviour (return 0) is the safer choice for take-clustering.

### Counts

- **Tools**: 59 (no change)
- **Tests**: 295 → **322 across 35 files**
- **Real-world bugs caught**: 1 (Resolve marker color case-sensitivity in adapter)

## [0.1.x] — Depth pass round 2: filter escapes, edge-case coverage

More real-world fixture verification via grep MCP. Found and fixed 2 cross-platform bugs in filter-path escapes; added 34 new edge-case tests across 4 modules.

### Cross-platform fixes

- **`compose_thumbnail` drawtext escape**: was missing backslash, percent, and newline handling. Verified against GVCLab/CutClaw, g0ldyy/comet, ehendrix23/tesla_dashcam: full rules are `\\` first → `:` → `'` → `%` → newline. Order matters — backslash must escape first or subsequent rules double-escape.
- **`burn_subtitles` filter path** for Windows: was emitting `C\\:\\Users\\me\\subs.ass` (double-backslashes for path separators) which ffmpeg rejects. Real-world Windows convention (RightNow-AI/openfang skill): forward slashes + `C\:` for the drive colon. Now produces `C\:/Users/me/subs.ass`.
- **`crossfade_videos` xfade list** expanded from 16 to 33 transitions — previous list was missing `fadeblack`, `fadewhite`, `fadegrays`, `slideup`, `slidedown`, the cover/reveal pairs, squeeze, zoom. Verified against the wubloader maintained list.

### Edge-case test coverage

- `core/silence.test.ts` (+5): silence covering entire file, adjacent silences (no zero-length keep emitted), overlapping silences, silence past totalSec, defensive sort. These are the cases real ffmpeg output produces with multi-pass detection.
- `core/format.test.ts` (+5): negative-frame clamp, 24h fixture (no overflow), 100h overflow path, frame-field never overflows fps (no "60 frames at 30fps" bug), full sub-second test.
- `core/review.test.ts` (+4): trailing whitespace after JSON fence, flags missing required fields dropped, empty flags array, missing flags key entirely.
- `tools/post-tools.test.ts` (+11): `escapeDrawtextValue` (7 tests — plain, quote, colon, percent, backslash, newlines, kitchen sink) + `escapeFilterPath` (4 tests — Windows backslashes, drive-colon, single quotes, plain Unix).
- `tools/read-transcript.test.ts` (NEW, 10 tests): no-filter, range, contains, speaker, intersection of all three, limit + truncated flag, missing-path error, speaker passthrough in output, no-speaker omission, includeWords on/off.

### Refactors

- Pure-function exports for testing: `escapeDrawtextValue` (compose-thumbnail), `escapeFilterPath` (burn-subtitles).

### Counts

- **Tools**: 59 (no change — still depth)
- **Tests**: 261 → **295 across 33 files**
- **Real-world bugs caught**: 2 (Windows filter path, drawtext escape order)

## [0.1.x] — Depth pass: real-world format compliance + parser hardening

No new tools — existing ones verified against real-world fixtures pulled via grep MCP from open-source repos and tightened where they drifted from convention.

### Format compliance fixes

- **FCPXML** now emits `videoSources="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"` on every asset (matches BBC fcpx-xml-composer, DozaVisuals, Apple's 1.10 sample, and the LTX-Desktop / harrisonwang exports). Without these, Resolve and Premiere occasionally fail to auto-route audio. New `audioChannels` and `audioRate` options on `buildFcpxml()` for non-stereo / non-48kHz sources.
- **Ducking** default threshold lowered from 0.05 → 0.02. Real-world podcast fixtures (lukaszliniewicz/Subdub, MatrixReligio/ProductVideoCreator, R3gm/SoniTranslate) cluster at 0.012–0.03; 0.05 was so high quiet conversation didn't trigger ducking at all.
- **Loudness `dual_mono=true` auto-detect**. Real-world ffmpeg invocations (AniDevTwitter/animeopenings, Just-Some-Bots/MusicBot) include `dual_mono=true` for mono sources — without it loudnorm under-measures by ~3 LU and pass 2 over-corrects. Both `measure_loudness` and `normalize_loudness` now probe channel count and pass through `dualMono: true` automatically when input is mono. Output payloads expose the flag.

### Parser hardening (silencedetect)

- Real-world ffmpeg emits `silence_start: -0.00133333` as a filter look-back artifact when the file leads with silence. Old parser rejected it, dropping the leading-silence detection. New parser clamps near-zero negatives (`v >= -1`) to 0 and continues. Genuinely-negative starts (< -1s) still rejected as parse errors.
- Junk-suffix lines like `silence_start: 430.41'peed= 858x` (jappeace/cut-the-crap fixture) survive — regex is anchored on the leading number only.
- Two new tests covering both edge cases.

### Refactors that enable better tests

- `whisperxJsonToTranscript(parsed, fallbackLanguage)` extracted as a pure function. Whisperx subprocess code now reduces to a one-liner. New unit tests cover real-world fixture shapes (typedef-ai/fenic, fastrepl/char, pavelzbornik/whisperX-FastAPI): segment-level speakers, word-level speakers with leading-space tokens, NaN word filtering, no-diarize and no-words paths, language fallback.
- `buildConcatListBody(paths)` extracted as a pure function from `concat_videos`. Tests verify POSIX-shell quote escaping (`'` → `'\\''`) against the Xinrea/bili-shadowreplay test fixture.

### MediaProbe extension

- `audioChannels?: number` and `audioSampleRate?: number` now parsed from ffprobe output — needed for the dual_mono auto-detect, useful for downstream tools.

### Tests (+12)

- `core/whisper.test.ts`: 5 new tests for `whisperxJsonToTranscript`.
- `core/silence.test.ts`: 2 new tests for the leading-silence and junk-suffix edge cases; existing test rephrased.
- `core/fcpxml-roundtrip.test.ts`: 2 new tests asserting standard audio-metadata attrs are emitted + custom overrides honoured.
- `tools/post-tools.test.ts`: 3 new tests for `buildConcatListBody`.

### Counts

- **Tools**: 59 (no change — depth pass)
- **Tests**: 249 → **261 across 32 files**
- All format-compliance regressions caught + fixed before any user hit them.

## [0.1.x] — Tier-7: delivery / polish layer

The agent could build great timelines but ended up handing the user a half-finished file when working in `none` mode (no NLE attached). This pass adds the delivery / polish layer: caption burn-in, stitching, fades, transitions, GIF previews, watermarking, thumbnail composition. All ffmpeg one-liners; all file-only; all work in every host mode.

### New tools (7)

- **`burn_subtitles`** — hardcode .srt or .ass into video via ffmpeg `subtitles=` filter. Audio copied unchanged. End-of-pipeline tool.
- **`concat_videos`** — two modes: lossless (concat demuxer, requires uniform codec/res/fps/SR) and re-encode (filter-based, always works). Intro/main/outro stitching.
- **`add_fades`** — video + audio fade-in / fade-out via `fade` + `afade` filters. Probes input duration and rejects fadeOut >= duration.
- **`crossfade_videos`** — ffmpeg xfade between two clips. 16 transition styles (fade/wipe/slide/circle/dissolve/pixelize/radial/smooth×4). Audio uses `acrossfade`.
- **`generate_gif`** — two-pass palettegen (stats_mode=diff) → paletteuse (bayer dither, rectangle diff_mode) for high-quality small GIFs. 480px @ 12fps default; 15s cap.
- **`overlay_watermark`** — PNG composite. Corner / center presets, configurable margin / opacity / scale. Filter chain: alpha-mix watermark → scale2ref against main width → overlay at computed coordinates. Audio passed through.
- **`compose_thumbnail`** — single-frame extract + drawtext headline in one ffmpeg call. White-on-black-outline at bottom by default (readable at thumbnail scale). System font fallback ladder (macOS Helvetica → Linux DejaVu → Windows Arial); explicit `fontFile` param overrides.

### System-prompt updates

- New "Delivery / polish" section listing the seven tools and the canonical ordering: cleanup → normalize → burn_subtitles → add_fades / overlay_watermark.

### Tests

- `tools/post-tools.test.ts` (5) — `positionFormula` for all five corner/center presets (the only non-trivial pure-logic branch in this batch).
- Tool list verification updated.

### Counts

- **Tools**: 52 → 59 (60 with `review_edit`)
- **Tests**: 244 → 249 across 32 files
- All 7 new tools work in `none` mode — file-only pipelines now ship a complete deliverable.

## [0.1.x] — Tier-6: envelope multicam, stabilization, pre-render QA, host gaps

### New tools (5)

- **`multicam_sync` v2** — added `method="envelope"` for dialogue-only sync. Pure-JS energy-envelope cross-correlation: ffmpeg extracts mono 16kHz PCM, we compute RMS in 100ms blocks (~600 samples for a 60s window) and run time-domain Pearson correlation within ±`maxLagSec`. Returns per-pair confidence; warns when any pair correlates below 0.3. Old transient method still default; agent retries with envelope when transient yields nulls.
- **`stabilize_video`** — ffmpeg vidstabdetect + vidstabtransform two-pass. Knobs: shakiness 1-10, smoothing 1-30, zoom -10..10. Audio copied unchanged. Requires ffmpeg compiled with libvidstab.
- **`add_track`** — append a video / audio / subtitle track to the active timeline. Resolve only; Premiere errors honestly (TrackCollection.add not reliably scriptable).
- **`set_clip_volume`** — per-clip audio gain in dB. Resolve only — Premiere unsupported. Bridge tries dB, native dB, and linear setters in turn (versions differ).
- **`pre_render_check`** — composite read-only QA. Verifies: timeline non-empty (block), no unresolved PAUSE markers (block), loudness within ±1 LU + TP within ceiling when source+target supplied (block), captions presence when expected (warn). Returns severity-tagged issues + a top-level status ("ok" / "warn" / "block").

### New core modules

- `core/envelope-sync.ts` — `extractEnvelope(path)` (ffmpeg PCM → RMS blocks), `correlateEnvelopes(a, b, maxLag)` pure Pearson correlator with documented sign convention, `envelopeSync(paths)` aligning all inputs to the first.
- `core/stabilize.ts` — `stabilize(in, out, opts)` two-pass vidstab runner with knob clamping and clear error messages when libvidstab is missing.

### New bridge methods

- **Resolve**: `add_track(kind)`, `set_clip_volume(clipId, volumeDb)` with three-setter fallback ladder.

### System-prompt updates

- Multicam section split: transient default + envelope fallback rule.
- New "Pre-render check" rule — always run before final render; block on severity="block".
- New "Stabilization" workflow.

### Tests (+11)

- `core/envelope-sync.test.ts` (5) — correlator: identical envelopes (corr~1, lag=0), trail (negative lag), lead (positive lag), uncorrelated signals, maxLag cap.
- `core/hosts/resolve/bridge.integration.test.ts` (+2) — `add_track`, `set_clip_volume` against fake adapter.
- `tools/new-tools.test.ts` (+4) — `add_track`, `set_clip_volume` (unsupported branch), `stabilize_video` (input==output rejection), `pre_render_check` (block on unreachable host).

### Counts

- **Tools**: 47 → 52 (53 with `review_edit`)
- **Mutating tools**: adds `add_track`, `set_clip_volume`
- **Tests**: 233 → 244 across 31 files

## [0.1.x] — Tier-5: real diarization, styled captions, ducking, safety nets

### New tools (5)

- **`duck_audio`** — sidechain compress music under voice. ffmpeg filter graph wraps `sidechaincompress` with sensible podcast defaults (threshold 0.05, ratio 8, attack 5ms, release 250ms). Voice + ducked-bg mixed into one output.
- **`write_ass`** — Advanced SubStation Alpha subtitle writer. Per-cue style overrides, font / size / color / outline / shadow / position (numpad alignment 1-9), bold/italic. Built-in vertical-canvas "Default" preset (Arial 72 white-on-black-outline, bottom-center, 220px margin).
- **`clone_timeline`** — duplicate the active timeline under a new name. Resolve uses `Timeline.DuplicateTimeline` then activates the clone; Premiere uses `Sequence.clone()` and renames. Safety net before destructive ops.
- **`save_project`** — explicit project save. Resolve `ProjectManager.SaveProject()`, Premiere `app.project.save()`. Use after a sequence of edits as a checkpoint.
- **Speaker diarization** — `transcribe(diarize=true)` shells out to **whisperx** (`pip install whisperx`), which uses pyannote-audio for real speaker labeling. Needs HF_TOKEN env (free Hugging Face account + accept pyannote license). New `detectWhisperx()` probe; new `transcribeWhisperx()` runner. Output `Transcript.segments[].speaker` and per-word `speaker` populated. `transcribe(backend="whisperx")` also opt-in without diarization. New `whisperxModel` option (default `base`).

### Bridge additions

- **Resolve**: `clone_timeline`, `save_project` methods. The clone activates the new timeline, then saves the project.
- **Premiere**: `clone_timeline` (Sequence.clone()) + `save_project` (app.project.save()).
- **None adapter**: HostUnreachableError for both.

### Per-call bridge cancellation

- Resolve `bridge.call(method, params, { signal })` accepts an AbortSignal. On abort: pending entry deleted from dispatcher, JS-side promise rejects with AbortError. The bridge process keeps running for other callers; the eventual late response is silently discarded.
- Premiere osascript transport `runOsascript(scriptPath, signal)` kills the spawned osascript on abort.
- Premiere HTTP transport passes `signal` straight to fetch().
- Resolve render still can't be cancelled mid-flight (host-side queue API limitation).

### New core modules

- `core/ducking.ts` — `buildDuckingFilter(opts)` pure builder + `duckAudio()` runner. Filter graph splits voice into output + sidechain key.
- `core/ass.ts` — `buildAss({ styles, cues, playRes... })` ASS writer + `assColor(hex)` (CSS RGBA → ASS BGRA with alpha inverted) + `formatAssTime(sec)` (centiseconds, not ms).

### Tests (+26)

- `core/ducking.test.ts` (5) — default filter chain, override values, voice split, output mix, gain controls.
- `core/ass.test.ts` (16) — time formatting, color conversion (RGB + RGBA inversion), Default-style requirement, section emission, newline escape, end<=start rejection, unknown-style rejection, vertical canvas, dialogue line format, style-override emission.
- `tools/new-tools.test.ts` (+3) — `clone_timeline`, `save_project`, `write_ass` end-to-end (writes file, reads back, verifies content).
- `core/hosts/resolve/bridge.integration.test.ts` (+2) — `clone_timeline`, `save_project` against the fake adapter (which gained `DuplicateTimeline`, `SetCurrentTimeline`, `SaveProject`).

### System prompt updates

- New rule #11: clone_timeline + save_project before destructive ops.
- Captions section: write_ass for styled burned captions.
- New "Music ducking" section.
- Speaker handling section rewritten with three paths in order of accuracy: real diarization (whisperx) → pre-labeled transcript → silence-gap heuristic.

### Counts

- **Tools**: 42 → 47 (48 with `review_edit`)
- **Mutating tools**: adds `clone_timeline`
- **Tests**: 207 → 233 across 30 files

## [0.1.x] — Tier-4 close: marker filters, style presets, speaker handling, golden tests

Close the four tractable items in the post-audit Tier 4 list. Two remain open and documented (diarization v2, multicam v2) because they need infra (whisperx/pyannote, FFT) better introduced as their own pass.

### New tools (1) + enhanced tools (2)

- **`detect_speaker_changes`** (new) — silence-gap heuristic: returns inter-segment gaps > `minGapSec` as CANDIDATES for speaker boundaries. Honest about its limits: reasonable for fast-cut interview audio, unreliable for natural conversation. Output is candidates, not assignments — the agent surfaces them; the user decides.
- **`get_markers`** — added `color` (Resolve name OR Premiere numeric index, both accepted), `contains` (case-insensitive substring of note), `startFrame` / `endFrame` filters. Filters apply server-side so context isn't blown by unrelated markers. `MarkerInfo.color` widened to `string | number` to reflect what bridges actually return.
- **`read_transcript`** — added `speaker` filter (case-insensitive). Only matches when the saved transcript JSON includes speaker labels (whisperx / AssemblyAI / manual). Speaker is now also surfaced in the per-segment compact output when present.

### Style presets (new feature)

- New `core/styles-loader.ts` — `discoverStyles({ cwd, homeDir })` walks `<cwd>/.gg/editor-styles/*.md` (project) + `~/.gg/editor-styles/*.md` (user). **Project overrides user** (opposite of skills, by design — a project's checked-in style wins).
- `renderStylesBlock(styles)` produces a markdown section the system-prompt builder embeds verbatim as "Active style presets". Empty when no styles — zero footprint.
- CLI auto-discovers styles at startup; `buildEditorSystemPrompt` accepts `styles?` for library consumers.

### Schema additions

- `TranscriptSegment.speaker?: string` — populated only by external diarization. Surfaces transparently through `read_transcript`.
- `MarkerInfo.color: string | number` — honest typing of what Resolve (string names) vs Premiere (numeric indices) returns.

### Round-trip golden tests

- `core/edl-roundtrip.test.ts` (8) — targeted regex extraction of CMX 3600 event lines + assertions on contiguous record cursor, monotonic event numbers, reel padding/truncation, track field width, frame-rate-agnostic timecode round-trip (24/25/29.97/30/60), clip-name comment placement.
- `core/fcpxml-roundtrip.test.ts` (7) — asset-clip parser + assertions on one-asset-per-unique-reel, contiguous offsets, NTSC fraction correctness for 29.97 and 23.976, asset/clip ref integrity, clip-name preservation.

### Tests

- `core/styles-loader.test.ts` (5) — empty dirs, project + user load, project-overrides-user collision rule, empty-file skip.
- `core/speaker-changes.test.ts` (4) — no-boundary case, single-boundary case, custom `minGapSec`, preview-text clipping.
- `core/edl-roundtrip.test.ts` (8) and `core/fcpxml-roundtrip.test.ts` (7) listed above.
- Total: 183 → **207 passing across 28 files**.

### Counts

- **Tools**: 41 → 42 (43 with `review_edit`)
- **Skills**: 3 bundled, layered with project + user files at runtime
- **Style presets**: new layer, project + user files (opposite override direction from skills)

## [0.1.x] — Audit-close pass

Close the gaps from the post-Tier-2 honest audit. Loudness, word-level captions, B-roll, audio cleanup, frame extraction, render-preset discovery, clip replacement, Smart Reframe, color-match, plus a chapter-markers skill recipe.

### New tools (10)

- **`measure_loudness`** — read-only EBU R128 measurement (I / TP / LRA / threshold). Use to decide whether normalization is needed.
- **`normalize_loudness`** — two-pass loudnorm. Platform presets: youtube/spotify/tiktok/instagram=-14, podcast/apple-podcasts=-16, broadcast-r128=-23. Custom `integratedLufs` overrides.
- **`clean_audio`** — voice-noise cleanup. Modes: `denoise` (mild afftdn), `denoise-strong`, `rnnoise` (with model file or afftdn fallback), `dehum` (50/60Hz mains + 3 harmonics), `deess`.
- **`extract_frame`** — single-frame JPEG/PNG extraction at a timestamp. Thumbnails, hero stills.
- **`insert_broll`** — place a cutaway clip on a higher track at a specific timeline frame, leaving the main video and audio undisturbed.
- **`replace_clip`** — swap a clip's underlying media reference without disturbing in/out timing or grade. Useful in iteration loops with motion designers.
- **`smart_reframe`** — trigger Resolve Studio's Smart Reframe AI on a clip. Resolve Studio only (free Resolve + Premiere return unsupported).
- **`color_match`** — vision-derived CDL: compares reference vs target frame and emits slope/offset/power/saturation. **Read-only** — returns the CDL with a `confidence` field; agent decides whether to pipe it through `set_primary_correction`. Below 0.4 confidence = don't apply.
- **`list_render_presets`** — enumerate the host's render presets so the agent can pick a real name instead of guessing. Resolve returns the populated list; Premiere returns `[]` (presets live in AME).
- **Word-level captions** via `transcribe(wordTimestamps=true)` + `read_transcript(includeWords=true)` + `write_srt(words=[...], groupSize?, gapSec?)`. Local whisper.cpp uses `-ml=1`; OpenAI uses `timestamp_granularities=word`. Required for TikTok / Reels burned-in captions.

### New bridge methods

- **Resolve**: `list_render_presets`, `replace_clip` (with `ReplaceClip`/`ReplaceMedia` fallback ladder), `smart_reframe` (with `frameInterest` + `referenceFrame`), `insert_clip_on_track` (uses `MediaPool.AppendToTimeline` with `clipInfo` dict for track-targeted insert).
- **Premiere**: `replace_clip` (uses `TrackItem.changeMediaPath` when present, else explicit error), `insert_clip_on_track` (uses `videoTracks[i].insertClip`).
- **None adapter**: `HostUnreachableError` for replace/smart_reframe/insert; empty list for `listRenderPresets`.

### New core modules

- `core/loudness.ts` — `measureLoudness` (pass 1, parses loudnorm JSON), `applyLoudnorm` (pass 2, linear), `PLATFORM_TARGETS` map, `extractJsonBlock` helper.
- `core/audio-cleanup.ts` — `buildCleanupFilter(mode, opts)` pure function + `applyCleanup` runner. Pure builder is unit-tested.
- `core/color-match.ts` — `deriveColorMatch(refPath, tgtPath)` GPT-4o vision call + `parseColorMatchResponse` extractor that clamps OOR values and falls back to neutral on missing fields.
- `core/whisper.ts` — word-timestamp support: new `TranscriptWord` type, `wordTimestamps` option, `regroupTokensIntoSegments` for whisper.cpp `-ml=1` output, OpenAI `timestamp_granularities=word` plumbing with linear distribution into segments.
- `core/srt.ts` — `buildWordLevelSrt(words, { groupSize, gapSec })` for one-cue-per-word burned captions.

### New skill

- **`chapter-markers`** (bundled) — recipe for YouTube-style chapter timestamps: read transcript in 90s windows, identify topic shifts, drop purple markers, emit a description block. Constraints: first chapter at 00:00, 5–15 chapters, ≥30s apart, no fabricated boundaries.

### System prompt updates

- Captions section split into long-form (sidecar) vs short-form (burned-in word-level) workflows.
- New "Audio delivery workflow" — measure → (clean) → normalize before render. Platform LUFS targets listed.
- New "Render presets discipline" — always `list_render_presets` first.
- New "B-roll insertion workflow".
- New "Smart Reframe" workflow for Resolve Studio after `reformat_timeline`.
- New "Replace clip" workflow.
- Color section extended with `color_match` confidence-gating rule.
- Chapter-markers workflow: 1-line pointer to the new skill.

### Tests

- `core/loudness.test.ts` (6) — `extractJsonBlock` against trailing/nested/missing curly braces; `PLATFORM_TARGETS` integrity.
- `core/audio-cleanup.test.ts` (7) — filter strings for every mode, rnnoise model fallback, colon-escaping, dehum 50 vs 60Hz harmonic verification.
- `core/color-match.test.ts` (6) — well-formed parse, missing-field fallbacks, value clamping, prose-wrapped JSON, malformed JSON, non-array slope/offset.
- `core/srt.test.ts` (+5) — `buildWordLevelSrt`: one-cue-per-word, groupSize, gapSec extension within and beyond threshold, empty/zero-duration filtering.
- `core/whisper.test.ts` (+4) — `regroupTokensIntoSegments`: punctuation flush, tail flush, empty input, whitespace-token filtering.
- `core/hosts/resolve/bridge.integration.test.ts` (+4) — `list_render_presets`, `replace_clip`, `smart_reframe`, `insert_clip_on_track`. Fake `_Item` gains `ReplaceClip` / `SmartReframe`; fake `_MediaPool.AppendToTimeline` recognises clipInfo-dict variant.
- `tools/new-tools.test.ts` (9) — wrapper-layer coverage for `apply_lut`, `set_primary_correction` (no-component refusal), `copy_grade`, `insert_broll`, `replace_clip`, `smart_reframe` (unsupported branch), `list_render_presets` (empty list), `multicam_sync` (env-guarded), `review_edit` (registration shape).
- `tools/index.test.ts` updated for the 10 new tools and 3 new mutating tools.

### Counts

- **Tools**: 31 → 41 (42 with `review_edit` when auth is configured)
- **Mutating tools** (subject to dry-run): adds `replace_clip`, `insert_broll`, `smart_reframe`
- **Skills**: 2 bundled → 3 bundled (project + user layering still applies)
- **Tests**: 142 → 183 passing across 24 files

## [0.1.x] — Tier-2 close

Close the six gaps from the last audit: honest Premiere `set_clip_speed`, Resolve color tools, multicam clap-sync, self-critique, user-extensible skills, and a longer Resolve bridge integration test.

### New tools (5)

- **`apply_lut`** — apply a `.cube` / `.dat` LUT to a clip's grading node (Resolve only). Premiere throws `HostUnsupportedError` honestly.
- **`set_primary_correction`** — CDL slope/offset/power/saturation on a node (Resolve only). Refuses if no component supplied.
- **`copy_grade`** — replicate a hero clip's grade across many targets (Resolve only). Surfaces a clean fix when the Color page isn't open.
- **`multicam_sync`** — first-transient (clap) alignment of 2+ recordings via `ffmpeg silencedetect`. Returns relative offsets for EDL construction. v1 limit (clap-only) is documented in the tool description; cross-correlation deferred.
- **`review_edit`** — spawns a fresh **read-only** sub-agent (host_info, get_timeline, get_markers, read_transcript, score_shot, probe_media, read_skill) and asks it to critique the current edit against a stated intent. Returns `{critique, flags[], turns, tokens}` with severity-tagged flags. Registered only when an auth token is available.

### Honest fixes

- **Premiere `set_clip_speed`** now throws `HostUnsupportedError` instead of pretending. The QE DOM `setSpeed` was undocumented and never reliable; the fix message points at `write_fcpxml` + `import_edl` with explicit timeMap rates.
- **Resolve bridge** factored out `_find_timeline_item(clip_id)` into a shared helper used by `set_clip_speed`, `apply_lut`, `set_primary_correction`, and `copy_grade`.
- **None adapter** raises `HostUnreachableError` for the three color methods (matches the existing pattern).

### User-extensible skills

- New `core/skills-loader.ts` — `discoverSkills({ cwd, homeDir, bundled })` layers `bundled → project (.gg/editor-skills/*.md) → user (~/.gg/editor-skills/*.md)`. Last-wins by name; user overrides project, project overrides bundled.
- `read_skill` no longer hard-codes the bundled set — it takes an injected `SkillSource[]`. The tool's enum becomes a string validated at execute time against the active list, so user skills are first-class.
- System prompt renders the active skill list with `(project)` / `(user)` badges so override layering is visible.
- README has a new "Custom skills" section.

### Tests

- `core/multicam.test.ts` — reference picking, missing-transient warning, single-file trivial path.
- `core/review.test.ts` — trailing-JSON parser: well-formed, missing block, malformed JSON, unknown severity drops.
- `core/skills-loader.test.ts` — bundled-only, project loading + description extraction, user-overrides-bundled, user-wins-over-project.
- `core/hosts/resolve/bridge.integration.test.ts` — fake `_TimelineItem` gains `SetLUT`, `SetCDL`, `CopyGrades`, `SetClipProperty`; fake `_MediaPool` gains `CreateEmptyTimeline`, `ImportMedia`, `AddSubFolder`, `SetCurrentFolder`; fake `_Resolve` gains `OpenPage`. New `it()` blocks cover `get_markers`, `create_timeline`, `import_to_media_pool`, `open_page`, `set_clip_speed`, `import_subtitles`, `apply_lut`, `set_primary_correction`, `copy_grade`.
- `tools/index.test.ts` — EXPECTED_TOOLS / EXPECTED_MUTATING updated; `review_edit` registration is gated on `reviewConfig`.

### Counts

- **Tools**: 27 → 31 (32 with `review_edit` when auth is configured)
- **Mutating tools** (subject to dry-run): adds `apply_lut`, `set_primary_correction`, `copy_grade`
- **Tests**: 117 → 142 passing

## [0.1.x] — Content-creator pass

Focused tooling and recipes for **long-form** (podcasts, interviews, vlogs, courses, talking-head) and **short-form** (TikTok / Reels / Shorts) video content. Generative video / motion graphics / VFX remain explicitly out of scope.

### New tools (9)

- **`get_markers`** — read existing timeline markers. Call at session start to resume work without redoing decisions.
- **`write_srt`** — SubRip caption writer. Standard 1-indexed cues, `HH:MM:SS,mmm` timestamps.
- **`import_subtitles`** — attach an SRT file to the active timeline. Returns `{imported, attached, note?}` so the agent can tell the user when to drag manually (Premiere) vs auto-attach worked (Resolve).
- **`create_timeline`** — new timeline / sequence with name, fps, optional resolution. Premiere fallback clones the active sequence and ignores fps/width/height; this is surfaced in the response so the agent knows.
- **`import_to_media_pool`** — bring files into the project's bins without appending to the timeline.
- **`open_page`** (Resolve only) — switch the host UI between media / cut / edit / fusion / color / fairlight / deliver.
- **`set_clip_speed`** — retime clips (slow-mo, speed-up). Tries multiple Resolve API surfaces; falls back with a clear error pointing to FCPXML rebuild.
- **`reformat_timeline`** — generate FCPXML for a target aspect (9:16 / 1:1 / 4:5 / 16:9 / 4:3). Pair with `import_edl` to produce a vertical/square version of an edit.
- **`read_skill`** — fetch the markdown content of a bundled recipe on demand (`long-form-content-edit`, `short-form-content-edit`).

### Bridge additions

- **Resolve**: `m_get_markers`, `m_create_timeline`, `m_import_to_media_pool`, `m_open_page`, `m_set_clip_speed`, `m_import_subtitles` registered in the embedded Python bridge.
- **Premiere**: `get_markers`, `create_timeline` (with active-sequence-clone fallback when no `.sqpreset` is supplied), `import_to_media_pool`, `set_clip_speed`, `import_subtitles` ExtendScript bodies. Premiere's lack of a page concept is signalled cleanly — `open_page` returns `error: not_supported; fix: page concept is Resolve-only`.
- **None adapter**: throws `HostUnreachableError` for every new method.

### Bundled skills

Two embedded recipes, exposed via the new `read_skill` tool. Their descriptions live in the system prompt; full content is fetched on demand.

- **`long-form-content-edit`** — the 5-pass method (utterance segmentation → take detection → filler removal → incomplete-sentence trim → silence normalization), wired to our toolset.
- **`short-form-content-edit`** — find moment → reformat 9:16 → hook the first 2 seconds → burn captions → render.

### System-prompt overhaul

Rewritten with: mental model (long-form vs short-form), session-resume discipline (`get_markers` first), human-in-the-loop pause via red markers, destructive-action discipline, captions/SRT recipe, rough-cut-from-script recipe, reformat-for-shorts recipe, page-aware guidance (Resolve), and a Skills section listing bundled recipes.

### Core helpers

- **`core/srt.ts`** — SRT writer + tests (cue numbering, timestamp formatting, edge cases).
- **`core/reformat.ts`** — aspect-ratio preset specs (9:16 / 1:1 / 4:5 / 16:9 / 4:3) + tests.

### Dry-run

`HOST_MUTATING_TOOLS` extended with `create_timeline`, `import_to_media_pool`, `open_page`, `set_clip_speed`, `import_subtitles`. File writers (`write_srt`, `reformat_timeline`) always run; reads (`get_markers`) always run.

### Tests

+21 tests: `srt.test.ts` (9), `reformat.test.ts` (7), `tools/index.test.ts` (5). Total **117/117** passing.

### Build pipeline

`scripts/build-skills.mjs` regenerates `src/skills.ts` from `src/skills/*.md` on every `build`, `check`, and `test`. The generated `src/skills.ts` is gitignored — author the markdowns, the build embeds them as TS string constants.

## [0.1.0] — Initial alpha

First public release. End-to-end functional for the canonical workflows on macOS.

### Hosts

- **DaVinci Resolve** adapter — long-lived Python sidecar bridge with JSON-line wire protocol. Methods: `ping`, `get_timeline`, `add_marker`, `append_clip`, `import_timeline`, `render`. Cross-platform (macOS / Linux / Windows). Verified end-to-end via integration tests with a fake `DaVinciResolveScript` module.
- **Adobe Premiere Pro** adapter — dual-transport bridge:
  - **HTTP** (preferred) — talks to the [`@kenkaiiii/gg-editor-premiere-panel`](../gg-editor-premiere-panel/README.md) CEP extension. Required on Windows; ~10-30ms per call. Auto-detected on first use.
  - **osascript** (macOS fallback) — spawns AppleScript per call. ~200-500ms per call. Used when the panel isn't running.
  - Methods: `ping`, `get_timeline`, `add_marker`, `append_clip`, `import_timeline`. Render and razor unsupported via live API (use `write_edl` + `import_timeline`).
- **None** adapter — file-only mode for ffmpeg/whisper-only workflows.
- Auto-detection via cross-platform process scan (`detectHost()`).

### Tools (16)

- **Timeline state**: `host_info`, `get_timeline`
- **Per-clip mutations**: `cut_at`, `ripple_delete`, `add_marker`, `append_clip`
- **Bulk timeline**: `write_edl` (CMX 3600 emitter), `import_edl`, `render`
- **Media**: `probe_media`, `extract_audio`
- **Audio analysis**: `detect_silence` (ffmpeg silencedetect with frame-aligned keep-ranges)
- **Transcription**: `transcribe` (whisper.cpp local + OpenAI API fallback), `read_transcript` (filtered query of saved transcripts)
- **Take selection**: `cluster_takes` (Jaccard similarity over normalized tokens)
- **Vision**: `score_shot` (OpenAI vision API, batched, low/high detail modes)

### Output discipline

- Every tool returns either compact JSON or a one-liner. No prose filler.
- Long lists are summarized with `{total, omitted, head[], tail[]}` shape.
- Errors are one-line: `error: <cause>; fix: <next-step>`.
- Big payloads (transcripts) are written to disk; tools return summary + path.
- File-write tools return `"ok:<absolute-path>"`.

### Ink TUI

- Standalone (no ggcoder dependency).
- `<Static>` history + dynamic live area for streaming.
- Animated sparkle spinner.
- Compact tool-call rendering with status icons + truncated results.
- Slash commands: `/quit` `/exit` `/q` `/clear` `/help` `/?`.
- Auto-falls-back to readline on non-TTY (CI, piped stdin).
- `--no-tui` flag to force legacy mode.

### CLI

- Auto-detects open NLE on launch.
- Flags: `--host`, `--cwd`, `--provider`, `--model`, `--api-key`, `--no-tui`.
- One-shot mode: `ggeditor "<prompt>"`.
- Clean SIGINT shutdown — kills Python/Premiere bridges.

### Tests

- 91 tests across 13 files. All passing.

### Added in 0.1.0 (post-initial)

- **`write_fcpxml`** — FCPXML 1.10 emitter alongside the existing CMX 3600 EDL writer. Preserves clip names, frame-rational time (no 23.976/29.97 rounding loss), and multi-source asset references. Preferred over EDL for Premiere imports.
- **`pick_best_takes`** — composite tool: clusters re-takes from a transcript, then picks the winner per cluster using a strategy (`last`, `first`, or `vision`). Replaces manual orchestration of cluster_takes + score_shot + winner-picking.
- **TUI input polish** — multi-line input via Shift-Enter or trailing-backslash continuation, Up/Down history navigation (100-entry rolling buffer), Ctrl-U to clear.
- **`--dry-run` mode** — host-mutating tools (cut_at, ripple_delete, add_marker, append_clip, import_edl, render) return a `{dryRun:true,skipped:...,args:...}` sentinel instead of executing. File writes (EDL, FCPXML) and analysis tools still run normally. System prompt informs the agent of the mode so it can warn the user. Propagates through Director-Executor mode.
- **TUI footer** — running totals: turns, tool calls, input/output tokens. Optional model badge. Yellow `DRY-RUN` badge when active. Updates per `turn_end` event from the agent.
- **Slash command autocomplete** — typing `/` opens a popover above the input. Up/Down cycles matches; Tab autocompletes; Enter submits the highlighted command. Falls through to input history when the menu is closed.
- **OAuth login + shared credentials** — `ggeditor login` runs the same PKCE flow as ggcoder (Anthropic + OpenAI) or prompts for an API key (GLM / Moonshot). Credentials live in `~/.gg/auth.json` — the SAME file ggcoder uses. If you've already logged in via ggcoder, ggeditor picks those credentials up automatically with auto-refresh on expiry. No env vars, no `--api-key` flag (removed). New subcommands: `ggeditor login [--provider <p>]`, `ggeditor logout [provider]`, `ggeditor auth`.
- Resolve bridge verified end-to-end via fake `DaVinciResolveScript` integration test.

### Director-Executor mode (opt-in)

- Two-agent architecture for long sessions: Director plans, Executor runs.
- Each `delegate` spawns a fresh Executor agent with full tool access; the Director only sees a one-paragraph summary back.
- Win: 100-tool-call sessions collapse to ~5 director turns each seeing ~50-token summaries instead of accumulated tool I/O.
- Enable via `--director` CLI flag.
- Per-session caps: maxDelegations (default 20), maxExecutorTurns (default 30).

### Known limitations

- Cut/ripple-delete on Resolve genuinely unsupported by the host API; agent falls back to `write_edl` + `import_edl`.
- Render unsupported on Premiere via script (requires AME integration); use File → Export.
- Premiere on Windows requires the companion `@kenkaiiii/gg-editor-premiere-panel` package (one-time install + restart Premiere).
- Vision scoring requires `OPENAI_API_KEY`.
- Local whisper.cpp requires `modelPath` argument; falls back to OpenAI API if not set.

See [ROADMAP.md](./ROADMAP.md) for complete tracking of what's done, stubbed, and planned.
