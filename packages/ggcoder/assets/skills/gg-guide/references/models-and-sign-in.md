# Models and sign-in

How to connect AI providers in the GG Coder desktop app, choose a model and thinking level, use local models, and read your plan usage.

## Where providers are connected

- Open Settings from the home screen and choose the **AI Providers** tab. A badge next to the page name shows how many providers are connected, for example "2 connected".
- If the list can't be read, the page says "Couldn't read your AI providers." with a **Try again** button.
- GG Coder also sends you here itself: if you try to open a workspace with no provider connected, it shows "Connect an AI provider first." and opens this tab.
- Every window shares the same sign-ins. Connecting or disconnecting in one window updates the others.

## The providers brain

- The page shows a 3D brain in the middle with provider cards around it, grouped by region: United States, China, Japan, Gateways and Other. Each group heading shows a count such as "1 of 3".
- When you connect a provider, a glowing nerve runs from its card into its own part of the brain, and the brain lights up more as you connect more providers.
- Pointing at a card highlights its nerve. You can also click a provider's part of the brain to open it.
- A connected card shows its method under the name: "OAuth" for a sign-in, "API key" for a key.
- If your computer can't draw the 3D brain, the cards are shown on their own and work the same way.
- The **On your machine** group holds two more cards: **Local models** and **Hugging Face**.

## Connecting a provider

Click a card to open its "Connect" window. It lists the models that provider offers. There are three kinds of connection:

1. Sign in through your browser (Anthropic and OpenAI only). If the provider asks for it, paste the code or callback URL back into the app and click **Submit**.
2. A pay-per-token API key from the provider's console. Paste it into the **Paste your API key** box and click **Connect** (or press Enter).
3. A plan key: some subscriptions connect by pasting a key. Under **Key type**, pick the plan option before pasting.

- When a provider offers both a sign-in and a key, the window first shows one card for each. Each card says what it bills, when to use it and what it needs, with **Connect** (or **Replace** when already connected) and **Disconnect**.
- Both methods can be connected at once. The one being used is marked **In use** and the other **Standby**. A line under the cards explains which one wins.
- After choosing a method you can click **Back** to return to the comparison. **Cancel** stops a sign-in that is waiting.

## Providers and their routes

- Anthropic: Sign in with Claude (your Claude Pro or Max plan), or an Anthropic API key (pay-per-token). The key is used only while you are not signed in with Claude.
- OpenAI: **Continue with ChatGPT** (your ChatGPT plan), or an OpenAI API key (pay-per-token). The plan is used first; the key takes over while the plan's usage is out, then it switches back.
- Kimi (Moonshot): key only. Key type "Kimi Code plan" (create it in the Kimi Code Console) or "Moonshot API" (pay-per-token). With both set, the plan key is used first and the Moonshot key covers models the plan doesn't include.
- Xiaomi (MiMo): key only. Key type "Token Plan" or "API Credits". UltraSpeed needs API Credits.
- MiniMax: one key box. An M Plan key bills your plan; a pay-as-you-go key is pay-per-token. The key you paste decides which.
- Z.AI (GLM): pay-per-token key only. GLM Coding Plan quota can't be used in GG Coder.
- xAI (Grok): API key only. SuperGrok and X Premium usage can't be used.
- OpenCode Go: an OpenCode API key from a workspace subscribed to Go; uses your Go subscription.
- OpenCode: an OpenCode API key billed to your Console credits. Free-tier models only run inside OpenCode, so they are not listed.
- Gemini (a Google AI Studio key), DeepSeek, Sakana (Fugu) and OpenRouter: API key, pay-per-token.
- OpenRouter also has an optional API base URL, so you can point it at any compatible gateway. Once connected, **Sync models** loads the list that endpoint serves, and **Use built-in list** goes back. Changing only the URL shows a **Save base URL** button.

## Using your Claude subscription

- Open **AI Providers**, click Anthropic, then Connect on the Sign in with Claude card and click **Continue**. Finish the sign-in in your browser.
- Claude plans run through Anthropic's official Claude Code. GG Coder downloads it once (about 140 MB) the first time you pick this.
- Claude Code holds the login; GG Coder never stores the token itself.

## Using your ChatGPT plan

- Click OpenAI, then Connect on the **Continue with ChatGPT** card and click **Continue with ChatGPT**.
- After your first sign-in on this computer, a window titled "You're using your ChatGPT plan" appears, with **Manage usage** (opens ChatGPT's usage settings, where you can set a limit for GG Coder) and **Got it**.
- While an OpenAI model is in use on the plan, the Model panel shows "Using ChatGPT plan · **Manage usage**".

## When plan usage runs out

- ChatGPT plan: if an OpenAI API key is also connected, requests move to the key until the usage window resets. The connect window then says, for example, "Subscription usage is out for ~3h — requests are using the OpenAI API key until it resets."
- If no key is connected, you get the provider's usage-limit error with its reset time, never a silent switch to paid billing.
- In the chat, the error comes with a model picker labelled "Switch provider" so you can move to another provider straight away. Other errors offer "Choose model".

## Disconnecting

- Open the provider's card. On a two-method provider, each card has its own **Disconnect**.
- The **Disconnect** button at the bottom left removes everything for that provider. When both methods are connected it reads **Disconnect both**.

## Retired sign-ins

- Some older sign-ins no longer work: the old ChatGPT/Codex token, the old pasted Claude token, the old Kimi and xAI sign-ins and the Google sign-in for Gemini. They never count as connected.
- **AI Providers** shows a notice such as "Your old Claude sign-in no longer works. Sign in with Claude again to keep using your subscription." with **Reconnect** and **Dismiss**.
- **Reconnect** opens that provider's connect window; connecting again clears the old entry. **Dismiss** removes only the dead sign-in.

## The Model panel

- In a session, the model button sits at the right end of the bar under the message box. It shows the model name, dots for the thinking level, and "paid" when a paid fast model is on. Click it to open the **Model** panel in place of the message box.
- Type in the search box (it reads "Search N models") to filter by model or provider name, for example "opus" or "kimi code". Use the arrow keys and Enter, or click. Escape clears the search, then closes the panel.
- Models are grouped by provider, with the context size on the right. Only models from connected providers and local servers are listed.
- Greyed-out rows can't be picked. They say why: "no tool calling", what your plan or keys are missing, or "main chat only".
- You can't switch while the agent is working: "Can't switch models while the agent is working. Stop it or wait."
- If models fail to load, the panel says "Couldn't load models from the agent. Reopen the project to try again."

## Does my model choice stick?

- Yes. The model and thinking level you pick are saved for that project, so its windows open on them again after a restart.
- A project you have never opened starts on the model you picked most recently anywhere.
- Paid fast models are the exception (see below).

## Paid fast models

- Some fast modes, such as Claude Opus 5.5 Fast and MiMo UltraSpeed, cost real money. The row shows its cost note.
- Picking one asks first: "spends real money", with **Cancel** (the default) and **Use it and pay**.
- It lasts for the current session only. New sessions, restarts and new windows go back to the standard model, and Ken and helper agents never use it.

## Thinking levels

- Thinking keys sit at the top of the Model panel: **Off** plus each level the current model supports, from **Minimal**, **Low**, **Medium**, **High**, **X-High** and **Max** (some OpenAI models also offer Ultra).
- The levels change with the model. When you switch to a model that doesn't support your level, thinking stays on at a level it does support; if thinking was off it stays off.
- Thinking can't be changed while the agent is working. The choice is saved for the project like the model.

## Ken's and the Critters' model

- In a code window the top of the Model panel has two targets: **GG** and **Ken**.
- Under Ken, choose "Follow GG" to use GG's model, or pick a model to pin Ken to it. The pin is saved for the project. Ken's model can't change while GG or Ken is working.
- In a Goal the second target is "Critters", which follow "GG Goals" unless you pin a model.
- Paid fast models show "main chat only" here and can't be picked.

## Local models

- Click **Local models** in **AI Providers**. GG Coder finds Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible server it can reach and lists each server with its models.
- Point at a model to see its context size, what it supports (tool calling, vision, thinking) and whether it is loaded.
- **Scan** checks again. **Add endpoint** opens **Endpoint URL**, **Name (optional)**, **API key (optional)** and **Context length (optional)**, then **Save**. Leave context length empty to use what the server reports.
- Remove an added server with the x next to it.
- To use one, open the **Model** panel in a session and pick it from the local group. A model without tool calling can't run the agent.
- If Ollama runs a model with a small context, raise its context length in Ollama's settings, then pick the model again.

## Downloading from Hugging Face

- Click the **Hugging Face** card to open "Add a Hugging Face model". Search, then click a result to download it with Ollama.
- Progress is shown. **Hide** closes the window without stopping the download; **Cancel download** stops it.
- When it finishes it says it is installed in Ollama and ready to pick. **Download another** starts a new search.

## Usage meter and Usage panel

- On a Claude sign-in or a Kimi Code plan key, the title bar shows a plan usage bar with time to reset. Click it to switch between the 5-hour window and the week.
- Claude figures update after each request, so they appear once you have sent one.
- The context key in the bar under the message box shows how full the conversation is. Click it for the **Usage** panel: **Context**, the 5-hour window and **Week**, plus project health, your level and trophies.
- If usage can't be fetched, the last known figures stay up, marked as last known.

## Common questions

Q: Where do I change models?
A: In a session, click the model name at the right end of the bar under the message box. The Model panel opens; search and pick a model.

Q: How do I use my Claude subscription?
A: In Settings, **AI Providers**, click Anthropic and connect Sign in with Claude. It needs a Claude Pro or Max plan, and GG Coder downloads Claude Code (about 140 MB) once.

Q: How do I use a local model?
A: Start Ollama, LM Studio or another local server, open **Local models** in **AI Providers** and click **Scan** or **Add endpoint**. Then pick the model in the Model panel.

Q: How do I use my ChatGPT plan?
A: Click OpenAI in **AI Providers** and use **Continue with ChatGPT**. You can also add an OpenAI API key to cover you when the plan's usage runs out.

Q: Will my model choice be kept for new sessions?
A: Yes, it is saved for the project and comes back after restarts. Paid fast models are not kept.

Q: Why is a model greyed out?
A: It can't call tools, your plan or keys don't cover it (the row says what it needs), or it is a paid model in Ken's list.

Q: Why can't I switch models?
A: Models and thinking can't change while the agent is working. Stop it or wait for it to finish.

Q: How do I change how hard the model thinks?
A: Use the thinking keys at the top of the Model panel. The levels offered depend on the model.

Q: Can Ken use a different model from GG?
A: Yes. In the Model panel choose the Ken target and pin a model, or "Follow GG" to match GG.

Q: What do In use and Standby mean?
A: With both a sign-in and a key connected, In use is the one requests go through and Standby is the backup.

Q: My plan ran out. What now?
A: Connect a pay-per-token key for that provider, or click "Switch provider" in the error to use another model until the reset time.

Q: How do I disconnect a provider?
A: Open its card in **AI Providers** and click **Disconnect**, or **Disconnect both** to remove both methods.

Q: Can I use my GLM Coding Plan or SuperGrok?
A: No. Z.AI and xAI only work with pay-per-token API keys in GG Coder.

Q: How do I download a model from Hugging Face?
A: Click the **Hugging Face** card, search, and click a result. It downloads into Ollama and then appears in the Model panel.

Q: Where do I see how much of my plan I've used?
A: The usage bar in the title bar (Claude sign-in or Kimi Code plan), or the **Usage** panel from the context key.

Q: It says my old sign-in no longer works.
A: Click **Reconnect** on the notice in **AI Providers** and connect again, or **Dismiss** to remove the dead sign-in.
