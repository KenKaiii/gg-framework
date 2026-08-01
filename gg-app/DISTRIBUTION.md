# gg-app distribution (macOS / Windows / Linux)

How the packaged desktop app ships and runs identically on all three OSes — not
just under `pnpm tauri dev`.

## The bundling model

A packaged gg-app must launch from Finder / Explorer / a file manager with **no
Node on the user's PATH** and reach the project picker. Two things are bundled
to make that work:

1. **A per-platform Node runtime** (`scripts/stage-node.mjs`). Downloads the
   official standalone Node build for the build machine's platform/arch and
   stages it as a Tauri [`externalBin`](https://v2.tauri.app/develop/sidecar/)
   at `src-tauri/binaries/ggnode-<target-triple>(.exe)`. Tauri copies it next to
   the app executable at bundle time. We **download** rather than copy
   `process.execPath` because package-manager Node (e.g. Homebrew) is
   dynamically linked to `libnode.dylib` and is not self-contained; official
   nodejs.org builds link only against system libraries. Pin/override with
   `GG_NODE_VERSION`, or skip the download with `GG_NODE_SOURCE=<path>`.

2. **A single-file sidecar bundle** (`scripts/bundle-sidecar.mjs`). esbuild
   bundles `packages/ggcoder/dist/app-sidecar.js` → `src-tauri/sidecar/app-sidecar.mjs`
   (ESM, `platform=node`) and ships it under `bundle.resources`. Bundled default
   skills are copied into `src-tauri/sidecar/skills/` so every installed app can
   discover them without a user-local setup step. Native / heavy optional packages
   can't be inlined, so they are marked `external` and copied verbatim (with their
   dependency trees, pnpm symlinks dereferenced) into
   `src-tauri/sidecar/node_modules/`.

At runtime the Rust shell resolves both from the bundle in production and falls
back to the workspace in dev (`src-tauri/src/lib.rs`, `resolve_node` /
`resolve_sidecar`): a debug build, or `GG_NODE_BIN` / `GG_SIDECAR_PATH` being
set, keeps the dev PATH/workspace behavior.

### Excluded / external packages

Marked `external` and copied next to the bundle:

- `sharp` — native image codec (**required**; its platform `@img/sharp-*` binary
  is copied for the build OS/arch).
- `@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm` — used by
  web-fetch HTML→markdown.
- `unpdf` — PDF text extraction.
- `playwright`, `@huggingface/transformers`, `ogg-opus-decoder` — heavy optional
  deps that are **lazy-loaded** and degrade gracefully if a platform variant is
  absent.

Because each OS/arch bundle is built on its own CI runner, the copied `sharp`
binary always matches the target. Other-platform `@img/sharp-*` variants are
correctly skipped (they don't exist on the build machine).

## Build & verify locally

```bash
pnpm --filter @kenkaiiii/ggcoder... build   # produce dist/app-sidecar.js
pnpm --filter gg-app stage:node             # download + stage the Node runtime
pnpm --filter gg-app bundle:sidecar         # esbuild bundle + copy externals
node gg-app/scripts/smoke-sidecar.mjs       # boot bundled node + sidecar, hit /state
pnpm --filter gg-app tauri build            # full installer
```

Stage the runtime + sidecar **before** `tauri build` (as above). The Tauri
`beforeBuildCommand` is only `pnpm build` (the frontend) — it deliberately does
NOT run `prebundle`, because on macOS the nested binaries are code-signed
between staging and bundling (see below); re-staging inside the build would
overwrite those signatures with unsigned files.

### macOS code signing of nested binaries

Apple notarization requires every embedded Mach-O (the staged Node runtime and
the sidecar's native addons: sharp, libvips, onnxruntime, fsevents) to carry a
Developer ID signature + secure timestamp + hardened runtime. Tauri signs the
app shell and the `externalBin` it knows about, but not arbitrary
`bundle.resources`, so the release workflow runs `scripts/sign-nested-macos.sh`
between cert import and `tauri build` to deep-sign them. The app shell + Node
runtime get the JIT / library-loading entitlements in
`src-tauri/entitlements.plist` (referenced from `bundle.macOS.entitlements`) —
without them a hardened-runtime Node crashes at launch.

## Window chrome

`titleBarStyle: Overlay` + `hiddenTitle` are macOS-only and are applied at
runtime in Rust (`window_chrome()` / `apply_mac_overlay`), not in the shared
`tauri.conf.json`. Windows/Linux keep native decorations. The webview tags
`<html>` with `platform-macos|windows|linux` (`src/platform.ts`) so the mac
traffic-light insets in `App.css` only apply on macOS — no dead left gutter or
top offset on Windows/Linux.

## Release pipeline

`.github/workflows/release.yml` runs on a `v*` tag: a matrix (`macos-14` arm64,
`windows-latest`, `ubuntu-latest`) stages node + sidecar, smoke tests, then
`tauri-apps/tauri-action` bundles, signs the updater artifacts, uploads them to
a draft GitHub release, and generates `latest.json` for the updater endpoint in
`tauri.conf.json`. Linux builds `deb` + `rpm` (AppImage is skipped — its
`linuxdeploy` step reliably hangs on CI for Node-bundling apps).

Platform coverage: Apple Silicon macOS (signed + notarized), Windows
(NSIS `.exe` + `.msi`), and Linux (`deb`/`rpm`). Intel macOS is intentionally
not built — see the matrix comment in `release.yml`.

`.github/workflows/ci.yml`'s `app` job exercises the same cross-OS spawn path on
every push/PR (stage + bundle + smoke + `cargo test`) without a full bundle.

### Required secrets

Updater signing (every OS):

| Secret                               | Purpose                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | minisign private key for updater signatures. **Must match** `plugins.updater.pubkey` in `tauri.conf.json`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for that key.                                                                                     |

If the updater key is lost, rotate both the key and the `pubkey` in
`tauri.conf.json` (old installs won't auto-update across the rotation).

macOS code signing + notarization (only consumed by the macOS matrix legs;
leave unset to ship an unsigned build — the workflow stays green):

| Secret                       | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of the exported **Developer ID Application** `.p12`.                |
| `APPLE_CERTIFICATE_PASSWORD` | the password chosen when exporting that `.p12`.                            |
| `APPLE_SIGNING_IDENTITY`     | full identity name, e.g. `Developer ID Application: NAME (396M7LY29W)`.    |
| `KEYCHAIN_PASSWORD`          | any throwaway password for the ephemeral CI keychain.                      |
| `APPLE_ID`                   | Apple ID email used for notarization.                                      |
| `APPLE_PASSWORD`             | an **app-specific** password for that Apple ID (not the account password). |
| `APPLE_TEAM_ID`              | Apple Team ID — `396M7LY29W`.                                              |

## macOS signing setup (one-time)

1. **Create a Developer ID Application certificate.** On your Mac, Keychain
   Access → Certificate Assistant → _Request a Certificate From a Certificate
   Authority_ to make a CSR. In the Apple Developer portal
   (Certificates, IDs & Profiles) create a **Developer ID Application**
   certificate, upload the CSR, download the `.cer`, and open it to install
   into your login keychain.
2. **Find the identity string:**
   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: NAME (396M7LY29W)"  → APPLE_SIGNING_IDENTITY
   ```
3. **Export the cert to a `.p12`** (Keychain Access → My Certificates →
   right-click the cert → Export), set a password (→ `APPLE_CERTIFICATE_PASSWORD`),
   then base64 it:
   ```bash
   openssl base64 -A -in cert.p12 -out cert-base64.txt   # contents → APPLE_CERTIFICATE
   ```
4. **App-specific password for notarization.** appleid.apple.com → Sign-In and
   Security → App-Specific Passwords → generate one (→ `APPLE_PASSWORD`). Never
   commit it; store it only as a GitHub secret. If one leaks, revoke and
   regenerate.
5. **Add all seven secrets** under repo Settings → Secrets and variables →
   Actions, then push a `v*` tag to trigger the release.

> Notarization uses the Apple ID path (`APPLE_ID` + `APPLE_PASSWORD` +
> `APPLE_TEAM_ID`). To switch to the App Store Connect API key path instead, set
> `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH` and drop the
> Apple ID trio.

## Follow-ups (not blocking functionality)

- **Windows code signing** — unsigned installers trigger SmartScreen. Add an
  Authenticode cert + signing step.
