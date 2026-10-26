// @ts-check
// Offline "AI": a combinatorial line generator + a reply generator that reacts to what was just said.
// Thousands of combinations per family, persona flavour on top, so the room never settles into a loop.
// Used when no real model is connected (window.__ggLLM / window.__crowdBrain), and to fill gaps when one is.
import { pickOne as P, chance, draw } from './talk.js';

const AGENT = ['my agent', 'the agent', 'my AI', 'the model', 'my copilot', 'the bot', 'my little AI guy', 'the autocomplete'];
const AGENT_DID = ['renamed every variable to "thing"', 'deleted the tests because they "failed"', 'added 400 lines to fix a typo', 'wrote a poem in my commit message',
  'apologised to me. twice', 'imported a library to add two numbers', 'turned my css into a blockchain', 'refactored the readme into a novel', 'invented an API that doesnt exist',
  'fixed the bug by commenting it out', 'put my secrets in the logs', 'called my code "charmingly legacy"', 'made 14 files called utils', 'rewrote it in rust. unprompted',
  'thanked me for my patience', 'replaced my loop with a recursive nightmare', 'added emoji to the error messages', 'opened a PR against itself', 'asked if i was sure. i wasnt',
  'left a TODO that says "good luck"', 'wrapped everything in try catch', 'made the button blue. i said red', 'generated a dark mode for the terminal', 'wrote tests that test the tests'];
const THING = ['auth flow', 'landing page', 'database', 'side project', 'resume', 'todo app', 'discord bot', 'weekend', 'portfolio', 'dotfiles', 'game jam entry', 'startup idea', 'cron job', 'CSS', 'whole repo'];
const HABIT = ['push to main on fridays', 'name branches "test2-final"', 'read the docs after asking the AI', 'keep 140 tabs open', 'commit with message "stuff"', 'debug with console.log only',
  'have 9 unfinished side projects', 'ignore the linter on purpose', 'still use the default terminal theme', 'reply "lgtm" without reading', 'store passwords in a file called passwords',
  'restart my laptop instead of fixing things', 'say "quick fix" and mean 4 hours', 'buy domains for apps i never build', 'drink coffee after midnight', 'blame the cache. always'];
const TAKE = ['tabs are fine. fight me', 'nobody reads code comments', 'every app should have a dark mode', 'the best code is deleted code', 'standups should be sit-downs', 'pineapple pizza is a valid deploy snack',
  'semicolons are a lifestyle choice', 'meetings are just slow chat', 'vim is a personality', 'naming things is the only hard part', 'the AI is better at regex than all of us', 'side projects are therapy',
  'friday deploys build character', 'light mode is a cry for help', 'the cloud is just someone elses basement', 'every startup is a spreadsheet with a logo', 'sleep is a feature, not a bug'];
const SOUND = ['humming', 'a dial-up noise', 'whispering', 'beeping', 'a tiny scream', 'jazz', 'a fax machine', 'typing', 'a modem song', 'clapping'];
const PLACE = ['vents', 'fridge', 'arcade machine', 'jukebox', 'server rack', 'basement', 'red curtain', 'pinball table', 'ceiling', 'toilet', 'old CRT'];
const MYSTERY = ['the build only works on tuesdays', 'my laptop fan is louder at night', 'there is a sock on the roof', 'the tests pass when i look away', 'the coffee machine knows my name',
  'prod is fine and i am scared', 'my cat sits on the exact key that breaks things', 'the wifi is called "DONT"', 'someone keeps winning at pinball at 4am', 'the jukebox only plays one song now',
  'my commit history looks haunted', 'the elevator goes to a floor that doesnt exist', 'every error message says "soon"'];
const BRAG = ['shipped a feature AND ate dinner', 'got 3 stars on github. one is my mum', 'fixed a bug i wrote in 2019', 'closed 40 tabs. felt nothing', 'deployed without crying',
  'wrote a test. a real one', 'mass-replaced without breaking prod', 'understood a regex on the first read', 'made a startup logo in 4 minutes', 'got the AI to say "you are right"', 'went outside. saw the sun. briefly'];
const FOOD = ['cold pizza', 'cereal', 'instant ramen', 'a whole cherry pie', 'gas station sushi', 'six espressos', 'leftover noodles', 'crackers and regret', 'a mystery sandwich', 'popcorn for dinner'];
const FOOD_TWIST = ['for breakfast', 'at 3am', 'over the keyboard', 'standing up', 'like a raccoon', 'with zero shame', 'during a deploy', 'while the tests run'];
const OPEN_CONFESS = ['confession:', 'dont judge me but i', 'real talk, i', 'ok i admit it, i', 'not proud of it but i', 'secret:'];
const WEIRD = [() => `anyone else hear ${P(SOUND)} in the ${P(PLACE)}?`, () => `why does ${P(MYSTERY)}`, () => `i think the ${P(PLACE)} is sentient`, () => `the ${P(PLACE)} just winked at me`,
  () => `dreamt i was a merge conflict. woke up resolved`, () => `my horoscope said "avoid ${P(THING)}s"`, () => `if this ${P(PLACE)} could talk it would file a bug`, () => `someone named their wifi after me. rude`];

/** a fresh line in one of the families */
export function genLine() {
  const x = Math.random();
  if (x < 0.22) return `${P(AGENT)} ${P(AGENT_DID)}`;
  if (x < 0.32) return `${P(AGENT)} ${P(AGENT_DID).replace(/^(\w+)/, 'just $1')} my ${P(THING)}`.replace(/ my my /, ' my ');
  if (x < 0.44) return `${P(OPEN_CONFESS)} ${P(HABIT)}`.replace('confession: ', 'confession: i ').replace('secret: ', 'secret: i ');
  if (x < 0.56) return `hot take: ${P(TAKE)}`;
  if (x < 0.68) return P(WEIRD)();
  if (x < 0.78) return `just ${P(BRAG)}`;
  if (x < 0.88) return `eating ${P(FOOD)} ${P(FOOD_TWIST)}`;
  return `does anyone know why ${P(MYSTERY)}?`;
}

const STOP = new Set('about after again also always another anyone because before being could didnt doesnt every first going gonna just like little maybe never really should since still their there these thing think those though today tonight until where which while would youre the and for are but not you all any can had her was one our out has his how its may new now old see two way who boy did get him let put say she too use that this with from have your what when will just been they them then than into some only over very much more most such well even back good make made know take come were said each tell does wont cant ive'.split(' '));
/** the word worth echoing from a line (longest non-filler word) */
export function keyWord(line) { const w = String(line).toLowerCase().replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter(x => x.length > 3 && !STOP.has(x)); return w.sort((a, b) => b.length - a.length)[0] || null; }
/** what kind of line it is */
export function kindOf(line) { const s = String(line).toLowerCase(); if (/\?\s*$/.test(s)) return 'question'; if (/^hot take|fight me|unpopular/.test(s)) return 'take'; if (/^just |shipped|fixed|got \d|deployed/.test(s)) return 'brag';
  if (/confession|admit|not proud|secret/.test(s)) return 'confess'; if (/agent|model|ai |the bot|copilot/.test(s)) return 'agent'; if (/hear|sentient|winked|dream|haunted|weird|ghost/.test(s)) return 'weird';
  if (/broke|fail|error|crash|deleted|bug|why/.test(s)) return 'pain'; if (/eat|pizza|ramen|pie|coffee|espresso|food|snack/.test(s)) return 'food'; return 'chat'; }

const REPLY = {
  question: [w => `no idea. ask the ${P(PLACE)}`, w => `${w}? never heard of it`, () => 'have you tried turning it off and on', () => 'the docs say "it depends"', () => 'thats a tomorrow problem',
    w => `i googled ${w} once. never again`, () => 'only the twins upstairs know', () => 'it is always DNS', (w, who) => `${who}, that is a cursed question`, () => 'magic. bad magic'],
  take: [() => 'absolutely not', () => 'finally someone said it', (w, who) => `${who} with the spicy ones tonight`, () => 'i will remember this at your code review', () => 'blocked. reported. agreed', w => `${w}? youre fired. from the bar`,
    () => 'ok but counterpoint: no', () => 'this is why we cant have nice things'],
  brag: [() => 'show off', (w, who) => `${who} carrying the whole building`, () => 'screenshot or it didnt happen', () => 'proud of you. weirdly', () => 'ok legend, sit down', w => `${w}?? at THIS hour?`, () => 'teach me your ways', () => 'thats going on the wall'],
  confess: [() => 'same. dont tell anyone', () => 'i am calling the police', (w, who) => `${who} that is a war crime`, () => 'we all do. we just dont say it', () => 'deleting you from my contacts', () => 'thats the most honest thing said here', () => 'brave. stupid. brave'],
  agent: [() => 'mine did that yesterday. we dont talk now', w => `${w}?? classic`, () => 'the robots are learning to be us', () => 'did you say please though', () => 'that agent needs a nap', (w, who) => `${who}, fire it. hire a duck`, () => 'it is not a bug, it is a personality', () => 'mine just writes apology letters'],
  weird: [() => 'ok im moving seats', () => 'that is a normal tuesday here', (w, who) => `${who}, stop scaring the new people`, () => 'thats nothing, the fridge asked me my name', w => `the ${w} again? call the twins`, () => 'i heard it too. i chose peace', () => 'this building runs on vibes and ghosts'],
  pain: [() => 'oof. rollback and walk away', () => 'f in the chat', (w, who) => `want a hug or a stack trace, ${who}?`, () => 'it builds character. allegedly', w => `blame the ${w}`, () => 'have you considered farming', () => 'drink first, debug second'],
  food: [() => 'thats not food thats a cry for help', () => 'share or leave', w => `${w}? respectfully, gross`, () => 'chefs kiss', () => 'the kitchen fears you', () => 'my body is 80 percent cold pizza'],
  chat: [() => 'real', () => 'say less', w => `wait, ${w}?`, (w, who) => `${who} talking sense for once`, () => 'that is so true it hurts', () => 'ok but why', () => 'noted. ignored. respected', w => `${w} is my villain origin story`],
};
/** a reply to `line` said by `who` */
export function genReply(line, who) {
  const k = kindOf(line), w = keyWord(line) || 'that'; let r = draw(REPLY[k] || REPLY.chat)(w, who); // shuffle-bag: no repeats until the pool is used
  if (chance(0.15)) r += P([' lol', ' honestly', ' tbh', '. anyway', ', no offence']);
  return r;
}
const FOLLOW = [w => `${w} you dont get it`, () => 'whatever, i stand by it', () => 'ok fair', () => 'you guys are the worst. love you', () => 'adding that to the incident report', () => 'brb, rethinking my life', () => 'this is why i drink here', () => 'noted', () => 'i hate that youre right', () => 'i regret everything', () => 'fine. FINE.', w => `${w}, we are not friends anymore`, () => 'ok that one hurt', () => 'never speak to me again (affectionate)'];
/** a follow-up from the first speaker after a reply (2nd turn of a generated exchange) */
export function genFollow(reply, who) {
  return draw(FOLLOW)(who);
}
