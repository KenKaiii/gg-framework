# Sessions, history and the transcript

A session is one conversation with GG in one window. This page covers starting, resuming and saving sessions, how much context they use, and everything that shows up in the transcript. For the composer, `!` commands and `/` commands see `code-mode.md`. For Chat, Motion and Goals windows see `chat-motion-goals.md`. For where saved sessions live on disk see `troubleshooting-and-data.md`.

## Starting a new session

- From Home, open a project and click **+ New session**.
- Inside a window, open the **More** panel and click **New session** (in a Chat window it reads **New chat**). It starts a fresh session in the same window and project.
- New session is greyed out while GG is running. Stop the run or wait for it to finish first.
- A new session starts with an empty context. Skills and MCP tools added since the last session are picked up.

## Resuming an earlier session

- On Home, click a project. Its earlier sessions are listed.
- Each row shows a preview of the conversation, when it was last active, and how many messages it has (for example "42 msgs").
- Click a row to reopen it. The transcript comes back as the real back-and-forth, including files you referenced.
- If the project has none yet, the list says **No previous sessions yet.** If the list fails to load, click **Try again**.
- To go back to the list from an open window, use **Projects** in the **More** panel (**All chats** in a Chat window, **All goals** in a Goal window).

## Claude Code and Codex conversations

- Projects and sessions from Claude Code and Codex show up in the same lists, with a **Claude Code** or **Codex** badge.
- Hovering over one of these sessions says it opens as a GG Coder session.
- Clicking it imports the conversation and opens it as a normal GG Coder session.

## Hiding and deleting

- A project can be hidden from the Home list with its x button (**Hide from this list**).
- The session list has no delete button. Saved sessions are files under `~/.gg/sessions`. Deleting files there removes that history; do it with GG Coder closed. See `troubleshooting-and-data.md`.
- Old sessions are pruned at startup based on a retention setting.

## Undo, checkpoints and rewind

- The app has no button to rewind a conversation or undo the agent's file edits.
- GG keeps per-chat checkpoint folders on disk (`~/.gg/checkpoints`), cleaned up after 30 days without use, but there is no on-screen control for restoring them.
- To undo file changes, use git (for example ask GG to revert a file, or run `!git restore <file>`), or start a **New session** to drop the conversation context.

## Exporting a chat

- Deck menu › **Export chat** saves the whole conversation as a Markdown file, wherever you choose.
- It reads **Exporting…** while it saves, and it is disabled when the chat is still empty.
- Goal windows don't offer it.

## The workspace header

The one-row bar at the top of every window:

- Left: the back key.
- Centre: the project name with its colour dot. Each project gets its own colour so windows are easy to tell apart. Hover for the full context: folder, branch, uncommitted files, GitHub issues and pull requests, extra folders. Click the name to open the folder.
- Chat windows show the conversation's title instead of a folder, plus the agent's name.
- Right, in Code windows: **Commit** with the number of uncommitted files, **Clean** when there is nothing to commit, or **Initialize Git** when the folder isn't a git repository yet.
- Right, in a started Goal: the **Chat** and **Workers** switch, a working/done/failed tally, and the pause/play button.
- XP gains float up briefly from the right of the bar.

## The More panel

The deck runs along the bottom of the window. Its **More** key (shown as ⋯) opens the **More** panel, which holds these keys (which ones appear depends on the window):

- **New session** / **New chat**: start fresh in this window.
- **Autopilot** (Code): after each run, Ken reviews the work and GG continues if it needs changes. See `code-mode.md`.
- **Checklist** (Code): the project health checklist.
- **Project Health** (Code, once a score exists): scores for file size, hygiene, safety and debt.
- **Notes**: your notes.
- **Tasks** (Code): the project's tasks, with a count of pending ones.
- **Brain** (Chat): memories and Jiwa. See `chat-motion-goals.md`.
- **Goal settings** (Goals).
- **Radio**: internet radio.
- **Export chat**: save the conversation as Markdown.
- **Arrange**: tidy the open windows on screen.
- **Projects** / **All chats** / **All goals**: back to the list.

## Context usage and compaction

- The deck shows a small ring for context use. Hover it for "Context used" and the percentage; it turns hot at 80% or more.
- Click it to open the **Usage** panel. The **Context** meter shows how full the model's context window is, next to your plan's usage windows where the provider reports them.
- Compaction summarises older messages so the conversation fits again. It happens automatically when the context gets close to full.
- To compact by hand, send `/compact`. Add a focus to say what the summary should keep, for example `/compact the database migration decisions`.
- While it works, a critter line appears in the transcript (for example "A critter is munching on the context…"), then a done line saying how many messages became how many.
- Session titles survive compaction.

## Cache expiry notice

- Providers cache the start of a long conversation so it is cheaper to re-send. The cache lapses after the chat sits idle.
- In a large chat whose cache has (or may have) expired, a strip above the composer says your next message re-reads that many tokens at full price.
- **Compact first** summarises older history before you send, so the next message re-reads less.
- **Dismiss** hides the strip; your next message sends as is.
- If compaction can't start, a toast says "Couldn't start compaction. Try again."

## The transcript

- Your messages and GG's replies, rendered as Markdown. Replies stream in as they are written.
- Code blocks have a **Copy** button (it shows **Copied** after clicking).
- Files you referenced with `@` are listed with the message they were sent with.
- Images you attached appear in your message; click one to open it in the image viewer.
- Tool calls appear as compact rows as GG works. While a run is going, one floating line above the deck shows the current step, for example a command it is running, and says so if it failed.
- Hook and review lines from Ken and Autopilot appear as short notes, such as "Plan looks solid. Approved it — implementation is underway."
- Shell commands you ran with `!` show their output with **Stop** while running and **Copy** after. **GG will see this with your next message** means the output is waiting to be sent; **Shared with GG** means GG has already received it.

## Images in the transcript

- Images GG shows you appear as cards with the file name. Click a card to open the file; use **Save image** to save a full-size copy wherever you choose.
- While GG generates an image, a card reads **Creating image** (or **Creating GIF**). You can play a small snake game on it with the arrow keys while you wait; Escape stops it.

## Answering GG's questions

When GG needs a decision, a question card appears at the bottom of the transcript.

- Click an option, or press its number key (a hint under the card says which keys work). One option may be marked **Recommended**.
- For questions that accept free text, just start typing to answer in your own words. Text questions show **Type your answer** and an **Answer** button; once sent it shows **Answered**.
- Multi-choice questions let you pick several, then confirm. With several questions in one card, the button says how many are left, then **Send answers**.
- If the question is no longer needed, the card says it was cancelled. If GG carried on without you, the card says it continued with its best guess and your answer will still be sent.
- There is no skip button; to skip, send a normal message instead, or answer in your own words.
- If a question is scrolled off screen, **You have a new question** jumps to it.

## MCP server input requests

- Sometimes an MCP server pauses a tool call to ask you something. A dialog titled with the server's name ("… needs your input") opens.
- Fill in the fields (lists start at **Select…**) and click **Send**.
- **Decline** refuses the request. **Cancel**, Escape or closing the dialog cancels it. The agent's turn waits until you choose.
- Requests from several servers queue one after another.

## Error notices

- When a run fails, a notice appears in the transcript with a headline (or **Something went wrong**) and a line of guidance.
- **Details** opens what was reported: the message, provider, HTTP status, request ID and time. If there's nothing more it says **No additional detail was supplied.**
- For plan limits, model access, missing capabilities or an outdated app, the notice includes a model picker so you can switch model right there and carry on.
- Errors from Ken or Autopilot are prefixed "Ken:" or "Autopilot:". Old errors from earlier attempts are marked as from a previous attempt.

## Toasts and confirmations

- Short messages pop up briefly for things like failed actions, then fade away on their own.
- Actions that can't be undone ask first in a dialog with **Confirm** and **Cancel** (or a specific label such as **Delete**).

## Moving around the transcript

- **Scroll to bottom** appears after you scroll up.
- **You have new chats** jumps to new output below.
- **You have a new question** jumps to an unanswered question.

## Common questions

Q: How do I start a new session?
A: Open the **More** panel (the ⋯ key on the bottom bar) and click **New session** (**New chat** in a Chat window), or pick a project on Home and click **+ New session**.

Q: Can I go back to an old conversation?
A: Yes. On Home, click the project and click the session in its list. It reopens with the full transcript.

Q: Can I continue a Claude Code or Codex conversation in GG Coder?
A: Yes. Those sessions appear in the project's list with a **Claude Code** or **Codex** badge; clicking one imports it and opens it as a GG Coder session.

Q: How do I delete a session?
A: There's no delete button in the app. Saved sessions are files in `~/.gg/sessions`; delete them there with GG Coder closed.

Q: Can I undo what the agent did or rewind the chat?
A: The app has no rewind or undo button. Use git to revert file changes, or start a **New session**.

Q: How do I save or share a conversation?
A: Deck menu › **Export chat** saves it as a Markdown file.

Q: How do I see how full the context is?
A: Look at the ring in the deck, or click it to open **Usage** and read the **Context** meter.

Q: How do I compact the conversation?
A: Send `/compact`, optionally with a focus such as `/compact keep the API decisions`. It also happens automatically when the context is nearly full.

Q: What does "This chat's cache expired" mean?
A: The chat sat idle so the provider's cache lapsed, and the next message re-reads the whole history at full price. Click **Compact first** to shrink it, or **Dismiss** to send as is.

Q: How do I answer GG's question?
A: Click an option or press its number, or start typing to answer in your own words. For multi-choice, pick several and confirm.

Q: Can I skip GG's question?
A: There's no skip button. Type your own answer, such as "skip this, use your best judgement".

Q: An MCP server is asking for input. What do I do?
A: Fill in the dialog and click **Send**, or click **Decline** or **Cancel**. GG waits until you choose.

Q: What does "Shared with GG" mean?
A: It's on output from a `!` command you ran: GG has already received it. **GG will see this with your next message** means it hasn't been sent yet.

Q: How do I see the full error?
A: Click **Details** on the error notice. For limit or access errors you can switch model from the notice itself.

Q: How do I copy code from a reply?
A: Click **Copy** on the code block.

Q: Where did the conversation go after I scrolled up?
A: Click **Scroll to bottom**, or **You have new chats** when new output arrived below.
