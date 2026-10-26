// @ts-check
// Activities for 'films-b': classic + comedy film homages (props/hotspots are placed by extras-films-b.js).
// Each one is a short in-world close-up with a caption (films-b-fx.js moment), except the printer mini-game overlay.
import { SFX } from '../sfx.js';
import { moment, slime, goldWash } from './films-b-fx.js';
import { printerGame } from './films-b-printer.js';
import { moonLocal } from './extras-films-b.js';

const on = (room, id) => (it, R) => R.id === room && it.id === id;
const DUDE = ["Yeah, well, that's just, like, your opinion, man.", 'This rug really tied the room together.', "Careful, man, there's a beverage here.", 'The Dude abides.'];

/** @type {any[]} */
export default [
  { id: 'fb-dude', sfx: 'glass', match: on('roof', 'fb-dude'), start(ctx) {
    const fx = ctx.R.fbx, av = fx.dude, line = DUDE[fx.dudeI++ % DUDE.length];
    av.fx.sip = 1.4; ctx.U?.bubble?.({ root: av.root }, line, 4);
    moment(ctx, { at: [-7.2, 0.8, 2.5], dir: { x: 0.6, y: 0.65, z: 1 }, zoom: 1.5, walls: false, title: 'The guy in the robe', line, secs: 4.2 });
  } },
  { id: 'fb-moon', sfx: 'magic', match: on('roof', 'fb-moon'), start(ctx) {
    const R = ctx.R, fx = R.fbx, side = fx.moonSide(), m = moonLocal(side);
    const at = side === 'n' ? [m.x, m.y, -R.d / 2 + m.z] : [-m.x, m.y, R.d / 2 - m.z];
    fx.bikeAt = (fx.now || 0) + 0.8;
    moment(ctx, { at: /** @type {[number,number,number]} */ (at), dir: side === 'n' ? { x: 0, y: 1, z: 0.75 } : { x: 0, y: 1, z: -0.75 }, zoom: 1.5, walls: false,
      title: 'Full moon over the city', line: 'Something small rides past. Phone home, buddy.', secs: 8.5 });
  } },
  { id: 'fb-case', sfx: false, match: on('bar', 'fb-case'), start(ctx) {
    SFX.play('snap'); setTimeout(() => SFX.play('snap'), 250); SFX.play('magic', { delay: 0.9, vol: 0.6 });
    const fx = ctx.R.fbx; fx.openWant = 1; goldWash(4.2); let said = 0; const me = ctx.S.me?.root, meVis = me?.visible; if (me) me.visible = false; // the player stands between camera and case
    moment(ctx, { at: [-7.85, 0.95, 2.8], dir: { x: 0.7, y: 1.3, z: 0.25 }, zoom: 0.95, title: 'The briefcase', line: '*click* *click*', secs: 4.5,
      tick: (dt, t, api) => { if (t > 1.1 && said < 1) { said = 1; api.cap.set(null, "It's... beautiful."); } if (t > 2.8 && said < 2) { said = 2; api.cap.set(null, 'You close it. Some things stay unexplained.'); fx.openWant = 0; } },
      end: () => { fx.openWant = 0; if (me) me.visible = meVis; } });
  } },
  { id: 'fb-water', sfx: false, match: on('bar', 'fb-water'), start(ctx) {
    const fx = ctx.R.fbx; fx.quake = 5; let last = -1;
    moment(ctx, { at: [-3.45, 1.15, -3.95], dir: { x: 0.2, y: 1.2, z: -0.55 }, up: { x: 0, y: 0, z: 1 }, zoom: 0.4, title: 'thoom... thoom...', line: 'Must go faster.', secs: 5,
      tick: (dt, t, api) => { const k = Math.floor((t + 0.2) / 1.0); if (k !== last) { last = k; api.shake(0.025); SFX.play('thud', { vol: 0.5, pitch: 0.6 }); } }, end: () => { fx.quake = 0; } });
  } },
  { id: 'fb-carpet', sfx: 'eerie', match: on('den', 'fb-carpet'), start(ctx) {
    [800, 1200, 1500].forEach((ms, i) => setTimeout(() => SFX.play('thud', { vol: 0.3 - i * 0.07, pitch: 1.6 }), ms));
    const fx = ctx.R.fbx; fx.ballT = 0;
    moment(ctx, { at: [-4.7, 0.3, 0.1], dir: { x: 0.6, y: 1, z: 0.75 }, zoom: 1.4, title: 'Strange hallway carpet', line: 'A tennis ball rolls up. Come play with us.', secs: 4.5 });
  } },
  { id: 'fb-hover', sfx: false, match: on('den', 'fb-hover'), start(ctx) {
    SFX.play('whoosh', { vol: 0.5 }); SFX.play('hum', { vol: 0.3, delay: 0.3 });
    const fx = ctx.R.fbx; fx.liftWant = 1;
    moment(ctx, { at: [1.6, 0.5, -5.1], dir: { x: 0.35, y: 1.1, z: 0.8 }, zoom: 0.9, title: 'Hoverboard', line: "Roads? Where we're going, we don't need roads.", secs: 4.5, end: () => { fx.liftWant = 0; } });
  } },
  { id: 'fb-mirror', sfx: false, match: on('bedroom', 'fb-mirror'), start(ctx) {
    const fx = ctx.R.fbx; let flipped = false;
    moment(ctx, { at: [-1.0, 1.15, -3.6], dir: { x: 0.3, y: 0.3, z: 1 }, zoom: 0.85, title: 'redrum. redrum.', line: 'Someone wrote on your mirror in lipstick.', secs: 4.5,
      tick: (dt, t, api) => { if (t > 1.4 && !flipped) { flipped = true; fx.flipWant = 1; api.shake(0.04); SFX.play('sting', { vol: 0.5 }); api.cap.set('REDRUM', '...read backwards: MURDER. Lovely.'); } }, end: () => { fx.flipWant = 0; } });
  } },
  { id: 'fb-stapler', sfx: false, match: on('basement', 'fb-stapler'), start(ctx) {
    SFX.play('snap', { vol: 0.5 }); setTimeout(() => SFX.play('snap', { vol: 0.4 }), 200);
    const st = ctx.R.fbx.stapler, ry = st.rotation.y;
    moment(ctx, { at: [-0.75, 0.8, 0.6], dir: { x: 0.75, y: 0.85, z: 0.6 }, zoom: 0.42, title: 'A red stapler', line: 'I believe you have my stapler.', secs: 3.8,
      tick: (dt, t) => { st.rotation.y = ry + Math.sin(t * 30) * 0.08 * Math.max(0, 1 - t); }, end: () => { st.rotation.y = ry; } });
  } },
  { id: 'fb-pack', sfx: 'hum', match: on('basement', 'fb-pack'), start(ctx) {
    const fx = ctx.R.fbx; fx.packHot = 4; let splat = false;
    moment(ctx, { at: [3.3, 0.6, -5.0], dir: { x: 0.5, y: 0.5, z: 1 }, zoom: 0.8, title: 'Unlicensed nuclear accelerator', line: 'Who you gonna call?', secs: 4.2,
      tick: (dt, t, api) => { if (t > 0.9 && !splat) { splat = true; SFX.play('splash', { vol: 0.5 }); slime((fx.now * 1000) | 0); api.shake(0.05); api.cap.set(null, "Not IT. That's slime on the lens."); } } });
  } },
  { id: 'fb-printer', match: on('basement', 'fb-printer'), start: printerGame },
];
