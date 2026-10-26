// @ts-check
// Room extras (bar, den, bedroom, kitchen, studio, roof, basement):
//   - idle-prop hotspots: a short label, a line, a fitting positional sound and a small reaction (the nearest live mesh
//     wobbles/pops; the player does a little Interact either way)
//   - player seats: one slot per piece of seating is held back while members pick their homes (crew init runs after
//     extras), then handed back on the room's first tick, so every couch/stool/booth has a seat members don't own.
import * as THREE from 'three';
import { SFX } from '../sfx.js';

/** @typedef {{ c:string, k:'spark'|'drops'|'puff'|'notes'|'glow', y?:number, x?:number, z?:number }} Fx  visual burst at the prop (x/z default to the hotspot) */
/** @typedef {{ id:string, x:number, z:number, r?:number, label:string, line:string, snd:[string, any?][], fx?:Fx }} Hot */
/** default burst from the hotspot's sound: every reaction shows something, not only a bubble */
const FX_BY_SND = { pour: ['#7fc8ff', 'drops', 0.8], zap: ['#ff4fd8', 'spark', 2.0], snap: ['#ffcf8a', 'glow', 0.9], chord: ['#ffd36b', 'notes', 1.0], paper: ['#ffffff', 'glow', 1.5],
  fire: ['#ff8a3d', 'spark', 0.6], creak: ['#cfa070', 'puff', 0.8], thud: ['#c0c8ff', 'puff', 0.7], rattle: ['#c0c8ff', 'puff', 0.8], bubble: ['#ff4fd8', 'spark', 0.7],
  meow: ['#ffd36b', 'notes', 1.4], magic: ['#3ddc84', 'spark', 1.2], wind: ['#cfe0ff', 'puff', 1.2], swoosh: ['#cfe0ff', 'puff', 0.6], ping: ['#7fc8ff', 'notes', 1.6] };
const N = 18;
/** how a named prop moves: plants sway, lamps/hammocks swing, neon/fire swell, guitars vibrate (all smooth, decaying) */
const animOf = h => /plant|planter/.test(h.id) ? 'sway' : /lamp|hammock/.test(h.id) ? 'swing' : /neon|ship|fire|lava/.test(h.id) ? 'pulse' : 'wiggle';
const DUR = { sway: 1.8, swing: 2.0, pulse: 1.6, wiggle: 0.7 };
let DOT = null;
function dot() { if (DOT) return DOT; const c = document.createElement('canvas'); c.width = c.height = 32; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  DOT = new THREE.CanvasTexture(c); return DOT; }
/** one pooled burst per room (sprite flash + 18 particles), created on first use, hidden when idle */
function makeBurst(R) {
  const m = new THREE.SpriteMaterial({ map: dot(), color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const flash = new THREE.Sprite(m); flash.visible = false; flash.userData.noGround = true; R.root.add(flash);
  const g = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), vel = new Float32Array(N * 3); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pm = new THREE.PointsMaterial({ map: dot(), size: 0.09, color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const pts = new THREE.Points(g, pm); pts.visible = false; pts.frustumCulled = false; pts.userData.noGround = true; R.root.add(pts);
  return { flash, pts, pos, vel, t: -1, k: 'glow', x: 0, y: 0, z: 0 };
}
/** @type {Record<string, Hot[]>} */
const HOTS = {
  bar: [
    { id: 'rx-neon', x: -4.2, z: -4.0, r: 0.6, fx: { c: '#3ddc84', k: 'spark', y: 2.6, z: -5.6 }, label: 'Tap the neon', line: 'it buzzes back. rude.', snd: [['zap', { vol: 0.35 }], ['hum', { vol: 0.3, delay: 0.1 }]] },
    { id: 'rx-coats', x: 0.4, z: 5.2, r: 0.5, label: 'Check the coat rack', line: "someone left a hoodie. it says 'prod'.", snd: [['rattle', { vol: 0.4 }], ['swoosh', { vol: 0.3, delay: 0.2 }]] },
    { id: 'rx-mic', x: 6.0, z: -4.4, r: 0.4, label: 'Tap the mic', line: '*tap tap* is this thing on?', snd: [['thud', { vol: 0.4, pitch: 1.6 }], ['ping', { vol: 0.25, delay: 0.25 }]] },
    { id: 'rx-sign', x: 5.0, z: -2.9, r: 0.45, label: 'Read the sign', line: 'open mic thursday. bring your bugs.', snd: [['paper', { vol: 0.5 }]] },
    { id: 'rx-speaker', x: 8.4, z: -5.0, r: 0.5, label: 'Feel the bass', line: 'your ribcage is now in 4/4.', snd: [['thud', { vol: 0.6, pitch: 0.6 }], ['thud', { vol: 0.5, pitch: 0.6, ms: 450 }]] },
    { id: 'rx-cat', x: 6.6, z: 5.5, r: 0.5, label: 'Pet the poster cat', line: '404: cat is asleep.', snd: [['meow', { vol: 0.4 }]] },
  ],
  den: [
    { id: 'rx-lava', x: -3.15, z: -5.2, r: 0.45, label: 'Shake the lava lamp', line: 'blobs: agitated. you: hypnotised.', snd: [['bubble', { vol: 0.4 }], ['gurgle', { vol: 0.3, delay: 0.3 }]] },
    { id: 'rx-plant', x: -5.5, z: 4.2, r: 0.5, fx: { c: '#7fc8ff', k: 'drops', y: 0.9, x: -5.9, z: 5.5 }, label: 'Water the plant', line: 'it has survived three LAN parties.', snd: [['pour', { vol: 0.4 }], ['gurgle', { vol: 0.3, delay: 0.5 }]] },
    { id: 'rx-lamp', x: -5.85, z: 3.75, r: 0.4, label: 'Click the lamp', line: 'click. click. still cosy.', snd: [['snap', { vol: 0.4 }], ['snap', { vol: 0.35, ms: 300 }]] },
    { id: 'rx-poster', x: 5.75, z: -5.5, r: 0.5, label: 'Read the poster', line: 'HERE BE DRAGONS (and merge conflicts).', snd: [['paper', { vol: 0.45 }]] },
  ],
  bedroom: [
    { id: 'rx-lamp', x: 4.5, z: -2.3, r: 0.45, label: 'Flick the lamp', line: 'mood lighting: engaged.', snd: [['snap', { vol: 0.4 }]] },
    { id: 'rx-plant', x: 4.45, z: 3.4, r: 0.5, label: 'Water the plant', line: 'it is 80% coffee grounds by now.', snd: [['pour', { vol: 0.4 }], ['gurgle', { vol: 0.3, delay: 0.5 }]] },
    { id: 'rx-guitar', x: 4.6, z: -0.8, r: 0.5, label: 'Strum the guitar', line: 'one chord. the only chord.', snd: [['chord', { vol: 0.5 }]] },
    { id: 'rx-laundry', x: -1.5, z: 3.4, r: 0.5, label: 'Sniff the laundry', line: 'still clean. probably.', snd: [['swoosh', { vol: 0.35 }], ['cushion', { vol: 0.3, delay: 0.2 }]] },
  ],
  kitchen: [
    { id: 'rx-plant', x: -1.95, z: -3.4, r: 0.45, label: 'Water the plant', line: 'basil. it judges your ramen.', snd: [['pour', { vol: 0.4 }], ['gurgle', { vol: 0.3, delay: 0.5 }]] },
    { id: 'rx-plant2', x: 3.6, z: 3.5, r: 0.45, label: 'Water the plant', line: 'the fern says thanks. probably.', snd: [['pour', { vol: 0.4 }], ['gurgle', { vol: 0.3, delay: 0.5 }]] },
    { id: 'rx-drawer', x: -2.75, z: 1.5, r: 0.5, label: 'Rummage the drawer', line: 'forks, a USB-C cable, 14 soy sauce packets.', snd: [['rattle', { vol: 0.45 }], ['glass', { vol: 0.25, delay: 0.3 }]] },
  ],
  studio: [
    { id: 'rx-lamp', x: -1.7, z: 0.6, r: 0.35, label: 'Click the lamp', line: 'key light: on. ring light: imaginary.', snd: [['snap', { vol: 0.4 }]] },
    { id: 'rx-neon', x: 5.6, z: 3.3, r: 0.45, label: 'Tap the neon', line: 'PODCAST. episode 0 forever.', snd: [['zap', { vol: 0.3 }], ['hum', { vol: 0.3, delay: 0.1 }]] },
    { id: 'rx-ship', x: -1.9, z: -3.5, r: 0.45, label: 'Tap the neon', line: 'SHIP IT. (on a friday.)', snd: [['zap', { vol: 0.3, pitch: 1.2 }], ['hum', { vol: 0.3, delay: 0.1 }]] },
    { id: 'rx-plant', x: -6.0, z: 3.6, r: 0.5, label: 'Water the plant', line: 'the money plant. still no money.', snd: [['pour', { vol: 0.4 }], ['coin', { vol: 0.2, delay: 0.6 }]] },
    { id: 'rx-mic', x: 4.0, z: 1.8, r: 0.4, label: 'Test the mics', line: 'check one two. the levels are vibes.', snd: [['ping', { vol: 0.3 }], ['blip', { vol: 0.25, delay: 0.3 }]] },
  ],
  roof: [
    { id: 'rx-fire', x: -1, z: -0.3, r: 0.45, label: 'Poke the fire', line: 'sparks up. everyone goes oooh.', snd: [['fire', { vol: 0.5 }], ['snap', { vol: 0.35, delay: 0.15 }]] },
    { id: 'rx-hammock', x: -7.7, z: 5.7, r: 0.5, label: 'Swing the hammock', line: 'creak... creak... nap pending.', snd: [['creak', { vol: 0.4 }], ['creak', { vol: 0.3, ms: 700 }]] },
    { id: 'rx-vent', x: 8.3, z: -5.7, r: 0.6, label: 'Kick the vent', line: 'clang. it was already like that.', snd: [['thud', { vol: 0.5 }], ['rattle', { vol: 0.4, delay: 0.1 }]] },
    { id: 'rx-planter', x: 6.6, z: 5.9, r: 0.6, label: 'Water the planter', line: 'rooftop tomatoes: 2. pigeons: 9.', snd: [['pour', { vol: 0.4 }], ['gurgle', { vol: 0.3, delay: 0.5 }]] },
    { id: 'rx-wind', x: 3.4, z: -6.0, r: 0.4, label: 'Look over the edge', line: 'long way down. nice breeze.', snd: [['wind', { vol: 0.4 }]] },
  ],
  basement: [
    { id: 'rx-rabbit', x: -3.8, z: -5.0, r: 0.6, label: 'Follow the rabbit', line: 'knock knock, Neo.', snd: [['magic', { vol: 0.4 }], ['hum', { vol: 0.25, delay: 0.2 }]] },
    { id: 'rx-spoon', x: 5.4, z: -5.0, r: 0.5, label: 'Read the poster', line: 'there is no spoon. there is a fork in the sink.', snd: [['paper', { vol: 0.45 }]] },
    { id: 'rx-cables', x: -5.0, z: -2.0, r: 0.5, label: 'Tidy the cables', line: 'you made it worse. respect.', snd: [['rattle', { vol: 0.4 }], ['snap', { vol: 0.3, delay: 0.3 }]] },
  ],
};

/** one seat per piece of seating that members must not take as a home */
const RESERVE = {
  bar: ['bar-stool-6', 'bar-booth-1a', 'bar-booth-2b', 'bar-booth-3a'],
  den: ['den-beanbag', 'den-armchair', 'den-cushion2', 'den-table3'],
  bedroom: ['bed-edge', 'beanbag', 'cushion'],
  kitchen: ['stool-2', 'table-w'],
  studio: ['studio-sofa1', 'studio-sofa4', 'studio-beanbag', 'studio-pod2'],
  roof: ['roof-sofa-l', 'roof-chair-s', 'roof-office', 'roof-crate-sw', 'roof-bean-b', 'roof-hammock', 'roof-bench'],
  basement: ['bs-couch-r', 'bs-armchair', 'bs-beanbag', 'bs-bench', 'bs-hack-0', 'bs-desk'],
};

export default {
  id: 'rooms',
  /** @param {{rooms:Record<string, any>}} ctx */
  install({ rooms }) {
    /** @type {{o:any, t:number, rz:number, rx:number, s:number, kind:string}[]} */ const wob = [];
    /** @type {Map<any, ReturnType<typeof makeBurst>>} */ const bursts = new Map(); /** @type {ReturnType<typeof makeBurst>[]} */ const active = [];
    const fire = (R, h) => {
      const d = FX_BY_SND[h.snd[0][0]] || ['#ffffff', 'glow', 1]; const f = h.fx || { c: d[0], k: d[1], y: d[2] };
      let b = bursts.get(R); if (!b) { b = makeBurst(R); bursts.set(R, b); }
      b.t = now; b.k = f.k; b.x = f.x ?? h.x; b.y = f.y ?? 1; b.z = f.z ?? h.z;
      b.flash.material.color.set(f.c); b.pts.material.color.set(f.c); b.flash.position.set(b.x, b.y, b.z); b.flash.visible = f.k !== 'drops'; b.pts.visible = true;
      for (let i = 0; i < N; i++) { const a = i * 2.39996, s = 0.3 + (i % 5) * 0.12; // golden-angle spread, deterministic
        b.pos[i * 3] = b.x + Math.cos(a) * 0.05; b.pos[i * 3 + 1] = b.y; b.pos[i * 3 + 2] = b.z + Math.sin(a) * 0.05;
        const up = f.k === 'drops' ? -0.2 : f.k === 'notes' ? 0.7 : f.k === 'puff' ? 0.35 : 0.9;
        b.vel[i * 3] = Math.cos(a) * s * (f.k === 'notes' ? 0.4 : 1); b.vel[i * 3 + 1] = up * (0.6 + (i % 3) * 0.3); b.vel[i * 3 + 2] = Math.sin(a) * s * (f.k === 'notes' ? 0.4 : 1); }
      b.pts.geometry.attributes.position.needsUpdate = true; if (!active.includes(b)) active.push(b);
    };
    /** @type {{R:any, sl:any[]}[]} */ const held = [];
    let me = null, now = 0;
    for (const id of Object.keys(HOTS).sort()) {
      const R = rooms[id]; if (!R) continue;
      const keep = new Set(RESERVE[id] || []), sl = R.slots.filter(s => keep.has(s.id) && !s.act);
      if (sl.length) { R.slots = R.slots.filter(s => !sl.includes(s)); held.push({ R, sl }); }
      const hot = new Map(HOTS[id].map(h => [h.id, h]));
      for (const h of HOTS[id]) R.interact.push({ id: h.id, x: h.x, z: h.z, r: h.r ?? 0.5, label: h.label, kind: 'prop', sfx: false });
      const oi = R.onInteract;
      R.onInteract = (hid, api) => {
        const h = hot.get(hid); if (!h) return oi?.(hid, api);
        const o = R.root.position, at = { x: o.x + h.x, y: 1, z: o.z + h.z };
        for (const [n, opt] of h.snd) { const { ms, ...p } = opt || {}; const go = () => SFX.play(n, { ...p, at }); if (ms) setTimeout(go, ms); else go(); }
        api?.bubble?.(h.line); fire(R, h);
        try { me?.once?.('Interact', 1.0); } catch { /* anim missing */ }
        let best = R.live.getObjectByName(h.id) || null, bd = best ? -1 : 0.8;
        if (bd > 0) for (const c of R.live.children) { if (c.isPoints || !c.visible) continue; const d = Math.hypot(c.position.x - h.x, c.position.z - h.z); if (d < bd) { bd = d; best = c; } }
        if (best && !wob.some(w => w.o === best)) wob.push({ o: best, t: now, rz: best.rotation.z, rx: best.rotation.x, s: best.scale.x, kind: animOf(h) });
      };
    }
    return (t, dt, S) => {
      now = t; me = S?.me || me;
      if (held.length && S?.members) for (const h of held.splice(0)) h.R.slots.push(...h.sl);
      for (let j = active.length - 1; j >= 0; j--) { // bursts: ~1.2 s, then hidden (no cost when idle)
        const b = active[j], k = (t - b.t) / 1.2; if (k >= 1 || k < 0) { b.flash.visible = b.pts.visible = false; active.splice(j, 1); continue; }
        const e = 1 - k; b.flash.material.opacity = 0.9 * e * e; b.flash.scale.setScalar(0.4 + k * 1.1); b.pts.material.opacity = e; b.pts.material.size = b.k === 'puff' ? 0.09 + k * 0.2 : 0.09;
        const g = b.k === 'drops' ? -5 : b.k === 'puff' ? 0.2 : b.k === 'spark' ? -1.5 : 0; const p = b.pos, v = b.vel, dd = Math.min(dt || 0.016, 0.05);
        for (let i = 0; i < N; i++) { v[i * 3 + 1] += g * dd; p[i * 3] += v[i * 3] * dd; p[i * 3 + 1] = Math.max(0.03, p[i * 3 + 1] + v[i * 3 + 1] * dd); p[i * 3 + 2] += v[i * 3 + 2] * dd; }
        b.pts.geometry.attributes.position.needsUpdate = true;
      }
      for (let i = wob.length - 1; i >= 0; i--) {
        const w = wob[i], T = DUR[w.kind], k = (t - w.t) / T;
        if (k >= 1 || k < 0) { w.o.rotation.z = w.rz; w.o.rotation.x = w.rx; w.o.scale.setScalar(w.s); wob.splice(i, 1); continue; }
        const e = 1 - k, a = t - w.t;
        if (w.kind === 'sway') { w.o.rotation.z = w.rz + Math.sin(a * 5.2) * 0.09 * e; w.o.rotation.x = w.rx + Math.sin(a * 3.7) * 0.05 * e; }
        else if (w.kind === 'swing') { w.o.rotation.z = w.rz + Math.sin(a * 3.6) * 0.07 * e * e; }
        else if (w.kind === 'pulse') w.o.scale.setScalar(w.s * (1 + 0.14 * Math.sin(k * Math.PI)));
        else { w.o.rotation.z = w.rz + Math.sin(k * 30) * 0.06 * e; w.o.scale.setScalar(w.s * (1 + 0.12 * e * Math.sin(k * Math.PI))); }
      }
    };
  },
};
