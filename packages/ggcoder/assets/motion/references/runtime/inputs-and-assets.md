# GG runtime inputs and assets

This is implementation support, not a creative workflow. Bind approved text,
fonts, colours, logos and media without adding a second look-selection process.

`hf` in these references is shorthand for the exact bundled launcher command
in the system prompt; expand it, never run bare `hf` or `npx hyperframes`.
`<node>` and `<motion bin>` also come from that prompt. No self-updates,
package installs, cloud rendering or publishing without explicit permission.

## Local inputs

- Keep original captures/uploads in `sources/`; use local `assets/` for the
  files consumed by the composition. Never overwrite originals or finished renders.
- A reusable kit lives at `brand-kits/<slug>/Motion.md` in the Motion workspace.
  Keep it read-only for ordinary video work; preserve legacy briefs rather than
  duplicating plans.
- A longer title or a different aspect ratio calls for a deliberate layout adjustment, not a silent
  crop.
- Root output duration is a static composition contract. If an input changes
  the duration, update the authored root explicitly; a runtime variable cannot
  silently change the compiled video length.

## Existing helpers (only when needed)

```sh
<node> "<motion bin>/fonts.mjs" list
<node> "<motion bin>/fonts.mjs" add <project> <Family>...
<node> "<motion bin>/pdf-extract.mjs" <file.pdf> <output-dir>
<node> "<motion bin>/three.mjs" add <project>
<node> "<motion bin>/library.mjs" list
<node> "<motion bin>/reveal.mjs" <delivered-file>
```

Inspect helper help for less common operations; do not guess options. Fonts,
Three.js and library assets remain available offline, but their existence does
not require using them. Respect actual licenses and required brand typography.

`fonts.mjs add` returns `head`: a `<style>` block of `@font-face` rules with
paths from the project folder. Paste it into the composition `<head>`.
`hf check` only recognises fonts declared in the page, so linking
`assets/fonts/fonts.css` instead renders fine but is reported as missing fonts.

GSAP loads from the pinned CDN script in
[minimal-composition](minimal-composition.md). There is no local copy in the
bundle; do not search for one or copy one from another project.

Shared music and SFX are at `../../assets/music/` and `../../assets/sfx/` relative
to this document. Upstream metadata can retain historical `skills/brag/` paths;
resolve its filenames under these shared asset roots, not the removed skill.
Those provenance notes are not instructions to invoke an old workflow.
Preserve credits, cue maps and SFX analysis. Copy only used
assets into the video project. The plan or user determines whether
sound belongs in the video; do not automatically add music or hits.

Request permission before installing missing FFmpeg/browser software. Never
upload user files to resolve a local blocker.
