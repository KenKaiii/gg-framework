# Checklist, project health and safety

This page covers two things: checking the user's own project (the Checklist and project health), and how GG Coder protects the user and their machine.

## The Checklist screen

- **Checklist** in a Code-mode window opens the full-page **Project checklist**: GG Coder's built-in project health checks, grouped and listed in recommended run order.
- Three views sit at the top: **All checks**, **Needs review** (anything not passed or not applicable) and **Findings** (checks whose recorded result reported issues).
- Each item shows its title, a short purpose tooltip and its current state, such as **Not reviewed**, **Not applicable**, a "Checked" date, or "Review due".
- Some items also show what GG detected automatically, for example that a CI workflow or a README exists. Detected setup is only a hint. It is never a pass on its own; an item passes only after a recorded review.
- If part of the setup couldn't be looked at, the screen says **Some setup could not be inspected**.

## Every group and item

- Foundations: Agent setup; README & setup docs; Shared vocabulary (one name per concept, a glossary, written-down decisions).
- Source control: Git & GitHub (repo, GitHub remote, .gitignore, protected main branch, no large binaries); Secrets kept out (no keys, tokens or passwords in tracked files or Git history).
- Code quality: Lint, format & type checks; Tests; CI; Commit checks (a project `/commit` that runs checks and a review); Code health (duplication, dead code, very large files); Errors & logging; Dependencies (committed lockfile, clean audit, no unused or abandoned packages).
- Design & UX: Design system; Consistent styling; Consistent animation (including reduced motion); Accessibility; Loading, empty & error states. These are not applicable to projects without a UI.
- Safety: Security audit; Data safety (reversible migrations, backups, recoverable destructive actions); Compliance (privacy policy, terms, cookies, payments, licences).
- Performance: Performance audit.
- Shipping: Build & release (clean build, versions, changelog, release steps); Error reporting (crashes reported somewhere the team sees them, findable logs, health checks).
- Handover: Don't embarrass me.

Several items load a bundled skill first: Secrets kept out, Dependencies and Security audit use `bulletproof`, Data safety uses `durable`, Compliance uses `compliance-guard`, and Performance audit uses `lean`.

## Agent setup and `/init`

- Agent setup is the first item. It checks that a context file (AGENTS.md or CLAUDE.md) exists, matches the code today, and that the project has the skills its recurring work needs.
- Its button runs `/init` (tooltip: "Run /init to create or update project instructions"). This is setup that writes project instructions, not an audit.
- Git & GitHub and CI point to `/setup-ci`, and Commit checks points to `/setup-commit`, as the setup commands that fix most gaps.

## Running a check

- Click **Check** on an item. It shows "Checking…" while the agent works, and checks wait if "The agent is busy".
- Every check apart from Agent setup is report-only ("Check and report, then choose what to fix"). The agent inspects the project and changes no project file. After reading the report, you decide what to fix and ask GG to do it.
- Each review states its scope and what it excluded.
- The verdict, date, commit and evidence are recorded in `.gg-checklist.json` at the project root. That file is meant to be committed, so the whole team shares one record.
- A check you ask for in normal chat ("check my tests", "run a security audit") can be recorded on the checklist too.
- A recorded result is due again after 30 days and then shows as "Review due". If the code has changed since a check, the result says so, so an old verdict isn't trusted blindly.

## Don't embarrass me

- Don't embarrass me (Handover group) is the capstone. It reviews the whole project the way an experienced developer taking it over would, looking for the tells of inexperienced or unreviewed AI-generated work.
- It looks at what a newcomer sees first (root files, README, package metadata, recent commit messages), AI and prototype leftovers, two libraries doing one job, structure, silenced type or lint checks, defensive noise, framework misuse, hard-coded values, and whether the docs are honest.
- Findings are ranked by how quickly a reviewer would notice them and how much credibility each costs, with a fix for each. It also names what already looks professional.
- For secrets, security, tests and failing builds it points you to the dedicated items instead of re-auditing them. It never suggests rewriting published Git history.

## Project health badge and panel

- The workspace header shows a **Project health** score from 0 to 100. It rescans automatically ("Rescans every 2 min"); while it runs you see "Scanning the project…", and a project it can't score shows **Not scored**.
- Click the badge for the **Health breakdown**. **Project Health** in the deck opens the same scores in a panel.
- The score combines four categories: File size (files that are very long, weighted more when they change often), Repo hygiene (secret files that are committed or not ignored, large files, a missing .gitignore or lockfile), Safety net (checks such as tests and CI) and Debt markers (TODO-style markers).
- Some problems hold the score down whatever the rest looks like. A committed secret holds it at 40, and a failed latest CI run holds it at 70. The breakdown says which ("Held at …").
- The scan reports where a suspected secret is and what kind it is, never its value.
- In a very large project the scan may stop early and say "Partly scanned (large project)".
- **Review** next to a category hands it to the agent to look at and fix.
- Project health is a quick automatic scan. The Checklist is the deeper review, done by the agent.

## How do I make sure my app is safe and ready to ship?

- Open **Checklist** and run the Safety group first: Security audit, Data safety and Compliance.
- Then run Secrets kept out, Dependencies, Git & GitHub and CI. Finish with Tests, Build & release, Error reporting and Don't embarrass me.
- Use the **Needs review** and **Findings** views to see what is left, then ask GG to fix the findings you choose.
- You don't need the Checklist to start. Asking in chat works too, for example "do a security review" or "is this ready to launch?".
- No review can promise that an app is fully secure. The security review reports what it checked, what it fixed and what is still open.

## Commands you type with `!`

- In a project you haven't trusted, a command typed with `!` shows **Run this command?**, the command, and the folder it runs in with your normal permissions.
- Choose **Run once**, **Always allow in this project** or **Cancel**. Enter runs and Esc cancels.
- Once a project is trusted, the `!` menu says **Commands run here without asking.** Click **Ask first instead** to turn the question back on.

## MCP servers and trust

- Servers from a project's `.gg/mcp.json` don't connect until that project is trusted, because a repo's config could otherwise run commands as soon as you open it. Adding a project-scope server for that project trusts it. Servers in `~/.gg/mcp.json` always connect.
- When a server sends its tool list, GG checks each tool's description. A tool is hidden, without asking you, if its description tells the agent to read secret or config files, hide something from you, steer how other tools are used, or take over another server's tool. A tool is also hidden if its description changes while the server's version stays the same. Hidden tools are listed under the server in the MCP screen.

## Blocked skills

- Every user skill is scanned for safety when it loads. A skill matching a malware, data-exfiltration or hiding rule is not loaded, and you are not asked about it.
- A warning appears once: "Skill "<name>" blocked for safety: <reason>". It appears again only if the skill's content changes.

## Package and command protection

- GG checks the packages the agent installs against a daily-updated malware feed and known-vulnerability data. It refuses packages with known malware or lookalike names.
- When an install pins an old version with a known high or critical vulnerability and a fixed release exists in the same line, GG moves it to that fixed release.
- Lockfiles already in your project are checked in the background too, so a package flagged after you installed it is still found. You then see a one-time warning such as "Infected package in this project, replacing it", and the agent is told to replace it.
- The agent refuses Git commands that would wipe uncommitted work, scripts piped from the internet straight into a shell, and catastrophic deletes such as wiping your home folder.
- When something is stopped, the chat shows one line starting "Blocked for safety:" and repeats fold into one row. The agent then tells you what it did instead.
- Web pages, files and tool results that try to give the agent orders are flagged, and hidden invisible text in files such as AGENTS.md is removed before the model reads it.

## Files, secrets and the network

- By default the agent can't write outside the project (plus temporary files and GG's own folder). Before writing elsewhere it has to ask you. Folder shortcuts in a repo can't redirect its writes outside the project either.
- Secrets found in your environment are redacted from saved session history.
- Two optional settings in `~/.gg/settings.json` add more control: `networkMode` set to `allowlist` with `networkAllow` limits the agent's web fetch, web search and recognised network commands to listed hosts, and `sandboxMode` (`auto` or `workspace`) runs shell commands in an OS sandbox where supported. Both are off by default and aren't on the Settings screen. The network allowlist is not an OS sandbox. The sandbox can break piped commands on Linux and Git over SSH on macOS.

## macOS Full Disk Access

- On macOS, Settings > General > Permissions shows whether GG Coder has Full Disk Access. **Grant Permissions…** opens System Settings. It is optional and only needed if you want GG to reach protected folders.

## What the agent does without asking

- It reads, edits and runs commands inside your project to do what you asked, and it runs tests or type checks before saying it's done.
- It asks before writing outside the project. Destructive Git commands, malware installs and similar actions are blocked outright.
- Checklist checks never change your files.

## Common questions

Q: How do I make sure my app is safe?
A: Open Checklist and run Security audit, Secrets kept out, Dependencies, Data safety and Compliance, or just ask GG for a security review in chat. You get a report of what was checked, what's wrong and what's still open, and then you choose what to fix.

Q: How do I know my app is ready to ship?
A: Work through the Checklist, especially Tests, CI, Build & release, Error reporting and Don't embarrass me, or ask GG for a launch-readiness check. The Needs review view shows what's left.

Q: Is GG Coder safe to run on my machine?
A: The agent works inside your project, asks before writing outside it, and blocks destructive Git commands, catastrophic deletes, piped install scripts and known-malware packages. No tool can promise perfect safety. For extra isolation, there are an optional network allowlist and shell sandbox.

Q: Why did GG block a skill?
A: Its safety scan matched a malware, data-exfiltration or hiding rule, so the skill wasn't loaded. The warning names the skill and the reason, and it shows again only if the skill changes.

Q: Will a checklist check change my code?
A: No. Every check except Agent setup is report-only. You decide what to fix afterwards.

Q: What's the difference between detected and passed?
A: Detected means GG noticed something exists, such as a CI file. Passed means the agent reviewed it and recorded a pass.

Q: Where are checklist results saved?
A: In `.gg-checklist.json` at the project root, with the verdict, date, commit and evidence. Commit it so your team shares the results.

Q: Why is a check I passed showing as due again?
A: Results come due again after 30 days, and a result also notes when the code has changed since it was checked.

Q: What does the Agent setup button do?
A: It runs `/init` to create or update the project's AGENTS.md-style instructions. It sets things up and is not an audit.

Q: Why is my project health score stuck at 40 or 70?
A: A committed secret holds the score at 40, and a failed latest CI run holds it at 70. Fix that issue and the next rescan lifts it.

Q: How often does project health update?
A: It rescans every 2 minutes. Click the badge for the breakdown, or click Review to have the agent work on a category.

Q: Why did GG ask before running my `!` command?
A: The project isn't trusted yet. Pick Always allow in this project to stop being asked there, or Ask first instead to turn the question back on.

Q: Why isn't my project's MCP server connecting?
A: Servers from a project's `.gg/mcp.json` connect only once that project is trusted. Adding the server for that project in the MCP screen trusts it.

Q: Why is an MCP tool missing?
A: The safety guard hid it because its description tried to steer the agent or changed without a version change. Hidden tools are listed under the server.

Q: GG warned me about an infected package. What now?
A: A package in your lockfile was flagged as malware after it was installed. The agent is told to replace it, and you can ask it to confirm the fix.

Q: Can I limit which websites the agent can reach?
A: Yes. Set `networkMode` to `allowlist` and list hosts in `networkAllow` in `~/.gg/settings.json`. It applies to GG's web tools and recognised network commands, so it is not a full sandbox.

Q: Does GG save my API keys in chat history?
A: Secrets from your environment are redacted from saved sessions, and project health never stores the value of a secret it finds.
