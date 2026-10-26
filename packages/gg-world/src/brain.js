// @ts-check
// Dex's demo brain. A real LLM plugs in via window.__npcBrain(history, context). Never grants rewards.

export const NPC = {
  name: 'Dex', role: 'Bartender of the Night Rooms',
  personality: 'Dry, dark humour; mild swearing; roasts commit messages; deadpan, never cruel. Talks in old-sysadmin metaphors. Knows who is online and who just shipped. Never hands out coins or XP.',
  backstory: 'Ran a datacenter night shift for eleven years. When the racks went to the cloud he kept the shades, the coat and the pager, '
    + 'and opened a bar where the servers used to hum. The house beer after a failed deploy is the Rollback IPA.',
  look: { body: 'barbarian', head: 'rogue', hair: '#141414', skin: '#b07a55', top: '#15161b', bottom: '#111216', acc: 'none', silly: ['shades', 'coat'] },
};

const pick = (arr, mem) => { mem.n = (mem.n || 0) + 1; return arr[(mem.n * 7 + arr.length) % arr.length]; };
const has = (s, ...w) => w.some(x => new RegExp('\\b' + x + '\\b', 'i').test(s));

/** @param {{role:string,text:string}[]} history @param {any} ctx */
export function demoReply(history, ctx) {
  const mem = ctx.memory; const said = history.filter(h => h.role === 'user'); const msg = (said[said.length - 1]?.text || '').trim();
  const you = mem.name || 'stranger';
  const ship = ctx.lastShip; const deploying = ctx.deploying?.length ? ctx.deploying.join(' and ') : null;
  const nameM = msg.match(/(?:my name is|i am|i'm|call me)\s+([A-Za-z]{2,12})\b/i);
  if (nameM && !has(nameM[1], 'fine', 'good', 'ok', 'tired', 'stuck', 'here', 'back', 'not', 'just', 'so', 'new', 'bored', 'drunk')) {
    mem.name = nameM[1][0].toUpperCase() + nameM[1].slice(1).toLowerCase();
    return pick([`${mem.name}. Logged. I keep better logs than your CI.`, `Alright, ${mem.name}. I'll remember that longer than you remember your own passwords.`], mem);
  }
  if (has(msg, 'coin', 'coins', 'reward', 'xp', 'free', 'points', 'money', 'level me')) return pick([`I pour drinks, ${you}. I don't mint currency. Go ship something.`, `Coins come from commits, not from charming the bartender. Nice try though.`], mem);
  if (has(msg, 'fail', 'failed', 'broke', 'broken', 'rollback', 'outage', 'down')) return pick([`Failed deploy? Rollback IPA. Bitter, cloudy, tastes like a 3am pager. On tap for exactly this.`, `Sit. Rollback IPA. Then git revert, then sleep. In that order.`], mem);
  if (has(msg, 'remember', 'earlier', 'what did i')) { const prev = said.slice(0, -1).map(h => h.text).filter(t => t.length > 3); return prev.length ? `You said "${prev[prev.length - 1].slice(0, 60)}". Old sysadmin habit: I keep the logs.` : `Clean log so far, ${you}.`; }
  if (has(msg, 'hi', 'hello', 'hey', 'yo', 'evening', 'sup')) return pick([`Evening, ${you}. ${ctx.online} online tonight. What are we drinking?`, `Hey. Pull up a stool. The jukebox only plays sad synthwave, don't ask.`], mem);
  if (has(msg, 'ship', 'shipped', 'deploy', 'release')) return deploying ? `${deploying} is deploying right now. I've got the shot glasses lined up, and the IPA on standby.` : ship ? `${ship} shipped last. Bought a round with imaginary money. Classic.` : `Nobody's shipped tonight. Suspiciously quiet. Like prod before a fire.`;
  if (has(msg, 'who', 'online', 'around', 'here')) return `${ctx.online} online. ${ctx.where || ''}`.trim();
  if (has(msg, 'beer', 'drink', 'shot', 'shots', 'cocktail', 'whiskey', 'order', 'ipa')) return pick([`House special: the Segfault. Green, strong, you'll forget where you put your pointers.`, `Beer's cold. Shots are for deploys. You deploy anything today?`, `One Rollback IPA, ${you}. You'll want it eventually.`], mem);
  if (has(msg, 'commit', 'commits', 'roast', 'pr', 'message')) return pick([`Your last commit message was "fix stuff", wasn't it. Shakespeare weeps.`, `"wip", "wip2", "final", "final_actually". Your git log reads like a hostage note.`, `I've seen commit messages that said "lol". In prod. Signed by a senior.`], mem);
  if (has(msg, 'shades', 'coat', 'matrix', 'pill', 'rabbit')) return pick([`The shades stay on. The light in here is fine, it's the logs that hurt.`, `Red pill's a cherry shot, blue pill's a Rollback IPA. Choose carefully.`], mem);
  if (has(msg, 'fuck', 'shit', 'damn', 'wtf')) return pick([`Yeah. That's the noise prod makes too. What broke?`, `Swear all you want, the walls are soundproofed. Old server room.`], mem);
  if (has(msg, 'who are you', 'your name', 'about you', 'yourself', 'story')) return `Dex. Eleven years of datacenter night shifts. The racks left, I stayed, and I added beer.`;
  if (has(msg, 'joke', 'funny')) return pick([`There's no place like 127.0.0.1. Especially at closing time.`, `A SQL query walks into a bar, sees two tables, asks to join. I threw it out. No index.`], mem);
  if (has(msg, 'thanks', 'thank', 'cheers', 'ty')) return pick([`Don't mention it. Seriously, don't, I have a reputation.`, `Cheers, ${you}.`], mem);
  if (has(msg, 'bye', 'later', 'night', 'cya')) return pick([`Go to bed, ${you}. The bug will still be there tomorrow. So will I.`, `Night. Don't push to main on the way out.`], mem);
  return pick([`Mm. ${deploying ? deploying + ' is deploying, so I\'m half listening. ' : ''}Go on.`, `No idea what that means, ${you}, but I nod professionally.`, `Uh huh. Want a drink with that thought?`], mem);
}

/** @param {{role:string,text:string}[]} history @param {any} context */
export async function npcReply(history, context) {
  // @ts-ignore
  if (typeof window.__npcBrain === 'function') { try { return String(await window.__npcBrain(history, context)); } catch (e) { /* fall back to demo */ } }
  return demoReply(history, context);
}
