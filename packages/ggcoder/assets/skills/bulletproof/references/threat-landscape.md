# Threat Landscape — techniques and defensive fingerprints

Why the defaults in this skill are what they are. Each entry is a **technique** an attacker used, the **fingerprint** a defender can check for, and the **lesson**. Incident names are kept as anchors only; counts and statistics rot, so they are deliberately left out. Markers: **[V]** verified against a primary source, **[S]** volatile or secondary, **[U]** uncertain. Snapshot 3 Oct 2026, reworked 22 Oct 2026.

Read once per full review to set the threat model. Cite only entries that map to a finding.

## 1. What automation changed

- **AI-orchestrated intrusion is operational** [V] (Anthropic, GTG-1002, Nov 2025). Technique: an agent wired to tooling over MCP ran recon through exfiltration, after operators posed as an authorized security firm. Lesson: a defensive framing in a brief is necessary, never sufficient; the Hard stops still apply.
- **Machine-found bugs at scale, exploitation not proportionally** [V] (VulnCheck, Jul 2026): AI-attributed vulnerabilities were exploited at about the general rate. Lesson: discovery volume moved the bottleneck to maintainer triage and patch capacity, which is where small teams are weakest.

What this means for code you write:

1. Assume any public repo has been read end-to-end by a machine. Obscurity is not even a delay.
2. Machines find classes with a cheap verification oracle fastest (web/API, parser memory safety). Business logic and multi-actor authorization remain where expensive breaches happen.
3. Patch latency is the dominant controllable variable.
4. Detection that needs a human to read a dashboard within the hour is not a control.

## 2. Supply chain

| Technique | Defensive fingerprint | Lesson |
|---|---|---|
| **Self-propagating npm worm** (Shai-Hulud lineage, Sept 2025 onward) [V]: steal a publish token, enumerate the victim's packages, inject, republish | Install hooks added in a patch release; packages you maintain republished without your commit; CI runners as the main victims | CI holds every credential at once; it is the real target |
| **Fork PR → `pull_request_target` → cache poisoning → OIDC token from runner memory** (TanStack, May 2026) [V] | `pull_request_target`/`workflow_run` jobs that check out PR code; release jobs restoring caches a PR job could write; `id-token: write` outside the publish job | No token theft is needed when CI trust boundaries leak |
| **Install-time execution without a lifecycle script** (bare `binding.gyp` → implicit `node-gyp rebuild`, mid-2026) [S] | `binding.gyp` in a package with no native need | Scanners that only watch `preinstall`/`postinstall` miss it |
| **Persistence in editor/agent config** (ChainDrop, Aug 2026) [V]: commits a `SessionStart` hook in `.claude/settings.json` and a `runOn: folderOpen` task in `.vscode/tasks.json` across branches | Those files on any branch, especially authored by an unfamiliar or bot-like identity | Opening the repo executes it; lockfile fixes do not remove it; check all branches |
| **Malicious release with valid provenance** (ChainDrop; `tensorlake@0.5.144`, Oct 2026, GHSA-rqxj-g25x-4v9v [V]): code pushed to main under a maintainer identity, shipped by the project's own release workflow, payload in a preinstall hook [S] | Direct pushes to the release branch without review; new install hooks | Provenance proves where an artifact was built, not that the build was honest |
| **Trust bound to a renameable name** (npm trusted publishing "SlugFest", Oct 2026) [S] | Publisher bindings pointing at a renamed, transferred or deleted repo | Bind trust to immutable IDs, in registries and in your own authorization |
| **Mutable tag repointed** (`tj-actions/changed-files`, Mar 2025, CVE-2025-30066) [S] | `uses: org/action@v1` instead of a 40-char SHA | A tag is not a pin |
| **Slopsquatting** (Spracklen et al., USENIX Security 2025) [V]: models recommend nonexistent package names, often the same names repeatedly, so squatters register them | A dependency with no history, a single early version, or a name that is a near-miss of a real one | Agents removed the human "does that name look right" check; verify existence first |
| **Malicious MCP server cloning an official one** (`postmark-mcp`, Sept 2025) [V]: clean releases, then a silent BCC of every email | A tool server whose behaviour changes across updates; unofficial publisher under the expected name | Pin servers and re-review after every update |
| **Lookalike editor extensions** [U] | Publisher identity differs from the display name; auto-updates on | Registry removal does not clean installed copies |

## 3. AI agents as an attack surface

Read `agent-surface.md` in full if the project is an agent, tool server, or AI feature.

- **Prompt injection has no reliable prevention** [V] (Nasr et al., arXiv 2510.09023: adaptive attacks bypassed every published defense tested). Design for containment.
- **Lethal trifecta**: private data + untrusted content + an egress channel. All three together is exploitable.
- **Sandbox escapes** [U]: files the agent writes inside the sandbox are later read, loaded or executed by a trusted process outside it (symlinks, config files).
- **Rules-file and skill backdoors** [S]: invisible Unicode in `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or shared skills, instructing exfiltration of `.env` or injection of credential-harvesting code into generated files.
- **Fetched content steering an agent** [S]: a malicious public issue or support ticket made a credentialed agent leak private data.
- **AI credentials are loot** [S]: worms read `.claude`, `.cursor` and model-provider auth files alongside cloud keys.

## 4. What is exploited against small teams

| Technique | Defensive fingerprint | Lesson |
|---|---|---|
| **Secret sprawl** [V] (GitGuardian, State of Secrets Sprawl 2026): hardcoded keys in commits, MCP configs, AI-assisted commits; old leaks stay valid | Literal keys in history, `.mcp.json`, build logs, client bundles | Leaks are not revoked by deleting the commit; rotate |
| **Open backend row-level security** (CVE-2025-48757, Supabase apps from a generator) [S] | RLS off; `using (true)`; reads locked but writes open; service-role key in the client; `auth.uid()` not compared to the owner column | The public anon key plus an open table is the standard indie breach |
| **Middleware-only auth** (CVE-2025-29927, Next.js `x-middleware-subrequest`) [V] | Authorization checked only in `middleware.ts` or edge guards | Re-check in the handler or data layer |
| **Framework fixed, native dependency reachable** (Next.js, 14 Oct 2026: unauthenticated RCE via SVG in image optimization / `next/og` through `sharp`/librsvg, and via `use cache` returning typed arrays) [V] | Native image/parsing deps in the lockfile; user-controlled images or cached values reaching them | After a framework upgrade, confirm its transitive native deps moved too |
| **Exposed AI and developer infrastructure** [U]: inference servers, notebooks, MCP endpoints on the internet | Services bound to `0.0.0.0` without auth | Generic credential scanners find you first, not AI-aware attackers |
| **CMS and edge devices** [V] (VulnCheck 1H-2026): the largest share of known-exploited vulnerabilities | A CMS or appliance in the deployment | Do not over-rotate to AI; check the likelier door |

## 5. Speed and economics

- **Leaked credentials are used, not archived.** Any secret that touched a public surface, build log, paste or third-party service is compromised at the moment of exposure.
- **Patch fast where exploitation is evidenced** and the component is reachable in your deployment: days, not weeks.

## How to use this file

1. Pick the two or three techniques that plausibly apply to *this* project and write them into the threat model as concrete scenarios.
2. Skip the rest.
3. Re-verify anything [S] or [U] before presenting it as current.
