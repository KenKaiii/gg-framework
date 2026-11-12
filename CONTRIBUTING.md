# Contributing to GG Coder

Thanks for helping out. Bug reports, ideas, docs fixes and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** [open an issue](https://github.com/KenKaiii/gg-framework/issues/new/choose) using one of the templates. Search existing issues first.
- **Security problems:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first so we can agree on the approach before you put time into it.
- **First time?** Look for issues labelled [`good first issue`](https://github.com/KenKaiii/gg-framework/labels/good%20first%20issue).

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 22+, pnpm 10 (the version comes from `packageManager` in `package.json`), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the desktop app. Some tests also need `ffmpeg`/`ffprobe` (Motion media checks) and `lsof` (macOS/Linux). They skip with a note when these are missing locally; CI installs them and runs every test.

```bash
git clone https://github.com/KenKaiii/gg-framework.git
cd gg-framework
pnpm install
pnpm build
pnpm --filter gg-app tauri dev
```

The desktop app in dev mode loads the engine from `packages/ggcoder/dist/`, so run `pnpm build` again (and restart the app) after changing anything under `packages/`. Changes in `gg-app/src` hot-reload.

## Where things live

| Path                 | What it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `gg-app/`            | The desktop app: React UI and the Rust (Tauri) shell              |
| `packages/gg-ai/`    | AI provider connections and streaming                             |
| `packages/gg-agent/` | The agent loop and tool running                                   |
| `packages/gg-core/`  | Models, auth, local models and other shared pieces                |
| `packages/ggcoder/`  | Sessions, tools, prompts, the CLI and the engine the app talks to |

Read [CONTEXT.md](CONTEXT.md) for the project's vocabulary before naming new things. The desktop app is the main product, so user-facing changes need to work there, not only in the CLI.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change focused on one thing. Follow the style of the code around it.
3. Add or update tests. Bug fixes should come with a test that fails without the fix.
4. Run the checks:

   ```bash
   pnpm lint
   pnpm check
   pnpm format:check
   pnpm test
   ```

5. If your change affects a published package (`gg-ai`, `gg-agent`, `gg-core` or `ggcoder`), add a changeset with `pnpm changeset` and describe the change for users.
6. Open a pull request and fill in the template.

## Versioning

The published packages share one version and follow [semantic versioning](https://semver.org/). When you add a changeset, pick the bump by its effect on code that uses the packages:

- **patch:** bug fixes and internal changes, with no change to the public API.
- **minor:** new features or options that existing code keeps working with.
- **major:** a breaking change to the public API (removed or renamed exports, changed signatures or behaviour callers rely on).

Model list updates and prompt changes are patch or minor, never major.

Each changeset becomes a changelog entry, so keep it readable:

- One change per changeset. Run `pnpm changeset` again for a second change rather than listing several in one entry.
- Select only the packages the change touches. The others still get the version bump, without an entry of their own.
- Write one or two sentences from the user's point of view: what changed and why it matters, not how it was done.

CI runs on Linux, macOS and Windows, and all three must pass. Don't skip or disable tests to get it green, and don't commit with `--no-verify`. On Windows, files used by a running process can't be deleted, so tests that start processes should wait for them to exit before cleaning up.

## License

GG Coder is licensed under [AGPL-3.0-only](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
