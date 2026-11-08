# preview, play, render, publish

Serve, render, and share commands.

## preview

```bash
hf preview                   # foreground on a TTY; persistent in agent shells
hf preview --background      # explicit persistent session
hf preview --foreground --json # ready JSON, then remain attached
hf preview --background --port 4567 # agent-safe custom port (default 3002)
hf preview --selection --json # print the current Studio selection and exit
hf preview --context --json  # print compact agent context from Studio
```

Hot-reloads on file changes. Opens Studio in the browser automatically — the full timeline editor, where the user can play the video and edit anything by hand before rendering. This is the review surface, not just a viewer.

When handing a project back to the user, use the Studio project URL, not the source `index.html` path:

```text
http://localhost:<port>/#project/<project-name>
```

Use the actual port and project directory name; treat `index.html` as source-code context, not the preview surface. For example, after `hf preview --background --port 3017` in `codex-openai-video`, report `http://localhost:3017/#project/codex-openai-video`.

Two ways a handed URL turns out dead — check both before handing it back: the URL is missing its `#project/<project-name>` hash (Studio loads but has no project to open), or the server is not actually running. Bare `preview` automatically creates a managed persistent session in a non-TTY agent shell; `--background` remains the clearest explicit form. Verify the printed URL returns HTTP 200, keep it alive for the whole review, and stop it explicitly with `hf preview --stop` afterward. Use the printed URL as-is: HyperFrames URL-encodes project names that contain route metacharacters.

### Agent context from Studio selection

`preview --context` and `preview --selection` are the agent bridge into a running Studio session. They do **not** start a new server; they find the active preview server for the current project, read agent-useful state from Studio, print it, and exit.

Use it when the user gives deictic edit instructions like "change this", "move the selected element", "make the card I clicked bigger", or "fix the current selection":

```bash
hf preview --context --json --context-fields selection
```

The compact context payload includes the selected element's source file, composition path, current timeline time, `data-hf-id` / selector target, bounding box, text content, and a thumbnail URL for the selected element. Prefer `selection.target.hfId` when present; fall back to `selection.target.selector` only when no stable `data-hf-id` exists. If `selection` is `null`, inspect `errors.selection.code` (for example, `no-selection`).

Keep agent context small by asking only for the slices you need:

```bash
hf preview --context --json --context-fields selection
hf preview --context --json --context-fields lint
hf preview --context --json --context-fields selection,lint
```

Use `--context-detail full` only when the edit genuinely needs heavy selection fields such as `computedStyles`, `inlineStyles`, `dataAttributes`, or editable text-field metadata:

```bash
hf preview --context --json --context-fields selection --context-detail full
```

`preview --selection --json` remains available when you explicitly want the full selected-element payload and do not need lint/server context.

Failure modes:

| Code                       | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `preview-not-running`      | Start Studio first with `hf preview --background`.                         |
| `ambiguous-preview-server` | Multiple matching Studio servers are open; rerun with one listed `--port`. |
| `preview-port-mismatch`    | The requested `--port` is not one of the matching Studio servers.          |
| `no-selection`             | Studio is open, but the user has not selected an element yet.              |
| `selection-unavailable`    | The running preview server does not expose selection context cleanly.      |

If there is no selection, ask the user to click the target element in Studio and rerun the command. If the server error lists candidate ports, rerun the same command with `--port <candidate>`. Do not infer the target from a screenshot when the CLI can give a stable element target.

## play (lightweight player)

```bash
hf play                  # current project, port 3003
hf play ./my-video       # specific project
hf play --port 8080      # custom port
```

`play` serves the composition through the embeddable `<hyperframes-player>` web component instead of the full Studio UI. Use it when sharing a preview link or when Studio is heavier than needed (no editor, no panels). `play` reports the plain `http://localhost:<port>` URL — no `#project/<name>` fragment (that's a Studio routing convention only `preview` uses).

The player's `playback-rate` attribute (preview speed control, drives the timeline's `timeScale`) is clamped to `[0.1, 5]`; values `≤ 0` or non-finite fall back to `1`. This is a preview/playback knob, not a composition `data-*` attribute — authored motion still renders at `1×`.

### Launching with an external browser (preview + play)

Both `preview` and `play` can open inside an explicit Chromium-compatible browser instead of the OS default. Two use cases: isolated Chromium profile, or external CDP attach (DevTools / Playwright / Puppeteer / browser-MCP). **HyperFrames itself does not own CDP automation** — this only exposes the endpoint; whatever connects to it is your problem. Not to be confused with `--browser-gpu` (a `render` flag controlling Chrome GPU access during capture).

| Flag                      | Type            | Notes                                                                                                                                                                                           |
| ------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--browser-path`          | path            | Absolute path to a Chromium-compatible executable (`/usr/bin/chromium`, `/Applications/Brave Browser.app/...`).                                                                                 |
| `--user-data-dir`         | path            | Chromium-compatible profile directory. Requires `--browser-path`. Use a throwaway directory to keep state out of your main profile.                                                             |
| `--remote-debugging-port` | integer 1-65535 | Open a Chromium CDP endpoint on the given port. **Requires both** `--browser-path` and `--user-data-dir` — refused otherwise, so a CDP endpoint cannot leak into your main profile by accident. |

```bash
# Open preview in an isolated Chromium profile
hf preview --background --browser-path /usr/bin/chromium --user-data-dir /tmp/hf-profile

# Same plus a CDP endpoint on :9222 (attach DevTools / Playwright / etc.)
hf play --browser-path /usr/bin/chromium --user-data-dir /tmp/hf-profile --remote-debugging-port 9222
```

Validation runs before any server boots, so an invalid value exits cleanly without leaving a listening socket behind.

## render

> A clear video request authorizes a new, versioned local render. Preview is available when useful, not a mandatory approval checkpoint. Ask only for unresolved inputs, material choices or permission to overwrite an existing export. The final render screens itself for harmful flashing.

```bash
hf render                                # standard MP4 from cwd
hf render ./my-video --output ./out.mp4  # render from outside the project dir
hf render --output final.mp4             # named output (no timestamp)
hf render -c compositions/intro.html -o intro.mp4  # render a specific sub-composition file
hf render --quality draft                # fast iteration
hf render --quality looks                # first real encode (default)
hf render --fps 60 --quality delivery    # final delivery
hf render --format webm                  # transparent WebM
hf render --docker                       # byte-identical
```

> Default `--output` is `renders/<project-name>_<YYYY-MM-DD>_<HH-MM-SS>.<ext>` — timestamped per render so successive runs don't clobber each other. Pass `--output` to get a stable name.

| Flag                                 | Options                                                                                            | Default                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir` (positional)                   | path                                                                                               | cwd                            | Project directory. Omit to use current working directory.                                                                                                                                                                                                                                                                                                                                                                                     |
| `--composition`, `-c`                | path to composition file                                                                           | `index.html`                   | Render a specific composition file (e.g. `compositions/intro.html`) instead of the project's `index.html`.                                                                                                                                                                                                                                                                                                                                    |
| `--output`, `-o`                     | path                                                                                               | `renders/<project>_<ts>.<ext>` | Output path. Default is timestamped (`<project-name>_YYYY-MM-DD_HH-MM-SS.<ext>`).                                                                                                                                                                                                                                                                                                                                                             |
| `--fps`                              | 24, 30, 60                                                                                         | 30                             | 60fps doubles render time                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--quality`                          | draft, looks, delivery, standard, high                                                             | looks                          | `looks` is CRF 16 on the standard preset. `delivery` is `high`. draft for iterating                                                                                                                                                                                                                                                                                                                                                           |
| `--format`                           | mp4, webm, mov, gif, png-sequence, hls                                                             | mp4                            | WebM/MOV render with transparency; gif for inline autoplay in GitHub PRs/READMEs/docs (two-pass palette encode, fps capped at 30 — prefer `--fps 15` — no audio, 1-bit transparency only, HDR falls back to SDR); png-sequence writes RGBA frames to a directory (AE/Nuke/Fusion ingest); hls writes an HLS VOD directory (master.m3u8 + video/audio playlists + MPEG-TS segments), SDR only, rejects `--gpu`, unavailable on lambda/cloudrun |
| `--gif-loop`                         | 0-65535                                                                                            | 0                              | GIF loop count; `0` loops forever. Only with `--format gif`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `--hls-segment-seconds`              | 1-60                                                                                               | 4                              | HLS target segment length in whole seconds; also locks the encoder GOP so every segment starts on a keyframe. Only with `--format hls`.                                                                                                                                                                                                                                                                                                       |
| `--resolution`                       | landscape, portrait, landscape-4k, portrait-4k, square, square-4k (+ aliases `1080p`, `4k`, `uhd`) | —                              | Supersample via Chrome `deviceScaleFactor`. Aspect ratio must match composition; scale must be an integer. Not with `--hdr`.                                                                                                                                                                                                                                                                                                                  |
| `--crf`                              | 0-51                                                                                               | —                              | Encoder CRF (lower = higher quality). Mutually exclusive with `--video-bitrate`.                                                                                                                                                                                                                                                                                                                                                              |
| `--video-bitrate`                    | e.g. `10M`, `5000k`                                                                                | —                              | Target bitrate. Mutually exclusive with `--crf`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `--hdr`                              | flag                                                                                               | off                            | Force HDR output even with SDR sources. MP4 only.                                                                                                                                                                                                                                                                                                                                                                                             |
| `--sdr`                              | flag                                                                                               | off                            | Force SDR even with HDR sources.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--workers`                          | number or `auto`                                                                                   | auto                           | Each worker spawns Chrome (~256 MB)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--docker`                           | flag                                                                                               | off                            | Reproducible output across hosts                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--gpu`                              | flag                                                                                               | off                            | GPU-accelerated FFmpeg encoding (NVENC / VideoToolbox / VAAPI / QSV)                                                                                                                                                                                                                                                                                                                                                                          |
| `--browser-gpu` / `--no-browser-gpu` | flag                                                                                               | auto (local), off (docker)     | Host GPU for Chrome/WebGL capture                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--browser-timeout`                  | seconds (0.001–86400)                                                                              | 60                             | Puppeteer page-navigation timeout for the entry HTML. Raise when heavy compositions (many videos / fonts / remote assets) can't reach `domcontentloaded` within the 60s default.                                                                                                                                                                                                                                                              |
| `--quiet`                            | flag                                                                                               | off                            | Suppress verbose output                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--strict`                           | flag                                                                                               | off                            | Fail on lint errors                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--strict-all`                       | flag                                                                                               | off                            | Fail on lint errors AND warnings                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--variables`                        | JSON object                                                                                        | —                              | Override values declared in `data-composition-variables`                                                                                                                                                                                                                                                                                                                                                                                      |
| `--variables-file`                   | path                                                                                               | —                              | JSON file with variable values (alternative to `--variables`)                                                                                                                                                                                                                                                                                                                                                                                 |
| `--strict-variables`                 | flag                                                                                               | off                            | Fail render on undeclared keys or type mismatches in `--variables`                                                                                                                                                                                                                                                                                                                                                                            |

**Quality guidance:** `draft` while iterating, `looks` (the default) for the first real encode, `delivery` for final delivery. `standard` and `high` still work.

**Read the summary's second line.** After the output path and size, `render` prints the capture path, GPU mode, and per-stage timings, e.g. `beginframe capture · software gpu · compile 0.7s · setup 1.1s · capture 8.1s · encode 5.8s`. `capture` is the frame loop and `setup` is calibration plus session init; the capture path reads `a|b` when parallel workers diverged, and `encode (during capture)` means the streaming encoder overlapped the loop, so do not add it to the wall time. Local GPU `auto` (the default) requests BeginFrame. If the line still says `screenshot capture` with `software gpu` on Linux, a hint under it says BeginFrame did not run (needs chrome-headless-shell, no `--resolution` upscale). It only appears when the GPU was auto-probed, never under `--docker` or `--no-browser-gpu`, where software GL is the point. Heavy compositions can stall on software GL. Do not reach for `--debug` just to learn which path ran.

**Parametrized renders:** the composition declares its variables on the `<html>` root with **`data-composition-variables`** — a JSON **array of declarations** (`{id, type, label, default}` per entry) that defines the schema. Scripts inside read the resolved values via `window.__hyperframes.getVariables()`. The CLI `--variables '{"title":"Q4 Report"}'` is a JSON **object keyed by id** that overrides those declared defaults for one render; missing keys fall through, so the same composition runs unchanged in dev preview and in production. Sub-comp hosts can also override per-instance with `data-variable-values`. See the `hyperframes-core` skill for the full pattern.

## GG delivery boundary

Keep renders and diagnostics local. Feedback submission, issue filing, publishing
and cloud rendering are not automatic completion steps. They require explicit
user authorization; do not send source files, private assets or logs upstream.
Use GG's `reveal.mjs` to select the delivered local file.
