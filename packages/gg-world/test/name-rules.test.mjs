// node --test packages/gg-world/test/name-rules.test.mjs   (the name rules: creator.js nameProblem + the typing filter)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// creator.js imports DOM modules, so test its nameProblem by evaluating just that function (and the guard it calls)
const src = fs.readFileSync(new URL('../src/creator.js', import.meta.url), 'utf8');
const { findProblem } = await import('../src/chat-guard.js');
const fnSrc = src.slice(src.indexOf('const RESERVED'), src.indexOf("import { makePreview }"));
const nameProblem = new Function('findProblem', fnSrc.replace('export function nameProblem', 'function nameProblem') + '\nreturn nameProblem;')(findProblem);
// the typing filter, copied from the input handler
const typed = s => { let v = s.replace(/[^A-Za-z0-9 ]/g, '').replace(/^ +/, '').replace(/ {2,}/g, ' '); const sp = v.indexOf(' '); if (sp >= 0) v = v.slice(0, sp + 1) + v.slice(sp + 1).replace(/ /g, ''); return v.slice(0, 14); };

test('good names pass', () => {
  for (const n of ['Ken', 'Ken Kai', 'Nova', 'kai99', 'Ada Lovelace', 'R2D2', 'abcdefghijklmn']) assert.equal(nameProblem(n), '', n);
});
test('bad names are refused', () => {
  const bad = { '': 'Pick a name first', '   ': 'Pick a name first', ab: 'At least 3 characters', abcdefghijklmno: 'Up to 14 characters',
    'Ken!': 'Letters, numbers and one space only', 'Kén': 'Letters, numbers and one space only', 'ken_kai': 'Letters, numbers and one space only',
    'a b c': 'Only one space', 'Ken  Kai': 'Only one space', '123': 'Needs at least one letter', 'aaaaaa': 'Try another name',
    admin: 'That name is reserved. Try another', 'GG Coder': 'That name is reserved. Try another', 'evil com': 'Try another name' };
  for (const [n, why] of Object.entries(bad)) assert.equal(nameProblem(n), why, JSON.stringify(n));
});
test('typing can only make letters, numbers and one space, 14 max', () => {
  assert.equal(typed('Ken!!! Kai'), 'Ken Kai');
  assert.equal(typed('  Ken'), 'Ken');
  assert.equal(typed('a b c d'), 'a bcd');
  assert.equal(typed('Ken    Kai'), 'Ken Kai');
  assert.equal(typed('😀Kén🔥'), 'Kn');
  assert.equal(typed('x'.repeat(60)), 'x'.repeat(14));
  assert.equal(typed('word '.repeat(50)).length <= 14, true);
});
