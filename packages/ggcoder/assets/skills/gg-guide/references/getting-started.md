# Getting started with the GG Coder desktop app

## First run and setup

- A new window opens on the Home screen.
- The four mode buttons on Home (**Code**, **Goals**, **Chat**, **Motion**) look dimmed until two things are set up: a workspace folder and a connected AI provider.
- Clicking a dimmed button opens Settings at the missing step:
  - With no folder set, it says "Set a workspace folder first." and opens the **General** tab.
  - With a folder but no provider, it says "Connect an AI provider first." and opens the **AI Providers** tab.
- On **General**, the **Project folder** section sets where new projects are created. Type a path or use **Browse…**. It saves straight away.
- **AI Providers** lists every supported provider. Sign in with OAuth, an API key, or both, depending on the provider.
- Home re-checks setup whenever its window gets focus, so you don't need to restart after signing in.

## The Home screen

- Top: the installed version (for example "v1.2.3") and a **What's new** button.
- Middle: the gold "GG Coder" pixel title, the tagline **Cause the other coding agents piss me off**, and the four mode buttons. Hovering each shows a tip:
  - **Code**: open a project and build it with the agent.
  - **Goals**: hand over a bigger goal and let a team of agents work on it.
  - **Chat**: talk things through. No project needed.
  - **Motion**: make videos and animations.
- Bottom-right: the gear button (**Settings**) for AI providers, your projects folder and more.
- Top-centre: an **Update** button, shown only while a new version is available.
- Background: a pixel-art campfire clearing in the pines, lit for your local time of day (stars and moon at night, sunbeams by day, fireflies at dusk). It stops animating while the window isn't focused, and shows a still frame if your system asks for reduced motion.
- Along the bottom edge, nine of the critter crew turn up on a randomly picked terrain (meadow, beach, desert, snow or space) and wander and play. Every so often one heads off and another arrives. Point at a critter to see its name and what it's up to. Clicking a critter spooks it.
- The background can be switched off in **Settings** › **General** › **Effects** with the **Background on** / **Background off** button. With it off, Home shows a plain background (the critters stay).
- To change mode from a workspace, go back to Home and pick another button. Other pages cover each mode in depth.

## Projects

- **Code** opens the **Choose a project** list. It shows every known project, including ones from Claude Code and Codex, each with a small source badge (**GG Coder**, **Claude Code**, **Codex** or **Folder**).
- Type in the search box ("Search projects…") to filter the list.
- Click a project to see its earlier sessions:
  - **+ New session** starts fresh.
  - Clicking an earlier session resumes it.
  - A Claude Code or Codex conversation is quietly imported and opens as a GG Coder session.
  - **All projects** goes back to the list.
- **Open existing** opens any folder on disk as a project.
- **+ New project** opens the **New project** dialog. Type a name; it's turned into lowercase-with-dashes, and a hint shows the full path it will create inside your projects folder. Press Enter or **Create**, or **Cancel**.
- The × on a project row (tooltip **Hide from this list**) hides that project. The folder itself is not deleted. Hidden projects stay hidden even if you change your projects folder.
- If the list can't load, it says **Couldn't load your projects.** With nothing found, it says **No projects yet.**
- Inside a project, the title bar shows the project name with a colour mark. Each project gets its own stable colour, so side-by-side windows are easy to tell apart.

## Windows

- Each window holds its own project, chat, goal or video session.
- Cmd/Ctrl+N opens a new window on Home.
- The window layout button (tooltip **Arrange into multiple project windows**) sits on the project, chat and goal lists. Inside a workspace it's **Arrange** in the **More** panel. Its options:
  - **2 windows**, **4 windows** or **6 windows** sets the app up as a grid of that many windows.
  - **Auto-arrange all** tidies every open window into a grid.
- Escape closes the layout menu.
- On relaunch (including the restart after an update), each window reopens with its mode, project folder and session, at its last position and size. A window whose folder no longer exists is skipped. If nothing can be restored, a single window opens on Home.

## Menu-bar (tray) menu

- On macOS the app puts a "G" icon in the menu bar; on Windows it's in the notification area. Linux has no tray icon.
- The menu items, top to bottom:
  - "Update now → v<version>" (only when an update is available; installs it and restarts)
  - "New chat session" (opens the chat list)
  - "New code session" (opens the project list)
  - "Remote" (turns Remote, the Telegram connection, on; reads "Remote · Turn off" while it's running, and then turns it off)
  - "Settings" (opens Settings)
- With exactly one window open, the new-session items use it. With several open, they open a new window so no one's work is replaced. If no window is open, one is opened.

## The welcome screen in a new session

- An empty session shows a critter on a small patch of terrain that types a greeting into a speech bubble and ends on a question, such as "What are we building today?".
- The lines differ for Code, Chat, Motion and Goals, and the terrain, critter and lines are picked at random.
- Click the critter and it hops and says hi.
- It disappears as soon as you send your first message.

## Updates

- The app checks for updates in the background about once an hour.
- When one is out, an **Update** key appears on Home showing the current and new version, and an update bar with an install key appears at the bottom of workspaces. Clicking either installs the update and restarts the app.
- While installing, the key becomes an XP bar with a little builder running along it and a percentage, then reads "Updated!" and the app restarts.
- If the install fails, the bar shows **Update failed** with **Retry** and **Download manually** (opens the latest release page on GitHub).
- The tray's "Update now" item does the same install.

## What's new

- **What's new** on Home opens a separate window centred on your screen: a campfire scene with the latest release on a board (**New this time**) and an **Earlier updates** list below it.
- Close it with Escape, Enter, the × (**Close**) or the **Got it** button.
- After an update restarts the app, the What's new window opens once by itself, headed **Fresh off the press** with a **Let's go** button. It does not open on a fresh install.

## About

- **Settings** › **About** has:
  - a short intro from Ken, who builds GG Coder, in a speech box you step through with **Next** (or **Show all**, then **Start over**)
  - links: **Learn with Ken on Skool** and **Watch on YouTube**
  - a calendar of desktop releases, one square per day, shaded from **Less** to **More**; point at or select a day to see what shipped, with **Your version** marked
  - the licence line (GNU AGPL-3.0, no warranty) with a **Source code** link

## Keep awake, sound and appearance

All are in **Settings** › **General**.

- **Appearance**: **Light**, **Dark** or **Auto** (follows your computer). Applies to every window at once.
- **Effects**: **Sound on** / **Sound off** turns all sound effects on or off (remembered on this computer), and **Background on** / **Background off** controls the Home background.
- **Power**: **Keep awake** stops the computer sleeping while the agent works. It's on by default, shows **On** or **Off**, and takes effect immediately, even mid-run. The screen can still turn off.

## Zoom

- Cmd/Ctrl + = (or +) zooms in, 5% per press. Cmd/Ctrl + - zooms out. Cmd/Ctrl + 0 resets to 100%.
- Zoom ranges from 50% to 200%. The level flashes briefly in the middle of the window.
- The level is shared by every window and kept after a restart.

## Keyboard shortcuts

On macOS use Cmd; on Windows and Linux use Ctrl.

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+N | New window |
| Cmd/Ctrl+` | Next window |
| Cmd/Ctrl+Shift+` | Previous window |
| Cmd/Ctrl+Shift+A | Auto-arrange all windows |
| Cmd/Ctrl + = / - / 0 | Zoom in / out / reset |
| Enter | Send a message (in the composer) |
| Shift+Enter | New line in the composer |
| Up / Down | Recall earlier prompts in the composer |
| Tab or Enter | Pick the highlighted item in the `/` or @ menu |
| Escape | Stop the running reply; close a menu, dialog or the What's new window |
| 1–9 | Pick an answer on a question card (when the composer is empty) |
| Enter | Confirm in the New project and Initialize Git dialogs |
| Cmd/Ctrl+Enter | Create, in the new goal dialog |
| Arrow keys, Home, End | Move through dropdowns, the window layout menu, Settings tabs and the About calendar |

- The window shortcuts (`, Shift+` and Shift+A) also work on the project, chat and goal lists.

## Common questions

Q: Why are the Code, Chat, Goals and Motion buttons greyed out?
A: You still need a workspace folder and a connected AI provider. Click any dimmed button and Settings opens at the missing step.

Q: How do I open a second project side by side?
A: Press Cmd/Ctrl+N for a new window and pick the project there, or use the window layout button and choose **2 windows**.

Q: How do I tidy all my windows into a grid?
A: Choose **Auto-arrange all** from the window layout button (or **Arrange** in the **More** panel), or press Cmd/Ctrl+Shift+A.

Q: Will my windows come back after I quit?
A: Yes. Each window reopens with its mode, project, session, position and size, unless its folder was deleted.

Q: How do I remove a project from the list?
A: Click the × on its row (**Hide from this list**). This only hides it; the folder stays on disk.

Q: Where do new projects get created?
A: In your projects folder, set under **Settings** › **General** › **Project folder**. The **New project** dialog shows the exact path before you create it.

Q: How do I update the app?
A: Click the **Update** key on Home, the update bar in a workspace, or "Update now" in the menu-bar menu. It installs and restarts.

Q: The update failed. What now?
A: Click **Retry** on the **Update failed** bar, or **Download manually** to get the latest release from GitHub.

Q: How do I see what changed in the latest version?
A: Click **What's new** at the top of Home. It also opens once by itself after an update.

Q: How do I turn off the sounds?
A: **Settings** › **General** › **Effects**, then click **Sound on** so it reads **Sound off**.

Q: The moving Home background is distracting. Can I turn it off?
A: Yes: **Settings** › **General** › **Effects** › **Background on** toggles it to **Background off**.

Q: How do I switch to dark mode?
A: **Settings** › **General** › **Appearance**, then pick **Dark** (or **Auto** to follow your computer).

Q: Can I stop my laptop sleeping during a long task?
A: **Keep awake** under **Power** in **Settings** › **General** does this and is on by default. The screen may still turn off.

Q: The text is too small. How do I zoom?
A: Press Cmd/Ctrl + = to zoom in, Cmd/Ctrl + - to zoom out and Cmd/Ctrl + 0 to reset. Every window uses the same zoom.

Q: What's in the menu-bar icon?
A: "New chat session", "New code session", "Remote" (on/off), "Settings", and "Update now" when an update is out. There is no tray icon on Linux.

Q: Where can I find the version I'm running?
A: Next to **What's new** at the top of Home, and marked **Your version** on the release calendar in **Settings** › **About**.
