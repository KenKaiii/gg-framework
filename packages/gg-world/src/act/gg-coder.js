// @ts-check
// The in-game computers open the player's OWN GG Coder (owner: "access a computer in this game, to code, with our
// GG Coder projects/sessions"). Sitting at one of these PCs only ASKS the app ({ t:'computer', open:true }); the app
// then frames its own window (this window's projects and sessions, nothing else) as a monitor over World. World never
// sees prompts, code or files and has no way to send a prompt: it is sealed (boot.js) and only knows "open" and "close".
// The app says { t:'computer', open:false } when the player stands up there; standing up here tells the app the same.
import { sitPlayer } from './sit.js';
import { tellApp, fromApp, EMBED } from '../bridge.js';
import { SFX } from '../sfx.js';

/** Seats at a PC, per room, that open GG Coder (lab PCs 8 and 9 keep their games: Windoze 93, which also has a
 * GGCODER.EXE icon, and the typing race; the bedroom PC is the Neo terminal). */
export const CODING_SEATS = {
  computer: ['pc-0', 'pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5', 'pc-6', 'pc-7', 'pc-10', 'pc-11'],
  basement: ['bs-desk', 'bs-hack-0', 'bs-hack-1', 'bs-hack-2', 'bs-hack-3'],
  studio: ['studio-stream'],
};

/**
 * Sit at a PC and open GG Coder on it. @param {any} ctx activity ctx @param {any} [slot] seat (default: ctx.it.slot)
 */
export function openComputer(ctx, slot = ctx.it.slot) {
  const { S, R } = ctx;
  const stand = slot ? sitPlayer(S, R, slot) : () => {};
  if (!EMBED) { ctx.api.toast?.('GG Coder opens here when you play World inside the app.'); stand(); ctx.done(); return; }
  // an invisible overlay: World's input stays paused (the registry), and closing it is our one clean-up point
  const ov = ctx.overlay({ title: 'GG Coder', sub: 'your projects', help: '' }); ov.el.style.display = 'none';
  // the camera leans onto the monitor first (registry.js), then GG Coder grows out of the screen (App.css .app-in-monitor)
  SFX.play('ui.select'); const t0 = performance.now(); const go = () => { if (ov.el.isConnected === false && performance.now() - t0 > 50) return; if (!S.view || (S.viewK || 0) > 0.9 || performance.now() - t0 > 900) tellApp({ t: 'computer', open: true }); else requestAnimationFrame(go); }; requestAnimationFrame(go);
  S.coding = true; // shared with other players as "coding at a PC" (net.js), never what's on screen
  let fromAppSide = false;
  const onMsg = (/** @type {MessageEvent} */ e) => { if (fromApp(e) && e.data?.gg === 'world' && e.data.t === 'computer' && e.data.open === false) { fromAppSide = true; ctx.done(); } };
  addEventListener('message', onMsg);
  ov.onClose(() => { S.coding = false; removeEventListener('message', onMsg); if (!fromAppSide) tellApp({ t: 'computer', open: false }); stand(); SFX.play('stand'); });
}

export default [{
  id: 'gg-coder', label: () => 'Code on this PC', sfx: false,
  match: (/** @type {any} */ it) => it?.kind === 'seat' && it.act === 'gg-coder',
  start: (/** @type {any} */ ctx) => openComputer(ctx),
}];
