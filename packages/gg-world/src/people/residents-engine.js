// @ts-check
// Ken: the dev of GG Coder, roaming the Engine Room fixing things at each station (FORMAT D, PEOPLE-BRIEF.md).
// look.tag 'ken' lets rooms/engine.js find him (wrench in hand + a spark/steam puff when he stops at a station).
export default [
  {
    id: 'ken', name: 'Ken', room: 'engine', role: 'builds GG Coder',
    personality: 'the developer of GG Coder; friendly, a bit tired, loves explaining how the engine works in plain words, always mid-fix, self-deprecating about bugs',
    look: { tag: 'ken', body: 'rogue', head: 'rogue', skin: '#e0b090', hair: '#2a1a12', top: '#2f9e63', bottom: '#2b2d42', acc: 'headphones', accColor: '#1a1a1a', silly: [] },
    routine: [
      { at: 'daemon', act: 'Use_Item', say: ['Bleeding the daemon...', 'Pressure looks fine. Ish.'] },
      { at: 'loop', act: 'Interact', say: ['Tightening the tool loop...', 'Oiling the agent loop.'] },
      { at: 'router', act: 'Interact', say: ['Re-patching a provider...', 'New model just dropped. Plugging it in.'] },
      { at: 'tools', act: 'PickUp', say: ['Sharpening grep...', 'Where did I put the edit tool?'] },
      { at: 'memory', act: 'Use_Item', say: ['Rewinding a session...', 'Compacting. Squeeze, squeeze.'] },
      { at: 'goals', act: 'Interact', say: ['Unjamming a worker crate...', 'Workers, report in.'] },
      { at: 'forge', act: 'Use_Item', say: ['Stoking the XP forge...', 'Fresh coins, still warm.'] },
    ],
    ambient: ['Who left a TODO in the boiler?', 'One more fix and I ship it.', 'CI is green. Touch wood.', 'Tests first, then coffee. Then more tests.'],
    greet: ['Oh hey {player}! Welcome to the engine room.', 'Mind the gears, {player}.', '{player}! Want the tour?'],
    reactShip: ['{other} shipped! The forge felt that.', 'Nice one, {other}.'],
    talk: {
      hello: ['Hey! I\'m Ken. I build GG Coder. This room is how it all runs. Ask me anything.', 'Hi {player}. Grab a gear, I mean a seat.'],
      who: ['I\'m Ken, the dev of GG Coder. Most days I\'m down here fixing whatever broke last night.'],
      room: ['This is GG Coder, made physical. Every machine is a real part: the daemon, the agent loop, models, tools, memory, goals, XP. Press E on any of them.'],
      work: ['Right now? Fixing things at random. Ask me about the loop, models, tools, goals or XP.'],
      joke: ['My code never has bugs. It just develops surprise features.', 'I fixed one bug and two more came to the funeral.', 'It works on my machine. Luckily this whole room IS my machine.'],
      bye: ['Later! Come back when I break something new.', 'See ya. Go ship something.'],
      unknown: ['Good question. Try the agent loop, models, tools, goals, XP, or what\'s next.', 'Hm, not sure. Ask me how the loop works, that one I love.'],
      topics: {
        loop: { keys: ['loop', 'agent', 'how does it work', 'how it works'], lines: ['You type, the model thinks and picks a tool, the tool runs, the result goes back. Round and round until it\'s done. You can steer or stop it any time.'] },
        models: { keys: ['model', 'claude', 'gpt', 'gemini', 'provider', 'kimi', 'grok', 'local'], lines: ['GG talks to loads of models: Claude, GPT, Gemini, Grok, Kimi, local ones. Use your subscription or a key. Everything comes back as one stream so the engine doesn\'t care who answered.'] },
        tools: { keys: ['tool', 'bash', 'edit', 'grep', 'read', 'skill'], lines: ['Tools are the agent\'s hands: read and grep look, edit changes, bash runs your tests. Rarer tools sit in a drawer until needed so the prompt stays small and cached.'] },
        goals: { keys: ['goal', 'worker', 'farm', 'team'], lines: ['GG Goals takes a big goal, agrees the plan with you, then splits it across workers running side by side. It checks their work until the goal is met.'] },
        xp: { keys: ['xp', 'level', 'coin', 'rank', 'forge'], lines: ['You earn XP for prompts and commits. Bigger commits earn more up to a cap, spamming prompts earns less. Each level is worth 80 coins here in World.'] },
        daemon: { keys: ['daemon', 'boiler', 'sidecar', 'tauri', 'rust', 'window'], lines: ['One Node daemon runs behind the app. Each window talks to it through the Rust shell and gets its own session. Quit, and it all shuts down cleanly.'] },
        memory: { keys: ['memory', 'session', 'compact', 'cache', 'remember'], lines: ['Chats are saved as sessions. When one gets long, old turns are squeezed into a summary. The prompt start stays fixed so it\'s cached: fast and cheap.'] },
        next: { keys: ['next', 'roadmap', 'future', 'coming', 'plan'], lines: ['What\'s next? Faster, fewer surprises, and more of this world. Ideas welcome, honestly.'] },
      },
    },
  },
];
