// @ts-check
// Night Rooms sound: every effect is synthesised with WebAudio at play time (no audio files, ~0 KB, nothing to load).
// Quiet by design: a soft master bus (compressor + low-pass) and short, gentle sounds. Positional: pass { at: worldPos }
// and the sound fades with distance from the player and pans left/right with the screen.
//   import { SFX } from './sfx.js';  SFX.play('glass');  SFX.play('ball.clack', { vol: 0.6, pitch: 1.2, at: pos });
//   SFX.forItem(it)   best-guess sound for an interactable (kind / id / label keywords): the default for anything new
//   SFX.step(surface) one footstep (wood | tile | carpet | concrete | metal | marble | grass)
// Rules for adding sounds: keep vol <= 0.5, decays short (< 0.6 s unless it's a moment), no harsh highs (we low-pass at
// 9 kHz anyway), no loops. Rate-limited per name (30 ms) and capped at 24 voices, so spamming can't get loud.
let ctx = /** @type {AudioContext|null} */ (null), bus = /** @type {GainNode|null} */ (null), noiseBuf = null;
const KEY = 'night-rooms-sound';
const ST = (() => { try { return { vol: 0.7, muted: false, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { vol: 0.7, muted: false }; } })();
let voices = 0; const lastAt = new Map(); let listener = { x: 0, z: 0, rx: 1, rz: 0 };

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext; if (!AC) return null;
  ctx = new AC(); const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.knee.value = 18; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.4;
  bus = ctx.createGain(); bus.gain.value = ST.muted ? 0 : ST.vol * 0.55; bus.connect(comp); comp.connect(lp); lp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}
// browsers only start audio after a user gesture
const unlock = () => { const c = ensure(); if (c && c.state === 'suspended') c.resume(); };
addEventListener('pointerdown', unlock, true); addEventListener('keydown', unlock, true);

// ---- tiny synth kit -------------------------------------------------------------------------------------------------
/** envelope on a gain param: attack a, decay to ~0 over d */
const env = (p, t, peak, a, d) => { p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); p.exponentialRampToValueAtTime(0.0001, t + a + d); };
/** oscillator: type, f0 -> f1 over the sound, volume, attack, decay */
function tone(out, t, { type = 'sine', f = 440, f1 = 0, v = 0.3, a = 0.004, d = 0.2, det = 0 }) {
  const c = /** @type {AudioContext} */ (ctx), o = c.createOscillator(), g = c.createGain(); o.type = /** @type {OscillatorType} */ (type); o.frequency.setValueAtTime(f, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + d); if (det) o.detune.value = det;
  env(g.gain, t, v, a, d); o.connect(g); g.connect(out); o.start(t); o.stop(t + a + d + 0.05);
}
/** filtered noise burst: filter type, centre f (-> f1), q, volume, attack, decay */
function hiss(out, t, { ft = 'bandpass', f = 1200, f1 = 0, q = 1, v = 0.3, a = 0.002, d = 0.12, off = 0 }) {
  const c = /** @type {AudioContext} */ (ctx), s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain(); s.buffer = noiseBuf;
  fl.type = /** @type {BiquadFilterType} */ (ft); fl.frequency.setValueAtTime(f, t); if (f1) fl.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + a + d); fl.Q.value = q;
  env(g.gain, t, v, a, d); s.connect(fl); fl.connect(g); g.connect(out); s.start(t, off || Math.random() * 1.2, a + d + 0.05);
}
/** FM bell / glassy ping */
function bell(out, t, { f = 880, ratio = 2.76, idx = 2, v = 0.2, d = 0.8 }) {
  const c = /** @type {AudioContext} */ (ctx), car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), g = c.createGain();
  car.frequency.value = f; mod.frequency.value = f * ratio; mg.gain.setValueAtTime(f * idx, t); mg.gain.exponentialRampToValueAtTime(1, t + d);
  mod.connect(mg); mg.connect(car.frequency); env(g.gain, t, v, 0.003, d); car.connect(g); g.connect(out); car.start(t); mod.start(t); car.stop(t + d + 0.05); mod.stop(t + d + 0.05);
}
const seq = (out, t, notes, step, fn) => notes.forEach((n, i) => fn(out, t + i * step, n, i));
const midi = n => 440 * Math.pow(2, (n - 69) / 12);
const KIT = { tone, hiss, bell, seq, midi };

// ---- the sound library ----------------------------------------------------------------------------------------------
/** @type {Record<string, (o:AudioNode, t:number, p:number)=>void>} p = pitch multiplier */
const LIB = {
  // UI
  // hover: a soft, low wooden 'tock' (was a 2 kHz chirp that read as a cricket when repeated)
  'ui.hover': (o, t, p) => { tone(o, t, { type: 'sine', f: 520 * p, f1: 430 * p, v: 0.05, a: 0.003, d: 0.07 }); hiss(o, t, { ft: 'lowpass', f: 900, q: 0.7, v: 0.025, d: 0.025 }); },
  // hovering a thing in the world: an even softer warm 'bloop', a fifth lower
  'ui.hover.world': (o, t, p) => { tone(o, t, { type: 'sine', f: 330 * p, f1: 392 * p, v: 0.045, a: 0.006, d: 0.09 }); tone(o, t + 0.005, { type: 'triangle', f: 660 * p, v: 0.012, a: 0.004, d: 0.05 }); },
  'ui.click': (o, t, p) => { tone(o, t, { type: 'triangle', f: 1300 * p, f1: 700 * p, v: 0.12, d: 0.045 }); hiss(o, t, { f: 3000, q: 2, v: 0.03, d: 0.02 }); },
  'ui.tap': (o, t, p) => tone(o, t, { type: 'sine', f: 520 * p, f1: 380 * p, v: 0.12, d: 0.07 }),
  'ui.open': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 500, f1: 2400, q: 0.8, v: 0.07, a: 0.04, d: 0.14 }); tone(o, t + 0.03, { type: 'sine', f: 660 * p, f1: 990 * p, v: 0.06, a: 0.01, d: 0.14 }); },
  'ui.close': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 2000, f1: 450, q: 0.8, v: 0.06, a: 0.02, d: 0.14 }); tone(o, t, { type: 'sine', f: 880 * p, f1: 520 * p, v: 0.05, a: 0.01, d: 0.12 }); },
  'ui.toast': (o, t, p) => { tone(o, t, { type: 'sine', f: 988 * p, v: 0.06, d: 0.12 }); tone(o, t + 0.07, { type: 'sine', f: 1319 * p, v: 0.05, d: 0.16 }); },
  'ui.deny': (o, t, p) => { tone(o, t, { type: 'square', f: 180 * p, f1: 140 * p, v: 0.04, d: 0.09 }); tone(o, t + 0.1, { type: 'square', f: 150 * p, f1: 120 * p, v: 0.035, d: 0.09 }); },
  'ui.send': (o, t, p) => tone(o, t, { type: 'sine', f: 700 * p, f1: 1400 * p, v: 0.08, d: 0.09 }),
  'ui.type': (o, t, p) => hiss(o, t, { ft: 'highpass', f: 2500 * p, q: 0.7, v: 0.05, d: 0.018 }),
  'ui.select': (o, t, p) => tone(o, t, { type: 'triangle', f: 880 * p, v: 0.08, d: 0.06 }),
  'ui.back': (o, t, p) => tone(o, t, { type: 'triangle', f: 600 * p, f1: 420 * p, v: 0.07, d: 0.07 }),
  'pop': (o, t, p) => { tone(o, t, { type: 'sine', f: 300 * p, f1: 900 * p, v: 0.14, a: 0.002, d: 0.06 }); },
  'sparkle': (o, t, p) => seq(o, t, [84, 88, 91, 96], 0.045, (o2, t2, n) => bell(o2, t2, { f: midi(n) * p, v: 0.05, d: 0.35, idx: 1.2 })),
  // rewards / results
  'coin': (o, t, p) => { bell(o, t, { f: 1568 * p, ratio: 3.5, idx: 1, v: 0.09, d: 0.25 }); bell(o, t + 0.06, { f: 2093 * p, ratio: 3.5, idx: 1, v: 0.09, d: 0.4 }); },
  'buy': (o, t, p) => { hiss(o, t, { f: 2500, q: 1, v: 0.05, d: 0.05 }); bell(o, t + 0.03, { f: 1175 * p, ratio: 3, idx: 0.8, v: 0.08, d: 0.3 }); },
  'success': (o, t, p) => seq(o, t, [72, 76, 79, 84], 0.075, (o2, t2, n) => tone(o2, t2, { type: 'triangle', f: midi(n) * p, v: 0.09, d: 0.22 })),
  'win': (o, t, p) => { seq(o, t, [67, 72, 76, 79, 84], 0.09, (o2, t2, n) => tone(o2, t2, { type: 'square', f: midi(n) * p, v: 0.045, d: 0.2 })); bell(o, t + 0.45, { f: midi(88) * p, v: 0.06, d: 0.8, idx: 1 }); },
  'fail': (o, t, p) => seq(o, t, [64, 61, 57], 0.13, (o2, t2, n) => tone(o2, t2, { type: 'triangle', f: midi(n) * p, f1: midi(n - 1) * p, v: 0.08, d: 0.22 })),
  'levelup': (o, t, p) => { seq(o, t, [60, 64, 67, 72, 76, 79], 0.06, (o2, t2, n) => tone(o2, t2, { type: 'triangle', f: midi(n) * p, v: 0.07, d: 0.25 })); LIB.sparkle(o, t + 0.36, p); },
  'score': (o, t, p) => tone(o, t, { type: 'square', f: 988 * p, f1: 1319 * p, v: 0.05, d: 0.08 }),
  'tick': (o, t, p) => tone(o, t, { type: 'sine', f: 2200 * p, v: 0.04, d: 0.015 }),
  'countdown': (o, t, p) => tone(o, t, { type: 'square', f: 660 * p, v: 0.045, d: 0.1 }),
  'go': (o, t, p) => tone(o, t, { type: 'square', f: 1320 * p, v: 0.05, d: 0.25 }),
  // body
  'sit': (o, t, p) => { hiss(o, t, { ft: 'lowpass', f: 600 * p, q: 0.5, v: 0.16, a: 0.02, d: 0.22 }); tone(o, t + 0.02, { type: 'sine', f: 110 * p, f1: 70, v: 0.1, d: 0.12 }); },
  'stand': (o, t, p) => hiss(o, t, { ft: 'lowpass', f: 900 * p, f1: 400, q: 0.5, v: 0.09, a: 0.04, d: 0.16 }),
  'cushion': (o, t, p) => hiss(o, t, { ft: 'lowpass', f: 500 * p, q: 0.4, v: 0.14, a: 0.03, d: 0.25 }),
  'whoosh': (o, t, p) => hiss(o, t, { ft: 'bandpass', f: 400 * p, f1: 1800 * p, q: 1.2, v: 0.1, a: 0.06, d: 0.18 }),
  'swoosh': (o, t, p) => hiss(o, t, { ft: 'bandpass', f: 1800 * p, f1: 500 * p, q: 1.2, v: 0.1, a: 0.03, d: 0.2 }),
  'thud': (o, t, p) => { tone(o, t, { type: 'sine', f: 120 * p, f1: 50, v: 0.18, d: 0.15 }); hiss(o, t, { ft: 'lowpass', f: 400, v: 0.1, d: 0.06 }); },
  'punch': (o, t, p) => { tone(o, t, { type: 'sine', f: 160 * p, f1: 55, v: 0.2, d: 0.12 }); hiss(o, t, { ft: 'bandpass', f: 1500 * p, q: 0.8, v: 0.14, d: 0.05 }); },
  'block': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 900 * p, q: 2, v: 0.14, d: 0.06 }); tone(o, t, { type: 'triangle', f: 240 * p, v: 0.08, d: 0.06 }); },
  'grunt': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 140 * p, f1: 100 * p, v: 0.05, a: 0.01, d: 0.14 }); hiss(o, t, { ft: 'bandpass', f: 700 * p, q: 3, v: 0.05, d: 0.12 }); },
  // household / bar
  'glass': (o, t, p) => { bell(o, t, { f: 2637 * p, ratio: 2.3, idx: 0.6, v: 0.07, d: 0.5 }); bell(o, t + 0.05, { f: 3136 * p, ratio: 2.3, idx: 0.5, v: 0.05, d: 0.4 }); },
  'pour': (o, t, p) => { for (let i = 0; i < 9; i++) hiss(o, t + i * 0.05, { ft: 'bandpass', f: (700 + i * 90) * p, q: 4, v: 0.16, d: 0.07 }); },
  'fizz': (o, t, p) => { hiss(o, t, { ft: 'highpass', f: 3500 * p, q: 0.5, v: 0.05, a: 0.01, d: 0.5 }); },
  'can': (o, t, p) => { hiss(o, t, { ft: 'highpass', f: 2500 * p, v: 0.12, d: 0.08 }); hiss(o, t + 0.04, { ft: 'highpass', f: 4000, v: 0.05, a: 0.01, d: 0.4 }); },
  'menu': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 1800 * p, f1: 900 * p, q: 0.7, v: 0.08, a: 0.01, d: 0.12 }); },
  'paper': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 2600 * p, f1: 1300 * p, q: 0.6, v: 0.08, a: 0.02, d: 0.16 }); hiss(o, t + 0.07, { ft: 'highpass', f: 3000, v: 0.03, d: 0.06 }); },
  'page': (o, t, p) => hiss(o, t, { ft: 'bandpass', f: 1600 * p, f1: 3400 * p, q: 0.8, v: 0.07, a: 0.03, d: 0.15 }),
  'door': (o, t, p) => { tone(o, t, { type: 'sine', f: 90 * p, f1: 60, v: 0.18, d: 0.2 }); hiss(o, t, { ft: 'lowpass', f: 700, v: 0.08, a: 0.02, d: 0.25 }); },
  'fridge': (o, t, p) => { hiss(o, t, { ft: 'lowpass', f: 300 * p, v: 0.12, a: 0.01, d: 0.12 }); tone(o, t + 0.05, { type: 'sine', f: 120, v: 0.04, a: 0.05, d: 0.5 }); },
  'microwave': (o, t, p) => seq(o, t, [0, 1, 2], 0.18, (o2, t2) => tone(o2, t2, { type: 'square', f: 2000 * p, v: 0.03, d: 0.1 })),
  'espresso': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 90 * p, v: 0.03, a: 0.05, d: 0.6 }); hiss(o, t + 0.1, { ft: 'bandpass', f: 1200, q: 2, v: 0.05, a: 0.1, d: 0.5 }); },
  'register': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 1500, q: 1, v: 0.08, d: 0.08 }); bell(o, t + 0.08, { f: 2349 * p, ratio: 3, idx: 1, v: 0.08, d: 0.6 }); },
  // tech
  'pc.boot': (o, t, p) => { tone(o, t, { type: 'sine', f: 70 * p, v: 0.05, a: 0.1, d: 0.5 }); seq(o, t + 0.12, [72, 79, 84], 0.09, (o2, t2, n) => tone(o2, t2, { type: 'triangle', f: midi(n) * p, v: 0.05, d: 0.25 })); },
  'crt.on': (o, t, p) => { tone(o, t, { type: 'sine', f: 15600 * p, v: 0.008, a: 0.02, d: 0.3 }); hiss(o, t, { ft: 'bandpass', f: 3000, q: 0.6, v: 0.05, a: 0.005, d: 0.12 }); tone(o, t, { type: 'sine', f: 60, f1: 40, v: 0.12, d: 0.15 }); },
  'crt.off': (o, t, p) => { tone(o, t, { type: 'sine', f: 900 * p, f1: 60, v: 0.05, d: 0.2 }); },
  'static': (o, t, p) => hiss(o, t, { ft: 'bandpass', f: 2500 * p, q: 0.4, v: 0.05, a: 0.01, d: 0.35 }),
  'beep': (o, t, p) => tone(o, t, { type: 'square', f: 1000 * p, v: 0.04, d: 0.08 }),
  'blip': (o, t, p) => tone(o, t, { type: 'square', f: 1500 * p, f1: 1800 * p, v: 0.035, d: 0.04 }),
  'key': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 3200 * p, q: 1.5, v: 0.07, d: 0.02 }); tone(o, t, { type: 'sine', f: 320 * p, v: 0.04, d: 0.02 }); },
  'typewriter': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 2200 * p, q: 2, v: 0.12, d: 0.03 }); tone(o, t, { type: 'square', f: 180 * p, v: 0.04, d: 0.03 }); },
  'typewriter.ding': (o, t, p) => bell(o, t, { f: 2794 * p, ratio: 2.9, idx: 1.4, v: 0.08, d: 0.9 }),
  'arcade.coin': (o, t, p) => { tone(o, t, { type: 'square', f: 988 * p, v: 0.05, d: 0.06 }); tone(o, t + 0.07, { type: 'square', f: 1319 * p, v: 0.05, d: 0.18 }); },
  'arcade.shoot': (o, t, p) => tone(o, t, { type: 'square', f: 1400 * p, f1: 300 * p, v: 0.04, d: 0.09 }),
  'arcade.boom': (o, t, p) => { hiss(o, t, { ft: 'lowpass', f: 1500 * p, f1: 150, q: 0.6, v: 0.12, d: 0.3 }); },
  'arcade.jump': (o, t, p) => tone(o, t, { type: 'square', f: 300 * p, f1: 900 * p, v: 0.04, d: 0.12 }),
  'laser': (o, t, p) => tone(o, t, { type: 'sawtooth', f: 1800 * p, f1: 200 * p, v: 0.04, d: 0.18 }),
  'zap': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 120 * p, f1: 900 * p, v: 0.05, d: 0.12 }); hiss(o, t, { ft: 'highpass', f: 3000, v: 0.05, d: 0.12 }); },
  'hum': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 60 * p, v: 0.03, a: 0.1, d: 0.6 }); tone(o, t, { type: 'sine', f: 120 * p, v: 0.03, a: 0.1, d: 0.6 }); },
  'ping': (o, t, p) => bell(o, t, { f: 1760 * p, ratio: 1.5, idx: 0.4, v: 0.06, d: 0.9 }),
  'dial': (o, t, p) => { tone(o, t, { type: 'sine', f: 697 * p, v: 0.05, d: 0.1 }); tone(o, t, { type: 'sine', f: 1209 * p, v: 0.05, d: 0.1 }); },
  'phone.pickup': (o, t, p) => { hiss(o, t, { ft: 'lowpass', f: 900, v: 0.1, d: 0.06 }); tone(o, t + 0.1, { type: 'sine', f: 350, v: 0.025, a: 0.02, d: 0.5 }); tone(o, t + 0.1, { type: 'sine', f: 440, v: 0.025, a: 0.02, d: 0.5 }); },
  'phone.ring': (o, t, p) => { for (let i = 0; i < 8; i++) tone(o, t + i * 0.05, { type: 'sine', f: 480 * p, v: 0.04, d: 0.04 }); },
  'radio': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 1800, q: 0.5, v: 0.05, d: 0.15 }); tone(o, t + 0.1, { type: 'square', f: 1200 * p, v: 0.03, d: 0.05 }); },
  // games
  'cue': (o, t, p) => { tone(o, t, { type: 'sine', f: 800 * p, f1: 300, v: 0.12, d: 0.04 }); hiss(o, t, { f: 2500, q: 2, v: 0.08, d: 0.02 }); },
  'ball.clack': (o, t, p) => { bell(o, t, { f: 2400 * p, ratio: 1.4, idx: 0.5, v: 0.1, d: 0.06 }); hiss(o, t, { f: 3500, q: 3, v: 0.06, d: 0.015 }); },
  'ball.pocket': (o, t, p) => { tone(o, t, { type: 'sine', f: 220 * p, f1: 110, v: 0.14, d: 0.12 }); tone(o, t + 0.08, { type: 'sine', f: 160 * p, f1: 90, v: 0.1, d: 0.15 }); },
  'ball.cushion': (o, t, p) => tone(o, t, { type: 'sine', f: 150 * p, f1: 100, v: 0.1, d: 0.06 }),
  'flipper': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 1200 * p, q: 1.5, v: 0.1, d: 0.03 }); tone(o, t, { type: 'square', f: 140 * p, v: 0.05, d: 0.04 }); },
  'bumper': (o, t, p) => { tone(o, t, { type: 'square', f: 660 * p, f1: 990 * p, v: 0.05, d: 0.08 }); bell(o, t, { f: 1320 * p, v: 0.04, d: 0.2 }); },
  'dart': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 800, f1: 2500, q: 2, v: 0.06, a: 0.05, d: 0.06 }); tone(o, t + 0.12, { type: 'sine', f: 180 * p, f1: 120, v: 0.18, d: 0.06 }); hiss(o, t + 0.12, { ft: 'bandpass', f: 1800, q: 2, v: 0.08, d: 0.03 }); },
  'dice': (o, t, p) => { for (let i = 0; i < 6; i++) { const k = i * 0.06 + Math.random() * 0.02; bell(o, t + k, { f: (1800 + Math.random() * 900) * p, ratio: 1.7, idx: 0.4, v: 0.05 * (1 - i / 8), d: 0.05 }); } },
  'cards': (o, t, p) => hiss(o, t, { ft: 'bandpass', f: 3200 * p, f1: 1600 * p, q: 0.9, v: 0.08, a: 0.005, d: 0.07 }),
  'card.flip': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 2000 * p, q: 1.2, v: 0.08, d: 0.04 }); hiss(o, t + 0.05, { ft: 'bandpass', f: 2600 * p, q: 1.2, v: 0.06, d: 0.04 }); },
  'shuffle': (o, t, p) => { for (let i = 0; i < 10; i++) hiss(o, t + i * 0.025, { ft: 'bandpass', f: 2800 * p, q: 1, v: 0.08, d: 0.03 }); },
  'chess': (o, t, p) => { tone(o, t, { type: 'sine', f: 600 * p, f1: 350, v: 0.1, d: 0.05 }); hiss(o, t, { ft: 'bandpass', f: 1500, q: 2, v: 0.05, d: 0.02 }); },
  // atmosphere / film
  'vinyl': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 600, f1: 2500, q: 2, v: 0.08, a: 0.02, d: 0.18 }); for (let i = 0; i < 5; i++) hiss(o, t + 0.2 + i * 0.07, { ft: 'highpass', f: 4000, v: 0.02, d: 0.01 }); },
  'chord': (o, t, p) => [60, 64, 67, 71].forEach(n => tone(o, t, { type: 'triangle', f: midi(n) * p, v: 0.035, a: 0.02, d: 0.9 })),
  'fire': (o, t, p) => { hiss(o, t, { ft: 'lowpass', f: 700 * p, q: 0.4, v: 0.08, a: 0.1, d: 0.6 }); for (let i = 0; i < 6; i++) hiss(o, t + Math.random() * 0.6, { ft: 'highpass', f: 2500, v: 0.05, d: 0.01 }); },
  'engine': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 45 * p, f1: 110 * p, v: 0.07, a: 0.1, d: 0.7 }); tone(o, t, { type: 'square', f: 90 * p, f1: 220 * p, v: 0.02, a: 0.1, d: 0.7 }); },
  'thunder': (o, t, p) => { hiss(o, t, { ft: 'lowpass', f: 600 * p, f1: 80, q: 0.4, v: 0.18, a: 0.02, d: 1.4 }); },
  'clock': (o, t, p) => { tone(o, t, { type: 'triangle', f: 1800 * p, v: 0.08, d: 0.03 }); tone(o, t + 0.5, { type: 'triangle', f: 1500 * p, v: 0.07, d: 0.03 }); },
  'chime': (o, t, p) => seq(o, t, [76, 72, 74, 67], 0.25, (o2, t2, n) => bell(o2, t2, { f: midi(n) * p, ratio: 3.01, idx: 0.8, v: 0.05, d: 1.0 })),
  'magic': (o, t, p) => { seq(o, t, [72, 79, 84, 88, 91], 0.06, (o2, t2, n) => bell(o2, t2, { f: midi(n) * p, ratio: 2, idx: 0.6, v: 0.045, d: 0.6 })); hiss(o, t, { ft: 'highpass', f: 5000, v: 0.02, a: 0.1, d: 0.4 }); },
  'eerie': (o, t, p) => { tone(o, t, { type: 'sine', f: 220 * p, f1: 207 * p, v: 0.05, a: 0.2, d: 1.1, det: 8 }); tone(o, t, { type: 'sine', f: 233 * p, f1: 220 * p, v: 0.04, a: 0.2, d: 1.1 }); },
  'sting': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 110 * p, v: 0.06, a: 0.005, d: 0.6 }); tone(o, t, { type: 'sawtooth', f: 116 * p, v: 0.05, a: 0.005, d: 0.6 }); hiss(o, t, { ft: 'lowpass', f: 900, v: 0.08, d: 0.3 }); },
  'heartbeat': (o, t, p) => { tone(o, t, { type: 'sine', f: 60 * p, f1: 40, v: 0.2, d: 0.1 }); tone(o, t + 0.18, { type: 'sine', f: 55 * p, f1: 38, v: 0.15, d: 0.1 }); },
  'horn': (o, t, p) => { for (const f of [55, 82.4, 110]) tone(o, t, { type: 'sawtooth', f: f * p, v: 0.05, a: 0.15, d: 1.4 }); },
  'splash': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 900 * p, f1: 300, q: 0.6, v: 0.12, a: 0.005, d: 0.35 }); },
  'gurgle': (o, t, p) => { for (let i = 0; i < 7; i++) tone(o, t + i * 0.06, { type: 'sine', f: (300 + Math.random() * 300) * p, f1: (500 + Math.random() * 400) * p, v: 0.06, d: 0.05 }); },
  'snap': (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: 2600 * p, q: 3, v: 0.12, d: 0.025 }); },
  'squeak': (o, t, p) => tone(o, t, { type: 'sine', f: 1200 * p, f1: 1700 * p, v: 0.05, a: 0.02, d: 0.08 }),
  'rattle': (o, t, p) => { for (let i = 0; i < 8; i++) hiss(o, t + i * 0.03, { ft: 'bandpass', f: 1400 * p, q: 2, v: 0.14, d: 0.025 }); },
  'creak': (o, t, p) => tone(o, t, { type: 'sawtooth', f: 180 * p, f1: 140 * p, v: 0.025, a: 0.05, d: 0.4 }),
  'meow': (o, t, p) => tone(o, t, { type: 'triangle', f: 600 * p, f1: 900 * p, v: 0.05, a: 0.06, d: 0.3 }),
  'woof': (o, t, p) => { tone(o, t, { type: 'sawtooth', f: 260 * p, f1: 160 * p, v: 0.06, a: 0.01, d: 0.12 }); hiss(o, t, { ft: 'bandpass', f: 700, q: 2, v: 0.06, d: 0.1 }); },
  'bubble': (o, t, p) => tone(o, t, { type: 'sine', f: 400 * p, f1: 1100 * p, v: 0.05, d: 0.06 }),
  'wind': (o, t, p) => hiss(o, t, { ft: 'bandpass', f: 500 * p, f1: 800 * p, q: 0.8, v: 0.06, a: 0.3, d: 0.9 }),
  'step.stair': (o, t, p) => LIB['step.wood'](o, t, p * 0.85),
};
// footsteps per surface (very quiet; pitch jitter is added by step())
const STEP = { wood: [900, 140, 0.11], tile: [2600, 220, 0.07], carpet: [500, 90, 0.07], concrete: [1600, 160, 0.08], metal: [3200, 300, 0.06], marble: [3400, 260, 0.06], grass: [1200, 0, 0.06] };
for (const [k, [f, thump, v]] of Object.entries(STEP)) LIB['step.' + k] = (o, t, p) => { hiss(o, t, { ft: 'bandpass', f: f * p, q: 1.1, v, a: 0.003, d: 0.05 }); if (thump) tone(o, t, { type: 'sine', f: thump * p, f1: thump * 0.6, v: v * 0.9, d: 0.05 }); };

/** room id -> floor surface (rooms can override with R.surface) */
export const SURFACE = { bar: 'wood', den: 'wood', bedroom: 'carpet', kitchen: 'tile', studio: 'wood', screening: 'carpet', diner: 'tile', library: 'wood', garage: 'concrete',
  overlook: 'carpet', hawkins: 'wood', biolab: 'metal', hackers: 'concrete', computer: 'tile', fightclub: 'concrete', inception: 'marble', tavern: 'wood', roof: 'concrete', basement: 'concrete' };

// keyword -> sound, for SFX.forItem (first match wins; checked against "kind id label")
const BY_WORD = [
  [/sofa|couch|beanbag|bean bag|armchair|seat|chair|stool|booth|bed\b|hammock|sit/, 'cushion'], [/pool|8-ball|billiard/, 'cue'], [/pinball/, 'flipper'], [/arcade|cabinet|slipstream|invaders/, 'arcade.coin'],
  [/dart/, 'dart'], [/jukebox|decks|turntable|vinyl|record|dj\b|music|lute|stage|radio(?!active)/, 'vinyl'], [/tv|television|screen|crt|monitor|feed|watch|film|movie|cinema|projector/, 'crt.on'],
  [/pc\b|computer|terminal|laptop|desktop|kiosk|handle|mother|hal\b|wopr|server|rack|gibson|hack/, 'pc.boot'], [/typewriter/, 'typewriter'], [/phone|payphone|walkie/, 'phone.pickup'],
  [/fridge|cooler|freezer/, 'fridge'], [/microwave/, 'microwave'], [/espresso|coffee|kettle/, 'espresso'], [/beer|drink|order|menu|bar\b|cocktail|shake|water|ale|tankard|cup|glass|bottle/, 'glass'], [/can\b|soda|vending/, 'can'],
  [/book|page|library|quest|board|poster|rules|catalogue|map|letter|mail|note|whiteboard|blueprint|plan|sign/, 'paper'], [/door|hatch|curtain|room ?237/, 'door'], [/window|telescope|moon|sky|stars/, 'wind'],
  [/fire|hearth|candle|flame/, 'fire'], [/dice|loot|roll/, 'dice'], [/card|duel|deck/, 'shuffle'], [/car\b|delorean|engine|88|bike|garage/, 'engine'], [/clock/, 'clock'], [/top\b|totem|spin/, 'whoosh'],
  [/maze/, 'paper'], [/ghost|trap|zap|egg|alien|rift|portal|upside|embryo|amber|tube|specimen|creature/, 'eerie'], [/twins|johnny|shining|scare/, 'sting'], [/hat|ring|wand|magic|spell|sorting/, 'magic'],
  [/mirror|city|fold|dream|limbo|penrose/, 'eerie'], [/bag|punch|spar|fight|ring\b/, 'punch'], [/soap/, 'bubble'], [/dog|einstein/, 'woof'], [/cat\b/, 'meow'], [/fish|murloc|mrgl/, 'gurgle'],
  [/plant|carpet|rug|hover/, 'pop'], [/waffle|pie|fries|food|pizza|eggo|burger/, 'pop'], [/register|till|cash/, 'register'], [/flux|lab|beaker|vial/, 'zap'], [/printer/, 'rattle'], [/bell|helpdesk/, 'ping'],
];

export const SFX = {
  get muted() { return ST.muted; }, get volume() { return ST.vol; },
  setMuted(m) { ST.muted = !!m; if (bus) bus.gain.value = ST.muted ? 0 : ST.vol * 0.55; try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch { /* ignore */ } },
  setVolume(v) { ST.vol = Math.max(0, Math.min(1, v)); if (bus) bus.gain.value = ST.muted ? 0 : ST.vol * 0.55; try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch { /* ignore */ } },
  /** where the player is + which way is screen-right (call once per frame) */
  listen(x, z, rx, rz) { listener.x = x; listener.z = z; listener.rx = rx; listener.rz = rz; },
  /** dip the world's sounds (a TV is playing) @param {boolean} on */
  duck(on) { ST.duck = !!on; if (bus) bus.gain.value = ST.muted ? 0 : ST.vol * 0.55 * (on ? 0.2 : 1); },
  suspend() { ctx?.suspend(); }, resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },
  has(name) { return !!LIB[name]; },
  /** add a room/activity-specific sound from your own file: SFX.define('my.sound', (out, t, p, K) => K.tone(out, t, {...}))
   *  K = the synth kit { tone, hiss, bell, seq, midi } (see the top of sfx.js for their options). Defining twice is a no-op. */
  define(name, fn) { if (!LIB[name]) LIB[name] = (o, t, p) => fn(o, t, p, KIT); },
  /** @param {string} name @param {{vol?:number, pitch?:number, at?:{x:number,z:number}, delay?:number, jitter?:number}} [o] */
  play(name, o = {}) {
    const fn = LIB[name]; if (!fn || ST.muted) return; const c = ensure(); if (!c || !bus || c.state !== 'running') return;
    // rate limit by START time (a sound scheduled with delay: later doesn't collide with one playing now)
    const now = c.currentTime, at0 = now + (o.delay || 0), prev = lastAt.get(name) ?? -1; if (Math.abs(at0 - prev) < 0.03 || voices > 24) return; lastAt.set(name, at0);
    let vol = o.vol ?? 1, pan = 0;
    if (o.at) { const dx = o.at.x - listener.x, dz = o.at.z - listener.z, d = Math.hypot(dx, dz); vol *= Math.max(0, 1 - d / 16) ** 1.6; if (vol < 0.02) return; pan = Math.max(-0.8, Math.min(0.8, (dx * listener.rx + dz * listener.rz) / 8)); }
    const g = c.createGain(); g.gain.value = vol; let out = /** @type {AudioNode} */ (g);
    if (pan && c.createStereoPanner) { const sp = c.createStereoPanner(); sp.pan.value = pan; g.connect(sp); sp.connect(bus); } else g.connect(bus);
    const p = (o.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * (o.jitter ?? 0.03));
    voices++; setTimeout(() => { voices--; try { g.disconnect(); } catch { /* gone */ } }, 2500);
    try { fn(out, now + 0.005 + (o.delay || 0), p); } catch (e) { console.warn('sfx ' + name, e); }
  },
  /** best-guess sound for an interactable */
  forItem(it, R) { if (it?.sfx === false) return; if (it?.sfx) { SFX.play(it.sfx); return; } const s = `${it?.kind || ''} ${it?.id || ''} ${it?.label || ''}`.toLowerCase();
    for (const [re, name] of BY_WORD) if (re.test(s)) { SFX.play(name); return; } SFX.play('ui.tap'); },
  /** one footstep on a surface */
  step(surface = 'wood', vol = 1) { SFX.play('step.' + (STEP[surface] ? surface : 'wood'), { vol, jitter: 0.08 }); },
  /** dev: render a sound offline -> { peak, rms, dur } (loudness audit, tools/sfx-test.mjs) */
  async measure(name) { const fn = LIB[name]; if (!fn) return null; const sr = 22050, off = new OfflineAudioContext(1, sr * 2.5, sr); const keep = [ctx, noiseBuf];
    ctx = /** @type {any} */ (off); noiseBuf = off.createBuffer(1, sr * 1.5, sr); const d0 = noiseBuf.getChannelData(0); for (let i = 0; i < d0.length; i++) d0[i] = Math.random() * 2 - 1;
    try { fn(off.destination, 0.01, 1); } finally { [ctx, noiseBuf] = keep; }
    const buf = await off.startRendering(), d = buf.getChannelData(0); let pk = 0, s = 0, last = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; s += d[i] * d[i]; if (a > 0.003) last = i; }
    return { peak: +pk.toFixed(3), rms: +Math.sqrt(s / Math.max(1, last)).toFixed(3), dur: +(last / sr).toFixed(2) }; },
  /** names, for docs / the sound test page */
  list() { return Object.keys(LIB); },
};
window.__sfx = SFX; // dev: __sfx.play('coin')
