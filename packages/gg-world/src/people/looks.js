// @ts-check
// Unique looks: each member is built from their persona's wardrobe + their own seed, with small body/head proportions,
// varied hair (incl. dyed), skin, accessory colours and the odd silly item, so a room of 20 never looks like clones.
import { rng } from '../rooms/kit.js';

const SKIN = ['#f9dcc4', '#f2c6a0', '#e8b48a', '#e0ac69', '#c68a5e', '#a8714f', '#8d5a3b', '#6f4e37', '#5a3a28', '#f5d0b0'];
const HAIR_NAT = ['#111111', '#1b1410', '#2a1a12', '#3a2618', '#5a3a22', '#6a4a2a', '#8a5a3a', '#a8743e', '#c9b79c', '#d8c8a8', '#7a2a1a', '#b05a2a', '#9a9a9a'];
const HAIR_DYE = ['#5a189a', '#1f6a8a', '#2a8a5a', '#c43a6a', '#d86a2a', '#3a4a9a', '#9ad0ff', '#ff7ab8', '#7ad87a'];
const ACC_COL = ['#111111', '#2a2a2e', '#3ddc84', '#b04fd8', '#e0a458', '#8fa3ff', '#d8263a', '#f2f2f2', '#2a1838'];
const DEF = { tops: ['#23262e', '#2a2440', '#3a2a34', '#1e2240', '#2d3a2e', '#4a2c2a'], bottoms: ['#15111c', '#1b1b2f', '#22223b'], acc: ['none', 'glasses', 'headphones'], heads: ['rogue', 'hooded', 'knight', 'mage', 'barbarian'], bodies: ['rogue', 'knight', 'mage', 'barbarian'], silly: [[]] };

/** tint a hex a little (k -1..1: darker..lighter), to break up identical wardrobe colours */
const nudge = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = c => Math.max(0, Math.min(255, Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k)))); return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join(''); };

/** @param {any} persona @param {string} seedKey @param {any} old (keep member's existing body build if useful) */
export function lookFor(persona, seedKey) {
  let h = 2166136261; for (let i = 0; i < seedKey.length; i++) { h ^= seedKey.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r = rng(h >>> 0), pk = a => a[Math.floor(r() * a.length)];
  const W = { ...DEF, ...(persona?.looks || {}) };
  const acc = pk(W.acc.length ? W.acc : DEF.acc);
  const look = {
    body: pk(W.bodies), head: pk(W.heads),
    hair: r() < 0.16 ? pk(HAIR_DYE) : pk(HAIR_NAT), skin: pk(SKIN),
    top: nudge(pk(W.tops), (r() - 0.5) * 0.3), bottom: nudge(pk(W.bottoms), (r() - 0.5) * 0.25),
    acc, accColor: pk(ACC_COL),
    // proportions: slightly taller/shorter, broader/slimmer, bigger/smaller head (subtle: they still read as chibi)
    scale: { height: +(0.93 + r() * 0.13).toFixed(3), width: +(0.92 + r() * 0.14).toFixed(3), head: +(0.94 + r() * 0.12).toFixed(3) },
  };
  const silly = W.silly && W.silly.length ? pk(W.silly) : [];
  if (silly.length && r() < 0.55) look.silly = silly; else if (r() < 0.08) look.silly = [pk(['cone', 'duck', 'moustache', 'sunglasses', 'tinfoil'])];
  return look;
}
