// @ts-check
// Payphone phreaking: crack today's 4-tone code (from the date) in 6 tries, Mastermind-style feedback per tone.
// Pays coins once per day via coins(S). Drawn with the art kit: a chrome payphone, an LCD, a CRT tone log.
import { SFX } from '../sfx.js';
import { loop, rng, coins, mouse } from './util.js';
import { PAL, panel, title, glow, banner, particles, shaker, rr, shade, badge } from './art.js';
import { scan, load, save, today, neonBg, btns } from './hackers-util.js';

// DTMF-ish soft beep per digit (two sines, short)
SFX.define('cyb.dtmf', (o, t, p, K) => { K.tone(o, t, { type: 'sine', f: 697 * p, v: 0.08, a: 0.005, d: 0.12 }); K.tone(o, t, { type: 'sine', f: 1209 * p, v: 0.06, a: 0.005, d: 0.12 }); });
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const TRIES = 6, PAY = 5, KX = 22, KY = 62, KS = 26;
const FC = ['#4a4458', '#ffb347', '#6eff7a'];

/** @param {any} ctx */
export function startPhone(ctx) {
  const { S } = ctx; ctx.R.hackers?.fire('phone');
  const ov = ctx.overlay({ title: 'Payphone', sub: 'free calls for the elite', help: '<kbd>0-9</kbd> dial <kbd>⌫</kbd> undo <kbd>enter</kbd> send / redial <kbd>click</kbd> keypad (* undo, # send) <kbd>esc</kbd> hang up' });
  const W = 320, H = 180; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), r = rng(day * 31 + 7), code = Array.from({ length: 4 }, () => String(Math.floor(r() * 10)));
  const paid = load('cyb-phone-paid', 0) === day;
  const st = { cur: '', rows: /** @type {{g:string, f:number[], t:number}[]} */ ([]), won: false, lost: false, press: '', pt: 0, shake: 0, endT: 0, msg: paid ? 'already phreaked today. still fun.' : `crack it for ${PAY} coins` };
  ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), phone: () => st }; ov.onClose(() => { if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.phone; });
  const bg = neonBg(W, H, '#ffb347', 0.6), fx = particles(), sh = shaker(), B2 = btns(c, W, H);
  const send = () => {
    if (st.cur.length < 4 || st.won || st.lost) return;
    const g = st.cur.split(''), f = [0, 0, 0, 0], left = code.slice();
    g.forEach((d, i) => { if (d === code[i]) { f[i] = 2; left[i] = '_'; } });
    g.forEach((d, i) => { if (f[i]) return; const k = left.indexOf(d); if (k >= 0) { f[i] = 1; left[k] = '_'; } });
    st.rows.push({ g: st.cur, f, t: 0 }); st.cur = ''; SFX.play('ui.send'); f.forEach((v, i) => SFX.play(v === 2 ? 'ping' : v === 1 ? 'blip' : 'beep', { delay: 0.15 + i * 0.12, vol: 0.6 }));
    if (f.every(v => v === 2)) { st.won = true; st.endT = -0.6; SFX.play('success', { delay: 0.7 }); setTimeout(() => { fx.burst(226, 80, { n: 40, colors: ['#6eff7a', '#ffe8a0', '#3ff0ff'] }); fx.confetti(W); }, 600);
      if (!paid && load('cyb-phone-paid', 0) !== day) { coins(S).spend(-PAY); save('cyb-phone-paid', day); st.msg = `line open! +${PAY} coins`; ctx.api.toast(`Free call. +${PAY} coins`); } else st.msg = 'line open! (paid out today)'; }
    else if (st.rows.length >= TRIES) { st.lost = true; st.endT = -0.6; st.shake = 0.5; setTimeout(() => sh.kick(6), 600); SFX.play('fail', { delay: 0.7 }); SFX.play('static', { delay: 0.7, vol: 0.5 }); st.msg = `traced! code was ${code.join('')}`; }
  };
  const dial = d => { if (st.cur.length >= 4 || st.won || st.lost) return false; st.cur += d; st.press = d; st.pt = 0.2; SFX.play('cyb.dtmf', { pitch: 0.8 + (+d) * 0.04, jitter: 0 }); return true; };
  const undo = () => { st.cur = st.cur.slice(0, -1); st.press = '*'; st.pt = 0.2; SFX.play('ui.back'); };
  const enter = () => { if (st.won || st.lost) { SFX.play('dial'); st.rows = []; st.cur = ''; st.won = st.lost = false; st.msg = load('cyb-phone-paid', 0) === day ? 'already phreaked today. still fun.' : `crack it for ${PAY} coins`; } else send(); };
  const onKey = e => {
    if (/^Digit\d$|^Numpad\d$/.test(e.code)) { if (!dial(e.code.slice(-1))) return; }
    else if (e.code === 'Backspace') undo();
    else if (e.code === 'Enter') enter();
    else return; e.preventDefault();
  };
  const m = mouse(ov, c, W, H);
  const press = k => { if (k === '*') undo(); else if (k === '#') { st.press = '#'; st.pt = 0.2; enter(); } else dial(k); };
  const RB = { x: W / 2 - 104, y: 136, w: 96, h: 20 }, LB = { x: W / 2 + 8, y: 136, w: 96, h: 20 };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    st.pt = Math.max(0, st.pt - dt); st.shake = Math.max(0, st.shake - dt); for (const rw of st.rows) rw.t += dt;
    const ended = (st.won || st.lost) && (st.endT += dt) > 0.8;
    m.rows(i => ({ x: KX + (i % 3) * KS, y: KY + Math.floor(i / 3) * 24, w: 22, h: 20 }), KEYS.length, { pick: i => press(KEYS[i]) });
    if (ended) { m.set([]); m.add({ ...RB, pick: enter }); m.add({ ...LB, pick: () => ov.close() }); }
    x.save(); sh.apply(x, dt); if (st.shake) x.translate(Math.round(Math.sin(t * 80) * 3), 0);
    bg.draw(x, t);
    // the payphone: brushed chrome body, coin slot, LCD, chrome keys
    panel(x, 12, 8, 100, 164, { style: 'metal', r: 6 });
    x.fillStyle = '#1a1e26'; rr(x, 20, 14, 84, 8, 2); x.fill(); title(x, 'BELL', 62, 22, { size: 16, body: true, color: '#ffb347' });
    const lcd = panel(x, 20, 28, 84, 26, { style: 'crt', r: 2 });
    for (let i = 0; i < 4; i++) { const ch = st.cur[i]; title(x, ch || '-', lcd.x + 14 + i * 19, lcd.y + 19, { size: 16, color: ch ? '#b8ff6a' : '#2a5a2a', ink: '#020a04', glow: ch ? 'rgba(157,255,61,0.6)' : undefined, glowR: 6 }); }
    KEYS.forEach((k, i) => { const kx = KX + (i % 3) * KS, on = st.pt > 0 && st.press === k, hot = !ended && B2.hot(kx, KY + Math.floor(i / 3) * 24, 22, 20), ky = KY + Math.floor(i / 3) * 24 + (on ? 2 : 0);
      x.fillStyle = 'rgba(0,0,0,0.5)'; rr(x, kx, KY + Math.floor(i / 3) * 24 + 3, 22, 20, 4); x.fill();
      const base = on ? '#9dff3d' : hot ? '#e8ecf4' : '#b8bec8', g = x.createLinearGradient(0, ky, 0, ky + 20); g.addColorStop(0, shade(base, 0.35)); g.addColorStop(1, shade(base, -0.3));
      x.fillStyle = g; rr(x, kx, ky, 22, 20, 4); x.fill(); x.strokeStyle = '#2a2e36'; x.lineWidth = 1; rr(x, kx + 0.5, ky + 0.5, 21, 19, 4); x.stroke(); x.fillStyle = 'rgba(255,255,255,0.7)'; x.fillRect(kx + 3, ky + 2, 16, 1);
      if (hot || on) glow(x, kx + 11, ky + 10, 18, on ? '#9dff3d' : '#ffffff', 0.25);
      title(x, k, kx + 11, ky + 15, { size: 16, body: true, color: '#1a1c22', ink: 'rgba(255,255,255,0.4)' }); });
    // tone log on a CRT
    const L = panel(x, 122, 8, 190, 120, { style: 'crt' });
    x.save(); x.strokeStyle = '#3ff0ff'; x.globalAlpha = 0.8; x.beginPath(); for (let i = 0; i < 100; i++) { const a = st.pt > 0 ? 7 : 1.2; x.lineTo(L.x + 8 + i, 22 + Math.sin(i * 0.4 + t * 30) * a * Math.sin(i * 0.07)); } x.stroke(); x.restore();
    title(x, `TONES ${st.rows.length}/${TRIES}`, L.x + L.w - 8, 26, { size: 16, body: true, align: 'right', color: '#ffb347', ink: '#020a04' });
    for (let j = 0; j < TRIES; j++) { const row = st.rows[j], by = 34 + j * 15;
      title(x, String(j + 1), L.x + 10, by + 11, { size: 16, body: true, color: '#2a6a3a', ink: '#020a04' });
      for (let i = 0; i < 4; i++) { const bx = L.x + 22 + i * 22, rev = row && row.t > 0.15 + i * 0.12, f = rev ? row.f[i] : 0;
        x.fillStyle = row ? (rev ? FC[f] : '#2a2638') : '#0a140e'; rr(x, bx, by, 18, 13, 3); x.fill(); x.strokeStyle = row ? 'rgba(255,255,255,0.25)' : '#1a3a24'; rr(x, bx + 0.5, by + 0.5, 17, 12, 3); x.stroke();
        if (rev && f) glow(x, bx + 9, by + 6, 14, FC[f], 0.35);
        if (row) title(x, row.g[i], bx + 9, by + 11, { size: 16, body: true, color: rev && f ? '#0b0a16' : PAL.cream, ink: rev && f ? 'rgba(255,255,255,0.35)' : '#000' }); } }
    // legend
    [['spot on', 2], ['moved', 1], ['nope', 0]].forEach(([s, f], i) => { const ly = 46 + i * 16; x.fillStyle = FC[+f]; rr(x, L.x + 118, ly - 8, 9, 9, 2); x.fill(); if (f) glow(x, L.x + 122, ly - 4, 9, FC[+f], 0.4);
      title(x, String(s), L.x + 132, ly, { size: 16, body: true, align: 'left', color: FC[+f] === FC[0] ? PAL.dim : FC[+f], ink: '#020a04' }); });
    badge(x, L.x + 116, 92, 'coins', paid ? 'paid' : String(PAY), { w: 66, h: 30, color: paid ? PAL.dim : PAL.gold });
    // message strip
    const mp = panel(x, 122, 134, 190, 24, { style: 'glass' });
    title(x, st.msg, mp.x + mp.w / 2, mp.y + 16, { size: 16, body: true, color: st.won ? '#9dff3d' : st.lost ? PAL.red : PAL.cream });
    title(x, 'type 0-9  enter send  ⌫ undo', 217, 174, { size: 16, body: true, color: PAL.dim });
    fx.draw(x, dt);
    x.restore();
    if ((st.won || st.lost) && st.endT > 0) { banner(x, W, H, st.won ? 'SPOOFED' : 'TRACED', st.msg, st.endT, { color: st.won ? '#9dff3d' : PAL.red });
      if (ended) { B2.draw(x, RB.x, RB.y, RB.w, RB.h, 'REDIAL', { primary: true }); B2.draw(x, LB.x, LB.y, LB.w, LB.h, 'HANG UP'); } }
    scan(x, W, H);
  });
}
