import test from 'node:test';
import assert from 'node:assert/strict';
import { packState, makeSender, cleanServer, cleanState, makeTrack, pushSample, sampleAt, parseBlocked, addBlocked, removeBlocked, simTarget, DELAY } from '../src/net-core.js';

test('packState rounds and clamps', () => {
  const s = packState({ floor: 'roof', room: 'deck', x: 1.23456, z: -200, face: 7, anim: 'run', emote: 'nope', tipsy: 3.7, prop: 'beer', coding: 1 });
  assert.deepEqual(s, { floor: 'roof', room: 'deck', x: 1.23, z: -80, face: 0.72, anim: 'run', emote: null, tipsy: 3, prop: 'beer', coding: true });
  assert.equal(packState({ floor: 'x' }).floor, 'main');
});
test('sender: only on change, max 10/s, keepalive 5 s', () => {
  const tx = makeSender(); const a = packState({ x: 1 }), b = packState({ x: 1.001 }), c = packState({ x: 2 });
  assert.equal(tx.want(a, 0), true);
  assert.equal(tx.want(b, 50), false); // same after rounding
  assert.equal(tx.want(c, 50), false); // too soon
  assert.equal(tx.want(c, 120), true);
  assert.equal(tx.want(c, 3000), false);
  assert.equal(tx.want(c, 5200), true);
});
test('cleanServer validates', () => {
  assert.equal(cleanServer(null), null); assert.equal(cleanServer({ t: 'evil' }), null);
  assert.equal(cleanState({ floor: 'moon', room: 'bar', x: 0, z: 0 }), null);
  assert.equal(cleanState({ floor: 'main', room: 'bar', x: NaN, z: 0 }), null);
  const w = cleanServer({ t: 'welcome', you: 'me', world: 'w1', count: 4, players: [{ id: 'a', name: '<b>Al</b>', level: 5000, look: { top: 'red', skin: '#aabbcc', body: 'x"y' }, s: { floor: 'main', room: 'bar', x: 1, z: 2, emote: 'dance', tipsy: 9 } }, { name: 'noid' }] });
  assert.equal(w.players.length, 1); const p = w.players[0];
  assert.equal(p.name, 'bAlb'); assert.equal(p.level, 999); assert.deepEqual(p.look, { skin: '#aabbcc' }); assert.equal(p.s.emote, 'dance'); assert.equal(p.s.tipsy, 5);
  const st = cleanServer({ t: 'states', u: [['a', { floor: 'main', room: 'bar', x: 1, z: 1 }], ['b', { floor: 'x' }], 'junk'] });
  assert.equal(st.u.length, 1);
  assert.equal(cleanServer({ t: 'chat', id: 'a', name: 'Al', text: '  ' }), null);
  assert.equal(cleanServer({ t: 'muted', until: 'soon' }), null);
  assert.deepEqual(cleanServer({ t: 'count', n: 3 }), { t: 'count', n: 3 });
});
test('interpolation renders DELAY behind and lerps face the short way', () => {
  const tr = makeTrack(), o = { x: 0, z: 0, face: 0 };
  assert.equal(sampleAt(tr, 0, o), false);
  pushSample(tr, 1000, 0, 0, 3.0); pushSample(tr, 1100, 10, 0, -3.0);
  sampleAt(tr, 1050 + DELAY, o); assert.equal(o.x, 5); assert.ok(Math.abs(Math.abs(o.face) - Math.PI) < 0.01);
  sampleAt(tr, 5000, o); assert.equal(o.x, 10);
  sampleAt(tr, 0, o); assert.equal(o.x, 0);
  for (let i = 0; i < 20; i++) pushSample(tr, 2000 + i * 100, i, 0, 0); assert.equal(tr.length, 8);
});
test('block list', () => {
  assert.deepEqual(parseBlocked('garbage'), []); assert.deepEqual(parseBlocked('["a","a",1,"b"]'), ['a', 'b']);
  let l = []; for (let i = 0; i < 250; i++) l = addBlocked(l, 'id' + i); assert.equal(l.length, 200); assert.equal(l[199], 'id249');
  assert.deepEqual(removeBlocked(['a', 'b'], 'a'), ['b']);
  assert.equal(simTarget(3), 22); assert.equal(simTarget(40), 0);
});

test('muted keeps who muted you (admin | rules)', () => {
  assert.deepEqual(cleanServer({ t: 'muted', until: 5, by: 'admin' }), { t: 'muted', until: 5, by: 'admin' });
  assert.equal(cleanServer({ t: 'muted', until: 5, by: 'x' })?.by, 'rules');
});

test('states: our own entry is skipped', async () => {
  const { othersOnly } = await import('../src/net-core.js');
  const u = [['me', { x: 1 }], ['p1', { x: 2 }]];
  assert.deepEqual(u.filter(([id]) => othersOnly(id, 'me')).map(e => e[0]), ['p1']);
  assert.equal(othersOnly('', 'me'), false);
});
