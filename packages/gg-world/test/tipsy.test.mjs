// node --test packages/gg-world/test/tipsy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { slur, blurt, STRENGTH, LEVELS, startDrink, tickTipsy, tipsyLevel } = await import('../src/tipsy.js');

test('5 levels, sober to absolutely gone', () => { assert.equal(LEVELS.length, 6); });
test('chat: sober and tipsy unchanged, then slurring, then nonsense', () => {
  assert.equal(slur('see you at the session', 0), 'see you at the session');
  assert.equal(slur('see you at the session', 1), 'see you at the session');
  let changed = 0; for (let i = 0; i < 40; i++) if (slur('see you at the session', 2) !== 'see you at the session') changed++;
  assert.ok(changed > 30, 'level 2 usually slurs');
  assert.ok(slur('hello there', 5).length > 0);
  assert.equal(blurt(2), null); assert.ok(blurt(4));
});
test('a drink: 2-3 sips, then the hand is empty; non-alcoholic does nothing', () => {
  const S = { t: 0, me: { av: { fx: {} } } }; let held = 'beer';
  startDrink(S, 'lager', 'beer', p => { held = p; });
  let sips = 0, prev = S.tipsy.drink.sips;
  for (let i = 0; i < 400; i++) { S.t += 0.05; tickTipsy(S, 0.05); if (S.tipsy.drink && S.tipsy.drink.sips < prev) { sips++; prev = S.tipsy.drink.sips; } if (!S.tipsy.drink) break; }
  assert.ok(S.tipsy.amount > 0.7, 'a lager makes you a bit tipsy');
  const S2 = { t: 0, me: { av: { fx: {} } } }; startDrink(S2, 'butter', 'mug', () => {});
  for (let i = 0; i < 400; i++) { S2.t += 0.05; tickTipsy(S2, 0.05); } assert.equal(tipsyLevel(S2), 0);
  assert.equal(STRENGTH.butter, undefined); assert.equal(STRENGTH.soda, undefined); assert.equal(STRENGTH.nuka, undefined);
});
test('it climbs with drinks and wears off over time', () => {
  const S = { t: 0, me: { av: { fx: {} } } };
  for (let d = 0; d < 6; d++) { startDrink(S, 'gargle', 'cocktail', () => {}); for (let i = 0; i < 300; i++) { S.t += 0.05; tickTipsy(S, 0.05); } }
  assert.ok(tipsyLevel(S) >= 4, 'six gargle blasters: very drunk');
  for (let i = 0; i < 20 * 60 * 10; i++) { S.t += 0.1; tickTipsy(S, 0.1); }
  assert.equal(tipsyLevel(S), 0, 'sober again after 20 minutes');
});

test('every alcoholic drink shows: one lager is Tipsy straight away (roof cooler or bar), soft drinks never', () => {
  const mk = () => ({ t: 0, me: { av: { fx: {} } } });
  const drink = (S, id) => { startDrink(S, id, 'beer', () => {}); while (S.tipsy.drink) { S.t += 0.05; tickTipsy(S, 0.05); } };
  for (const id of ['lager', 'ipa2', 'ipa', 'red', 'blue', 'round']) { const S = mk(); drink(S, id); assert.equal(tipsyLevel(S), 1, id); }
  for (const id of ['dude', 'martini', 'negroni', 'hotfix', 'mystery', 'gargle']) { const S = mk(); drink(S, id); assert.ok(tipsyLevel(S) >= 2, id); }
  for (const id of ['soda', 'nuka', 'nuka2', 'butter', 'fries', 'pizza', 'royale', 'soylent']) { const S = mk(); drink(S, id); assert.equal(tipsyLevel(S), 0, id); }
  const S = mk(); drink(S, 'lager'); drink(S, 'ipa2'); assert.equal(tipsyLevel(S), 2, 'two beers: buzzed');
  let t = 0; const L = mk(); drink(L, 'lager'); while (tipsyLevel(L) > 0) { L.t += 1; t += 1; tickTipsy(L, 1); }
  assert.ok(t > 90 && t < 180, `a lager lasts about 2 minutes (${t} s)`);
});

test('the HUD stays above the tilted (tipsy) game canvas', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/ui.css.js', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('../src/tipsy.js', import.meta.url), 'utf8');
  // a CSS transform on the canvas makes a new layer that paints over an un-stacked #ui: #ui needs its own z-index
  assert.match(css, /#ui\{position:fixed;inset:0;z-index:2;/);
  assert.match(src, /canvas\.style\.zIndex = '0'/);
});
