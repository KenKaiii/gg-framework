# Working in a Code-mode window

A Code-mode window is one session on one project folder. You type in the composer at the bottom. GG works in the transcript above it, and the deck holds the tools.

## The composer

- Enter sends. Shift+Enter adds a new line.
- The placeholder reads **Type a message, / commands, @ files, @Ken for help**. Every few seconds it rotates to another tip, such as **Start with ! to run a command, like !git status** or **Need a second opinion? Ask @Ken**. While GG is working the tips change to ones like **Got another thought? Queue it here**.
- Up and Down in an empty composer bring back prompts you sent earlier. In a multi-line draft they move the cursor as usual.
- Esc stops the current run (or Ken) when no menu is open. With the slash menu open, Esc clears the input.
- `/` opens the command menu, `@` opens the file picker and `!` opens the command picker. Each menu works with Up/Down, Tab or Enter to pick, and Esc to close.

## Mentioning files with @

- Type `@` and part of a file name to open the file picker. With nothing typed after `@`, it shows recent files.
- Picking a file adds it as a chip above the input. GG gets the list under **Referenced files:** when you send. Remove a chip to drop that file.

## Attaching images and files

- Click **Attach files** (the paperclip) to choose files. You can also drag files onto the composer or paste them from the clipboard.
- Attachments show in a bar above the input, and each one can be removed. Click an image to open it.
- Images and videos are recognised by type. Anything else, such as a PDF or a text file, is sent as a file.
- All attachments in one message can add up to 100 MB. Above that you get "Attachments are too big to send" and nothing is sent.
- If the current model can't watch video, the transcript notes that GG can still pull frames or audio out of it, and suggests switching to a video-capable model.
- Send stays disabled while attachments are loading. Its tooltip reads **Loading attachments…**.

## Sending while GG is busy

- You can keep typing during a run. Enter queues the message instead of interrupting.
- A queued message goes to GG at the next turn boundary, not after the whole run ends. The strip above the input says **queued for the next turn**.
- To cancel one queued message, click its x (**Cancel this queued message**). If several are queued, the strip shows how many. Open it with **cancel…** and cancel them one by one. A message that is already being delivered can't be cancelled.

## Stopping a run

- During a run the round send button becomes **Stop the run**. Click it or press Esc to stop.
- That button stops GG's run and also stops an Autopilot review in progress.

## Running your own commands with !

- Start the input with `!` to run a shell command in the project folder, for example `!git status`. This doesn't start an agent turn, and it works even while GG is running. The send button reads **Run command**.
- Typing `!` opens a **commands** picker. It lists commands you've run here, most used first, then commands that fit the project.
- The first time you run a command, GG asks **Run this command?** and shows the folder it will run in. You can choose:
  - **Run once** (Enter): run it this time only.
  - **Always allow in this project**: future commands in this project run without asking.
  - **Cancel** (Esc): the transcript shows that it didn't run.
- Once a project is trusted, the picker footer says **Commands run here without asking.**. Click **Ask first instead** to turn confirmation back on.
- Output streams live, with errors in their own colour and an elapsed timer. Click **Stop** to end a running command. When it finishes you see the exit code and duration, and **Copy** copies the output. Long output folds behind a show-all control.
- GG doesn't see the output right away. The block reads **GG will see this with your next message**, and after you send it reads **Shared with GG**.

## Working across more than one folder

- Click **Add folder** in the **More** panel (the ⋯ key on the bottom bar) and pick a folder. GG can then read and edit it as well as the project, and it's told about the folder before its next step.
- It works in Code and Chat windows. The header shows how many extra folders are attached, and the title tooltip lists them.
- You can add a folder while GG is working. A folder already inside the workspace can't be added twice, and the message says why.
- Commands in the added folder's `.gg/commands` show up in the `/` menu.
- To drop one again, click **Remove folder** (it appears right after **Add folder** once a folder is added). The **Added folders** panel lists each folder with its own **Remove** key.

## Slash commands

Type `/` to open the menu. You only see commands in a Code-mode window.

- `/schedule` (alias `/sched`): run a prompt on a repeating schedule (see Schedules below).
- `/init`: create or update CLAUDE.md for this project.
- `/commit`: runs the project's checks and tests and fixes failures, has a helper review the diff, stages the changed files, commits with a one-line message and pushes if the branch has an upstream. If the review finds real issues, GG asks whether to fix them first or commit anyway. A project's own `.gg/commands/commit.md` takes precedence.
- `/setup-commit`: writes a project-specific `.gg/commands/commit.md` with that project's checks.
- `/setup-ci`: set up or harden CI for any stack.
- `/expand`: researches similar products and reports a ranked table of user-facing features to add. Nothing is changed until you pick an option. Text after the command sets a focus.
- `/compare`: compares the code GG just wrote in this chat with how real projects do it, using the Steroids code index.
- `/steroids`: finds well-maintained repos like this project, shows them in a table, asks how many to index, then adds them to the Steroids index. It needs Agent Steroids installed.

Custom commands: each Markdown file in the project's `.gg/commands/` folder becomes a `/<name>` command with its own description. Folders added with **Add folder** bring their `.gg/commands` too. A custom command can't take over a built-in name.

## Schedules

- Format: `/schedule <prompt> | <interval> [| <times>]`, for example `/schedule run the full test suite | 1h30m | 10`.
- The interval uses minutes or hours: `15m`, `2h`, `1h30m`. Seconds aren't accepted. Leave out the run count to repeat until you stop it. A pipe inside the prompt is fine.
- A hint above the composer shows each part as you type and flags a mistake before you send. Pressing Enter adds a transcript line starting "Scheduled ·", followed by something like "Every 15 min · until stopped".
- Active schedules appear as an "N schedules" button. It opens **Schedules**, with each one's cadence, progress and next run, plus a **Stop** button. Schedules only run while that window stays open.

## Prompt enhancement

- To enhance a prompt, type a draft and click **Enhance**, the small key to the left of send. Its tooltip reads **Rewrite your prompt with clearer wording and the right terms**.
- The key only shows when there is text in the composer. It hides while the slash or @ menu is open, while you're typing a `/schedule`, and once the current text is already enhanced.
- While it works, the key reads **Enhancing…**. Your draft fades out, a shimmer holds its place, and the new text types itself in. You can't type during the animation. With reduced motion turned on in your system, the text is simply replaced.
- What it does: it rewrites your draft into a clear request for GG. It keeps your intent (a question stays a question), keeps every path, name and number, and doesn't add scope. A clear draft can come back almost unchanged.
- Technical terms it swaps in are highlighted. Hover one to see **you said:** with your original words and a short note. The highlight also stays on the sent message in the transcript.
- It uses the model currently selected for this window, so it bills like any other request to that model.
- Nothing is sent until you press Enter. You can edit the result first. Editing it removes the highlights and brings the Enhance key back.
- There is no undo button. To get your original back, retype it or use the text editing undo in the field if your system supports it.
- If enhancement fails, an error notice appears and your draft stays as it was.

## Plan mode and plan review

- In plan mode GG reads and plans but edits nothing. The deck shows a **Plan mode** flag.
- There is no plan-mode switch for the user. GG enters plan mode itself for larger or riskier changes, and you can ask it to plan first.
- When GG finishes a plan, the **Plan review** screen opens with the plan and the status **Your call on the plan**.
  - **Accept plan**: GG leaves plan mode and carries the plan out.
  - **Reject**: turns the plan down. GG doesn't start the work.
  - Type in the **Tell GG what to change in the plan…** box and press Enter (or click send) to ask for a revision. GG revises and shows the plan again.
- While Autopilot is on, Ken may review the plan as well. The status then reads **Ken is reviewing it. Your call still wins**.
- During a run, the activity bar shows plan progress as "Plan: step X of Y".

## Autopilot

- Turn **Autopilot** on or off in the **More** panel (the ⋯ key on the bottom bar). After each run, Ken reviews the work and GG continues if it needs changes. Busywork such as commits or status checks is skipped.
- You can't change the switch during a run or a review.

## Tasks

- **Tasks** in the deck lists the project's tasks. Each shows **Pending**, **Running** or **Done**.
- You don't type tasks in yourself. Ask GG to add tasks, for example "add a task to fix the login bug". With none yet, the list says **No tasks yet. Ask the agent to add tasks, then run them here.**
- **Run** starts that task in a fresh session. **Run all** runs every pending task, one fresh session each. Both are disabled while GG is running.
- The x (**Delete task**) removes a task.

## Notes

- **Notes** opens **Your notes**, a free-text notepad kept per project on this computer. GG never sees it, and it saves as you type.

## Checklist and project health

- **Checklist** opens the project checklist: tests, CI, security, design and more. It shows how many items pass, and you can run a check on any item.
- The project health badge shows a score and **Rescans every 2 min**. Click it for a breakdown and an option to have GG review project health. **Project Health** in the deck opens the full scores for file size, hygiene, safety and debt.

## Git in the title bar

- In a folder that isn't a git repository yet, the title bar shows **Initialize Git**. It opens a dialog that sets up git, creates a GitHub repository and configures CI for the stack.
  - **Repository name** defaults to the folder name. If it needs cleaning up, the dialog shows the name it will use.
  - Visibility: Private or Public.
  - **Also set up**: **CI workflow + Dependabot**, **Branch protection** and **AGENTS.md**, each a checkbox.
  - Click **Initialize** (or press Enter in the name field), and GG does the setup as a normal run. **Cancel** closes the dialog.
- In a repository with uncommitted changes, the title bar shows **Commit** with the number of changed files. Clicking it runs `/commit`.
- When there is nothing to commit it shows **Clean** (tooltip **Nothing to commit**).
- These buttons are disabled while GG is running.
- The deck's **Git** panel shows the branch, uncommitted files, and pull requests and issues for GitHub projects.

## CI indicator

- When the project has GitHub Actions CI, an indicator shows the number of runs and their status: running, passed or failed. Running shimmers. Click it to open GitHub Actions.
- A finished, passing result hides itself after about 10 seconds. A failure stays until you click **Dismiss CI failure**.
- If the status can't be fetched it reads **CI unavailable**, and the last result may be out of date.

## Activity bar and working beam

- The activity bar above the composer shows what GG is doing. Idle, it shows lines like **Ready for work** or **Your move**. During a run it shows lines like **Working…** and a timer, then a short summary when it finishes.
- While GG, Ken or an Autopilot review is running, a light beam moves around the composer. It is decorative only.

## Sub-agents

- When GG sends out helpers, a "critter" feed tracks them: launched, still working, finished, failed or called back. Ken and Autopilot are covered in ken-and-autopilot.md.

## Notices in the transcript

- Compaction: when the context is compacted, a critter line shows it working and then done.
- Cache expiry: in a large chat that has been idle, a strip warns that the next message will re-read the whole context at full price. **Compact first** shrinks the history before you send, and **Dismiss** hides the warning.
- Hooks: when a project hook steps in, a shimmering pink critter line says what it's doing, for example "A critter is running the project's checks…". Others cover reviewing the work, re-checking new edits, checking that tests weren't weakened, breaking out of a loop, or re-reading the request after compaction. They are informational; no action is needed.

## Moving around the transcript

- After you scroll up, **Scroll to bottom** appears in the corner.
- **You have new chats** jumps to new output that arrived below.
- **You have a new question** jumps to a question from GG that is off screen and still needs an answer.

## Common questions

Q: How do I enhance my prompt?
A: Type a draft, then click **Enhance** next to the send button. GG rewrites it with clearer wording using the current model, and you can edit it before pressing Enter.
Q: Can I undo an enhancement?
A: There is no undo button. Edit or retype the text; any change removes the enhancement highlights.
Q: What are the highlighted words after enhancing?
A: They are technical terms swapped in for your wording. Hover one to see what you originally said.
Q: How do I commit my changes?
A: Click **Commit** in the title bar, or type `/commit`. GG runs the checks, reviews the diff, commits and pushes.
Q: Why does the title bar say Clean?
A: There are no uncommitted changes in the project, so there is nothing to commit.
Q: How do I put my project on GitHub?
A: In a folder without git, click **Initialize Git**, pick a name and visibility, choose extras, and click **Initialize**.
Q: How do I run a terminal command?
A: Start the message with `!`, for example `!git status`, and press Enter. It runs in the project folder without starting an agent turn.
Q: How do I stop being asked before every command?
A: Choose **Always allow in this project** on the confirmation. To turn asking back on, click **Ask first instead** in the `!` picker.
Q: How do I stop a command that's running?
A: Click **Stop** on its output block.
Q: Does GG see my command output?
A: Yes, with your next message. The block shows **Shared with GG** once it has been sent.
Q: Can I send a message while GG is working?
A: Yes. It is queued and delivered at the next turn boundary. Click its x to cancel it.
Q: How do I stop GG?
A: Click the square send button (**Stop the run**) or press Esc.
Q: How do I reference a file?
A: Type `@` and part of the file name, then pick it with Enter or Tab.
Q: How big can attachments be?
A: Up to 100 MB in total per message.
Q: How do I bring back something I typed earlier?
A: Press Up in an empty composer to step through earlier prompts.
Q: How do I make GG plan before changing code?
A: Ask it to plan first. When the plan is ready, choose **Accept plan**, **Reject**, or type what to change.
Q: How do I run something every hour?
A: Use `/schedule <prompt> | 1h`. Add `| <times>` to limit the runs. The window must stay open.
Q: How do I stop a schedule?
A: Open the schedules button above the composer and click **Stop** next to it.
Q: How do I add tasks and run them?
A: Ask GG to add tasks, then open **Tasks** in the deck and click **Run** or **Run all**.
Q: How do I add my own slash command?
A: Put a Markdown file in the project's `.gg/commands/` folder. Its file name becomes the command, unless a `name:` line at the top sets another name.
Q: How do I work on two folders at once?
A: Click **Add folder** in the **More** panel (the ⋯ key on the bottom bar) and pick the folder. To drop it, click **Remove folder** and then **Remove** next to it.
Q: Where can I keep private notes?
A: Open **Notes** in the deck. GG never sees them.
