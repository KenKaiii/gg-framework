// @ts-check
// Real AI for the crowd (owner: "react to itself and to other AI, randomised and real, weird, funny, cringy").
// The app plugs a model in with ONE of:
//   window.__ggLLM = async (system, user) => text              // simplest: the game builds the prompt and parses the reply
//   window.__crowdBrain = async (ctx) => [{ name, text }, ...]   // full control
// (Members' own tokens are already connected in the coding app; whichever adapter the app sets, the game uses it.)
// Cost control: one request per ~15-25 s, only for the room the player is in, only with 2+ people there, short output.
// Anything that fails or is slow (> 12 s) is ignored and the offline generator keeps the room talking.

export const SYSTEM = `You write the background chatter of a cozy late-night hangout game for programmers who code with AI agents.
People in the room are either PLAYERS (real coders, each with a personality) or NPCs (residents with a job in that room).
Write the next 2-4 lines of what they say out loud, as a natural scene: they react to each other and to the recent lines,
interrupt, tease, go off on weird tangents, overshare, get cringy, make inside jokes. Vary it a lot; never repeat earlier lines.
Rules: each line under 60 characters, lowercase is fine, mild swearing ok, no slurs, nothing sexual or hateful,
no real people. ASCII only, no emoji. Only use names from the list. Reply with JSON only: [{"name":"...","text":"..."}]`;

/** the user prompt for one room */
export function crowdUser(ctx) {
  const ppl = ctx.people.map(p => `- ${p.name} (${p.kind}${p.kind === 'npc' ? ', ' + p.role : ''}): ${p.about}${p.status ? '; right now: ' + p.status : ''}`).join('\n');
  const recent = ctx.recent.length ? ctx.recent.map(r => `${r.name}: ${r.text}`).join('\n') : '(quiet so far)';
  return `Room: ${ctx.room} (${ctx.roomAbout}). Time: ${ctx.hour}. Weather outside: ${ctx.weather}.${ctx.event ? ' Just happened: ' + ctx.event + '.' : ''}
People here:
${ppl}
Recent lines (oldest first):
${recent}
Next lines:`;
}

const clean = s => String(s || '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80);

/** ask the connected model for the next lines; resolves to [{name,text}] or null */
export async function askCrowd(ctx) {
  // @ts-ignore
  const W = window;
  const timeout = new Promise(res => setTimeout(() => res(null), 12000));
  const run = (async () => {
    if (typeof W.__crowdBrain === 'function') return await W.__crowdBrain({ ...ctx, system: SYSTEM, user: crowdUser(ctx) });
    if (typeof W.__ggLLM === 'function') { const txt = String(await W.__ggLLM(SYSTEM, crowdUser(ctx))); const m = txt.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : null; }
    return null;
  })().catch(() => null);
  const out = await Promise.race([run, timeout]);
  if (!Array.isArray(out)) return null;
  const names = new Set(ctx.people.map(p => p.name));
  return out.filter(x => x && names.has(x.name) && x.text).slice(0, 4).map(x => ({ name: x.name, text: clean(x.text) })).filter(x => x.text.length > 1);
}
export const aiConnected = () => { /* @ts-ignore */ const W = window; return typeof W.__crowdBrain === 'function' || typeof W.__ggLLM === 'function'; };
