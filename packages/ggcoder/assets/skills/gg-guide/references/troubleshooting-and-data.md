# Troubleshooting and where GG Coder keeps data

GG Coder keeps its data in one folder in the user's home directory, `~/.gg/`. The desktop app and the `ggcoder` CLI share this folder, so a sign-in made in one also works in the other.

## What lives in `~/.gg/`

Settings and sign-ins:
- `~/.gg/settings.json`: agent settings such as the chosen model, thinking level, keep-awake and the trust choices for project MCP servers. Shared with the CLI.
- `~/.gg/gg-app.json`: desktop-app settings, such as the projects folder and per-project app options like autopilot.
- `~/.gg/gg-app-workspace.json`: a record of which windows were open, with their project, chat and position. The app uses it to reopen windows after a restart.
- `~/.gg/auth.json`: sign-ins and API keys for AI providers. Every app window and the CLI share it. This is a credential file. Never share it.
- `~/.gg/openai-host-id` and `~/.gg/openai-chatgpt-client.json`: identity data for the ChatGPT sign-in. Treat them as credentials.
- `~/.gg/claude-code`: the Claude Code build that GG Coder downloads for "Sign in with Claude", one folder per version. It also holds GG Coder's own Claude Code login in a `config` folder, separate from the user's own Claude Code. Never share the login.
- `~/.gg/telegram.json`: Telegram bot settings, including the bot token. Never share it.

MCP:
- `~/.gg/mcp.json`: global MCP servers, used in every project.
- `~/.gg/mcp-auth.json`: sign-ins for MCP servers. This is a credential file. Never share it.
- `~/.gg/mcp-catalog.json`: a cached list of MCP tools. It is safe to delete and gets rebuilt.

Work and history:
- `~/.gg/sessions`: saved chats (session transcripts). Deleting them removes chat history. Old sessions are pruned at startup based on a retention setting.
- `~/.gg/subagent-sessions`: transcripts of helper agents.
- `~/.gg/goals`: one folder per Goal.
- `~/.gg/checkpoints`: per-chat checkpoint folders. The app removes folders that have gone 30 days without being touched.
- `~/.gg/tool-output`: full tool outputs kept for recovery. The app deletes them after 48 hours.
- `~/.gg/diagnostics/sessions`: diagnostic records. The app deletes them after 30 days.
- `~/.gg/skills`: the user's global skills.
- `~/.gg/progress.json` and `~/.gg/trophies.json`: progress and earned trophies.

Logs and housekeeping:
- `~/.gg/gg-app-sidecar.log`: the desktop app's agent log. Read this first for app problems.
- `~/.gg/debug.log`: the CLI's log. The desktop app does not write to it.
- `~/.gg/gg-app-sidecars`: a list of the app's running agent processes. Don't edit it while the app is open.

Safe to delete when GG Coder is closed: the logs, `~/.gg/mcp-catalog.json`, `~/.gg/tool-output`, `~/.gg/diagnostics/sessions`. If `~/.gg/claude-code` is deleted, the Claude sign-in downloads it again and the user has to sign in again.
Never paste or upload: `~/.gg/auth.json`, `~/.gg/mcp-auth.json`, `~/.gg/telegram.json`, the files under `~/.gg/claude-code`, and the OpenAI identity files.

## Files inside a project

Each project can have its own `.gg/` folder:
- `.gg/mcp.json`: MCP servers for this project only.
- `.gg/skills`: skills for this project. Each skill is a folder with a `SKILL.md`.
- `.gg/commands`: custom slash commands, one `.md` file each. They appear in the `/` menu. A Goal's attached repos and folders added with **Add folder** contribute their commands too.
- `.gg/uploads`: files attached in chat.
- `.gg-checklist.json` (in the project root, not inside `.gg/`): the project health checklist record.

## Which log to read

- For agent, model, MCP or tool problems, read `~/.gg/gg-app-sidecar.log`. The app replaces it each time the app starts, so collect it before relaunching.
- The desktop shell writes a separate log named `gg-app.log` in the system's log folder for the app. It records crashes of the window itself.
- Before sharing any log, remove API keys, tokens and anything private.

## Common problems

Not signed in, or a sign-in stopped working:
- When a chat starts with no provider connected, the app shows "Connect an AI provider first." Connect a provider from the providers screen with **Connect** or **Sign in**.
- If an old sign-in has been retired, the providers screen shows a notice with **Reconnect** and **Dismiss**. **Reconnect** opens that provider's login. **Dismiss** removes only the retired sign-in.
- If the providers list fails to load, the screen shows "Couldn't read your AI providers." with **Try again**.
- Sign-ins are shared, so connecting or disconnecting in one window updates every window.

Model errors in a chat:
- An error appears in the chat as a short headline, a line of guidance, and a **Details** button. **Details** shows the provider's original message, the provider name, the HTTP status, the request ID and the time of the report.
- Errors fall into these kinds: usage limit, billing, quota, rate limit, model access, auth, network, capability, context, update, provider or unknown.
- For usage-limit, model-access, capability and update errors, a model picker appears next to the notice so the user can switch models.
- For a usage limit, **Details** shows the reported reset time. After that time has passed, the guidance tells the user to check their usage before trying again.
- An error from an earlier attempt is shown with the prefix "Earlier:".
- If a subscription runs out and the provider also has an API key saved, the provider screen says requests are using the API key until the subscription resets.

Common error headlines and what to do:
- "<provider> usage limit reached": wait for the reset shown in **Details**, or switch to another provider or model with the picker next to the notice. If the provider also has an API key saved, GG uses the key until the subscription resets.
- "<provider> is limiting requests": wait a moment, then try again.
- "<provider> sign-in needs attention": reconnect the account in the AI Providers settings.
- "Couldn't reach the provider": check your internet connection, then try again.
- "The response kept stalling": try again, ask for smaller pieces of work, or pick another model.
- "This conversation is too large": compact the conversation or send a smaller request.
- "The local server rejected its key": check the endpoint's key under Local models in the AI Providers settings.

Small pop-up messages (toasts) appear at the edge of the window for things like saved settings or failed actions. Normal ones fade after a few seconds. Error toasts stay until you close them with the x (**Dismiss**).

A window stuck loading or showing an error:
- The window waits for the background agent to start. If the agent doesn't start in time, or keeps crashing on startup, the window shows that reason. A crash message names the cause, for example a permissions error on `~/.gg/settings.json`.
- If the window itself crashes, it shows **This window hit a problem** with an **Error details** section and a **Reload window** button. Chats are saved, so reloading continues where the user left off.
- If the problem continues, check `~/.gg/gg-app-sidecar.log`.

MCP server not working (Settings, MCP):
- A green tick with a tool count means the server is connected.
- A lock with **Requires login** means the server needs a sign-in. Click **Sign in**.
- A red cross shows the connection error under the server's row. Errors that start with "blocked" are safety blocks. Tools hidden by the safety guard are listed under the row.
- A server from a project's `.gg/mcp.json` stays disconnected until that project is trusted, because the file can run commands chosen by the repo. Adding or re-adding the server for that project in the MCP screen trusts that project.
- If the list says "Couldn't reach the agent to list servers.", use **Try again**.

`!` commands ask for confirmation:
- In a project that hasn't been trusted, a shell command typed with `!` shows **Run this command?** along with the command and the folder it will run in. The choices are **Run once**, **Always allow in this project** and **Cancel**. Enter runs the command and Esc cancels it.

App updates:
- An update bar offers the new version. Installing it downloads the update, then restarts the app.
- If the install fails, the bar shows **Update failed** with **Retry** and **Download manually**. **Download manually** opens the latest release on GitHub.

Quit and relaunch:
- The app records each open window's project, chat and position when the user picks a project, closes a window or quits. On the next launch, including the restart after an update, it reopens those windows where they were.

## Reporting a bug

- File bugs at github.com/KenKaiii/gg-framework using the Bug report form. It asks what happened, steps to reproduce, where it happened (choose Desktop app), the app version, the operating system, the provider and model, and logs.
- Attach the relevant part of `~/.gg/gg-app-sidecar.log` with secrets removed. Never attach the credential files.
- Report security problems privately through GitHub security advisories, not as a public issue.
- For questions and help, use the Skool community (skool.com/kenkai).

## Resetting

- To sign out of one provider, disconnect it in the AI Providers settings. Removing `~/.gg/auth.json` while the app is closed signs you out of every provider in the app and the CLI.
- To clear chat history, delete `~/.gg/sessions` while the app is closed.
- To forget which windows were open, delete `~/.gg/gg-app-workspace.json` while the app is closed.
- Deleting the whole `~/.gg/` folder resets GG Coder completely, including sign-ins, settings, MCP servers, skills and chat history. Back up anything you want to keep first.
- The docs do not describe a separate uninstaller. Remove the app the normal way for your system; the `~/.gg/` folder stays until you delete it.

## Common questions

Q: Where are the logs?
A: The desktop app's agent log is `~/.gg/gg-app-sidecar.log`. It starts fresh each launch, so copy it before relaunching. The CLI writes `~/.gg/debug.log` instead.

Q: GG says I'm out of usage, what now?
A: Wait for the reset time shown under **Details**, or pick another provider or model from the picker next to the notice. If you also saved an API key for that provider, GG uses the key until the subscription resets.

Q: Where does GG Coder keep my data?
A: In `~/.gg/` in your home folder, shared by the app and the CLI. Each project can also have its own `.gg/` folder for MCP servers, skills and commands.

Q: A window says "This window hit a problem". What do I do?
A: Click **Reload window**. Your chats are saved, so you continue where you left off.

Q: The window is stuck loading.
A: The background agent may have failed to start; the window shows the reason when it gives up. Check `~/.gg/gg-app-sidecar.log`, fix the cause it names (often file permissions on `~/.gg/`), then relaunch.

Q: Every chat says I'm not signed in.
A: Open the AI Providers settings and click **Connect** or **Sign in** for a provider. If a provider shows **Reconnect**, click it to log in again.

Q: My MCP server won't connect.
A: Open Settings, MCP and read the error under the server's row. Click **Sign in** if it needs a login, and for project servers make sure the project is trusted by adding the server for that project.

Q: The update failed.
A: Click **Retry** in the update bar. If it still fails, click **Download manually** to get the latest release from GitHub.

Q: Will my windows come back after I quit?
A: Yes. The app reopens each window with its project, chat and position on the next launch, including after an update.

Q: Why does GG ask before running a `!` command?
A: The project isn't set to always allow shell commands. Choose **Run once**, **Always allow in this project** or **Cancel**.

Q: What does the error **Details** button show?
A: The provider's original message, the provider name, the HTTP status, the request ID and when it happened. Include these in a bug report.

Q: How do I report a bug?
A: Use the Bug report form at github.com/KenKaiii/gg-framework, choose Desktop app, and attach the relevant part of `~/.gg/gg-app-sidecar.log` with secrets removed.

Q: Which files must I never share?
A: `~/.gg/auth.json`, `~/.gg/mcp-auth.json`, `~/.gg/telegram.json`, the files under `~/.gg/claude-code` and the OpenAI identity files.

Q: How do I reset GG Coder completely?
A: Quit the app and delete the `~/.gg/` folder. This removes all sign-ins, settings, MCP servers, skills and chat history.

Q: Is it safe to delete files in `~/.gg/` to free space?
A: With the app closed, the logs, `~/.gg/tool-output`, `~/.gg/diagnostics/sessions` and `~/.gg/mcp-catalog.json` are safe to delete. Old checkpoints and tool outputs are also cleaned up automatically.
