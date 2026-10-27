// @ts-check
// Club Cyberdelia activity helpers: safe localStorage, the player's hacker handle, today's seed.
export const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
export const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
/** @param {any} S */
export const handle = S => load('cyb-handle', null) || (S?.player?.name ? String(S.player.name).toUpperCase().slice(0, 12) : 'ANON');
export const today = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
