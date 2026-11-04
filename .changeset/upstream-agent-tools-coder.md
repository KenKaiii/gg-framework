---
"@kleio/coder": patch
---

Agent-tool and prompt changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- The system prompt and tool descriptions are shorter. The Talk and Work guidance becomes brief Replies and Work sections, and a skill description is capped at 240 bytes.
- Rarely used tools are deferred, including `find`, `ls`, `web_fetch`, `web_search`, `spawn_agent`, `subagent`, `steroids` and the plan tools. A deferred tool the model calls by name loads and runs. A background `bash` loads `task_output`, `task_send` and `task_stop`, and a spawn loads `wait_agent`.
- `edit` takes a `files` form that edits several files in one call. Each file applies on its own, and the result names any that failed. Claude models see a flat `file_path`/`old_text`/`new_text` schema, and more malformed edit calls are recovered.
- `write` overwrites instead of refusing a file the model hasn't fully read. It lists any lines it removed that the model hadn't seen, saves the previous file and gives the path.
- `cat` output, and `sed -n` and `head` line views, now count as reads of those lines.
- New `debug` tool (deferred, local only) drives a Node.js debugger session: breakpoints, stepping and live variables.
- After each JS or TS edit, `write` and `edit` name the tests that import the file and the command that runs them.
- `spawn_agent` and `followup_task` take acceptance checks that the worker verifies against its receipt.
- A check with only read-only commands around it, such as `npm test && git diff --stat`, now counts as verification under bash with pipefail. `bash` no longer adds a note to checks whose exit status can't prove success; the session re-runs such a check on its own when needed.
- Built-in `/commit` runs the project's checks and tests, reviews the diff, then commits and pushes. A project's own `.gg/commands/commit.md` is followed instead. `/setup-commit` now includes the tests. In the desktop app, unchecked edits in a plain reply read "Changes saved" instead of Unverified; Autopilot asks once for checks before it reviews.
- Project checklist: a `checklist` tool records project health reviews in `.gg-checklist.json`, and a result is due again after 30 days or once the code changes.
- `bash` refuses shell commands matching known attack patterns, and package installs check OSV for known-malicious packages (fail-open). A likely typosquat runs only on an identical retry.
- Stream rules load from `~/.gg/rules` and the project's `.gg/rules`.
- `ask_user` gets a soft deadline: past 10 minutes, or 2 when nobody is watching, the agent carries on with safe, reversible work, and a late answer is queued as a message.
- A submitted plan reaches the review box only once nothing else will act on it, and a plan that can't be accepted says so.
- The desktop app keeps the computer awake while a run works (a setting, on by default), and prewarms the Anthropic prompt cache on the first keystroke after a pause of more than 4 minutes.
- Codex requests drop the Responses-Lite shape and strict tool schemas by default. The `codexResponsesLite` and `codexStrictTools` settings restore them.
- OpenAI sub-agents inherit the parent's reasoning level, capped to their own model's ladder.
- Sub-agents and compaction summaries retry on the active model when the provider rejects the chosen one.
- `bash` says to kill processes by exact PID, never by name or pattern.
- Windows: checklist writes no longer fail while a released lock folder is waiting to be deleted, and debug breakpoints bind on temp folders with 8.3 short names.
