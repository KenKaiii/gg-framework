// @ts-check
// Payphone phreaking: crack today's 4-tone code (from the date) in 6 tries, Mastermind-style feedback per tone.
// Pays coins once per day via coins(S).
import { SFX } from '../sfx.js';
import { text, loop, rng, coins } from './util.js';
import { backdrop, scan, load, save, today } from './hackers-util.js';

// DTMF-ish soft beep per digit (two sines, short)
SFX.define('cyb.dtmf', (o, t, p, K) => { K.tone(o, t, { type: 'sine', f: 697 * p, v: 0.08, a: 0.005, d: 0.12 }); K.tone(o, t, { type: 'sine', f: 1209 * p, v: 0.06, a: 0.005, d: 0.12 }); });
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const TRIES = 6, PAY = 5;

/** @param {any} ctx */
export function startPhone(ctx) {
  const { S } = ctx; ctx.R.hackers?.fire('phone');
  const ov = ctx.overlay({ title: 'Payphone', sub: 'free calls for the elite', help: '<kbd>0-9</kbd> dial <kbd>⌫</kbd> undo <kbd>enter</kbd> send / redial <kbd>esc</kbd> hang up' });
  const W = 320, H = 180; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), r = rng(day * 31 + 7), code = Array.from({ length: 4 }, () => String(Math.floor(r() * 10)));
  const paid = load('cyb-phone-paid', 0) === day;
  const st = { cur: '', rows: /** @type {{g:string, f:number[]}[]} */ ([]), won: false, lost: false, press: '', pt: 0, shake: 0, msg: paid ? 'already phreaked today. still fun.' : `crack it for ${PAY} coins` };
  ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), phone: () => st }; ov.onClose(() => { if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.phone; });
  const send = () => {
    if (st.cur.length < 4 || st.won || st.lost) return;
    const g = st.cur.split(''), f = [0, 0, 0, 0], left = code.slice();
    g.forEach((d, i) => { if (d === code[i]) { f[i] = 2; left[i] = '_'; } });
    g.forEach((d, i) => { if (f[i]) return; const k = left.indexOf(d); if (k >= 0) { f[i] = 1; left[k] = '_'; } });
    st.rows.push({ g: st.cur, f }); st.cur = ''; SFX.play('ui.send'); f.forEach((v, i) => SFX.play(v === 2 ? 'ping' : v === 1 ? 'blip' : 'beep', { delay: 0.15 + i * 0.12, vol: 0.6 }));
    if (f.every(v => v === 2)) { st.won = true; SFX.play('success', { delay: 0.7 });
      if (!paid && load('cyb-phone-paid', 0) !== day) { coins(S).spend(-PAY); save('cyb-phone-paid', day); st.msg = `line open! +${PAY} coins`; ctx.api.toast(`Free call. +${PAY} coins`); } else st.msg = 'line open! (paid out today)'; }
    else if (st.rows.length >= TRIES) { st.lost = true; st.shake = 0.5; SFX.play('fail', { delay: 0.7 }); SFX.play('static', { delay: 0.7, vol: 0.5 }); st.msg = `traced! code was ${code.join('')}`; }
  };
  const onKey = e => {
    if (/^Digit\d$|^Numpad\d$/.test(e.code) && st.cur.length < 4 && !st.won && !st.lost) { const d = e.code.slice(-1); st.cur += d; st.press = d; st.pt = 0.2; SFX.play('cyb.dtmf', { pitch: 0.8 + (+d) * 0.04, jitter: 0 }); }
    else if (e.code === 'Backspace') { st.cur = st.cur.slice(0, -1); SFX.play('ui.back'); }
    else if (e.code === 'Enter' && (st.won || st.lost)) { SFX.play('dial'); st.rows = []; st.cur = ''; st.won = st.lost = false; st.msg = load('cyb-phone-paid', 0) === day ? 'already phreaked today. still fun.' : `crack it for ${PAY} coins`; }
    else if (e.code === 'Enter') send();
    else return; e.preventDefault();
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    st.pt = Math.max(0, st.pt - dt); st.shake = Math.max(0, st.shake - dt);
    x.save(); x.translate(st.shake ? Math.round(Math.sin(t * 80) * 3) : 0, 0);
    backdrop(x, W, H, t, '#ffcf8a');
    // keypad
    x.fillStyle = '#5a5e6a'; x.fillRect(14, 14, 96, 152); x.fillStyle = '#2a2c34'; x.fillRect(20, 20, 84, 22);
    text(x, st.cur.padEnd(4, '-'), 62, 37, { size: 16, align: 'center', color: '#9dff3d' });
    KEYS.forEach((k, i) => { const kx = 22 + (i % 3) * 28, ky = 50 + Math.floor(i / 3) * 28, on = st.pt > 0 && st.press === k;
      x.fillStyle = on ? '#9dff3d' : '#c8ccd4'; x.fillRect(kx, ky, 22, 22); text(x, k, kx + 11, ky + 16, { align: 'center', color: '#1a1c22' }); });
    // tone wave
    x.strokeStyle = '#3ff0ff'; x.beginPath(); for (let i = 0; i < 180; i++) { const a = st.pt > 0 ? 8 : 1; x.lineTo(126 + i, 26 + Math.sin(i * 0.4 + t * 30) * a * Math.sin(i * 0.07)); } x.stroke();
    // guesses
    text(x, `TONES  ${st.rows.length}/${TRIES}`, 130, 54, { color: '#ffcf8a' });
    st.rows.forEach((row, j) => row.g.split('').forEach((d, i) => { const bx = 130 + i * 22, by = 60 + j * 17;
      x.fillStyle = row.f[i] === 2 ? '#3ddc84' : row.f[i] === 1 ? '#e0a458' : '#3a3448'; x.fillRect(bx, by, 18, 14); text(x, d, bx + 9, by + 12, { align: 'center', color: '#0b0a16' }); }));
    text(x, 'green: spot on', 236, 70, { color: '#3ddc84' }); text(x, 'amber: moved', 236, 84, { color: '#e0a458' }); text(x, 'grey: nope', 236, 98, { color: '#8a8498' });
    text(x, st.msg, 218, 172, { align: 'center', color: st.won ? '#9dff3d' : st.lost ? '#ff6b6b' : '#c8c0d8' });
    if (st.won) text(x, 'SPOOFED', 262, 110, { size: 32, title: false, align: 'center', color: '#9dff3d' });
    x.restore(); scan(x, W, H);
  });
}
