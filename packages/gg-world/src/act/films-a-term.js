// @ts-check
// "Wake up, Neo" terminal close-up: the scripted sequence, a knock in the world, then a tiny joke shell.
import { SFX } from '../sfx.js';
import { gx } from './gx.js';
import { crtDevice, typer, esc, CURSOR } from './films-a-crt.js';

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
  const ov = ctx.overlay({ title: 'Terminal', sub: 'Night Shift · your PC', help: '<kbd>watch</kbd> the screen' });
  const K = gx(ov), scene = K.scene({ aspect: 4 / 3, maxW: 900 });
  const dev = crtDevice(scene, { name: 'OMNIVIEW 14', fs: '4.2cqh' });
  const log = /** @type {{s:string,c:string}[]} */ ([]); let phase = 'wait', timers = /** @type {any[]} */ ([]), started = false;
  const later = (ms, f) => timers.push(setTimeout(() => ov.el.isConnected && f(), ms));
  ov.onClose(() => timers.forEach(clearTimeout));
  const draw = (scriptLine) => {
    if (phase !== 'shell') { dev.txt.classList.add('gxcrt-top'); dev.txt.innerHTML = `<div style="font-size:1.6em">${esc(scriptLine || '')}${CURSOR}</div>`; return; }
    dev.txt.classList.remove('gxcrt-top');
    dev.txt.innerHTML = log.slice(-18).map(l => `<div style="color:${l.c}">${esc(l.s)}</div>`).join('') + `<div>&gt; ${esc(sh.buf)}${CURSOR}</div>`;
  };
  const sh = typer(ov, v => {
    if (phase !== 'shell') return;
    log.push({ s: '> ' + v, c: G }); SFX.play('blip', { vol: 0.3, delay: 0.15 });
    const out = run(v);
    if (out === 'exit') { log.push({ s: 'goodbye, mr. anderson.', c: '#e0a458' }); draw(); later(1100, () => ov.close()); return; }
    for (const l of out) log.push({ s: l, c: l === 'it was you' ? '#ff6b6b' : '#b8f5d0' });
    if (log.length > 40) log.splice(0, log.length - 40);
    draw();
  }, 34, () => draw());
  const play = () => {
    if (started) return; started = true; phase = 'script'; let at = 600;
    for (const s of SCRIPT) { for (let n = 0; n <= s.length; n++) { const k = n; later(at + k * 1000 / CPS, () => { draw(s.slice(0, k)); if (k) SFX.play('key', { vol: 0.15, jitter: 0.2 }); }); } at += s.length * 1000 / CPS + (HOLD + 0.5) * 1000; }
    later(at, () => {
      phase = 'shell'; dev.flash(); K.swell(); R.filmsA?.knock();
      dev.el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 400 });
      log.push({ s: '*knock knock*', c: '#e0a458' }, { s: 'type help', c: DIM }); draw();
      ov.setHelp('<kbd>type</kbd> a command <kbd>enter</kbd> run'); ov.setSub('somebody is at the door');
    });
  };
  draw('');
  K.card({ title: 'Wake up, Neo', text: 'Watch the screen. Then type commands.', how: [[['Type'], 'command'], [['Enter'], 'run']], cta: 'Watch', onGo: play });
}
