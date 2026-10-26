// @ts-check
// The Engine Room explainer cards: what each station means (plain English) + a small animated diagram per station.
// Diagrams draw into a box (X, Y, W, H) at time t (seconds); nothing blinks faster than 1.5 s.
import { PAL, glow, title, rr, shade } from './art.js';
import { CFONT } from '../fonts.js';

const lbl = (x, s, X, Y, c = PAL.cream, align = 'center') => { x.save(); x.font = CFONT.body(16); x.textAlign = /** @type {CanvasTextAlign} */ (align); x.fillStyle = PAL.ink; x.fillText(s, Math.round(X) + 1, Math.round(Y) + 1); x.fillStyle = c; x.fillText(s, Math.round(X), Math.round(Y)); x.restore(); };
const box = (x, X, Y, W, H, fill, edge = PAL.ink, on = false) => { x.save(); if (on) glow(x, X + W / 2, Y + H / 2, Math.max(W, H) * 0.8, fill, 0.35); const g = x.createLinearGradient(0, Y, 0, Y + H); g.addColorStop(0, shade(fill, 0.15)); g.addColorStop(1, shade(fill, -0.25)); x.fillStyle = g; rr(x, X, Y, W, H, 3); x.fill(); x.strokeStyle = edge; x.lineWidth = 1.5; rr(x, X + 0.5, Y + 0.5, W - 1, H - 1, 3); x.stroke(); x.restore(); };
const line = (x, pts, c = 'rgba(243,230,204,0.35)', w = 2) => { x.save(); x.strokeStyle = c; x.lineWidth = w; x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.stroke(); x.restore(); };
const dot = (x, X, Y, c, r = 3) => { glow(x, X, Y, r * 4, c, 0.5); x.fillStyle = c; x.beginPath(); x.arc(X, Y, r, 0, 7); x.fill(); };
const along = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
const sm = k => k * k * (3 - 2 * k);

/** @type {{ id: string, name: string, tag: string, lines: string[], draw: (x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, t: number) => void }[]} */
export const CARDS = [
  { id: 'daemon', name: 'The Daemon', tag: 'the boiler that powers every window',
    lines: ['One Node engine runs quietly behind the whole desktop app.', 'Each window talks to it through the Rust shell, never directly.', 'Every window gets its own agent session inside the daemon.', 'Quit the app and it shuts down, helpers and all.'],
    draw(x, X, Y, W, H, t) {
      const wy = [Y + 22, Y + H / 2, Y + H - 22], sx = X + W / 2 - 40, bx = X + W - 110;
      wy.forEach((y, i) => { line(x, [[X + 92, y], [sx, Y + H / 2]]); box(x, X + 10, y - 14, 82, 28, '#2a4a6a', PAL.ink, false); lbl(x, 'window ' + (i + 1), X + 51, y + 5, '#bfe6ff');
        const k = ((t * 0.5 + i / 3) % 1); const [px, py] = along([X + 92, y], [sx, Y + H / 2], k); dot(x, px, py, '#8fd8ff', 2.5); });
      line(x, [[sx + 80, Y + H / 2], [bx, Y + H / 2]]); { const k = (t * 0.6) % 1; dot(x, sx + 80 + (bx - sx - 80) * k, Y + H / 2, '#8fd8ff', 2.5); }
      box(x, sx, Y + H / 2 - 18, 80, 36, '#5a4a6a'); lbl(x, 'Rust shell', sx + 40, Y + H / 2 + 5);
      const br = 0.5 + 0.5 * Math.sin(t * 1.6); glow(x, bx + 50, Y + H / 2, 70, '#ff8a3a', 0.2 + br * 0.15);
      box(x, bx, Y + 6, 100, H - 12, '#b8643a', PAL.ink); lbl(x, 'daemon', bx + 50, Y + 24, PAL.goldHi);
      for (let i = 0; i < 3; i++) { box(x, bx + 12, Y + 34 + i * 22, 76, 17, '#3a2418', PAL.ink, false); lbl(x, 'session ' + (i + 1), bx + 50, Y + 47 + i * 22, i === Math.floor(t / 2) % 3 ? PAL.green : PAL.dim); }
    } },
  { id: 'loop', name: 'The Agent Loop', tag: 'the gears that do the work',
    lines: ['You type what you want.', 'The model thinks, then answers or picks a tool.', 'The tool runs (read a file, run the tests) and the result goes back to the model.', 'Round and round until the job is done. You can steer or stop it any time.'],
    draw(x, X, Y, W, H, t) {
      const you = [X + 50, Y + H / 2], mod = [X + W / 2, Y + H / 2], tool = [X + W - 60, Y + 20], ans = [X + W - 60, Y + H - 20];
      line(x, [you, mod]); line(x, [mod, tool]); line(x, [mod, ans]);
      x.save(); x.strokeStyle = 'rgba(245,189,99,0.45)'; x.setLineDash([4, 4]); x.lineDashOffset = -t * 12; x.beginPath(); x.moveTo(tool[0] - 10, tool[1] + 14); x.quadraticCurveTo(mod[0] + 60, mod[1] + 8, mod[0] + 26, mod[1] + 8); x.stroke(); x.restore();
      // phases: 0 you->model, 1 model->tool, 2 tool->model, 3 model->tool, 4 tool->model, 5 model->answer (1.6 s each)
      const ph = Math.floor(t / 1.6) % 6, k = sm((t / 1.6) % 1), legs = [[you, mod], [mod, tool], [tool, mod], [mod, tool], [tool, mod], [mod, ans]];
      const cur = /** @type {any} */ (legs[ph]), [px, py] = along(cur[0], cur[1], k);
      const hot = n => (n === 'you' && ph === 0) || (n === 'mod' && (ph === 0 || ph === 2 || ph === 4) && k > 0.8) || (n === 'tool' && (ph === 1 || ph === 3) && k > 0.8) || (n === 'ans' && ph === 5 && k > 0.8);
      box(x, you[0] - 40, you[1] - 16, 80, 32, '#2f6a8a', PAL.ink, hot('you')); lbl(x, 'you', you[0], you[1] + 5);
      box(x, mod[0] - 46, mod[1] - 20, 92, 40, '#6a4a8a', PAL.ink, hot('mod')); lbl(x, 'model', mod[0], mod[1] + 5, PAL.goldHi);
      box(x, tool[0] - 48, tool[1] - 16, 96, 32, '#3a6a4a', PAL.ink, hot('tool')); lbl(x, ph < 3 ? 'read a file' : 'run tests', tool[0], tool[1] + 5);
      box(x, ans[0] - 48, ans[1] - 16, 96, 32, '#8a6a2a', PAL.ink, hot('ans')); lbl(x, 'answer', ans[0], ans[1] + 5);
      dot(x, px, py, ph === 2 || ph === 4 ? PAL.green : PAL.gold, 4);
      lbl(x, 'turn ' + (ph < 2 ? 1 : ph < 4 ? 2 : 3), X + 8, Y + 14, PAL.dim, 'left');
    } },
  { id: 'router', name: 'The Model Router', tag: 'the switchboard to every AI',
    lines: ['GG Coder can talk to many AI models: Claude, GPT, Gemini, Grok, Kimi, local ones and more.', 'Sign in with your subscription or plug in an API key.', 'Every reply is turned into one common stream, so the rest of the engine never cares who answered.', 'Switch models whenever you like.'],
    draw(x, X, Y, W, H, t) {
      const P = ['Claude', 'GPT', 'Gemini', 'Grok', 'Kimi', 'Local'], cols = ['#d88a5a', '#6ee7a0', '#8fa3ff', '#cfcfcf', '#62e8d8', '#f5bd63'];
      const src = [X + 70, Y + H / 2], step = Math.floor(t / 2.4) % P.length, k = sm(Math.min(1, ((t / 2.4) % 1) * 2.2));
      box(x, X + 10, Y + H / 2 - 20, 74, 40, '#2f9e63'); lbl(x, 'GG', X + 47, Y + H / 2 + 5, PAL.ink);
      P.forEach((p, i) => { const jy = Y + 12 + i * (H - 24) / 5, jx = X + W - 110, on = i === step && k > 0.95;
        box(x, jx, jy - 8, 100, 17, on ? shade(cols[i], -0.2) : '#2a2230', PAL.ink, on); lbl(x, p, jx + 50, jy + 5, on ? PAL.ink : cols[i]); x.fillStyle = '#0a0a0a'; x.beginPath(); x.arc(jx - 8, jy, 4, 0, 7); x.fill(); });
      const ty = Y + 12 + step * (H - 24) / 5, tx = X + W - 118, end = along([src[0] + 14, src[1]], [tx, ty], k);
      x.save(); x.strokeStyle = cols[step]; x.lineWidth = 3; x.beginPath(); x.moveTo(src[0] + 14, src[1]); x.quadraticCurveTo((src[0] + end[0]) / 2, Y + H + 10, end[0], end[1]); x.stroke(); x.restore();
      dot(x, end[0], end[1], cols[step], 4);
      lbl(x, 'one stream back', X + W / 2 - 10, Y + 14, PAL.dim);
    } },
  { id: 'tools', name: 'The Tool Bench', tag: "the agent's hands",
    lines: ['Tools are how the agent touches your project.', 'read and grep look around, edit changes files, bash runs commands and tests.', 'Rare tools wait in the drawer until needed, so prompts stay small and cached.', 'Skills are manuals it pulls off the shelf for special jobs.'],
    draw(x, X, Y, W, H, t) {
      const T = [['read', 'looks at a file'], ['grep', 'searches the code'], ['edit', 'changes a file'], ['bash', 'runs a command']], cur = Math.floor(t / 1.8) % 4;
      x.fillStyle = '#c8a878'; rr(x, X + 6, Y + 4, W - 150, H - 8, 3); x.fill(); x.fillStyle = 'rgba(60,40,20,0.4)'; for (let yy = Y + 12; yy < Y + H - 6; yy += 10) for (let xx = X + 14; xx < X + W - 150; xx += 10) x.fillRect(xx, yy, 2, 2);
      T.forEach(([n], i) => { const cx = X + 46 + i * ((W - 170) / 3.4), cy = Y + 40, on = i === cur, bob = on ? -3 * Math.sin(((t / 1.8) % 1) * Math.PI) : 0;
        box(x, cx - 28, cy - 22 + bob, 56, 38, on ? '#6a4a2a' : '#4a3222', PAL.ink, on); lbl(x, n, cx, cy + 2 + bob, on ? PAL.goldHi : PAL.cream); });
      box(x, X + 16, Y + H - 40, W - 170, 28, '#2a2230'); lbl(x, T[cur][1], X + 16 + (W - 170) / 2, Y + H - 21, PAL.green);
      // drawer + shelf
      const dx = X + W - 136; box(x, dx, Y + 8, 128, 40, '#5a3a26'); lbl(x, 'drawer: more', dx + 64, Y + 26); lbl(x, 'tools on demand', dx + 64, Y + 40, PAL.dim);
      box(x, dx, Y + 56, 128, H - 64, '#4a3222'); const cs = ['#e8645a', '#f5bd63', '#62e8d8', '#b07aff', '#6ee7a0', '#8fa3ff'];
      cs.forEach((c, i) => { const pulled = i === Math.floor(t / 2.6) % 6 ? -6 * Math.sin(((t / 2.6) % 1) * Math.PI) : 0; x.fillStyle = c; x.fillRect(dx + 10 + i * 18, Y + 66 + pulled, 13, H - 96); });
      lbl(x, 'skills', dx + 64, Y + H - 14, PAL.goldHi);
    } },
  { id: 'memory', name: 'Memory & Sessions', tag: 'the tape reels',
    lines: ['Every chat is saved as a session you can reopen later.', 'When a chat grows too long, older turns get squeezed into a short summary so work can carry on.', 'The start of the prompt stays the same, so it is cached: long sessions stay quick and cheap.', 'Your project notes (AGENTS.md) load every time.'],
    draw(x, X, Y, W, H, t) {
      const cyc = (t % 12) / 12, n = Math.min(9, 2 + Math.floor(cyc * 12)), squash = cyc > 0.72 ? sm(Math.min(1, (cyc - 0.72) / 0.12)) : 0;
      const ty = Y + H / 2 - 4; x.fillStyle = '#3a2a1a'; x.fillRect(X + 4, ty - 18, W - 8, 36);
      // reels
      for (const [cx, sp] of [[X + 24, 1], [X + W - 24, 1.4]]) { x.save(); x.translate(cx, Y + 20); x.rotate(t * sp); x.fillStyle = '#9aa4b2'; x.beginPath(); x.arc(0, 0, 14, 0, 7); x.fill(); x.fillStyle = '#2a2230'; for (let i = 0; i < 3; i++) { x.rotate(2.09); x.fillRect(-2, 4, 4, 8); } x.restore(); }
      box(x, X + 50, ty - 15, 60, 30, '#2f6a8a'); lbl(x, 'notes', X + 80, ty + 5, '#bfe6ff');
      let px = X + 116; const old = 4;
      if (squash > 0) { const w = 46 + (old * 34 - 46) * (1 - squash); box(x, px, ty - 15, w, 30, '#8a6a2a', PAL.ink, squash > 0.9); lbl(x, squash > 0.5 ? 'summary' : '...', px + w / 2, ty + 5, PAL.ink); px += w + 4; }
      for (let i = squash > 0 ? old : 0; i < n; i++) { box(x, px, ty - 15, 30, 30, i % 2 ? '#5a4a6a' : '#3a5a4a'); lbl(x, i % 2 ? 'AI' : 'you', px + 15, ty + 5, PAL.cream); px += 34; if (px > X + W - 40) break; }
      x.save(); x.strokeStyle = PAL.green; x.lineWidth = 1.5; x.beginPath(); x.moveTo(X + 50, ty + 22); x.lineTo(X + 50, ty + 28); x.lineTo(X + 110, ty + 28); x.lineTo(X + 110, ty + 22); x.stroke(); x.restore();
      lbl(x, 'cached', X + 80, ty + 42, PAL.green); lbl(x, squash > 0 ? 'compacted' : 'chat growing...', X + W / 2 + 40, ty + 42, squash > 0 ? PAL.gold : PAL.dim);
    } },
  { id: 'goals', name: 'The Goal Farm', tag: 'where big jobs get split up',
    lines: ['Hand GG Goals a big goal and it agrees the plan with you first.', 'Then it splits the work into tasks and sends out workers that run side by side.', 'Each worker reports back. The coordinator checks the work and keeps going until the goal is met.'],
    draw(x, X, Y, W, H, t) {
      const hx = X + 50, hy = Y + H / 2, wk = [0, 1, 2].map(i => [X + W - 70, Y + 20 + i * (H - 40) / 2]), cyc = (t % 7.5) / 7.5;
      box(x, hx - 40, hy - 26, 80, 52, '#2f9e63', PAL.ink, cyc < 0.15); lbl(x, 'GG Goals', hx, hy - 4, PAL.ink); lbl(x, 'plans', hx, hy + 12, '#12301e');
      wk.forEach(([wx, wy], i) => { line(x, [[hx + 40, hy], [wx - 36, wy]]); const done = cyc > 0.62 + i * 0.05;
        box(x, wx - 36, wy - 15, 72, 30, done ? '#3a6a4a' : '#5a3a26', PAL.ink, done && cyc < 0.85); lbl(x, done ? 'done' : 'worker ' + (i + 1), wx, wy + 5, done ? PAL.green : PAL.cream);
        const out = sm(Math.min(1, Math.max(0, (cyc - 0.12 - i * 0.04) / 0.3))), back = sm(Math.min(1, Math.max(0, (cyc - 0.66 - i * 0.04) / 0.2)));
        if (out > 0 && out < 1) { const [px, py] = along([hx + 40, hy], [wx - 36, wy], out); x.fillStyle = '#c89a5a'; x.fillRect(px - 6, py - 6, 12, 12); x.strokeStyle = PAL.ink; x.strokeRect(px - 6, py - 6, 12, 12); }
        if (back > 0 && back < 1) { const [px, py] = along([wx - 36, wy], [hx + 40, hy], back); dot(x, px, py, PAL.green, 3); } });
      const met = cyc > 0.88; if (met) title(x, 'goal met', X + W / 2 - 10, Y + H - 6, { size: 16, color: PAL.green });
      else lbl(x, cyc < 0.12 ? 'agree the plan' : cyc < 0.6 ? 'workers busy' : 'checking...', X + W / 2 - 10, Y + H - 8, PAL.dim);
    } },
  { id: 'forge', name: 'The XP Forge', tag: 'where your coding turns into coins',
    lines: ['Coding with GG Coder earns XP: for prompts you send and commits you ship.', 'Bigger commits earn more (up to a cap). Spamming prompts earns less, so steady work wins.', 'XP fills your level and rank.', 'Here in GG World, every level is worth 80 coins for looks and fun.'],
    draw(x, X, Y, W, H, t) {
      const cyc = (t % 9) / 9, fill = Math.min(1, cyc / 0.75), lvl = 12 + Math.floor(t / 9);
      [['prompt', '#8fa3ff', 0], ['commit', '#6ee7a0', 0.5]].forEach(([n, c, o], i) => { box(x, X + 10, Y + 14 + i * 50, 76, 30, /** @type {string} */ (c)); lbl(x, /** @type {string} */ (n), X + 48, Y + 34 + i * 50, PAL.ink);
        const k = ((t * 0.55 + /** @type {number} */ (o)) % 1), sx = X + 90 + k * 110, sy = Y + 29 + i * 50 + Math.sin(k * Math.PI) * -12; x.fillStyle = PAL.gold; x.beginPath(); x.arc(sx, sy, 4, 0, 7); x.fill(); lbl(x, '+XP', sx, sy - 8, PAL.goldHi); });
      // furnace
      const fx = X + 210; box(x, fx, Y + 12, 80, H - 24, '#8a4a34'); glow(x, fx + 40, Y + H - 34, 46, '#ff7a2a', 0.35 + 0.1 * Math.sin(t * 1.4)); x.fillStyle = '#ff9a40'; x.fillRect(fx + 14, Y + H - 44, 52, 16);
      lbl(x, 'forge', fx + 40, Y + 30, PAL.goldHi);
      // level bar
      const bx = X + W - 120; lbl(x, 'level ' + (fill >= 1 ? lvl + 1 : lvl), bx + 50, Y + 18, PAL.cream); x.fillStyle = '#1a1410'; rr(x, bx, Y + 26, 100, 14, 3); x.fill(); x.fillStyle = fill >= 1 ? PAL.goldHi : PAL.green; rr(x, bx, Y + 26, Math.max(4, 100 * fill), 14, 3); x.fill();
      if (fill >= 1) { title(x, 'LEVEL UP', bx + 50, Y + 66, { size: 16, color: PAL.gold, glow: PAL.gold }); lbl(x, '+80 coins', bx + 50, Y + 88, PAL.goldHi); }
      else lbl(x, 'XP filling', bx + 50, Y + 66, PAL.dim);
    } },
];
