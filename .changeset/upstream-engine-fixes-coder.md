---
"@kleio/coder": patch
---

Fixes imported selectively from upstream engine releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- Verified work no longer goes back to Unverified when, after a passing check, the model runs one Kleio can't resolve: an unrecognized read-only check, or any check in the persistent shell.
- `bash` and `task_send` refuse git commands that would permanently lose work: `reset --hard`, `checkout --`/`restore`, `clean -f`, `stash drop`/`clear`, `branch -D` and a plain force push. Each one checks the real repo first and names what would be lost. The same command still runs on a clean tree, and the check fails open outside a repo.
- The catastrophic-command guard sees through flag spellings, control flow, wrappers, other deleters, `cd`, PowerShell and cmd, and catches Windows backslash paths such as `C:\Users\me`. It also blocks removing a folder that holds the workspace or the home folder.
- Web and MCP tool output that reads like instructions to the model gets one warning line appended.
- A message sent while tools run interrupts them and reaches the model on its next call. `edit`, `write`, `ui_adopt` and `spawn_agent` always finish.
- In the persistent shell, a timeout or abort stops only the running command, and the shell keeps its directory and environment. A shell that dies is restarted from its last snapshot, with a one-line note under the exit code.
- The agent's own background git calls run with repo-config execution hooks (fsmonitor, hooks and filters) turned off.
- MCP: an idle stdio server stops after 15 minutes and restarts on its next call; `keepAlive` opts out. Calls forward progress notifications and honour `maxTotalTimeout`, and a result the server marks `isError` is reported as an error.
- Each sub-agent turn carries an engine-built receipt of its tool calls, and a batch `spawn_agent` call restores one history row per child.
- `wait_agent` loads as soon as `spawn_agent` succeeds, which saves a `tool_search` turn.
- When `bash`, `read` or `task_output` output is truncated, the note counts the error and warning lines that were cut, names their labels and files, and quotes the first distinct errors.
- `edit` recovers a call that closes the `edits` string where `old_text` should end and puts `new_text` at the top level, a shape Claude Haiku 5.5 sends.
- A folder added or removed mid-conversation reaches the model through the environment-update note instead of a rebuilt system prompt, so the cached conversation stays valid.
- Tool-output pruning starts only once the context reaches half of the compaction trigger. Below that, each prune re-sent more uncached history than it freed.
- When a turn would end unverified because the model ran its tests inside a longer command whose exit status came from a later part, Kleio re-runs that check once on its own and records the re-run's result. A failed re-run leaves the work unverified, not failed.
- Replies after code changes stay under about 100 words, mention commits only when one was made or asked about, and updates between tool calls are one sentence.
