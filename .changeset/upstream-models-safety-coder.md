---
"@kleio/coder": patch
---

Model, provider, safety and skills changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- gg-safe security layer:
  - A package install stops on a version with a HIGH or CRITICAL OSV advisory, and points to the newest fixed release in the same major version.
  - Skills flagged by the threat feed are not loaded, and are named.
  - MCP tool descriptions are scanned and pinned before the model sees them. A poisoned or shadowing tool is blocked.
- Web search: on Anthropic, web search runs as a side request to Claude Haiku 5.5, so result pages stay out of the main context. Other providers use the client search.
- `web_fetch` says where a cut page stops, and takes an `offset` to continue from there.
- Bash output over 30,000 bytes is offloaded and shown compressed. Routine output, such as installs and builds, is compacted.
- `grep` scans on worker threads with byte prefilters and pruned walks, and groups its output by file.
- Background tasks detect failures from their output (test runners, tsc, cargo, npm and pnpm, tracebacks and CI watches). `task_output`'s wait stops on a failure in another task or a finished sub-agent, and says which. Waking an idle agent on such a failure waits for its desktop wiring in a later import.
- Before switching to a model that costs money, the model picker asks first.
- Skills:
  - Bundled skills are cut to `compliance-guard` and `durable`, with sharper descriptions. `bulletproof` and `lean` stay, hidden for Checklist audits.
  - The skill name is required.
  - Loaded skills share delegation and host rules.
  - The retired `find-skills` seed is removed from the skills folder only when it is unchanged.
  - `/setup-skills` is removed.
- Removed tools: `code_search` and `code_nav`.
- Language style packs are removed: the "Language Style Packs" prompt section, `.gg/styles/<language>.md` overrides, and the badge for a newly detected language. Languages are still detected for verify commands.
- Prompt rules:
  - Make each code change in one bash command.
  - Comment only a non-obvious why.
  - Calls in one reply run in parallel, except shell commands and edits, which run in listed order.
  - The first prompt lists the project's files.
- The `steroids` tool is framed as current open-source code. It is not a default research step, and its repos list no longer flags stale repos.
- Settings:
  - A value a build rejects falls back to its own default instead of resetting every setting.
  - Unknown keys are written back untouched.
  - Settings are saved atomically.
  - In the desktop app, picking a local model no longer resets the other settings.
