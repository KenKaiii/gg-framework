# MCP servers and skills

## What MCP servers are

MCP servers give the agent extra tools, such as Notion, a database, or a browser. GG Coder keeps its own list of MCP servers. It is separate from Claude Code's list.

## The MCP panel

Open Settings and pick the MCP tab (the panel is titled **MCP servers**; its list is titled **Servers**).

- Each server has a row with a status icon:
  - Connected: shows how many tools it has (for example "12 tools").
  - **Requires login**: the server needs an OAuth sign-in. Click **Sign in** on the row. Your browser opens to finish the login. When it's done, a message says how many tools are now available.
  - Failed: shows the connection error. If a safety check hid any of the server's tools, those are listed under the row.
- To remove a server, click the small x at the end of its row.
- If the list can't be loaded, click **Try again**.

## Adding a server in the panel

1. Under **Add a server**, paste a `claude mcp add …` line, usually copied from the server's docs. Example:
   `claude mcp add --transport http notion https://mcp.notion.com/mcp`
2. Choose a scope:
   - "Global": saved to `~/.gg/mcp.json` and used in every project.
   - "Project": saved to that project's `.gg/mcp.json`. Type the project path or pick one from the list.
3. Click **Add** (or press Enter).

If the server connects, you see its tool count. If it needs OAuth, it is saved and you click **Sign in**. If it can't connect, it is still saved, and the message gives the reason.

The panel shows one scope at a time. Switch between "Global" and "Project" to see each list.

## The `!` route: pasting a command into the chat input

Type `!` and then paste a `claude mcp …` or `ggcoder mcp …` line. GG Coder runs it itself instead of passing it to a shell, so the line changes GG Coder's servers, not Claude Code's.

Supported subcommands:
- `add`: http/sse servers (`--transport http <name> <url>`, `--header "K: V"`, `--client-id`, `--callback-port`) or stdio servers (`<name> -- <command> [args…]`, or `<name> <command> …` without `--`, `--env K=V`)
- `add-json <name> '<json>'`
- `list`
- `get <name>`
- `remove <name>` (or `rm`), optionally with `--scope local|user`
- `help` (also shown when nothing follows `mcp`)

Forms it accepts:
- A leading `$ ` copied from docs is ignored.
- Lines broken with a trailing `\` are joined.
- Quotes work as they do in a shell.
- For a pre-registered OAuth client secret, put the secret in front of the command: `MCP_CLIENT_SECRET=… claude mcp add --client-id <id> --client-secret …`. The secret is kept for sign-in, never written to `mcp.json`, and hidden in the saved command.

Scope:
- No `--scope`: this project's `.gg/mcp.json`. This matches Claude Code, whose default is the current project.
- `-s user` (or `--scope user` / `global`): `~/.gg/mcp.json`, for every project.
- Claude Code's `local` and `project` scopes both go to this project's `.gg/mcp.json`.

To run the real Claude Code CLI instead, type `!command claude mcp …`.

Like every `!` command, it first asks **Run this command?**. Click "Run once", "Always allow in this project", or "Cancel". If the project is already set to always allow, it runs without asking.

## When changes take effect

A server you add or remove loads into all open windows right away, with no restart. The output says if the server also loaded in other open windows. After you remove a server, the agent is told its tools no longer work.

## Project servers and trust

Servers in a project's `.gg/mcp.json` only connect when the project is trusted. Adding a project-scope server, in the panel or with `!claude mcp add`, marks that project as trusted.

## How the agent finds MCP tools

MCP tools are often not loaded up front. The agent searches for them with its `tool_search` tool, by capability or by server name, and then uses them. When a server is added mid-session, the agent gets a note listing its tools.

## Guidance for the agent

When a user asks you to add an MCP server, give them the exact `!claude mcp add …` line to paste into the chat input (or tell them to paste it into the MCP panel). Do not run `claude mcp add` in your own bash tool: that changes Claude Code's config, not GG Coder's.

## MCP servers asking for input

Some MCP servers stop in the middle of a tool call to ask a question, such as a name, a choice or a confirmation. A dialog titled "<server> needs your input" opens in the app with the server's message and form fields.
- Fill in the fields and click **Send** (Enter also sends when the form is complete).
- **Decline** says no to the request. **Cancel** cancels it.
- If two servers ask at once, the dialogs queue and show one at a time.
- Some servers ask for confirmation with no fields; then the dialog only has the buttons.

## Skills

A skill is a set of instructions for one kind of work. The agent sees each skill's name and description and loads the full skill when a task fits it. GG Coder ships with built-in skills. A user skill with the same name replaces the built-in one.

Where to put your own skills:
- Global, for all projects: `~/.gg/skills/`
- This project only: `.gg/skills/` in the project. A project skill replaces a global one with the same name.
- Layout: either `<name>/SKILL.md` or a single `<name>.md` file, with `name` and `description` frontmatter. Adding `hidden: true` leaves it out of the list the agent sees, but it can still be loaded by name.

When new skills load: skills are read when a session starts, so a new skill is available in the next new chat, not the current one.

## Skills in Chat and Motion

Each mode keeps its own skills:
- Chat: user skills go in the GG Chat workspace's `.gg/skills/` folder as `<name>/SKILL.md`. Every Chat session and all three chat agents can use them. Chat does not use the built-in or global coding skills, and Coder and Motion can't use Chat's skills.
- Motion: user skills go in the GG Motion workspace's `.gg/skills/` folder. They add to Motion's built-in video skills but cannot replace them. Coder and Chat can't use them.
- Coder: global skills in `~/.gg/skills/` or project skills in `.gg/skills/`. When you ask for a new skill in Coder, the agent asks whether it is for this project or every project.
- In every mode, a new skill loads in the next session or chat.

Motion's built-in skills cover the different video types: app walkthroughs, before/after videos, brand kits, developer tool videos, launch videos, matching a reference video, website videos and taking in source material.

## Blocked skills

Every user skill is scanned for safety when it loads. A skill that matches a malware, data-exfiltration, or hiding rule is not loaded, and you are never prompted about it. The app shows a warning once: "Skill "<name>" blocked for safety: <reason>". It shows again only if the skill's content changes.

## Built-in skills

GG Coder ships these skills for Coder mode. Each loads only when the task matches it:
- `bulletproof`: security for code an attacker can reach, such as logins, uploads, payments, secrets and other users' data. It reports what was checked, what was fixed and what is still open.
- `compliance-guard`: the legal side of shipping to real users, such as which privacy laws apply and what consent, notices and policies the product needs.
- `durable`: keeping stored data safe before anything that could delete, overwrite or reshape it, and checking backups and recovery.
- `lean`: making software faster or lighter when speed, memory, CPU or size is the problem.
- `gg-guide`: how GG Coder itself works. The agent uses it to answer questions about the app.

A user skill with the same name as a built-in one replaces it in Coder mode.

## Making a new skill

Ask GG to make one, for example "make a skill for writing our release notes". The agent knows where each mode keeps skills, writes the `SKILL.md` with a name and description, and in Coder asks whether it is for this project or every project. Start a new chat to use it.

You can also write one by hand in the folders above. Keep the description short and say when to use it, because the agent decides from the description alone whether to load the skill.

## Steroids

Steroids is a separate tab in Settings with extra agent options. See `references/settings.md`.

## Common questions

Q: How do I add an MCP server?
A: Paste the server's `claude mcp add …` line into Settings, MCP, under **Add a server**, pick a scope and click **Add**. Or type `!` in the chat input followed by the same line.

Q: How do I remove an MCP?
A: Click the small x at the end of its row in the MCP panel, or type `!claude mcp remove <name>` in the chat input.

Q: Do I need to restart after adding an MCP?
A: No. Added or removed servers load into all open windows right away.

Q: Where is my MCP config saved?
A: Global servers are in `~/.gg/mcp.json`; project servers are in the project's `.gg/mcp.json`. GG Coder's list is separate from Claude Code's.

Q: I ran `claude mcp add` in a terminal and GG can't see the server. Why?
A: That changes Claude Code's config, not GG Coder's. Run it with `!` in the GG chat input or paste it into the MCP panel instead.

Q: My server says Requires login. What do I do?
A: Click **Sign in** on its row and finish the login in your browser.

Q: My project server won't connect.
A: Project servers only connect in trusted projects. Adding the server for that project from the MCP panel or with `!claude mcp add` trusts the project.

Q: How do I see which servers I have?
A: Open the MCP panel and switch between "Global" and "Project", or type `!claude mcp list`. Use `!claude mcp get <name>` for one server.

Q: The server needs a client secret. How do I pass it?
A: Put `MCP_CLIENT_SECRET=…` in front of the add command. The secret is kept for sign-in and never written to `mcp.json`.

Q: A popup says a server needs my input. What is it?
A: An MCP server is asking a question mid-task. Fill it in and click **Send**, or click **Decline** or **Cancel**.

Q: The agent isn't using my MCP tools.
A: Check the server is connected in the MCP panel, then ask the agent to use that server by name; it finds MCP tools with `tool_search`.

Q: What skills come built in?
A: In Coder: `bulletproof`, `compliance-guard`, `durable`, `lean` and `gg-guide`. Motion has its own video skills.

Q: How do I make my own skill?
A: Ask GG to make one. It puts the skill in the right folder for the mode you are in.

Q: I added a skill but the agent doesn't use it.
A: Skills load when a session starts, so open a new chat. Also make sure it is in the right mode's folder and has `name` and `description` frontmatter.

Q: Can Chat use my coding skills?
A: No. Chat, Motion and Coder each use their own skills.

Q: Why was my skill blocked?
A: It matched a safety rule for malware, data theft or hiding instructions. The warning gives the reason. It stays blocked while its content matches the rule.
