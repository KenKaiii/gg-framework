// @ts-check
// Tavern activity helpers: rarity colours, date seed, safe localStorage.
import { rng } from './util.js';

export const RARITY = [['Poor', '#9d9d9d'], ['Common', '#ffffff'], ['Uncommon', '#1eff00'], ['Rare', '#0070dd'], ['Epic', '#a335ee'], ['Legendary', '#ff8000']];

/** @param {string} k @param {any} def */
export function load(k, def) { try { const v = JSON.parse(localStorage.getItem('tavern-' + k) || 'null'); return v ?? def; } catch { return def; } }
/** @param {string} k @param {any} v */
export function save(k, v) { try { localStorage.setItem('tavern-' + k, JSON.stringify(v)); } catch { /* ignore */ } }
/** YYYY-MM-DD for today + seeded rng for it. @param {Date} [d] */
export function today(d = new Date()) { const key = d.toISOString().slice(0, 10); return { key, r: rng(+key.replace(/-/g, '')) }; }
