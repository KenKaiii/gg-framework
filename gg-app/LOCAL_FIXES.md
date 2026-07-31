# Preserving Local Fixes Across App Updates

Official GG App updates replace the installed binary and cannot preserve source-only fixes from this checkout. A local-patched build still checks the official release feed, but routes installation through this repository instead of installing the official binary directly.

## Protected checkout

Local-patched mode auto-detects the canonical `custom/local-customizations` branch, the temporary `custom/local-customizations-v2` cutover branch, and the configured fork origin. Detection fails closed when Git metadata is unavailable; set `VITE_GG_LOCAL_PATCHED=1` and `VITE_GG_SOURCE_ROOT=<repo>` explicitly for detached or exported builds.

The updater accepts `custom/local-customizations` by default and temporarily accepts `custom/local-customizations-v2` during the cutover. `custom/local-customizations-safety` is a read-only reference and is never an update target. Use `--allow-other-branch` only for an intentional branch override.

## Update local fixes

From the repository root:

```bash
git switch custom/local-customizations
pnpm --filter gg-app update:local-fixes -- --check
```

The workflow defaults to `upstream/main` and:

1. Rejects unresolved conflicts and in-progress Git operations.
2. Records the source/fork OIDs, commit range, tracked patch, and dirty status in a timestamped manifest under `.gg/local-fixes/backups/`.
3. Fetches `upstream/main` and `origin/custom/local-customizations`.
4. Creates `gg-local-before-update-*` at the old `HEAD` before rebasing.
5. Stashes tracked and untracked work and records the stash OID.
6. Rebases every local commit onto the fetched upstream target, retaining cherry-picks and empty commits.
7. Applies dirty work without dropping its stash, then verifies the commit sequence and saves a `range-diff`.
8. Verifies Supah Coder branding, the `GG Coder` native identity, official update discovery, source-update routing, and four-file version lockstep.
9. Runs required checks and builds a fresh Windows NSIS installer with a recorded SHA-256.
10. Retains the backup branch. The app never pushes; CLI push requires an explicit exact-OID lease.

Preview the exact plan without mutation:

```bash
pnpm --filter gg-app update:local-fixes -- --dry-run --no-install --no-build
```

Useful overrides:

```bash
pnpm --filter gg-app update:local-fixes -- --remote upstream --branch main
pnpm --filter gg-app update:local-fixes -- --no-install --no-build --no-check
pnpm --filter gg-app update:local-fixes -- --allow-other-branch --no-build --no-check
```

## Conflict recovery

A rebase conflict, dirty-work restore conflict, identity drift, changed commit sequence, or failed check stops before build and push. The backup branch and recorded stash remain available. Follow the printed manifest instructions, then:

```bash
git status
git add <resolved-files>
git rebase --continue
# Apply the printed stash OID only when the updater says dirty work was not applied.
git stash apply <printed-stash-oid>
pnpm --filter gg-app check
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter gg-app build:local-patched
```

Follow the manifest's `phase` and `dirtyWorkApplied` fields before touching the stash. To recover instead, run `git rebase --abort` and use the printed backup branch, stash OID, manifest, byte-for-byte worktree backup, or patch path. The stash is dropped only after successful verification and restoration.

## Build a local-patched installer

```bash
pnpm --filter gg-app build:local-patched
```

`build:local-hotfix` remains an alias. The protected updater currently requires Windows and verifies a newly written NSIS `.exe` under `src-tauri/target/release/bundle/nsis`; `.gg/local-fixes/latest-installer.json` records its path, size, timestamp, and SHA-256.

## Verified fork push

App-triggered updates never push. After reviewing the backup manifest, `range-diff`, checks, and installer hash, an operator may rerun the CLI flow with `--push`. The updater captures the fork branch's exact pre-rebase OID and uses only:

```bash
git push --force-with-lease=refs/heads/custom/local-customizations:<captured-origin-oid> \
  origin HEAD:refs/heads/custom/local-customizations
```

A concurrent fork update makes the lease fail. Plain `--force`, pushes to `upstream`, noncanonical branches, skipped checks, and skipped builds are rejected.
