// node --test packages/gg-world/test/chat-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProblem, clean, createGuard, LADDER } from '../src/chat-guard.js';

const ZW = '\u200b';

const LINKS = [
  'google.com', 'GOOGLE.COM', 'go to google.com now', 'google .com', 'google . com', 'google (dot) com', 'google[.]com',
  'google(.)com', 'google dot com', 'google DOT com', 'google d0t com', 'g o o g l e . c o m', 'g o o g l e dot c o m', 'come to g o o g l e (dot) c o m', 'g o o g l e [.] c o m', 'g o o g l e [dot] c o m', 'g-o-o-g-l-e.com', 'g.o.o.g.l.e.c.o.m',
  'google.c0m', 'g00gle.com', 'g\u043e\u043egle.com' /* cyrillic o */, 'google\uff0ecom', 'google\u3002com', 'google\u00b7com',
  'google\u2022com', `google${ZW}.com`, `google.${ZW}com`, `goo${ZW}gle.c${ZW}om`, '\uff47\uff4f\uff4f\uff47\uff4c\uff45\uff0e\uff43\uff4f\uff4d',
  '\u{1d420}\u{1d428}\u{1d428}\u{1d420}\u{1d425}\u{1d41e}.\u{1d41c}\u{1d428}\u{1d426}' /* math bold */, '\u24d6\u24de\u24de\u24d6\u24db\u24d4.\u24d2\u24de\u24dc' /* circled */,
  '\u{1F1EC}\u{1F1F4}\u{1F1F4}\u{1F1EC}\u{1F1F1}\u{1F1EA}.com' /* regional indicators */, '\u1d0d\u028fs\u026a\u1d1b\u1d07.\u1d04\u1d0f\u1d0d' /* small caps */,
  'g\u0301o\u0301o\u0301gle.com' /* accents */, 'google,com', 'mysite. com', 'mysite com', 'mysite dotcom',
  'https://x.y', 'http://localhost:3000/x', 'hxxps://evil', 'h t t p s : / / evil', 'www.something.xyz', 'www something',
  'discord.gg/abc', 'discord gg/abc', 'discord . gg / abc', 'discord.com/invite/abc', 'dsc.gg/abc', '.gg/abc', 't.me/channel',
  'wa.me/123', 'bit.ly/abc', 'linktr.ee/me', 'mysite.me/page', 'check out react.dev', 'visit mysite.me', 'go to my.site',
  'mysite.app/login', 'cool.site?x=1', 'evil.ru', 'shop.xyz', 'socket.io', 'xn--80ak6aa92e.com', 'mysite.co', 'mysite.gg',
  'https;//google', '*evil*.com', '_evil_.com', 'wwwevil', '1.2.3.4', '192.168.0.1', 'free stuff at 45.33.32.156',
];
const CONTACT = [
  'email me: bob@gmail.com', 'bob @ gmail . com', 'call me +44 7700 900123', 'text 555-123-4567', 'my number is (555) 123 4567',
  '0x52908400098527886E0F7030069857D2E4169EE7', 'send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
];
const ADS = [
  'join my discord', 'JOIN MY DISCORD!!', 'add me on snap', 'add me on snapchat', 'follow my twitch', 'sub to my channel',
  'subscribe to my youtube', 'check out my store', 'free nitro', 'free robux here', 'claim free vbucks', 'use my code GG10',
  'promo code xyz', 'use code GG10', 'link in bio', 'links in my bio', 'dm me for prices', 'pm me for the link', 'sub4sub', 'follow for follow',
  'my discord: coolguy#1234', 'snap: coolguy99', 'telegram @coolguy', 'my insta is @cool.guy', 'hit me up on telegram',
  'dm me on whatsapp', 'crypto airdrop live', 'double your btc', 'j0in my d1sc0rd', 'selling accounts cheap', 'discord invite: abc', 'add me: coolguy#1234 on discord', 'snap coolguy99 add me', 'follow @coolguy on twitter', 'my yt channel is up', 'f r e e n i t r o', 'cashapp $coolguy',
];
const FINE = [
  'gg', 'gg wp', 'nice. gg', 'good game. GG!', 'lol', 'hey everyone', 'i use .NET at work', 'asp.net is fine', 'dot net core rocks',
  'node.js rocks', 'next.js 15 is out', 'three.js', 'logger.info(x)', 'req.body.id', 'process.env.DEV', 'main.py crashed',
  'readme.md', 'install.sh failed', 'check user.id', 'this.store', 'app.tsx', 'style.css', 'index.html', 'version 1.2.3', 'v2.0.1',
  'node 20.11', '3.14', 'e.g. this', 'i.e. that', 'co-op is fun', 'done. co-workers left', 'the org chart', 'my org uses it',
  'net worth', 'safety net', 'the point is', 'i\'m online now', 'app store', 'coffee shop', 'more info please',
  'check out my project', 'check out my new build', 'my discord is down', 'discord is down again', 'i posted on youtube yesterday',
  'follow the tutorial', 'subscribe to the newsletter', 'free time later', 'use code review', 'call me at 5',
  'my score is 12000', 'level 42 now', 'deploy at 3pm', 'port 3000', '1,000 coins', 'hello,world', 'a dot in the corner',
  'polka dot is cute', 'connect the dots', 'dm me if you want to pair', 'hit me up later', 'see you at 5',
  'http requests are slow', 'the http status was 404', 'i love vs code', 'c o o l', 's o r r y', '1 2 3 go',
  'whats up', 'the com port', 'telecom stuff', 'sitcom night', 'my discord name is long', 'snap back', 'tag me @kai', '$VIBE is up 4%', 'discord v2 update', 'anyone shipping today?', 'just pushed to main', 'the build is green', 'i\'m on the roof', 'meet at the bar',
  'that was a good point io think', 'cool. Org meeting at 3', 'it is what it is', 'go to the den', 'see it on the map',
  'yo', 'nice one!', 'check out logger.info, works fine', 'check out this.store', 'see the req.page value', 'on user.me we keep the profile', 'at this.app level', 'haha that\'s so true', 'react is cool', 'vue or svelte?', 'python 3.12', 'ES2024 is out',
];

test('links are caught, however they are disguised', () => {
  assert.deepEqual(LINKS.filter(s => findProblem(s) !== 'link'), [], 'should block as link');
});
test('contact details are caught', () => {
  assert.deepEqual(CONTACT.filter(s => !findProblem(s)), [], 'should block');
});
test('advertising is caught', () => {
  assert.deepEqual(ADS.filter(s => !findProblem(s)), [], 'should block as ad');
});
test('ordinary chat (including code talk) passes', () => {
  assert.deepEqual(FINE.map(s => [s, findProblem(s)]).filter(([, p]) => p !== null), [], 'should pass');
});

test('clean() strips invisible and bidi tricks, folds fancy fonts, trims zalgo and floods, caps length', () => {
  assert.equal(clean(`hi${ZW}\u202Ethere`), 'hithere');
  assert.equal(clean('\uff48\uff45\uff59'), 'hey');
  assert.equal(clean('h\u0301\u0302\u0303\u0304\u0305i'), 'h\u0301\u0302i');
  assert.equal(clean('noooooooooo'), 'nooo');
  assert.equal(clean('\u{1F602}'.repeat(9)), '\u{1F602}'.repeat(3));
  assert.equal([...clean('a'.repeat(30) + ' ' + 'x y '.repeat(80))].length <= 120, true);
  assert.equal(clean('  two\n lines  '), 'two lines');
});

const clock = (t0 = 1_000_000_000_000) => { let t = t0; return { now: () => t, add: ms => { t += ms; } }; };

test('a link mutes for 2 min, then 5, then 1 hour, then 1 day, then 1 week', () => {
  const c = clock(); const g = createGuard({ now: c.now });
  const want = [2, 5, 60, 24 * 60, 7 * 24 * 60, 7 * 24 * 60];
  for (const m of want) {
    const r = g.check('visit evil.com'); assert.equal(r.muted, true); assert.equal(r.minutes, m);
    assert.equal(g.check('hello').ok, false, 'still muted');
    c.add(m * 60_000 + 1);
  }
  assert.equal(LADDER.length, 5);
});

test('muted people cannot talk until it ends; then they can', () => {
  const c = clock(); const g = createGuard({ now: c.now });
  g.check('google.com');
  c.add(60_000); assert.deepEqual(g.check('hi').muted, true);
  c.add(61_000); assert.deepEqual(g.check('hi'), { ok: true, text: 'hi' });
});

test('the ladder steps down one level per clean day', () => {
  const c = clock(); const g = createGuard({ now: c.now });
  g.check('google.com'); c.add(3 * 60_000); g.check('google.com'); // level 2 (5 min)
  c.add(6 * 60_000 + 24 * 3600_000);                                 // a clean day
  assert.equal(g.check('google.com').minutes, 5, 'one step down from 3 -> back to the 5 min rung');
  c.add(10 * 60_000 + 3 * 24 * 3600_000);                            // three clean days
  assert.equal(g.check('google.com').minutes, 2);
});

test('spam: flooding messages mutes', () => {
  const c = clock(); const g = createGuard({ now: c.now });
  const words = ['one', 'two', 'three', 'four', 'five'];
  for (const w of words) { assert.equal(g.check(w).ok, true); c.add(1000); }
  const r = g.check('six'); assert.equal(r.muted, true); assert.equal(r.minutes, 2);
});

test('normal fast chat is fine', () => {
  const c = clock(); const g = createGuard({ now: c.now });
  for (let i = 0; i < 30; i++) { assert.equal(g.check(['yo', 'lol', 'nice', 'ok', 'same', 'true', 'gg'][i % 7] + ' ' + 'abcdefghijklmnopqrstuvwxyzab'[i]).ok, true, `msg ${i}`); c.add(2500); }
});

test('spam: the same message three times (even with numbers or punctuation changed) mutes', () => {
  const c = clock(); const g = createGuard({ now: c.now });
  assert.equal(g.check('buy my stuff').ok, true); c.add(20_000);
  assert.equal(g.check('buy my stuff 2').ok, true); c.add(20_000);
  assert.equal(g.check('BUY MY STUFF!!!').muted, true);
});

test('empty, invisible-only and symbol-only messages are dropped quietly (no mute)', () => {
  const g = createGuard();
  for (const s of ['', '   ', ZW + ZW, '\u202E', '...', '!!!']) { const r = g.check(s); assert.equal(r.ok, false); assert.equal(r.muted, undefined); }
});

test('the mute survives a reload (saved state)', () => {
  const c = clock(); let saved = null;
  const g1 = createGuard({ now: c.now, save: s => { saved = s; } });
  g1.check('google.com');
  const g2 = createGuard({ now: c.now, load: () => saved });
  assert.equal(g2.check('hi').muted, true);
  assert.ok(g2.mutedUntil() > c.now());
});

test('tampered saved state is clamped', () => {
  const g = createGuard({ load: () => ({ level: 999, until: 'x', last: null }) });
  assert.ok(g.state().level <= LADDER.length);
});

// ---- adversarial batches (bypass tries people actually use) ----
const BAD_A = [
  'GoOgLe.CoM', 'google. com', 'google .com/xyz', 'google com/abc', 'https;//google', 'h-t-t-p-s://x', 'hTtPs://x',
  'go to evil dot xyz', 'evil(dot)xyz', 'evil{dot}com', 'evil<dot>com', 'evil (.) com', 'evil[d0t]com', 'evil DOT C O M',
  'evil·com', 'evil。xyz', 'evil．co', 'e v i l . c o', 'evil\u2024com', 'evil\u2027com',
  'evil.\u0441om' /* cyrillic c */, 'еvil.соm' /* cyrillic e, c, o */, 'evil.ᴄᴏᴍ', 'evil.ⓒⓞⓜ', 'evil.𝗰𝗼𝗺', '𝓮𝓿𝓲𝓵.𝓬𝓸𝓶',
  'evil.c\u0336o\u0336m\u0336' /* strikethrough */, 'e\u200dv\u200di\u200dl.com', 'evil\u2063.com', 'evil.c\u00adom',
  'discord .gg/xyz', 'discord.gg / xyz', 'dsc . gg/xyz', 'discord invite: abc', 'join: discord gg slash abc',
  'add me: coolguy#1234 on discord', 'my snap is coolguy_99', 'snap coolguy99 add me', 'ig: @cool.guy',
  'follow @coolguy on twitter', 'my yt channel is up', 'onlyfans in bio', 'ⓕⓡⓔⓔ ⓝⓘⓣⓡⓞ', 'fr33 n1tr0', 'f r e e n i t r o',
  'bob [at] gmail [dot] com', 'bob(at)gmail.com', 'b o b @ g m a i l . c o m', 'evil.com.', '(evil.com)', '"evil.com"', 'evil.com!',
  '*evil*.com', '_evil_.com', 'evil .xyz', 'evil . ru', 'www dot evil dot com', 'wwwevil', 'evil.c0m', 'ev1l.c0m', '3vil.xyz',
  'cashapp $coolguy', 'venmo: @coolguy', 'paypal.me/coolguy', 'ko-fi.com/me', 'patreon.com/me', 'kick.com/me', 'twitch.tv/me',
  'youtu.be/abc', 'youtube.com/@me', 'x.com/me', 'fb.com/me', 'reddit.com/r/x', 'steamcommunity.com/id/me',
  'call me 07700 900 123', '+1 (555) 010-9999', 'evil․com',
];
const FINE_A = [
  'gg ez', 'ggs', 'GG!', 'good luck have fun', 'that was close', 'who wants to play pool', 'meet me at the bar', 'the roof is nice',
  'i shipped v1.4.2 today', 'npm i three', 'pnpm dev', 'cd src', 'git push origin main', 'useState hook', 'array.map is cool',
  'i.e. no', 'etc.', 'Mr. Smith', 'Dr. Who', 'U.S.A.', 'a.m. or p.m.', '9 a.m.', 'ok. so what', 'fine. cool', 'yes. me too', 'done. to bed',
  'well... it is', 'hmm.... no', 'dot dot dot', 'I like dots', 'the com port', 'telecom stuff', 'sitcom night', 'intercom bot',
  'come on', 'common sense', 'company party', 'compile error', 'commit it', 'components', 'my org', 'org mode', 'netflix later',
  'my discord name is long', 'i\'m on discord later', 'discord server is cool', 'youtube is slow', 'twitch chat is wild',
  'snap back', 'snap judgement', 'follow up later', 'add me to the team', 'join the team', 'join us in the den',
  'free for a chat', 'free to pair?', 'code review time', 'use the code from main', 'sub to main branch', 'link the PR',
  'my email is broken', 'call later', 'at 5pm', '100 coins', 'level 99', '12:30', 'v2', '50%', '#1 player', '@everyone hi',
  'tag me @kai', 'ping @dex', 'IG = in game', 'ig the boss is hard', 'tt for now', 'brb', 'afk', 'pog', 'hype', 'lmao',
  'it.is fine', 'so.so', 'me.too', 'to.do list', 'win.exe', 'pro tip', 'go.mod file', 'cargo.toml', 'package.json', 'tsconfig.json',
  'vite.config.ts', '.env file', '.gitignore', 'node_modules', 'C:\\Users', '~/code', '/usr/bin', 'localhost', 'port 8080',
  'a. b. c.', 'A.I. is wild', 'Q&A', 'p.s. hi', 'P.S. bye', 'No. 1', 'St. Louis', 'U.K. time', 'the U.S. team',
];
test('adversarial batch A: every bypass is caught', () => { assert.deepEqual(BAD_A.filter(s => !findProblem(s)), []); });
test('adversarial batch A: ordinary chat passes', () => { assert.deepEqual(FINE_A.map(s => [s, findProblem(s)]).filter(([, p]) => p), []); });
const BAD_B = [
  'google🔥.🔥com', 'g🔥o🔥o🔥g🔥l🔥e.com', 'google💯com', 'google★.com', 'google.★com', '\u202Emoc.elgoog', 'moc.elgoog',
  'hey all! fun night. btw my stuff is at evil.com if you want', 'lol nice. evil . xyz', 'e-v-i-l-c-o-m', 'e_v_i_l.c_o_m',
  'evil.com'.split('').join('\u200b'), 'evil.com'.split('').join(' '), 'EVIL[.]XYZ/abc', 'evil\\.com', 'evil%2Ecom', 'evil&#46;com',
  'evil,xyz', 'evil。ru', 'go 2 evil.c0m', 'g0 t0 3vil d0t c0m', 'my tele is t.me slash coolguy', 'join discord dot gg slash abc',
];
const FINE_B = ['good night everyone 🌙', 'gg 🔥🔥🔥', 'nice! 💯', 'ok :)', 'lol :D', 'yes!!! :3', 'wow... ok', 'brb 5 min', 'see ya ✌️',
  'hey all! fun night', 'evil laugh', 'moc moc', 'i love com-sci', 'the .com era', 'old .net code', 'docs are good', 'regex: a.b.c'];
test('adversarial batch B: every bypass is caught', () => { assert.deepEqual(BAD_B.filter(s => !findProblem(s)), []); });
test('adversarial batch B: ordinary chat passes', () => { assert.deepEqual(FINE_B.map(s => [s, findProblem(s)]).filter(([, p]) => p), []); });
