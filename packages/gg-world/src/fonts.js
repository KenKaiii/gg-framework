// @ts-check
// Night Rooms typography, matching GG Royale: m5x7 (Daniel Linssen, CC0) for everything, Alagard (Hewett Tsoi,
// free with credit) for titles. Both are pixel fonts drawn on a 16px grid: use sizes that are multiples of 16
// (16, 32, 48) and line-heights in whole pixels so they stay crisp. Fonts are inlined, so this works offline.
import m5x7 from './assets/fonts/m5x7.ttf';
import alagard from './assets/fonts/alagard.ttf';
// Sora (OFL, assets/fonts/sora-OFL.txt): the GG Coder app's own font, only for the app-style buttons (Stand up).
import sora from './assets/fonts/sora-latin.woff2';

/** CSS font stacks. body = m5x7 (UI, labels, chat, menus), title = Alagard (headings, names, big numbers), app = Sora. */
export const FONT = { body: '"m5x7", ui-monospace, Menlo, monospace', title: '"Alagard", "m5x7", serif', app: '"Sora", -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, sans-serif' };
/** Canvas font strings at crisp sizes. */
export const CFONT = { body: (px = 16) => `${px}px m5x7`, title: (px = 16) => `${px}px Alagard` };

let ready = null;
/** Inject @font-face once and resolve when both fonts are usable (canvas text needs this before drawing). */
export function installFonts() {
  if (ready) return ready;
  const st = document.createElement('style');
  st.textContent = `@font-face{font-family:"m5x7";src:url(${m5x7}) format("truetype");font-display:block}`
    + `@font-face{font-family:"Alagard";src:url(${alagard}) format("truetype");font-display:block}`
    + `@font-face{font-family:"Sora";src:url(${sora}) format("woff2");font-weight:100 800;font-display:swap}`;
  document.head.appendChild(st);
  ready = Promise.all([document.fonts.load('16px m5x7'), document.fonts.load('16px Alagard')]).then(() => true, () => false);
  return ready;
}
