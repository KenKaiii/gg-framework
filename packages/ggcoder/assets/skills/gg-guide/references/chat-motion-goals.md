# Chat, Motion and Goals

Home has four buttons: **Code**, **Goals**, **Chat** and **Motion**. Code is for working in a project folder. The other three are covered here. Chat and Motion both need a projects folder: set one in **Settings** first.

## Chat

Chat is for talking things through. You don't need a project.

How do I open Chat?
- On Home, click **Chat**. The **Chats** list opens and shows your earlier chats, with a preview, when each was last active and how many messages it has.
- Click **+ New chat** to start a new one, or click an earlier chat to pick it up again.
- If no projects folder is set, the list says: "Choose a projects folder in Settings before starting a chat."

What are the chat agents?
- There are three. The window header shows which one is active: General, Therapist or Research.
- General handles broad, everyday conversation.
- Therapist handles emotional support, reflection, coping, relationships and wellbeing.
- Research handles evidence, sources, current information, comparisons and deep analysis.
- New chats start with General unless they continue from another agent.

How do I switch agents?
- The agents hand the conversation to each other. When the main need of a chat clearly changes, the active agent passes the whole conversation to a better-suited one, and the header label changes.
- A handoff keeps the full conversation history. It lasts until the next handoff and isn't a one-off side task.
- When you reopen a chat, it opens with the agent that was last active in it.
- There's no agent picker button. To steer things, ask in the chat, for example "let the research agent handle this".

What does Chat remember?
- All three agents share one memory. The agents save lasting facts about you on their own, without being asked. These include who you are, stable preferences, ongoing projects or goals, important relationships or dates, recurring constraints, and significant health or work context.
- They don't save one-off task details, conversation summaries, guesses, passwords or secrets, or passing moods.
- Jiwa is a second shared store. It holds lasting instructions about how the chat agents should behave: a name or persona you gave them, tone and formatting, interaction style, boundaries and preferred workflow. It also holds requests to stop doing something that annoys you.
- To add or remove something, say so in the chat. The agents act on "remember…", "forget…" and "stop doing…".
- Each entry is at most 600 characters. When a store reaches about 60 entries, the agents merge related ones and remove old ones. 90 is the upper limit.

How do I view or delete memories?
- In a chat, open the **More** panel from the window's bottom bar and click **Brain**.
- The **Brain** window has two tabs, **Memories** and **Jiwa**. Each tab is a table showing the entry, its **Category**, its **Importance** (1 to 5) and when it was last **Updated**.
- To delete an entry, click the bin icon on its row. An empty tab says **No durable memories yet.** or **No Jiwa instructions yet.**
- Memories are stored in `~/.gg/chat-memories.json` and Jiwa in `~/.gg/chat-jiwa.json`.

Other chat controls (the **More** panel):
- **New chat** starts a new conversation. It's unavailable while the agent is replying.
- **Export chat** saves the conversation as a Markdown file. It's greyed out until the chat has messages.
- **Add folder** lets the chat agents read and work with files in another folder you pick, such as a folder of documents. The header shows how many are attached.
- **Remove folder** (shown once a folder is added) lists the added folders. Click **Remove** next to one to drop it.
- **Notes** opens a notes pad that is saved on this computer.
- **Radio** plays internet radio: pick a station, then press **Play** or **Pause** and set the volume.
- **All chats** goes back to the **Chats** list.

Where do chat files live?
- The chat workspace is a folder called `GG Chat` inside your projects folder. It never shows up in your project list.

Chat skills:
- Skills for Chat go in `GG Chat/.gg/skills/<name>/SKILL.md`, with `name` and `description` frontmatter.
- Every chat and all three agents can use them. Code and Motion can't. A new skill loads when you start the next chat.

## Motion

Motion makes short videos and animations from a request: product launches, app walkthroughs, website videos, before-and-after videos, developer tool videos, or a video in the style of an example you supply.

How do I start a video?
- On Home, click **Motion**. The **Motion** list shows earlier video sessions. Click **+ New video** to start a new one, or reopen an earlier session.
- Starter chips fill in the start of a request, and you finish the sentence before sending:
  - **Make a product launch**
  - **Make an app walkthrough**
  - **Make a website video**
  - **Make a before and after**
  - **Make a developer tool video**
  - **Make one like my example**
- You can also just type what you want and attach a logo, photos, screenshots, footage or an example video.

What will I be asked?
- Motion asks only what it can't work out, on a single card of at most four questions. A detailed request gets no questions.
- Typical questions:
  - Where people will mostly watch it: on a phone (tall video), on a website or YouTube (wide), slides or a big screen, a background loop, or sent to someone.
  - Whether it should have music.
  - What to build the visuals from: your images, photos from your website, illustrations, or a mix.
  - What it should include.
  - What people should get from it.
  - How it should feel.
  - How long it should be: about 10 seconds, about 30 seconds or about a minute.
- For a new video it may also pitch two or three ideas, plus "Let GG Motion choose". This only gathers your preference. It isn't an approval step.

How is it made and rendered?
- Motion builds the video in one go, checks a few still frames, then renders the final video once, with sound and motion blur.
- The render also adjusts the volume and checks the video for harmful flashing. A video that fails the flashing check is fixed and rendered again, never delivered.
- When it's done, Motion opens the file for you and says what it checked. Stills aren't the same as watching it play, so watch the video yourself.
- It re-renders only to fix something visibly broken. For an edit, ask in the same session. Only what you asked for changes.

Where are videos saved?
- **Motion** sessions are listed like chats. The **More** panel has **New session**, **Notes**, **Radio** and the way back to the list.

- Each video gets its own folder inside the `GG Motion` folder in your projects folder.
- Finished files go in that video's `renders/` folder as versioned `.mp4` files, such as `name-v1.mp4`. Earlier exports are never overwritten.

Limits:
- Motion uses only real material: your product's real name, words, colours, logo and screens. It won't invent features, facts or prices. If assets are missing, it asks for them.
- It won't generate images unless you ask. Drawn scenes are built as illustrations instead.
- It asks before overwriting a finished export, deleting things, installing software or spending money.
- A new video always starts fresh, even for the same subject. To change an earlier video, reopen its session or say which one you mean.
- Motion has its own skills, stored in `GG Motion/.gg/skills`. It can't use Chat skills.

## Goals

A goal is a long-running objective that's too big for one session, for example "Get checkout loading under one second on mobile". Goals hands it to GG Goals, an agent that coordinates a team of worker agents.

How do I create a goal?
- On Home, click **Goals**. The **Choose a goal** list opens. You can search by name or goal text. Each row shows when the goal was last active and, when it matters, a status: **Running now**, **Paused** or **Interrupted**. Goals still in briefing or finished show no status.
- Clicking a goal reopens its conversation. A goal is one ongoing conversation, so there's no session list.
- Click **+ New goal**. In the **New goal** window, fill in:
  - **Name**: up to 15 characters.
  - **Goal**: the objective, up to 2000 characters.
  - **Context** (optional): click **Add**, then **Add folders** or **Add files**. Up to 20 items, such as repos, specs or mock-ups. Remove one with its x button.
  - **Instructions** (optional): rules for the whole goal, up to 4000 characters, for example "Ask before adding dependencies". GG Goals and its workers follow them throughout.
- **Create goal** stays greyed out until Name and Goal are filled in. The goal opens straight away.

Briefing, then starting:
- A new goal starts in its briefing phase. GG Goals replies on its own: it sums up the goal, asks questions, and does no work.
- When you're ready, choose the start option on GG Goals' question card, or type "start the goal now". This switches the goal to active, and work begins. A question or a delayed start ("start it tomorrow") doesn't count.
- If GG Goals needs an answer while it works, a **Ken needs you** sign appears over the farm with the question, and "And 1 more question" if there are more. Click **Answer in Chat** to reply. Questions wait safely even if you reload.

The goal world, and Chat | Workers:
- Once a goal is active, its window shows the goal world: GG Goals and its workers appear as critters on a top-down farm.
- Critters walk to the place for what they're doing: the bookcase to read, the laptop for the web, the notes board to plan, the carpenter's bench to edit, the stove to run things, the post box to ask you something, and the tea bench by the fire to wait.
- A small status pill on the farm says what GG Goals is doing right now, with a timer.
- You can click things on the farm to make them react and play a sound. Your sound setting mutes them.
- Point at a critter on the farm to see its name and what it's doing. Workers come and go in different ways (through the gate's light, by saucer, on foot), and now and then a visitor turns up. It's decoration and needs no action.
- The header switch flips between **Chat** (the conversation) and **Workers** (the farm). The **Chat** button is highlighted when a question is waiting for you.
- The header also shows how many workers are working, how many tasks are done and how many failed. Next to it is a play/pause button: **Pause the goal**, **Resume the goal**, or "Not running. Carry the goal on" when the goal has stopped.

When a goal finishes:
- A card appears on the farm with Ken's face, his parting line and the score: **Time**, **Workers** (and how many failed), **Turns** and **Tokens**.
- Its title is **Job done**, **Done, not all checked** (finished but not everything verified) or **Ken got stuck**.
- Click **Read summary in Chat** for the write-up, or **Close**. Cancelled runs show no card.

Goal settings:
- In the **More** panel, click **Goal settings** to change the goal's standing instructions and its attached folders and files, then click **Save**.
- You can't change settings while the goal is working. Pause it first. GG Goals picks up the change on its next step.
- **All goals** in the **More** panel goes back to the goal list. Goals also have **Radio**, but no **Notes**, **New session** or **Export chat**.

Critters model:
- In a goal, the model picker has a second setting, **Critters**, for the workers. By default it follows GG Goals' model. Pick a different model to run workers on it.

Deleting a goal:
- In **Choose a goal**, hover a goal and click the bin icon (**Delete goal**), then **Delete**. This removes the goal and its conversation. Attached folders and files are not touched. It can't be undone. There's no archive.

Where does goal data live?
- Each goal has a folder at `~/.gg/goals/<id>/`, containing `goal.json` with its name, goal text and the attached paths.
- Goal folders never appear in the project list. A goal isn't a project and isn't a project task.

## Common questions

Q: How do I start a new chat?
A: On Home click **Chat**, then **+ New chat**. Inside a chat, use **New chat** in the **More** panel.
Q: How do I go back to an old chat?
A: Open **Chat** from Home and click it in the **Chats** list. It reopens with the agent that was last active.
Q: How do I switch to the Therapist or Research agent?
A: There's no picker. Ask in the chat, or just talk about what you need. The agent hands the whole conversation over when the need changes.
Q: How do I make GG forget something?
A: Say "forget …" in a chat, or open **Brain** from the **More** panel and click the bin icon on that entry.
Q: How do I see what GG remembers about me?
A: Open **Brain** in a chat. The **Memories** tab holds facts about you, and **Jiwa** holds instructions on how the agents should behave.
Q: How do I make the chat agents stop doing something?
A: Say "stop doing …" in a chat. It's saved to Jiwa and all three agents follow it.
Q: How do I save a chat?
A: Click **Export chat** in the **More** panel to save it as a Markdown file.
Q: Where are chat skills kept?
A: In `GG Chat/.gg/skills/<name>/SKILL.md` inside your projects folder. They load from the next new chat.
Q: Why can't I start a chat or a video?
A: Chat and Motion need a projects folder. Choose one in **Settings** first.
Q: How do I make a video?
A: On Home click **Motion**, then **+ New video**. Pick a starter chip or type your request, attach any logo, screenshots or footage, and answer the short question card.
Q: Where is my video saved?
A: In that video's `renders/` folder, inside the `GG Motion` folder in your projects folder, as a versioned `.mp4`. Motion opens the file when it's done.
Q: How do I change a video Motion made?
A: Reopen its session from the **Motion** list and say what to change. Only that part changes, and the new render gets a new version number.
Q: Can Motion make up images or facts?
A: No. It uses your real product, words and assets, asks for missing ones, and only generates images if you ask.
Q: How do I create a goal?
A: On Home click **Goals**, then **+ New goal**. Fill in **Name** and **Goal**, optionally add context and instructions, and click **Create goal**.
Q: Why isn't my goal doing any work?
A: New goals start in briefing, where GG Goals only asks questions. Choose the start option or type "start the goal now".
Q: How do I pause a goal?
A: Click the pause button in the goal's header (**Pause the goal**). Click it again to resume.
Q: How do I change a goal's instructions or folders?
A: Pause the goal, then open **Goal settings** in the **More** panel, edit, and click **Save**.
Q: What does "Ken needs you" mean?
A: GG Goals has a question for you. Click **Answer in Chat** to reply.
Q: How do I watch the workers?
A: Use the **Chat** | **Workers** switch in the goal's header. **Workers** shows the farm.
Q: What happens when a goal is done?
A: A finish card shows the outcome, time, workers, turns and tokens. Click **Read summary in Chat** for the details.
Q: How do I delete a goal?
A: In **Choose a goal**, click the bin icon on its row, then **Delete**. Your attached files are kept, but this can't be undone.
Q: Can workers use a cheaper model?
A: Yes. Set the **Critters** model in the goal's model picker. By default it follows GG Goals.
Q: Where is goal data stored?
A: In `~/.gg/goals/<id>/`, with the goal's details in `goal.json`.

Q: Can the chat look at files in one of my folders?
A: Yes. Click **Add folder** in the **More** panel (the ⋯ key on the bottom bar) and pick the folder. The agents are told about it before their next reply.
