# Supply Chain & Build Integrity

A03:2025 is Software Supply Chain Failures — promoted because this is now the dominant compromise route for small teams. Your dependencies, your CI, and your release pipeline are all code you ship, written by people you have not met.

Snapshot 3 October 2026. **[V]** verified, **[S]** volatile, **[U]** uncertain.

## Adding a dependency

Before adding any package — and **especially** one you or a model produced from memory:

1. **Confirm it exists and is the one you mean** — query the registry (`npm view <name>`, `pip index versions <name>`) before writing the install command. In a USENIX Security 2025 study, 19.7% of model-recommended packages did not exist and 43% of invented names recurred on every rerun [V]; squatters register them (slopsquatting). An agent removes the human "does that name look right" check, so the check is yours.
2. **Check identity, not vibes:** registry age, download history, repository link that actually resolves, maintainer with other work, a version history that is not a single `0.0.1`. New package + high download count + no history is the squat signature.
3. **Check character-level lookalikes** against the package you meant: hyphen vs underscore, singular vs plural, scoped vs unscoped, `-js` suffix, homoglyphs.
4. **Prefer what is already in the project.** The safest dependency is the one you do not add. For a few dozen lines, write the code.
5. **Pin it.** Exact version in the manifest, lockfile committed, and for containers and Actions pin by digest or commit SHA.
6. **Let it age.** Malicious worm versions were typically pulled within hours, so a cooldown blocks most of them. Set one [S]: npm ≥ 11.10 `min-release-age=<days>` in `.npmrc`; pnpm ≥ 10.16 `minimumReleaseAge` (minutes; defaults to 1440 from v11); Yarn ≥ 4.10 `npmMinimalAgeGate`. Exempt a version only to take an urgent security fix.

## Install-time execution

`preinstall`/`postinstall` scripts run arbitrary code with full developer privileges before anything is reviewed, with access to your registry tokens, cloud credentials, source, and filesystem [V]. This is the mechanism behind the worm lineage.

- **npm ≥ 12** (8 Jul 2026) [V] blocks dependency `preinstall`/`install`/`postinstall`, implicit `node-gyp` builds, and git/remote-URL dependencies by default; approve per package in `allowScripts`. A blocked script only **warns and exits 0** — add `strict-allow-scripts=true` [S] so CI fails loudly.
- **pnpm ≥ 10** blocks dependency scripts by default; allowlist builders explicitly. On older npm: `ignore-scripts=true` plus manual builds.
- Review every change to the script allowlist like a code change.
- In CI, install with a frozen lockfile (`npm ci`, `pnpm install --frozen-lockfile`) in a job with no cloud credentials and no `id-token: write`.

## Publishing your own package

If others install your code, you are their supply chain.

- **npm state of play** [V]: classic tokens were permanently revoked on 9 Dec 2025; `npm login` now yields 2-hour session tokens; granular write tokens enforce 2FA by default (Bypass-2FA is opt-in) and are capped at 90 days. npm intends to end direct publishing with Bypass-2FA tokens around Jan 2027 [U].
- **Trusted publishing (OIDC) instead of stored tokens.** A token in CI is the exact asset every worm enumerates. But OIDC alone did not stop TanStack or ChainDrop: put `id-token: write` only on the publish job, never in a job that runs PR code or restores a cache a PR could have written.
- **Staged publishing** (GA 22 May 2026, npm CLI ≥ 11.15.0) [V]: CI uploads to a stage queue and a maintainer approves with 2FA; since Sep 2026 approval waits for npm's malware scan. For a solo maintainer, this is the single best publish control — a stolen CI identity can stage but not release.
- 2FA on the registry and source-control accounts, phishing-resistant (passkey/security key) where possible.
- Generate provenance/attestations — but **provenance proves where an artifact was built, not that the build was honest.** Both 2026 worms shipped valid provenance [V].
- Verify what is in the tarball before it ships: `npm pack --dry-run` or equivalent. Ship no source maps, no `.env`, no test fixtures, no internal docs. A source-map leak has already exposed a major product's source [S].
- Review the diff of every release, including dependency bumps. Maintainer-account compromise is the entry point in most of these incidents; a second pair of eyes on the release commit is the cheapest control.

## CI/CD

The highest-value target, because CI holds every credential at once — 59% of machines compromised in one worm forensic study were CI runners, not laptops [V].

| Control | Check |
|---|---|
| **Pin actions by SHA** | `uses: org/action@<40-char-sha>`. A version tag is mutable: the 2025 `tj-actions/changed-files` compromise retroactively repointed its tags at malicious code [S] |
| **Least-privilege token** | An explicit `permissions:` block, default `contents: read`, elevated only in the job that needs it |
| **Enforce pinning** | Repo/org setting: Actions policy → require full-SHA pins (fails unpinned workflows; available since Aug 2025) [V]. Let Dependabot bump the SHAs |
| **`pull_request_target` / `workflow_run`** | Avoid them. These run with the base repo's token, secrets, and default-branch cache access [V]. Since 8 Dec 2025 the workflow always comes from the default branch [V], and current `actions/checkout` refuses fork-PR head refs under `pull_request_target` (backported 16 Jul 2026 to floating major tags only — **SHA-pinned checkouts must be bumped to get it**) [V]. Never check out or run PR code there |
| **Cache poisoning** | Any job that runs untrusted code must not save caches the release job restores; key release caches separately or skip caching in release. This was TanStack's initial access [V] |
| **OIDC scope** | `id-token: write` only on the deploy/publish job; cloud trust policies pinned to repo + branch/environment, not just the org |
| **Script injection** | Never interpolate `${{ github.event.* }}` (titles, branch names, comment bodies) directly into a `run:` block. Pass through `env:` and quote |
| **Secret hygiene** | No secrets echoed, no `set -x` around them, masked in logs, scoped per environment, rotated on any suspicion |
| **Runners** | Prefer ephemeral. A reused self-hosted runner leaks state between jobs, including from forks |
| **Branch protection** | Required review on the release branch, signed commits where feasible, no force-push |

## Consuming other people's code beyond packages

- **Editor extensions**: lookalike-name campaigns recur [U]; extensions auto-update and registry removal does not clean installed copies. Check publisher identity, install history, and repository link — not the display name.
- **MCP servers**: the first in-the-wild malicious server, `postmark-mcp`, cloned the official server under the same npm name and added a silent BCC in its 16th release [V]. Install from the official registry with signing and verification where possible; pin versions; review the tool list after every update. See `agent-surface.md`.
- **Container base images**: pin by digest, scan, prefer minimal or distroless, rebuild regularly rather than pinning to a stale digest forever.
- **Model artifacts**: signed and verified at load, code-capable formats rejected, dataset revisions pinned by hash. See the ML section of `platform-playbooks.md`.
- **Opening an untrusted repository is itself an install.** Before opening one in an editor or an agent, check `.vscode/tasks.json` for `runOn: folderOpen`, agent hook configuration (`.claude/settings.json` hooks and equivalents), `.git/config` for `core.fsmonitor` and `core.pager`, and any install script. ChainDrop persisted through exactly these, on every branch, in commits authored as `claude <claude@users.noreply.github.com>` [V] — `git log --all -- .claude/settings.json .vscode/tasks.json` on your own repos after any suspected token theft.

## Keeping it current

- Automated dependency updates with a review gate, plus a scanner that fails the build on known-exploited vulnerabilities in reachable code — not on every advisory, or the team learns to ignore it.
- Track a real SBOM (CycloneDX or SPDX) generated in CI per release. It is a regulatory obligation for some products [V], and independently it is the only way to answer "are we affected" in hours instead of days.
- Median time from CVE publication to confirmed exploitation is now roughly 80 days [S]. **The controllable variable is your patch latency**, not their speed.
- Subscribe to advisories for your actual stack. For a small team, three feeds you read beats thirty you filter.

## If you suspect compromise

Order matters:

1. **Rotate every credential the affected machine or pipeline could reach** — registry tokens, cloud keys, model API keys, source-control tokens, SSH keys, session secrets. Assume everything on that host is gone.
2. Revoke sessions and active tokens; re-issue signing keys if a signing key could have been touched.
3. Check for published artifacts you did not publish, and for commits, branches, and workflow files you did not author.
4. Check persistence: editor tasks, agent hooks, git config, shell profiles, scheduled jobs, new deploy keys, new OAuth app grants.
5. Preserve logs before cleaning. Then rebuild the machine rather than cleaning it.
6. Only then work out how it happened.
