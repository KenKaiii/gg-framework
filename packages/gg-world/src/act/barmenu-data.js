// @ts-check
// Bar menu data (items, Dex lines, effects) and tiny pixel icons drawn on canvas.

/** @typedef {{ id:string, name:string, desc:string, price:number, icon:string, tint?:string, prop:string, say:string, fx?:string }} Item */

/** @type {Item[]} */
export const DRINKS = [
  { id: 'dude', name: 'The Dude', desc: 'white russian. abides.', price: 6, icon: 'rocks', tint: '#efe6d2', prop: 'cocktail', say: 'the dude abides. careful, man.' },
  { id: 'martini', name: 'Shaken Not Stirred', desc: 'vodka martini, olive', price: 8, icon: 'martini', tint: '#dfe8d0', prop: 'cocktail', say: 'shaken. obviously.' },
  { id: 'red', name: 'Red Pill', desc: 'see how deep it goes', price: 4, icon: 'shot', tint: '#e0453a', prop: 'drink', say: 'red pill. bold.', fx: 'red' },
  { id: 'blue', name: 'Blue Pill', desc: 'wake up in your bed', price: 4, icon: 'shot', tint: '#4a7bff', prop: 'drink', say: 'blue pill. sure, sleep tight.', fx: 'blue' },
  { id: 'ipa', name: 'Rollback IPA', desc: 'tastes like last friday', price: 5, icon: 'pint', tint: '#e0a458', prop: 'beer', say: 'rollback IPA. rough deploy?' },
  { id: 'negroni', name: 'Merge Conflict', desc: 'negroni. bitter. both sides.', price: 7, icon: 'rocks', tint: '#c8382c', prop: 'cocktail', say: 'resolve it yourself, mate.' },
  { id: 'hotfix', name: 'Hotfix Espresso', desc: 'espresso martini. ship it.', price: 8, icon: 'martini', tint: '#3a2416', prop: 'cocktail', say: 'hotfix. straight to prod.' },
  { id: 'butter', name: 'Butterbeer', desc: 'non-alcoholic. still magic.', price: 4, icon: 'mug', tint: '#e8b860', prop: 'mug', say: 'no booze. ten points to you.' },
  { id: 'nuka', name: 'Nuka Cola', desc: 'slightly radioactive', price: 3, icon: 'bottle', tint: '#ff4fd8', prop: 'beer', say: 'glows a bit. normal.' },
  { id: 'gargle', name: 'Pan Galactic', desc: 'gargle blaster. brain, brick.', price: 12, icon: 'martini', tint: '#6ee7a0', prop: 'cocktail', say: "don't panic. bring a towel." },
];
/** @type {Item[]} */
export const BITES = [
  { id: 'fries', name: 'Fries', desc: 'salty as code review', price: 3, icon: 'fries', prop: 'beer', say: 'fries. ketchup is BYO.' },
  { id: 'royale', name: 'Royale with Cheese', desc: 'metric system burger', price: 6, icon: 'burger', prop: 'beer', say: 'royale with cheese. classic.' },
  { id: 'soylent', name: 'Soylent Green', desc: "it's people.", price: 5, icon: 'cracker', prop: 'mug', say: "don't ask what's in it." },
  { id: 'pizza', name: 'Pizza Slice', desc: 'cold. like your backlog.', price: 3, icon: 'pizza', prop: 'beer', say: 'cold pizza. breakfast of devs.' },
  { id: 'round', name: 'Shots for the Bar', desc: 'one for everyone in here', price: 15, icon: 'tray', prop: 'drink', say: 'SHOTS FOR THE BAR!', fx: 'round' },
  { id: 'mystery', name: "Dex's Mystery Pour", desc: 'no refunds. no questions.', price: 5, icon: 'bottle', tint: '#9b7bff', prop: 'cocktail', say: 'trust me. probably.' },
];
/** @type {Item[]} */
export const COOLER = [
  { id: 'lager', name: 'Cold Lager', desc: 'sweating more than you', price: 2, icon: 'bottle', tint: '#3e6b2e', prop: 'beer', say: 'ahh. cold one.' },
  { id: 'ipa2', name: 'Rollback IPA', desc: 'the can edition', price: 3, icon: 'can', tint: '#e0a458', prop: 'beer', say: 'rolling back. tonight.' },
  { id: 'nuka2', name: 'Nuka Cola', desc: 'glows in the dark', price: 2, icon: 'bottle', tint: '#ff4fd8', prop: 'beer', say: 'slightly radioactive. nice.' },
  { id: 'soda', name: 'Sparkling Water', desc: 'hydrate, you gremlin', price: 1, icon: 'can', tint: '#8fd3ff', prop: 'beer', say: 'responsible. respect.' },
];

/** Draw a 16x16 pixel icon at (px, py). @param {CanvasRenderingContext2D} x @param {string} k @param {string} [tint] */
export function icon(x, k, px, py, tint = '#e0a458') {
  const r = (c, a, b, w, h) => { x.fillStyle = c; x.fillRect(px + a, py + b, w, h); };
  const glass = '#cfe3e8';
  if (k === 'rocks') { r(glass, 3, 5, 10, 10); r(tint, 4, 8, 8, 6); r('#ffffff', 5, 6, 3, 3); r('#ffffff', 4, 5, 1, 9); }
  else if (k === 'martini') { r(glass, 2, 2, 12, 1); r(glass, 3, 3, 10, 1); r(tint, 4, 3, 8, 2); r(glass, 5, 5, 6, 1); r(glass, 6, 6, 4, 1); r(glass, 7, 7, 2, 6); r(glass, 4, 13, 8, 1); r('#6b8e23', 10, 1, 2, 2); }
  else if (k === 'shot') { r(glass, 4, 6, 8, 9); r(tint, 5, 9, 6, 5); r('#ffffff', 5, 7, 1, 6); }
  else if (k === 'pint') { r(glass, 3, 3, 9, 12); r(tint, 4, 6, 7, 8); r('#f4f0e0', 3, 2, 9, 3); r(glass, 12, 6, 2, 1); r(glass, 13, 6, 1, 5); r(glass, 12, 10, 2, 1); }
  else if (k === 'mug') { r('#7a4a22', 3, 4, 9, 11); r('#f4f0e0', 3, 2, 9, 3); r(tint, 4, 6, 7, 1); r('#7a4a22', 12, 6, 2, 1); r('#7a4a22', 13, 6, 1, 5); r('#7a4a22', 12, 10, 2, 1); }
  else if (k === 'bottle') { r(tint, 5, 7, 6, 8); r(tint, 6, 4, 4, 3); r(tint, 7, 1, 2, 3); r('#d8c896', 5, 9, 6, 3); r('#ffffff', 6, 7, 1, 2); }
  else if (k === 'can') { r(tint, 4, 3, 8, 12); r('#b8c0c8', 4, 2, 8, 1); r('#b8c0c8', 4, 15, 8, 1); r('#1e2240', 5, 7, 6, 3); r('#ffffff', 5, 4, 1, 2); }
  else if (k === 'fries') { for (let i = 0; i < 5; i++) r('#f2c94c', 3 + i * 2, 2 + (i % 2) * 2, 1, 7); r('#c8382c', 3, 8, 10, 7); r('#ffb36b', 5, 10, 6, 2); }
  else if (k === 'burger') { r('#d08a3c', 2, 3, 12, 3); r('#e8b860', 3, 2, 10, 1); r('#5fa83c', 2, 7, 12, 1); r('#f2c94c', 2, 8, 12, 1); r('#6a3a1e', 2, 9, 12, 3); r('#d08a3c', 2, 12, 12, 2); }
  else if (k === 'pizza') { r('#c87a3a', 2, 2, 12, 2); for (let i = 0; i < 6; i++) r('#f2c94c', 3 + i, 4 + i * 2, 10 - i * 2, 2); r('#c8382c', 5, 5, 2, 2); r('#c8382c', 9, 6, 2, 2); r('#c8382c', 7, 9, 2, 2); }
  else if (k === 'cracker') { r('#3a7a3a', 2, 4, 12, 9); r('#6ee7a0', 3, 5, 10, 1); r('#2a5a2a', 4, 8, 2, 2); r('#2a5a2a', 9, 9, 2, 2); r('#2a5a2a', 6, 11, 2, 1); }
  else if (k === 'tray') { r('#8a8f98', 1, 12, 14, 2); for (let i = 0; i < 4; i++) { r(glass, 2 + i * 3, 6, 3, 6); r(['#e0453a', '#6ee7a0', '#ffb36b', '#ff4fd8'][i], 2 + i * 3, 8, 3, 3); } }
}
