---
name: gg-guide
description: "Only when the user asks how to use GG Coder itself: how or where to do something in the app (models, sessions, settings, MCP, `!` and `/` commands, Checklist, safety, Goals, Motion, Chat, files, errors). Do NOT use for coding work."
---

# GG Coder guide

How the GG Coder desktop app works, for answering the user's questions about it. The user is in the desktop app (not the `ggcoder` terminal CLI) unless they say otherwise.

## Rules

1. Use this only to answer a question the user asked about the app. Don't bring the app's features up unprompted while doing other work.
2. Read the matching reference below before answering. Answer from it, not from memory: the app changes often. Each page ends with common questions in users' own words.
3. Use the exact on-screen labels from the reference, in bold, and say where they are (for example **Settings** › **General**).
4. If the references don't cover it, say so plainly and suggest where to look in the app. Never invent a button, setting or command.
5. Give the steps the user needs, not whole sections. Answer first, in your reply text. Only after that, if it's something you could do for them (run a Checklist item, a security review, a commit), offer it in one line; don't start it unasked.

## Quick answers

- New session: **New session** in the **More** panel (the ⋯ key on the bottom bar), or **+ New session** in the project's session list. See `references/sessions-and-history.md`.
- Change model or thinking: click the model readout in a session to open the **Model** panel. See `references/models-and-sign-in.md`.
- Improve a prompt before sending: the **Enhance** key next to send. See `references/code-mode.md`.
- Add an MCP server: give the user the exact line to paste into the chat input, `!claude mcp add …` (from the server's docs). It loads straight away, no restart. Never run `claude mcp add` in your own bash tool: that changes Claude Code's config, not GG Coder's. See `references/mcp-and-skills.md`.
- Is my app safe / ready to ship: the **Checklist** (Security, Dependencies, Secrets and the rest), or ask for a review. See `references/checklist-and-safety.md`.
- App problems: the log is `~/.gg/gg-app-sidecar.log`. See `references/troubleshooting-and-data.md`.

## References

| The question is about | Read |
|---|---|
| First run, Home, projects, windows and layout, tray menu, updates, What's new, About, zoom, keyboard shortcuts | `references/getting-started.md` |
| Sessions: new, resume, import, export, the transcript, answering GG's questions, context and compaction, errors in the chat | `references/sessions-and-history.md` |
| Code windows: composer, `@` files, attachments, queued messages, `!` commands, `/` commands, schedules, Enhance, plan review, tasks, notes, git and commits, CI | `references/code-mode.md` |
| Ken, Autopilot, sub-agents and critters, trophies, Radio | `references/ken-and-autopilot.md` |
| Checklist, project health, making an app safe or ready to ship, and how GG Coder keeps the user safe | `references/checklist-and-safety.md` |
| Providers and sign-in, plans and keys, choosing a model, thinking levels, local models, usage | `references/models-and-sign-in.md` |
| Every Settings tab: General, AI Providers, Remote (Telegram), MCP, Steroids, About | `references/settings.md` |
| MCP servers (panel and `!claude mcp …`), skills, blocked skills | `references/mcp-and-skills.md` |
| Chat (agents, Brain memory), Motion (videos) and Goals | `references/chat-motion-goals.md` |
| Files on disk, logs, errors, sign-in and update problems, reporting a bug | `references/troubleshooting-and-data.md` |
