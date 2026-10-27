// @ts-check
// The three mini-apps shown on close-up screens: trading terminal (studio), deploy news (bar), server dashboard (basement).
import { rng } from './util.js';
import { GX } from './gx.js';

// Sora text/plates for the screen apps (logical screen units; the frame scales the canvas to screen x DPR).
const PAL = { red: GX.error, cream: GX.text, green: GX.success };
const font = (size, w) => `${w} ${size * 0.6}px Sora, system-ui, sans-serif`;
/** @param {CanvasRenderingContext2D} x */
function text(x, s, px, py, o = {}) { x.save(); x.font = font(o.size || 16, o.weight || 500); x.textAlign = o.align || 'left'; x.fillStyle = o.color || GX.text2; x.fillText(s, px, py); x.restore(); }
function title(x, s, px, py, o = {}) { x.save(); if (o.glow) { x.shadowColor = o.glow; x.shadowBlur = 10; } text(x, s, px, py, { ...o, weight: o.body ? 600 : 800, align: o.align || 'center' }); x.restore(); }
function panel(x, px, py, w, h) { x.save(); x.fillStyle = 'rgba(24,26,30,.94)'; x.strokeStyle = 'rgba(255,255,255,.12)'; x.beginPath(); x.roundRect(px, py, w, h, 8); x.fill(); x.stroke(); x.restore(); }
function glow(x, px, py, r, c, a) { x.save(); x.globalAlpha = a; const g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, c); g.addColorStop(1, 'transparent'); x.fillStyle = g; x.fillRect(px - r, py - r, r * 2, r * 2); x.restore(); }
function button(x, px, py, w, h, s, o = {}) { x.save(); x.fillStyle = o.hot ? GX.primaryHi : GX.primary; x.beginPath(); x.roundRect(px, py, w, h, 5); x.fill(); x.restore(); text(x, s, px + w / 2, py + h * 0.7, { align: 'center', weight: 700, size: 13, color: GX.onPrimary }); }
import { market } from './screens-market.js';

const G = '#7fdc95', G2 = '#3ddc84', AM = '#e0a458', AM2 = '#ffb36b', RED = '#ff5a5a', MAG = '#ff4fd8', DIM = '#5a6a5e';
const fmt = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toFixed(v < 0.01 ? 5 : 4);
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

const ROASTS = ['$VIBE -7% after dev pushed to main on a Friday', '$SHIP +12% on rumours of a passing test', '$VIBE halted: README written by the intern',
  'analysts: "it worked on my machine" not a strategy', '$COPE all-time high as Copilot autocompletes a lawsuit', '$BUG +300% after hotfix to the hotfix',
  'whale sells 4M $VIBE to pay for GPU rent', '$VIBE +69% after dev finally closes a Jira ticket', 'SEC investigating vibes. vibes unavailable for comment'];

/** Studio trading terminal. */
export function tradingApp(S, ov) {
  const m = market(S); let sel = 0, mode = 'line', tape = 0, flash = 0, jit = rng(7);
  const live = m.rows.map(r => ({ ...r, series: r.series.slice() }));
  const sync = () => { m.rows.forEach((r, i) => { live[i].price = r.price; live[i].chg = r.chg; live[i].series = r.series.slice(); live[i].real = r.real; }); };
  m.ready.then(() => { sync(); flash = 1; ov.setSub(m.real ? 'live prices: CoinGecko (stocks simulated)' : 'SIMULATED feed (offline)'); });
  ov.setSub('connecting to CoinGecko...');
  let acc = 0;
  return {
    key(code) { if (code === 'ArrowDown' || code === 'ArrowRight') sel = (sel + 1) % live.length; else if (code === 'ArrowUp' || code === 'ArrowLeft') sel = (sel + live.length - 1) % live.length; else if (code === 'Space' || code === 'KeyC') mode = mode === 'line' ? 'candle' : 'line'; flash = 0.5; },
    click(px, py) { if (px < 150 && py > 26 && py < 26 + live.length * 18) { sel = Math.floor((py - 26) / 18); flash = 0.5; } else if (px >= 150) mode = mode === 'line' ? 'candle' : 'line'; },
    draw(x, w, h, dt, t) {
      acc += dt; if (acc > 0.5) { acc = 0; for (const r of live) { if (r.real && r.sym !== '$VIBE') continue; const k = r.sym === '$VIBE' ? 0.02 : 0.002; const d = (jit() - 0.5) * k; r.price *= 1 + d; r.chg += d * 100; r.series.push(r.price); r.series.shift(); } }
      flash = Math.max(0, flash - dt * 2); tape += dt * 40;
      x.fillStyle = '#0a0d12'; x.fillRect(0, 0, w, h);
      { const hg = x.createLinearGradient(0, 0, 0, 18); hg.addColorStop(0, '#2e3460'); hg.addColorStop(1, '#161a34'); x.fillStyle = hg; x.fillRect(0, 0, w, 18); x.fillStyle = 'rgba(255,255,255,0.15)'; x.fillRect(0, 0, w, 1); } title(x, 'VIBETRADE PRO', 6, 13, { size: 16, body: true, align: 'left', color: AM2 }); if (m.real) glow(x, w - 20, 9, 16, '#6ee7a0', 0.3 + Math.sin(t * 2) * 0.1); title(x, m.real ? 'LIVE' : 'SIMULATED', w - 6, 13, { size: 16, body: true, align: 'right', color: m.real ? G : DIM });
      text(x, new Date().toISOString().slice(11, 19) + ' UTC', w / 2 + 30, 13, { align: 'center', color: DIM });
      live.forEach((r, i) => {
        const y = 26 + i * 18;
        if (i === sel) { x.fillStyle = flash > 0 ? '#2e3a5a' : '#232848'; x.fillRect(2, y, 146, 17); x.fillStyle = AM; x.fillRect(2, y, 2, 17); }
        const up = r.chg >= 0; text(x, r.sym, 8, y + 13, { color: r.sym === '$VIBE' ? MAG : '#d8dccf' });
        text(x, fmt(r.price), 92, y + 13, { align: 'right', color: '#c9d1c4' }); text(x, pct(r.chg), 146, y + 13, { align: 'right', color: up ? G2 : RED });
        if (!r.real) { x.fillStyle = '#3a3a48'; x.fillRect(48, y + 8, 2, 2); }
      });
      text(x, 'dot = simulated', 8, 26 + live.length * 18 + 12, { color: '#3e4656' });
      // chart
      const r = live[sel], cx = 156, cy = 24, cw = w - cx - 6, ch = h - cy - 34;
      x.fillStyle = '#0e1219'; x.fillRect(cx, cy, cw, ch); x.strokeStyle = '#1a2030'; x.lineWidth = 1;
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(cx, cy + (ch * i / 4) | 0); x.lineTo(cx + cw, cy + (ch * i / 4) | 0); x.stroke(); }
      const s = r.series, lo = Math.min(...s), hi = Math.max(...s), sp = hi - lo || 1, Y = v => cy + 22 + (1 - (v - lo) / sp) * (ch - 30), up = r.chg >= 0, col = up ? G2 : RED;
      text(x, r.sym + ' / USD', cx + 6, cy + 14, { color: r.sym === '$VIBE' ? MAG : AM2 }); text(x, '$' + fmt(r.price) + '  ' + pct(r.chg), cx + cw - 6, cy + 14, { align: 'right', color: col });
      text(x, mode === 'line' ? '24H LINE' : '24H CANDLES', cx + cw / 2, cy + 14, { align: 'center', color: DIM });
      if (mode === 'line') {
        x.beginPath(); s.forEach((v, i) => { const px = cx + 4 + i / (s.length - 1) * (cw - 8); i ? x.lineTo(px, Y(v)) : x.moveTo(px, Y(v)); });
        x.strokeStyle = col; x.lineWidth = 1.5; x.stroke(); x.lineTo(cx + cw - 4, cy + ch); x.lineTo(cx + 4, cy + ch); x.closePath(); x.fillStyle = up ? 'rgba(61,220,132,.12)' : 'rgba(255,90,90,.12)'; x.fill();
      } else {
        const n = 24, per = Math.floor(s.length / n), bw = (cw - 8) / n;
        for (let i = 0; i < n; i++) { const seg = s.slice(i * per, i * per + per + 1); if (seg.length < 2) continue; const o = seg[0], c = seg[seg.length - 1], hh = Math.max(...seg), ll = Math.min(...seg), u = c >= o;
          x.fillStyle = u ? G2 : RED; const px = (cx + 4 + i * bw) | 0; x.fillRect(px + (bw / 2 | 0), Y(hh) | 0, 1, Math.max(1, Y(ll) - Y(hh)) | 0); x.fillRect(px + 1, Math.min(Y(o), Y(c)) | 0, Math.max(2, bw - 2) | 0, Math.max(1, Math.abs(Y(o) - Y(c))) | 0); }
      }
      x.fillStyle = col; x.fillRect(cx + cw - 5, Y(s[s.length - 1]) - 1, 4, 3);
      text(x, 'H ' + fmt(hi), cx + 6, cy + ch - 4, { color: DIM }); text(x, 'L ' + fmt(lo), cx + 80, cy + ch - 4, { color: DIM });
      // tape
      x.fillStyle = '#2a2440'; x.fillRect(0, h - 18, w, 18); const str = ROASTS.join('   ///   ') + '   ///   ';
      x.save(); x.font = font(16, 500); const tw = x.measureText(str).width || 2000; x.restore(); const off = tape % tw;
      text(x, str, -off, h - 5, { color: AM2 }); text(x, str, -off + tw, h - 5, { color: AM2 });
    },
  };
}

const HEAD = ['{n} SHIPS {v} TO PROD, NOTHING CATCHES FIRE', '{n} DEPLOYS {v}. QA "NOT CONSULTED"', 'DEVELOPING: {n} MERGES OWN PR, APPROVES IT TOO', 'LIVE: {n} SAYS {v} IS "BASICALLY DONE"'];
/** Bar deploy news feed (reads S.members). */
export function deployApp(S, ov) {
  let sel = 0, head = 0, ht = 0, rollback = 0; const t0 = performance.now() / 1000;
  const mem = () => (S.members || []).map(m => ({ name: m.d?.name || m.d?.id || '?', status: m.status || 'idle', ver: m.version || '-', shipped: m.d?.shipped || 0, txt: m.statusText || m.status, lvl: m.d?.level || 1 }));
  return {
    key(code) { const n = Math.max(1, mem().length); if (code === 'ArrowDown') sel = (sel + 1) % n; else if (code === 'ArrowUp') sel = (sel + n - 1) % n; else if (code === 'ArrowRight' || code === 'ArrowLeft') head++; else if (code === 'Space' || code === 'Enter') rollback = 2.5; },
    click(px, py) { if (py > 54 && py < 54 + 14 * 9) sel = Math.floor((py - 54) / 14); },
    draw(x, w, h, dt, t) {
      const ms = mem(); sel = Math.min(sel, Math.max(0, ms.length - 1)); ht += dt; if (ht > 5) { ht = 0; head++; } rollback = Math.max(0, rollback - dt);
      x.fillStyle = '#060a07'; x.fillRect(0, 0, w, h);
      const dep = ms.filter(m => m.status === 'deploying'), pick = dep[0] || ms[head % Math.max(1, ms.length)] || { name: 'nobody', ver: 'v0' };
      const blink = (t * 2 | 0) % 2;
      x.fillStyle = rollback > 0 ? '#5a1010' : '#3a0d0d'; x.fillRect(0, 0, w, 20); x.fillStyle = blink ? RED : '#a02020'; x.fillRect(0, 0, 70, 20);
      text(x, rollback > 0 ? 'ROLLBACK' : 'BREAKING', 35, 15, { align: 'center', color: '#fff' });
      const hl = rollback > 0 ? `${pick.name.toUpperCase()} ROLLS BACK. BLAMES DNS.` : HEAD[head % HEAD.length].replace('{n}', pick.name.toUpperCase()).replace('{v}', pick.ver === '-' ? 'v1' : pick.ver);
      text(x, hl, 78, 15, { color: '#ffe0d0' });
      const up = performance.now() / 1000 - t0 + 86400 * 41 + 3600 * 7;
      text(x, `UPTIME ${up / 86400 | 0}d ${(up % 86400) / 3600 | 0}h ${(up % 3600) / 60 | 0}m ${up % 60 | 0}s`, 6, 38, { color: G });
      const ships = ms.reduce((a, m) => a + m.shipped, 0) + 1180; text(x, `SHIPS TODAY ${ships}`, w / 2, 38, { align: 'center', color: AM2 }); text(x, `ONLINE ${ms.filter(m => m.status !== 'offline').length}/${ms.length}`, w - 6, 38, { align: 'right', color: G });
      x.fillStyle = '#1f3a2a'; x.fillRect(4, 44, w - 8, 1);
      text(x, 'CREW', 8, 54, { color: DIM }); text(x, 'STATUS', 110, 54, { color: DIM }); text(x, 'VER', 240, 54, { color: DIM }); text(x, 'SHIPPED', w - 8, 54, { align: 'right', color: DIM });
      ms.slice(0, 9).forEach((m, i) => { const y = 58 + i * 14; if (i === sel) { x.fillStyle = '#12301e'; x.fillRect(4, y, w - 8, 13); }
        const c = m.status === 'deploying' ? (blink ? AM2 : AM) : m.status === 'offline' ? '#4a4a4a' : m.status === 'thinking' ? '#9aa8ff' : G;
        text(x, m.name, 8, y + 11, { color: i === sel ? '#e8efe4' : G }); text(x, (m.status === 'deploying' ? '> ' : '') + m.txt, 110, y + 11, { color: c }); text(x, m.ver, 240, y + 11, { color: '#c9d1c4' }); text(x, String(m.shipped), w - 8, y + 11, { align: 'right', color: AM });
      });
      const s = ms[sel]; if (s) { x.fillStyle = '#0d1a12'; x.fillRect(4, h - 40, w - 8, 20); text(x, `${s.name}: lvl ${s.lvl}, ${s.shipped} ships, ${s.status === 'offline' ? 'gone dark' : 'vibing'}. SPACE: roll back`, 8, h - 26, { color: '#a8c8b0' }); }
      x.fillStyle = '#1e2240'; x.fillRect(0, h - 18, w, 18); text(x, 'DEPLOY NEWS NETWORK  ·  all times "eventually"  ·  p99 latency: vibes', 6, h - 5, { color: AM });
    },
  };
}

const LOGS = ['[info] GET /api/vibes 200 4ms', '[warn] node_modules now heavier than the sun', '[info] cron: rotated logs, logs dizzy', '[err ] undefined is not a function (again)', '[info] cache hit ratio 0.69 nice', '[warn] GPU at 91C, cooking eggs', '[info] worker-3 restarted, feels better', '[info] POST /deploy 202 accepted', '[warn] disk 87%: 400GB of .DS_Store', '[info] health check ok (we think)'];
const ALERTS = ['DISK /var 97% FULL', 'OOM KILLED: chrome (obviously)', 'p99 > 2s ON /checkout', 'CERT EXPIRES IN 2 DAYS', 'MINER EATING ALL CPU'];
/** Basement server dashboard (htop-ish). */
export function serverApp(S, ov) {
  const r = rng(3); const cpu = Array.from({ length: 8 }, () => r()), net = Array.from({ length: 80 }, () => r() * 0.5), log = LOGS.slice(0, 7);
  let lt = 0, nt = 0, alert = null, at = 1.5, acked = 0, ackFlash = 0, shake = 0;
  const ack = () => { if (alert) { alert = null; acked++; ackFlash = 1; at = 6 + r() * 6; log.push('[ack ] alert acknowledged by you. hero.'); log.shift(); } };
  return {
    key(code) { if (code === 'Space' || code === 'Enter' || code === 'KeyA') ack(); },
    click(px, py) { if (alert) ack(); },
    draw(x, w, h, dt, t) {
      for (let i = 0; i < 8; i++) cpu[i] += ((r() < 0.1 ? r() : cpu[i]) - cpu[i]) * 0.2 + (r() - 0.5) * 0.06, cpu[i] = Math.min(1, Math.max(0.03, cpu[i]));
      if ((nt += dt) > 0.1) { nt = 0; net.push(Math.min(1, Math.max(0, net[net.length - 1] + (r() - 0.5) * 0.25))); net.shift(); }
      if ((lt += dt) > 0.7) { lt = 0; log.push(LOGS[(r() * LOGS.length) | 0]); log.shift(); }
      if (!alert && (at -= dt) < 0) { alert = ALERTS[(r() * ALERTS.length) | 0]; shake = 0.4; }
      ackFlash = Math.max(0, ackFlash - dt * 2); shake = Math.max(0, shake - dt);
      x.save(); if (shake) x.translate(((r() - 0.5) * 6) | 0, ((r() - 0.5) * 4) | 0);
      x.fillStyle = '#05080a'; x.fillRect(-4, -4, w + 8, h + 8);
      const box = (bx, by, bw, bh, t2) => { x.strokeStyle = '#1f3a2a'; x.lineWidth = 1; x.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1); x.fillStyle = '#05080a'; x.fillRect(bx + 6, by - 2, t2.length * 6 + 6, 6); text(x, t2, bx + 8, by + 6, { color: AM }); };
      // CPU
      box(4, 6, 200, 104, 'CPU');
      cpu.forEach((v, i) => { const y = 16 + i * 11; text(x, String(i), 10, y + 9, { color: DIM }); x.fillStyle = '#10201a'; x.fillRect(22, y + 2, 140, 6); x.fillStyle = v > 0.85 ? RED : v > 0.6 ? AM2 : G2; x.fillRect(22, y + 2, (140 * v) | 0, 6); text(x, ((v * 100) | 0) + '%', 198, y + 9, { align: 'right', color: '#c9d1c4' }); });
      // MEM + load
      box(210, 6, w - 214, 50, 'MEM'); const mem = 0.62 + Math.sin(t * 0.3) * 0.05; x.fillStyle = '#10201a'; x.fillRect(218, 22, w - 230, 8); x.fillStyle = G; x.fillRect(218, 22, ((w - 230) * mem) | 0, 8);
      text(x, `${(mem * 64).toFixed(1)}G / 64G   swap 0.0G`, 218, 46, { color: '#c9d1c4' });
      box(210, 60, w - 214, 50, 'NET'); x.beginPath(); net.forEach((v, i) => { const px = 214 + i / 79 * (w - 222), py = 104 - v * 36; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.strokeStyle = G2; x.stroke();
      text(x, `rx ${(net[79] * 900 | 0)} MB/s`, w - 10, 76, { align: 'right', color: DIM });
      // logs
      box(4, 116, w - 8, h - 140, 'journalctl -f'); log.forEach((l, i) => text(x, l, 10, 132 + i * 12, { color: l.includes('err') ? RED : l.includes('warn') ? AM2 : l.includes('ack') ? MAG : G }));
      text(x, `load ${(cpu.reduce((a, b) => a + b, 0) / 2).toFixed(2)}  ·  tasks 420  ·  alerts acked ${acked}  ·  up 69d`, 6, h - 6, { color: DIM });
      if (alert) { const pulse = 0.5 + Math.sin(t * 3) * 0.5; x.fillStyle = `rgba(80,0,0,${0.25 + pulse * 0.15})`; x.fillRect(0, 0, w, h);
        glow(x, w / 2, h / 2, 190, '#ff3a3a', 0.25 + pulse * 0.15); panel(x, w / 2 - 150, h / 2 - 40, 300, 76, { style: 'metal' });
        x.fillStyle = '#e8c33a'; for (let i = 0; i < 300 - 8; i += 12) { x.beginPath(); x.moveTo(w / 2 - 146 + i, h / 2 - 36); x.lineTo(w / 2 - 140 + i, h / 2 - 36); x.lineTo(w / 2 - 146 + i + 2, h / 2 - 30); x.lineTo(w / 2 - 152 + i + 2, h / 2 - 30); x.fill(); } // hazard stripe
        title(x, '!! ALERT !!', w / 2, h / 2 - 8, { size: 16, color: PAL.red, glow: '#ff3a3a' }); title(x, alert, w / 2, h / 2 + 10, { size: 16, body: true, color: PAL.cream });
        button(x, w / 2 - 70, h / 2 + 16, 140, 16, 'SPACE / CLICK: ACK', { primary: true, hot: pulse > 0.6 }); }
      if (ackFlash) { x.fillStyle = `rgba(110,231,160,${ackFlash * 0.25})`; x.fillRect(0, 0, w, h); x.save(); x.globalAlpha = Math.min(1, ackFlash * 2); title(x, 'ACK  +1 karma', w / 2, h / 2 + 8, { size: 32, color: PAL.green, glow: PAL.green }); x.restore(); }
      x.restore();
    },
  };
}
