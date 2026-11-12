# Settings

Settings is where you set up GG Coder: how it looks, sounds and behaves, your project folder, your AI providers, your Telegram bot, extra tools (MCP servers) and Steroids. It also has an About page.

## Opening Settings

- On the home screen, click the gear button labelled **Settings**. Its tooltip reads "Settings: AI providers, your projects folder, and more."
- Settings fills the whole window. A row of tab icons runs along the bottom: **General**, **AI Providers**, **Remote**, **MCP**, **Steroids** and **About**. The selected tab widens to show its name, which also appears at the top of the screen.
- Switch tabs by clicking them, or with the Left and Right arrow keys, Home and End.
- Some pages put their status badge and main button in the top bar, next to the page name.
- Click **Back** at the top left to return to the home screen. The home screen then re-checks your folder and providers.
- GG Coder opens Settings for you when something is missing. Opening a workspace without a project folder shows "Set a workspace folder first." and opens General. With no AI provider connected it shows "Connect an AI provider first." and opens AI Providers.

## The tray Settings dialog

- On macOS and Windows, the menu-bar (tray) menu has a **Settings** item. It opens a smaller dialog titled **Settings** over the current window.
- It has the same sections as the General tab. Appearance, Effects and Power apply as soon as you click them.
- In this dialog the project folder is only saved when you click **Save**. **Cancel** closes it without saving the folder.

## General

General opens first. It has no Save button: every change saves as soon as you make it.

### Permissions (macOS only)

- Shows whether GG Coder has Full Disk Access, with a **Granted** or **Not granted** badge.
- **Grant Permissions…** opens your computer's System Settings so you can turn on Full Disk Access. Once granted, the button reads **Permissions granted** and is greyed out.
- GG Coder checks again each time you switch back to its window, so the badge updates on its own.
- The section is hidden on systems where there is nothing to grant.

### Appearance

- Pick **Light**, **Dark** or **Auto**. Auto follows your computer's light or dark setting.
- The default is Dark.
- The change applies right away, to every GG Coder window.

### Effects

- **Sound on** / **Sound off** turns all of the app's sound effects on or off. Sound is on by default. Turning it back on plays a click to confirm.
- **Background on** / **Background off** turns the moving background on the home screen on or off. It is on by default.
- Both choices are kept on this computer and last after a restart.

### Power

- **Keep awake** stops your computer from going to sleep while the agent is working. The screen can still turn off.
- A badge next to it shows **On** or **Off**. It is on by default.
- The change applies right away, including to a task already running, and is remembered.

### Project folder

- The folder where new projects are created. The example text in the box is /Users/you/gg-projects.
- Type a path and press Enter or click outside the box, or click **Browse…** to pick a folder. Either way it saves immediately and "Project folder saved." appears.
- If you clear the box, nothing is saved and the folder you saved before comes back.
- If you have never saved a folder, the section says "Not saved yet. Press Enter to use this folder, or Browse for another." Until you save one, opening a workspace sends you back here.
- Changing the folder doesn't affect your saved models, Autopilot choices, hidden projects or local endpoints.

## AI Providers

- Shows every AI provider you can connect, grouped by region around an animated brain. A badge shows how many are connected, for example "0 connected".
- Click a provider to connect it: sign in through your browser, or paste a key into the **Paste your API key** box and click **Connect**.
- On a connected provider, **Replace** swaps in a new key or sign-in and **Disconnect** removes it. With both methods connected, the bottom button reads **Disconnect both**.
- The **Local models** and **Hugging Face** cards set up models that run on your own computer.
- You need at least one connected provider (or a local model) before you can open a workspace or start Remote.
- Choosing a model and thinking level is not done here; it's in the Model panel inside a session. See the models and sign-in page for every provider and the Model panel.

## Remote

Remote lets you message your agent on this computer from your phone, using your own Telegram bot. The setup is titled **Telegram setup**.

- **Bot token**: create a bot with @BotFather in Telegram (send /newbot), then paste the token it gives you. If a token is already saved, the box shows a shortened version. Leave it blank to keep the saved token.
- **Your Telegram user ID**: your numeric Telegram ID. Message @userinfobot in Telegram to find it. The box accepts only digits.
- **Save bot** (top right) checks the token and saves your bot. On success "Telegram connected." appears; if the check fails, the error appears under the boxes.
- **Start serving** starts the bot. It stays greyed out until a bot is saved ("Save your bot first"), and needs a connected AI provider. While running it shows "Serving on Telegram — message your bot."
- **Stop serving** turns the bot off.
- A badge next to the page name shows **Live** while the bot is running and **Off** when it isn't.
- On macOS and Windows, the tray menu's Remote item reads "Remote · Turn off" while the bot is running.

## MCP

MCP servers are extra tools your agent can use.

- Choose **Global** to work with servers available in every project, or **Project** for one project. With Project, type the project's path or pick it from the list. The **Servers** list shows the servers for the scope you chose.
- **Sign in** connects a server that needs you to log in. The x next to a server removes it.
- **Add a server**: paste a `claude mcp add` command, for example `claude mcp add --transport http notion https://mcp.notion.com/mcp`, then press Enter or click **Add** at the top right.
- Windows that are already open load a new server right away.
- If nothing is set up yet, the list says "No MCP's configured".

## Steroids

Steroids lets your agent read current code from real repositories on your computer before it writes code. It is free and works offline.

- **Status** shows **Connected**, **Empty corpus**, **Not installed** or **Broken**. When connected it also shows the version, number of repos and files, and disk space used.
- **Install Steroids** installs it when it isn't installed yet.
- If it is installed but has no repositories, the page suggests asking the agent to "curate a Steroids corpus for this project".
- **Read the README** opens the Steroids documentation.
- When Steroids is not connected, a small red dot appears on the Steroids tab icon.

## About

- Who makes GG Coder: Ken Kai, with **Learn with Ken on Skool** and **Watch on YouTube** links.
- **Desktop app releases**: a calendar with one square per day since the first release. Brighter squares mean more releases that day. Point at a day to see what changed. The day your installed version shipped is marked **Your version**.
- **Read every release** opens the full list of release notes.
- The license notice and a **Source code** link.

## What is not in Settings

- Model and thinking level: the Model panel in each session, saved per project.
- Ken's model: the Ken target in the Model panel.
- Autopilot is switched on per project inside a code window.
- Other agent behaviour (for example compaction) has no switch in the app.

## Common questions

Q: Where is Settings?
A: On the home screen, click the gear button labelled **Settings**. On macOS and Windows the tray menu also has a **Settings** item.

Q: Do I need to press Save?
A: Not on the Settings screen; every change saves as you make it. Only the tray Settings dialog has a **Save** button, and it only saves the project folder.

Q: How do I switch to light mode?
A: In **General**, under **Appearance**, click **Light**, or **Auto** to follow your computer. It applies to every window at once.

Q: How do I turn off the sounds?
A: In **General**, under **Effects**, click **Sound on** so it reads **Sound off**.

Q: How do I stop the moving home background?
A: In **General**, under **Effects**, click **Background on** to turn it off.

Q: Why does my computer stay awake?
A: **Keep awake** under **Power** is on by default while the agent works. Click it to turn it off; the screen can still sleep either way.

Q: Where are new projects created?
A: In the folder under **Project folder** in General. Type a path and press Enter, or use **Browse…**.

Q: It keeps saying "Set a workspace folder first."
A: Open **General** and press Enter in the **Project folder** box, or browse for a folder. It saves right away.

Q: Where do I add my API key?
A: In the **AI Providers** tab. Click the provider, paste the key and click **Connect**.

Q: Where do I change the model in Settings?
A: There is no model setting in Settings. Click the model name in the bar under the message box in a session.

Q: How do I use GG Coder from my phone?
A: In **Remote**, paste your bot token and Telegram user ID, click **Save bot**, then **Start serving**.

Q: How do I add an MCP server?
A: In **MCP**, paste a `claude mcp add` command into the add box, choose **Global** or **Project**, and press Enter.

Q: Why is there a red dot on the Steroids tab?
A: Steroids isn't connected. Open the tab to install it or to see why it isn't working.

Q: Why is the Permissions section missing?
A: It only appears on macOS, where GG Coder can ask for Full Disk Access.

Q: How do I see what changed in each release?
A: Open **About**, point at a day in the release calendar, or click **Read every release**.
