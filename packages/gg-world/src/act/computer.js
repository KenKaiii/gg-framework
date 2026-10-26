// @ts-check
// Activities for The Computer Lab: Windoze 93 desktop (Snake + Mines + Clipp-E), Prompt School daily quiz,
// Type Racer 3000, Oregon Commit, plus in-world E gags (printer, server rack, vending machine, IT helpdesk).
import { startDesktop } from './computer-os.js';
import { startPrompt } from './computer-prompt.js';
import { startTyping } from './computer-typing.js';
import { startTrail } from './computer-trail.js';

const lab = R => R.id === 'computer';
/** In-world gag: the room animates it (R.onInteract), we just end at once. */
const gag = (id, line) => ({ id: 'computer-' + id, match: (it, R) => lab(R) && it.id === id,
  /** @param {any} ctx */ start(ctx) { ctx.R.onInteract?.(id, ctx.api); if (line) ctx.api.toast(line); ctx.done(); } });

export default [
  { id: 'computer-desktop', label: () => 'Use the PC', match: (it, R) => lab(R) && (it.act === 'computer-desktop' || it.id === 'pc-desktop'), start: startDesktop },
  { id: 'computer-typing', label: () => 'Typing race', match: (it, R) => lab(R) && (it.act === 'computer-typing' || it.id === 'pc-typing'), start: startTyping },
  { id: 'computer-prompt', label: () => 'Prompt School', match: (it, R) => lab(R) && it.id === 'prompt', start: startPrompt },
  { id: 'computer-trail', label: () => 'Play Oregon Commit', match: (it, R) => lab(R) && it.id === 'trail', start: startTrail },
  gag('printer', ''), gag('rack', ''), gag('vending', ''), gag('helpdesk', ''),
];
