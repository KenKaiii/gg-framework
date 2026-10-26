// @ts-check
// Activities for Doc's Garage: 88 MPH in the time car, cranking the giant amp, and the ghost trap.
// The in-world effects live in rooms/garage-fx.js; these set its flags (R.gx) and frame the moment with a caption.
import { moment } from './films-b-fx.js';
import { SFX } from '../sfx.js';

const on = id => (it, R) => R.id === 'garage' && it.id === id && !!R.gx;

/** Full-screen white flash. @param {number} ms */
function flash(ms = 700) {
  const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;background:#fff;opacity:1;transition:opacity ' + ms + 'ms ease-out';
  document.body.appendChild(d); requestAnimationFrame(() => requestAnimationFrame(() => { d.style.opacity = '0'; })); setTimeout(() => d.remove(), ms + 100);
}

/** @type {any[]} */
export default [
  { id: 'garage-car', label: 'Hit 88 MPH', sfx: 'beep', match: on('car'), start(ctx) {
    const g = ctx.R.gx, r = ctx.S.me?.root; g.carWant = true; let step = 0; if (r) r.visible = false; // the car leaves with you in it
    moment(ctx, { at: [3.4, 0.8, 0.8], dir: { x: -0.3, y: 0.75, z: 1 }, zoom: 3.2, title: 'Time circuits on', line: 'Destination: NOV 05 1955.', secs: 7.2,
      tick: (dt, t, api) => {
        if (step < 0.5) { step = 0.5; SFX.play('blip', { delay: 0.2 }); SFX.play('engine', { delay: 0.4 }); }
        if (t > 1.4 && step < 1) { step = 1; SFX.play('gr.flux'); SFX.play('engine', { pitch: 1.4, delay: 0.5 }); api.cap.set('Flux capacitor... fluxing', 'Hold on. 77... 82... 88 MPH!'); }
        if (t > 2.6 && step < 2) { step = 2; flash(700); api.shake(0.18); SFX.play('zap'); SFX.play('thunder', { vol: 0.8 }); SFX.play('fire', { delay: 0.3 }); api.cap.set('OUTATIME', 'Two lines of fire and an empty garage.'); }
        if (t > 4.6 && step < 3) { step = 3; flash(350); api.shake(0.1); SFX.play('zap', { pitch: 0.8 }); SFX.play('thud', { delay: 0.1 }); SFX.play('wind', { delay: 0.4, vol: 0.5 }); api.cap.set('Great Scott!', "It's back. And it's smoking."); }
      }, end: () => { if (r) r.visible = true; } });
  } },
  { id: 'garage-amp', label: 'Crank it to 11', sfx: false, match: on('amp'), start(ctx) {
    const { S, R } = ctx, me = S.me, g = R.gx; let blown = false, k = -1; const p = me?.root?.position, from = p ? p.clone() : null;
    moment(ctx, { at: [-5.2, 0.9, 2.6], dir: { x: 0.35, y: 0.7, z: 1 }, zoom: 3.4, walls: false, title: 'Volume: 11', line: 'One chord. Just one.', secs: 3.6,
      tick: (dt, t, api) => {
        if (t < 0.7 && k < -0.5) { k = -0.4; SFX.play('ui.click', { vol: 0.5 }); for (let i = 0; i < 4; i++) SFX.play('tick', { delay: 0.1 + i * 0.12, pitch: 1 + i * 0.1 }); }
        if (t > 0.7 && !blown) { blown = true; k = 0; g.ampWant = true; api.shake(0.25); SFX.play('gr.kraang'); SFX.play('whoosh', { delay: 0.1 }); SFX.play('thud', { delay: 0.65 }); api.cap.set('KRAAANG!', 'Blown clean across the garage.'); if (me) { me.path = null; me.av?.play?.('Jump_Full_Short'); } }
        if (k >= 0 && k < 1 && p && from) { k = Math.min(1, k + dt / 0.55); const e = 1 - (1 - k) * (1 - k), nx = from.x + 3.2 * e;
          if (R.grid.free(nx, from.z)) p.x = nx; if (k >= 1) me.av?.play?.('Idle'); }
      } });
  } },
  { id: 'garage-clocks', label: 'Check the time', match: on('clocks'), start(ctx) {
    const g = ctx.R.gx, r = ctx.S.me?.root; g.clockAt = g.now; let step = 0; if (r) r.visible = false;
    moment(ctx, { at: [-5.2, 1.55, -3.6], dir: { x: 0, y: 0.18, z: 1 }, zoom: 1.55, title: 'Doc\'s clocks', line: 'Every clock says something different...', secs: 5,
      tick: (dt, t, api) => {
        if (step < 0.5) { step = 0.5; for (let i = 0; i < 12; i++) SFX.play('clock', { delay: 0.2 + i * 0.13, vol: 0.5, pitch: 1 + (i % 3) * 0.15 }); }
        if (t > 1.9 && step < 1) { step = 1; SFX.play('chime'); SFX.play('ui.select', { delay: 0.25 }); api.cap.set('10:04 PM', 'Every single clock. At once.'); }
        if (t > 2.5 && step < 2) { step = 2; flash(500); api.shake(0.08); setTimeout(() => flash(250), 180); SFX.play('zap'); SFX.play('thunder'); api.cap.set('KRA-KOOM!', 'Lightning strikes the clock tower. Right on time.'); }
      }, end: () => { if (r) r.visible = true; } });
  } },
  { id: 'garage-dog', label: 'Pet the dog', match: on('dog'), start(ctx) {
    const g = ctx.R.gx; g.dogAt = g.now; let step = 0;
    moment(ctx, { at: [6.4, 0.45, 2.75], dir: { x: 0.5, y: 1.1, z: -0.7 }, zoom: 1.25, title: 'Einstein', line: 'One ear twitches. He is up!', secs: 6,
      tick: (dt, t, api) => {
        if (t > 0.6 && step < 1) { step = 1; SFX.play('woof'); for (let i = 0; i < 10; i++) SFX.play('step.concrete', { delay: i * 0.24, vol: 0.4, pitch: 1.6 }); api.cap.set('Zoomies', 'A victory lap of the garage.'); }
        if (t > 3.2 && step < 2) { step = 2; SFX.play('woof', { pitch: 1.15 }); SFX.play('sparkle', { delay: 0.3, vol: 0.5 }); api.cap.set('Good boy.', 'Sits. Wags. Accepts your offering of pets.'); }
      } });
  } },
  { id: 'garage-trap', label: 'Open the ghost trap', sfx: 'snap', match: on('trap'), start(ctx) {
    const g = ctx.R.gx; g.ghostWant = true; let step = 0;
    moment(ctx, { at: [0.5, 1.2, 0], dir: { x: 0.6, y: 0.8, z: 1 }, zoom: 4.6, walls: false, title: 'Click.', line: 'Oops. Something got out.', secs: 7,
      tick: (dt, t, api) => {
        if (step < 0.5) { step = 0.5; SFX.play('creak', { delay: 0.15 }); }
        if (t > 1.0 && step < 1) { step = 1; SFX.play('eerie'); SFX.play('whoosh', { delay: 0.4 }); api.cap.set('Bwahahaha!', 'A little green ghost does laps of the garage.'); }
        if (t > 5.4 && step < 2) { step = 2; api.shake(0.06); SFX.play('zap'); SFX.play('swoosh', { delay: 0.1 }); SFX.play('snap', { delay: 0.5 }); api.cap.set('Gotcha.', 'Sucked back in. Lid shut. Nobody saw that.'); }
      } });
  } },
];
