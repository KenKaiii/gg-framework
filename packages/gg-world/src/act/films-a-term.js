// @ts-check
// "Wake up, Neo" terminal close-up: the scripted sequence, a knock in the world, then a tiny joke shell.
import { SFX } from '../sfx.js';
import { loop, text } from './util.js';
import { crt, typer, wrap } from './films-a-crt.js';

const SCRIPT = ['Wake up, Neo...', 'The Matrix has you...', 'Follow the white rabbit.', 'Knock, knock, Neo.'];
const CPS = 20, HOLD = 0.5;
const G = '#6ee7a0', DIM = '#2f7a52';

/** @param {string} raw @returns {string[] | 'exit'} */
function run(raw) {
  const c = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!c) return [];
  if (c === 'help') return ['commands: whoami, ls, git blame,', 'sudo make me a sandwich, exit'];
  if (c === 'whoami') return ['the one? (unverified)'];
  if (c === 'sudo make me a sandwich') return ['[sudo] password for neo: ******', 'okay.'];
  if (c === 'make me a sandwich') return ['what? make it yourself.'];
  if (c === 'git blame') return ['it was you'];
  if (c === 'ls') return ['white_rabbit.txt  red_pill  blue_pill'];
  if (/^(cat )?(red|blue)_?pill/.test(c)) return ['choice accepted. (it changes nothing)'];
  if (c === 'cat white_rabbit.txt') return ['follow me. bring snacks.'];
  if (c === 'exit' || c === 'logout') return 'exit';
  return [c.split(' ')[0] + ': command not found', 'there is no spoon.'];
}

/** @param {any} ctx */
export function startTerminal(ctx) {
  const { R } = ctx;
  const ov = ctx.overlay({ title: 'Terminal', sub: 'Night Shift · your PC', help: '<kbd>watch</kbd>... <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const st = { t: 0, phase: 'script', flash: 0, log: /** @type {{s:string,c:string}[]} */ ([]), shake: 0, bye: -1 };
  const sh = typer(ov, v => {
    if (st.phase !== 'shell') return;
    st.log.push({ s: '> ' + v, c: G }); SFX.play('blip', { vol: 0.3, delay: 0.15 });
    const out = run(v);
    if (out === 'exit') { st.log.push({ s: 'goodbye, mr. anderson.', c: '#e0a458' }); st.bye = st.t + 1.1; return; }
    for (const l of out) st.log.push({ s: l, c: l === 'it was you' ? '#ff6b6b' : '#b8f5d0' });
    if (st.log.length > 40) st.log.splice(0, st.log.length - 40);
  }, 34);
  // script timeline
  const starts = []; let acc = 0.6; for (const s of SCRIPT) { starts.push(acc); acc += s.length / CPS + HOLD + 0.5; }
  const knockAt = acc;
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    if (st.bye > 0 && t > st.bye) { st.bye = -1; ov.close(); return; }
    if (st.phase === 'script' && t >= knockAt) {
      st.phase = 'shell'; st.flash = 1; st.shake = 0.5; R.filmsA?.knock();
      st.log.push({ s: '*knock knock*', c: '#e0a458' }, { s: 'type help', c: DIM });
      ov.setHelp('<kbd>type</kbd> a command <kbd>enter</kbd> run <kbd>esc</kbd> leave'); ov.setSub('somebody is at the door');
    }
    st.flash = Math.max(0, st.flash - dt * 1.4); st.shake = Math.max(0, st.shake - dt);
    const ox = st.shake > 0 ? Math.round(Math.sin(t * 90) * 3 * st.shake * 2) : 0;
    x.save(); x.translate(ox, 0);
    crt(x, W, H, (sx, sy, sw, shh) => {
      if (st.phase === 'script') {
        let i = starts.length - 1; while (i > 0 && t < starts[i]) i--;
        const n = Math.max(0, Math.min(SCRIPT[i].length, Math.floor((t - starts[i]) * CPS)));
        const s = SCRIPT[i].slice(0, n), cur = (t * 2.2) % 1 < 0.55 ? '█' : '';
        text(x, s + cur, sx + 16, sy + 44, { size: 32, color: G });
      } else {
        const lines = []; for (const l of st.log) for (const w of wrap(x, l.s, sw - 28)) lines.push({ s: w, c: l.c });
        lines.push({ s: '> ' + sh.buf + ((t * 2.2) % 1 < 0.55 ? '_' : ''), c: G });
        const max = Math.floor((shh - 20) / 16), vis = lines.slice(-max);
        vis.forEach((l, k) => text(x, l.s, sx + 14, sy + 24 + k * 16, { color: l.c }));
      }
    }, { flash: st.flash });
    x.restore();
  });
}
