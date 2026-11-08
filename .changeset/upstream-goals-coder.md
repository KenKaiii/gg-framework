---
"@kleio/coder": patch
---

Goals, imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- Goals: a long-running objective bigger than one session. Each goal is a folder under the agent directory's `goals/` holding `goal.json` (name, goal, attached folders and files, standing instructions). Its window talks to a coordinator agent with the goal brief in its system prompt and the attached folders as workspace roots.
  - The coordinator replies first, briefs and asks, and starts work only after the user picks "Start the goal now", in the card or typed in the chat.
  - It does small and connected work itself and starts workers from its own team (builder, scout, researcher, checker) for big independent parts. Workers reach every attached folder, including ones attached mid-goal, and never run on a paid model.
  - Goals can be paused, resumed, carried on after a restart, and changed (attached folders and instructions). A goal another process is running (the desktop app or `kleio-coder acp`) is never resumed twice.
  - Goal folders never appear in the project list.
- ACP mode (`kleio-coder acp`) lists, creates, runs and deletes goals and runs autopilot cycles, over the `_gg/*` extension methods.
- Questions waiting on the user survive a reload and a daemon restart: the ready frame closes cards nobody can answer and restores live ones.
- Slash commands come from every workspace root, so a goal's attached repos and `/add-dir` folders bring their `.gg/commands`.
- In the desktop app, a background task that fails after the agent ended its turn starts a hidden run for it, at most twice per user message and never after Stop.
- A session whose saved conversation file is gone starts fresh instead of failing.
