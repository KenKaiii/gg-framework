// @ts-check
// Films A helpers, GX edition: a beautifully made CRT device (DOM + CSS, drawn at screen resolution) whose glass shows
// crisp phosphor text (smooth mono, glow via text-shadow, static scanlines), plus the typed-input line for terminals.
import { SFX } from '../sfx.js';

export const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
let styled = false;
function ensure() {
  if (styled) return; styled = true;
  const st = document.createElement('style'); st.id = 'gxcrt-style';
  st.textContent = `
.gxcrt-dev{position:absolute;inset:0;border-radius:4.5cqh;background:var(--case);box-shadow:inset 0 2px 0 rgba(255,255,255,.18),inset 0 -6px 14px rgba(0,0,0,.45),0 30px 60px -20px rgba(0,0,0,.85),0 0 0 1px rgba(0,0,0,.5)}
.gxcrt-dev::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(ellipse 70% 40% at 50% 0%,rgba(255,214,160,.22),transparent 70%)}
.gxcrt-bez{position:absolute;left:5%;right:5%;top:6%;bottom:15%;border-radius:4cqh;background:linear-gradient(#0c0d0f,#1b1d21);box-shadow:inset 0 3px 8px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.12)}
.gxcrt-glass{position:absolute;inset:3.2cqh 3.4cqh;border-radius:5cqh/7cqh;overflow:hidden;background:radial-gradient(ellipse at 50% 45%,var(--bg1),var(--bg0) 80%);box-shadow:inset 0 0 6cqh rgba(0,0,0,.85),0 0 4cqh -1cqh var(--glow)}
.gxcrt-glass::before{content:"";position:absolute;inset:0;z-index:2;pointer-events:none;background:repeating-linear-gradient(transparent 0 2px,rgba(0,0,0,.22) 2px 3px)}
.gxcrt-glass::after{content:"";position:absolute;inset:0;z-index:3;pointer-events:none;background:radial-gradient(ellipse 50% 30% at 28% 18%,rgba(255,255,255,.09),transparent 70%),radial-gradient(ellipse at 50% 50%,transparent 60%,rgba(0,0,0,.55))}
.gxcrt-txt{position:absolute;inset:6% 6.5%;z-index:1;font:500 var(--fs,3.6cqh)/1.45 ${MONO};color:var(--ph);text-shadow:0 0 .35em var(--glow),0 0 1.1em var(--glow);white-space:pre-wrap;word-break:break-word;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
.gxcrt-txt.gxcrt-top{justify-content:flex-start}
.gxcrt-cur{display:inline-block;width:.6em;height:1.05em;vertical-align:-.15em;background:var(--ph);box-shadow:0 0 .5em var(--glow);animation:gxcrt-blink 1.6s steps(1) infinite}
@keyframes gxcrt-blink{60%{opacity:0}}
.gxcrt-flash{position:absolute;inset:0;z-index:4;background:#e8fff0;opacity:0;pointer-events:none;transition:opacity .9s}
.gxcrt-chin{position:absolute;left:6%;right:6%;bottom:3.5%;height:8%;display:flex;align-items:center;justify-content:space-between;font:700 2.3cqh/1 "Sora",sans-serif;letter-spacing:.24em;color:var(--badge)}
.gxcrt-led{width:1.4cqh;height:1.4cqh;border-radius:50%;background:var(--glow);box-shadow:0 0 1.2cqh var(--glow)}
@media (prefers-reduced-motion: reduce){.gxcrt-cur{animation:none}}
`;
  document.head.appendChild(st);
}

/**
 * A CRT device filling `parent` (a K.scene). Returns { el, glass, txt, flash() }.
 * @param {HTMLElement} parent @param {{ ph?: string, glow?: string, bg0?: string, bg1?: string, case?: string, badge?: string, name?: string, top?: boolean, fs?: string }} [o]
 */
export function crtDevice(parent, o = {}) {
  ensure();
  const d = document.createElement('div'); d.className = 'gxcrt-dev';
  const v = { '--ph': o.ph || '#8cf5b4', '--glow': o.glow || 'rgba(61,220,132,.55)', '--bg0': o.bg0 || '#020806', '--bg1': o.bg1 || '#0a1d14',
    '--case': o.case || 'linear-gradient(160deg,#3a4440,#232a27 60%,#191e1c)', '--badge': o.badge || 'rgba(255,255,255,.35)', '--fs': o.fs || '3.6cqh' };
  for (const k in v) d.style.setProperty(k, v[k]);
  d.innerHTML = `<div class="gxcrt-bez"><div class="gxcrt-glass"><div class="gxcrt-txt${o.top ? ' gxcrt-top' : ''}"></div><div class="gxcrt-flash"></div></div></div><div class="gxcrt-chin"><span>${o.name || ''}</span><span class="gxcrt-led"></span></div>`;
  parent.appendChild(d);
  const glass = /** @type {HTMLElement} */ (d.querySelector('.gxcrt-glass')), txt = /** @type {HTMLElement} */ (d.querySelector('.gxcrt-txt')), fl = /** @type {HTMLElement} */ (d.querySelector('.gxcrt-flash'));
  return { el: d, glass, txt, flash() { fl.style.transition = 'none'; fl.style.opacity = '.85'; void fl.offsetWidth; fl.style.transition = ''; fl.style.opacity = '0'; } };
}
/** Escape text for innerHTML. @param {string} s */
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);
export const CURSOR = '<span class="gxcrt-cur"></span>';

/** Typed input line: printable keys append, Backspace deletes, Enter submits. Removed on close. */
export function typer(ov, onEnter, max = 40, onChange) {
  const st = { buf: '', on: true };
  const kd = e => {
    if (!st.on || e.code === 'Escape' || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter') SFX.play('ui.send', { vol: 0.4 }); else if (e.key === 'Backspace' || e.key.length === 1) SFX.play('key', { vol: 0.35, jitter: 0.1 });
    if (e.key === 'Enter') { const v = st.buf.trim(); st.buf = ''; onEnter(v); }
    else if (e.key === 'Backspace') st.buf = st.buf.slice(0, -1);
    else if (e.key.length === 1 && st.buf.length < max) st.buf += e.key;
    else return;
    e.preventDefault(); e.stopPropagation(); onChange?.();
  };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  return st;
}
