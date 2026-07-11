---
name: release
description: Cut a full release — publish npm packages (changesets) then bump + tag the gg-app desktop build
---

You are cutting a release for this monorepo. There are **two independent release
tracks** and they must go in this order. Read this whole file, then execute.

- **Track A — npm framework packages** (`@kenkaiiii/gg-ai`, `gg-agent`, `gg-core`,
  `ggcoder`, `gg-boss`, and dependents) via **Changesets**. These are the engine the
  CLI ships from. The spine is a *fixed group* — one changeset bumps them together.
- **Track B — gg-app desktop** (`gg-app`, currently a `0.1.x` line, `private: true`,
  never on npm). Released by pushing a `v*` git tag, which triggers
  `.github/workflows/release.yml` to build/sign/notarize installers and publish a
  **non-draft** GitHub release + updater `latest.json`.

The app's CI builds the sidecar from **workspace source** (`pnpm install` resolves
`workspace:*` locally), so the desktop build does not strictly require npm to be
published first. But publishing npm first keeps the shipped CLI and app in lockstep
and is the correct order — do Track A, then Track B.

> **IRON RULE — Track A always drags Track B with it.** gg-app bundles the
> ggcoder sidecar built from the **same** spine source you just published. So if
> Track A runs, the app is now shipping changed engine code and **Track B is
> mandatory in the same release** — even when `gg-app/` itself has zero diff. The
> only release that is npm-only is one where Track A did NOT run. Never finish a
> release that bumped npm without also bumping + tagging the app. Do not ask the
> user; do not wait to be told. This is the single most-repeated miss — do not
> repeat it.

---

## 0. Auto-detect scope (don't ask — figure it out)

Decide scope by what actually changed since each track's last release. Do NOT ask
the user which tracks to run — common sense: if npm package source changed, release
npm; if the app changed, release the app. Run both detections:

**Track A (npm) needed?** Compare against the last spine tag:
```bash
LAST_NPM=$(git tag --sort=-creatordate | grep '@kenkaiiii/ggcoder@' | head -1)
# Real source/metadata changes. Ignore generated changelogs, pure tests, and a
# package.json only when its sole diff is the top-level version line.
NPM_CHANGES=$(
  git diff --name-only "$LAST_NPM" HEAD -- packages/ \
    | grep -vE 'CHANGELOG\.md$|^packages/gg-pixel/|/(src/)?.*\.test\.' \
    | while IFS= read -r file; do
        if [[ "$file" == */package.json ]]; then
          git diff --quiet -I '^[[:space:]]*"version":[[:space:]]*' \
            "$LAST_NPM" HEAD -- "$file" || printf '%s\n' "$file"
        else
          printf '%s\n' "$file"
        fi
      done
)
if [[ -n "$NPM_CHANGES" ]]; then printf '%s\n' "$NPM_CHANGES"; else echo "(no npm source changes)"; fi
```
Exclude the `gg-pixel` SDK (not on the spine), generated changelogs, pure tests,
and package manifests whose only change is version noise from the previous publish.
Dependency, export, bin, script, and other package metadata changes still trigger Track A.
If only `gg-app/` or non-package files changed, Track A is **not** needed.

**Track B (desktop) needed?** Track B is needed if **EITHER** of these is true:

1. **Track A ran** (npm spine was published). The app bundles that spine as its
   sidecar, so a spine release *always* requires a matching app release. This
   alone is sufficient — stop here and mark Track B needed.
2. `gg-app/` itself changed since the last `v*` tag:
   ```bash
   LAST_APP=$(git tag --sort=-creatordate | grep -E '^v[0-9]' | head -1)
   git diff --name-only "$LAST_APP" HEAD -- gg-app/ | grep -v '^gg-app/dist/' || echo "(no app-only changes)"
   ```

So: **Track A needed ⇒ Track B needed, period.** Track B is only skipped when
Track A did NOT run AND `gg-app/` has no diff. When Track B is triggered only by
Track A (no `gg-app/` diff of its own), still cut it — the "What's new" entry then
describes the engine wins users now get (the same changes you wrote the changeset
for).

**Bump level:** default **patch**. Use **minor** if the changes add a user-facing
feature/command/flag; **major** only for a breaking API/CLI change. Pick per track
from the diff — if genuinely ambiguous between minor and major, that's the ONE thing
worth a quick confirm; otherwise proceed without asking.

State the detected plan in one line (e.g. "Both, patch — npm: useAgentLoop fix; app:
activity-bar polish") and then run the relevant tracks. If NEITHER track changed,
stop and say there's nothing to release.

---

## 1. Pre-flight (always)

1. `git status` — the tree must be clean (everything committed). If there are
   uncommitted changes, STOP and tell the user to commit first (point them at
   `/commit`). Do not stash or commit on their behalf.
2. Confirm you're on `main` and up to date: `git rev-parse --abbrev-ref HEAD` then
   `git pull --ff-only`. If not on `main`, STOP and ask.
3. Run quality checks: `pnpm check && pnpm lint && pnpm format:check && pnpm test`.
   Fix all errors before continuing (`pnpm lint:fix` / `pnpm format` as needed).
   Any failure STOPS the release.

---

## 2. Track A — npm packages (skip if "desktop only")

1. Check pending changesets: `ls .changeset/*.md | grep -v README`.
   - If none exist, create one non-interactively: write a `.changeset/<slug>.md`
     describing the change, with frontmatter bumping the spine at the level the user
     chose, e.g.:
     ```md
     ---
     "@kenkaiiii/ggcoder": patch
     ---

     <one-line summary of what shipped>
     ```
     (Bumping any one spine member bumps the whole fixed group — do not list them all.)
2. Preview the release graph **before changesets are consumed**:
   `pnpm changeset status`. Confirm it shows the packages about to publish.
3. Apply versions + changelogs: `pnpm changeset version`. This rewrites the
   packages' `version` fields, internal deps, and changelogs, and consumes the
   changeset file.
4. Rebuild with the new versions: `pnpm build`.
5. **Commit the version bump BEFORE publishing** — `pnpm changeset publish`
   creates git tags at `HEAD`, so the bump must already be committed or the tags
   point at the wrong commit and you publish from a dirty tree. Stage the changed
   `package.json`/`CHANGELOG.md`/`.changeset` files and commit:
   `git commit -m "Version packages"` (changesets' convention).
6. Publish to npm (topological order, pnpm under the hood): `pnpm changeset publish`.
   - This also creates the per-package git tags at the commit from step 5.
7. Push the version commit + the tags changesets just created:
   `git push --follow-tags`.
8. Verify: `npm view @kenkaiiii/ggcoder version` matches the new version.

---

## 3. Track B — gg-app desktop (skip ONLY if Track A did not run AND gg-app/ had no diff)

1. Bump all four in-sync version files with the helper (never hand-edit them — they
   must match or the release ships mismatched):
   ```bash
   pnpm --filter gg-app bump <patch|minor|major|x.y.z>
   ```
   It updates `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   and `src-tauri/Cargo.lock`, and prints the new version. Capture that version as
   `NEW` (e.g. `0.1.41`).
2. **Write the "What's new" entry.** This is the single most important hand-
   written step of the desktop release. It ships in `gg-app/src/changelog.ts`
   (the `CHANGELOG` array) and is shown to every user in a celebratory window the
   first time they launch the new build. It must read like Ken hyping up his own
   product, never like a git log.

   **a. Find what actually changed since the last desktop release:**
   ```bash
   LAST_APP=$(git tag --sort=-creatordate | grep -E '^v[0-9]' | head -1)
   git log --oneline "$LAST_APP"..HEAD | grep -ivE 'version packages|update gg-app'
   git diff "$LAST_APP" HEAD -- gg-app/ packages/ | head -400   # skim the real
     # diff, not just commit subjects, to find the user-facing wins
   ```
   Read the diffs, not just the commit subjects, so you describe what the user
   can now SEE or DO, not how it was implemented. Drop pure internals (refactors,
   type fixes, build plumbing, test-only changes) unless they produce a felt win
   (faster, cheaper, fewer crashes, fewer bugs) — then sell THAT win, not the
   plumbing behind it.

   **b. Rewrite each user-facing change in Ken's voice.** The hard rules:
   - **First person, singular.** This is Ken talking straight to the user: "I"
     built / fixed / squeezed, never "we" or "the team". Address the user as
     "you".
   - **Exciting and non-technical.** Every line should make the update sound
     worth installing. Lead with the benefit the user feels, not the mechanism.
   - **No em dashes and no emojis.** Break clauses with periods, commas, or
     colons only. Keep it punchy with plain punctuation.
   - **Exactly one bullet per distinct feature.** A feature's headline, details,
     polish, reliability, and proof belong in ONE cohesive bullet. Never split one
     feature into several bullets just to make the list look longer. Use multiple
     bullets only when users can clearly do or feel different things.
   - **Highlight specifics with backticks.** Wrap 1 to 3 concrete names, controls,
     model names, commands, or meaningful numbers in backticks, for example
     `` `Autopilot` ``, `` `GPT-5.6 Ultra` ``, or `` `90 MB` ``. The app renders
     these as themed inline highlights. Highlight specifics, never whole sentences.
   - Keep each bullet punchy at roughly 1 to 3 short sentences.

   **c. Worked example** — raw commits become one feature bullet, not fragments:
   ```text
   commit subjects: "Fix enhance-animation handoff flash"
                    "Dim input while enhancer runs"
        ↓ (both are one Prompt Enhancer feature, so MERGE them)
   bullet: "The `Prompt Enhancer` now glides in glassy-smooth. I erased the
            split-second handoff flash and gently dim the input while it works.
            Pure silk."

   commit subject: "Send extended-cache-ttl beta header for 1h Anthropic cache"
        ↓ (internal-sounding, but the felt win is speed + cost)
   bullet: "Long conversations just got cheaper and snappier. I squeezed a full
            `1 hour` of smart caching out of every chat so you spend less and
            wait less."
   ```
   Match that energy: confident, warm, a little swagger, zero jargon. Before
   writing the file, compare every pair of bullets: if they describe the same
   user-facing feature, merge them.

   **d. PREPEND one new entry** to the top of the `CHANGELOG` array (newest
   first). NEVER delete or rewrite old entries — the window already caps itself
   at the 20 most-recent bullets across versions, so history just scrolls.
   ```ts
   export const CHANGELOG: ChangelogEntry[] = [
     {
       version: "<NEW>",          // the bumped version, no leading "v"
       date: "<YYYY-MM-DD today>",
       items: [
         "<feature bullet with `highlighted specifics`>",
         "<a second bullet only for a genuinely different feature>",
       ],                          // ≈1 to 5 DISTINCT feature highlights, best first
     },
     // ...every existing entry stays exactly as-is below.
   ];
   ```
   If genuinely nothing user-facing shipped (pure refactor/chore release), add a
   single honest-but-warm line rather than inventing hype, e.g. "Tuned things
   under the hood so GG Coder stays fast and stable."
3. Confirm the bump touched exactly the four version files plus the changelog:
   `git status --short gg-app/`.
4. Stage **only** those five files (never `git add -A`):
   ```bash
   git add gg-app/package.json gg-app/src-tauri/tauri.conf.json \
           gg-app/src-tauri/Cargo.toml gg-app/src-tauri/Cargo.lock \
           gg-app/src/changelog.ts
   ```
5. Commit: `git commit -m "Update gg-app to v<NEW>"`.
6. Push the commit: `git push`.
7. Tag and push the tag (this is what fires the release workflow):
   ```bash
   git tag v<NEW>
   git push origin v<NEW>
   ```
8. Confirm the build kicked off: `gh run list --workflow=release.yml --limit 1`.

---

## 4. Report back

Summarize what shipped, bottom line first:
- npm: which packages + version (or "skipped").
- desktop: `v<NEW>` tag pushed, release workflow run id + that it publishes a
  **non-draft** release automatically (no manual publish step).
- Give the user the watch command: `gh run watch <run-id>`.

Never pause for confirmation between steps once scope is chosen — run the whole
release through.
