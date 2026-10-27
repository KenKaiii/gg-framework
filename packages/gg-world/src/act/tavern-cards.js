// @ts-check
// Tavern Duel card set (the rules data; the look lives in tavern-duel.js).
/** @typedef {{ n:string, m:number, d?:number, h?:number, b?:number, c:string, t:string, ic:string, r:number }} Card */
/** @type {Card[]} */
export const CARDS = [
  { n: 'Spark', m: 1, d: 2, c: '#ffb36b', t: 'Deal 2', ic: 'spark', r: 1 },
  { n: 'Mug of Ale', m: 1, h: 3, c: '#e0a458', t: 'Heal 3', ic: 'ale', r: 1 },
  { n: 'Murloc Pal', m: 2, d: 3, c: '#5aa86a', t: 'Deal 3', ic: 'fish', r: 2 },
  { n: 'Tankard Shield', m: 2, b: 4, c: '#8aa0c8', t: 'Block 4', ic: 'shield', r: 2 },
  { n: 'Fireball', m: 3, d: 5, c: '#ff5a2a', t: 'Deal 5', ic: 'fire', r: 3 },
  { n: 'Bar Brawl', m: 4, d: 7, c: '#a8302a', t: 'Deal 7', ic: 'fist', r: 4 },
];
