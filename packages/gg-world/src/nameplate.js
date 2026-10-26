// @ts-check
// Nameplates: the "Minimal" style the owner picked (showcase/nameplates.html, style E).
// No box: the name floats with a dark outline and the level sits in a pill-shaped orb.
// 11 tiers by level (up to 200). Each tier adds one thing so high levels are something to show off:
//   Fresh 1-9 grey, Regular 10-24 accent colour, Shipper 25-39 bronze, Veteran 40-59 silver, Elite 60-79 gold + aura +
//   title, Mythic 80-99 pink + halo, Legend 100-124 rainbow + crown, Ascended 125-149 starlit + stars, Eternal 150-174
//   molten + embers, Architect 175-199 white + light rays, The One 200 green + falling code + shades.
// FULL plate (near you, hovered or targeted): level orb + name + title (from Elite) + decorations.
// COMPACT plate (everyone else): NAME ONLY, keeping the tier's colour/glow so rank still shows at a glance.
// All effects use transform / opacity animations only, and stop for prefers-reduced-motion.
import { FONT } from './fonts.js';

export const TIERS = [
  { t: 1, name: 'Fresh', min: 1 }, { t: 2, name: 'Regular', min: 10 }, { t: 3, name: 'Shipper', min: 25 },
  { t: 4, name: 'Veteran', min: 40 }, { t: 5, name: 'Elite', min: 60 }, { t: 6, name: 'Mythic', min: 80 },
  { t: 7, name: 'Legend', min: 100 }, { t: 8, name: 'Ascended', min: 125 }, { t: 9, name: 'Eternal', min: 150 },
  { t: 10, name: 'Architect', min: 175 }, { t: 11, name: 'The One', min: 200 },
];
/** @param {number|string} lv */
export const tierOf = lv => { const n = Number(lv); if (!Number.isFinite(n)) return 0; return TIERS.reduce((t, T) => (n >= T.min ? T.t : t), 1); };

const svg = (w, h, rects, cls = '') => `<svg class="px ${cls}" width="${w * 2}" height="${h * 2}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${rects}</svg>`;
const R = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
const crownSvg = (c1, c2, g1, g2) => svg(11, 7, R(0, 2, 1, 5, c1) + R(5, 0, 1, 7, c1) + R(10, 2, 1, 5, c1) + R(1, 4, 9, 3, c1) + R(1, 6, 9, 1, c2) + R(3, 4, 1, 1, g1) + R(5, 3, 1, 1, g2) + R(7, 4, 1, 1, g1));
const SHADES = svg(13, 4, R(0, 0, 13, 1, '#050505') + R(1, 1, 5, 2, '#050505') + R(7, 1, 5, 2, '#050505') + R(2, 1, 1, 1, '#3ddc84') + R(8, 1, 1, 1, '#3ddc84') + R(2, 3, 3, 1, '#050505') + R(8, 3, 3, 1, '#050505'));
const CROWN = { 7: ['#ffe08a', '#b8862a', '#ff4fd8', '#3ddcff'], 8: ['#cfd8ff', '#5a68d8', '#c08bff', '#6ad1ff'], 9: ['#ffc66a', '#c0400c', '#ff3d1a', '#ffe08a'], 10: ['#ffffff', '#9aa6c0', '#ffd1f4', '#9fd8ff'] };

/** Decorations that sit around the plate (only on full plates, except the aura which also softly glows compact ones). */
function deco(t) {
  let d = '';
  if (t >= 5) d += '<span class="aura"></span>';
  // (no halo: a floating ring above the name read as a stray circle; the tier shows in the level chip + name glow)
  if (CROWN[t]) d += `<span class="crown full-only">${crownSvg(...CROWN[t])}</span>`;
  if (t === 8) d += '<span class="fx stars full-only"><i></i><i></i><i></i><i></i></span>';
  if (t === 9) d += '<span class="fx embers full-only"><i></i><i></i><i></i><i></i><i></i><i></i></span>';
  if (t >= 10) d += '<span class="fx rays full-only"></span>';
  if (t === 11) d += `<span class="fx code full-only"><i>1</i><i>0</i><i>1</i><i>1</i><i>0</i><i>1</i></span><span class="fx shades full-only">${SHADES}</span>`;
  return d;
}

/**
 * Inner HTML for a plate. Caller sets className via plateClass().
 * @param {{ lv: number|string, name: string, title?: string, status?: string, full: boolean }} o
 */
export function plateHTML(o) {
  const t = tierOf(o.lv); const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const sub = o.full ? (t >= 5 && o.title ? o.title : '') : '';
  return deco(t) + `<span class="orb">${esc(o.lv)}</span><span class="nm">${esc(o.name)}</span>`
    + (o.full && o.status ? `<span class="st">${esc(o.status)}</span>` : '') + (sub ? `<span class="sub">${esc(sub)}</span>` : '');
}
/** @param {number|string} lv @param {boolean} full @param {string} [extra] */
export const plateClass = (lv, full, extra = '') => `np t${tierOf(lv) || 'x'}${full ? '' : ' mini'}${extra ? ' ' + extra : ''}`;

export const PLATE_CSS = `
.np{position:absolute;transform:translate(-50%,-100%) scale(var(--ui,1));transform-origin:50% 100%;display:flex;align-items:center;gap:6px;height:20px;white-space:nowrap;isolation:isolate;pointer-events:none;
  font:16px/16px ${FONT.title};color:#eef2ea;text-shadow:0 1px 0 #000,0 0 3px #000,0 0 6px rgba(0,0,0,.8);z-index:5}
.np .orb{min-width:24px;height:18px;padding:0 6px;border-radius:9px;display:inline-grid;place-items:center;font:16px/16px ${FONT.body};color:#0b0a12;background:var(--orb,#7d877f);text-shadow:none;box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.np .st{font:16px/16px ${FONT.body};color:#9aa79c}
.np .sub{position:absolute;left:50%;top:100%;transform:translate(-50%,2px);font:16px/16px ${FONT.body};color:#9aa79c;white-space:nowrap}
.np.mini{height:18px}.np.mini .orb,.np.mini .st,.np.mini .sub,.np.mini .full-only{display:none}
/* NPCs (residents, Dex): warm name + a small role tag (no level) */
.np.npc{color:#ffd9a0}.np.npc .role{font:16px/16px ${FONT.body};color:#c9b48a;padding:0 6px 2px;border-radius:4px;background:rgba(30,20,10,.55);text-shadow:none}
.np.tx{--orb:#e0a458}.np.tx .orb{color:#1a1206}
.np.t1{--orb:#7d877f;color:#d2d8cf}.np.t2{--orb:var(--a,#6ee7a0)}
.np.t3{--orb:radial-gradient(circle at 35% 30%,#ffd2a0,#c87a3a 60%,#6e3d1d)}
.np.t4{--orb:radial-gradient(circle at 35% 30%,#fff,#b9c4d0 55%,#59616d)}
.np.t5{--orb:radial-gradient(circle at 35% 30%,#fff8d0,#ffcf4a 55%,#9a6a16);--aura:rgba(255,207,74,.35)}.np.t5 .nm{color:#fff2c8}
.np.t6{--orb:radial-gradient(circle at 35% 30%,#ffe0f8,#ff4fd8 50%,#5a1a78);--aura:rgba(255,79,216,.4);--halo:#ff9ad5}.np.t6 .nm{color:#ffe8fa;text-shadow:0 1px 0 #000,0 0 8px rgba(255,79,216,.8)}
.np.t7{--orb:conic-gradient(from 0deg,#ffe08a,#ff9ad5,#9ad6ff,#b9ffcf,#ffe08a);--aura:rgba(255,220,140,.5)}.np.t7 .nm{color:#fff8e6;text-shadow:0 1px 0 #000,0 0 8px rgba(255,220,140,.9),0 0 16px rgba(255,154,213,.6)}
.np.t8{--orb:radial-gradient(circle at 35% 30%,#e6ecff,#6a7cff 50%,#141a5a);--aura:rgba(106,124,255,.5);--halo:#9fb0ff}.np.t8 .nm{color:#e8ecff;text-shadow:0 1px 0 #000,0 0 8px rgba(106,124,255,.95)}
.np.t9{--orb:radial-gradient(circle at 35% 30%,#fff1c2,#ff6a1a 55%,#5a0e02);--aura:rgba(255,106,26,.5);--halo:#ffb347}.np.t9 .nm{color:#ffe2c4;text-shadow:0 1px 0 #000,0 0 8px rgba(255,106,26,.95)}
.np.t10{--orb:radial-gradient(circle at 35% 30%,#fff,#e9eefc 60%,#9aa6c0);--aura:rgba(255,255,255,.45);--halo:#fff}.np.t10 .nm{color:#fff;text-shadow:0 1px 0 #000,0 0 10px rgba(255,255,255,.9),0 0 20px rgba(159,216,255,.7)}
.np.t11{--orb:radial-gradient(circle at 35% 30%,#eafff1,#3ddc84 55%,#04140a);--aura:rgba(61,220,132,.55)}.np.t11 .nm{color:#d6ffe4;text-shadow:0 1px 0 #000,0 0 8px #3ddc84,0 0 16px rgba(61,220,132,.7)}
.np .aura{position:absolute;left:50%;top:50%;width:150%;height:36px;transform:translate(-50%,-50%);border-radius:50%;z-index:-1;background:radial-gradient(ellipse,var(--aura) 0%,transparent 70%);opacity:.6;animation:npBreathe 3s ease-in-out infinite}
.np.mini .aura{opacity:.4;animation:none}
.np .halo{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);width:28px;height:6px;border-radius:50%;border:2px solid var(--halo,#ffe08a);box-shadow:0 0 6px var(--halo,#ffe08a);animation:npBob 2.4s ease-in-out infinite}
.np .crown{position:absolute;left:50%;bottom:100%;transform:translate(-50%,3px);z-index:3}
.np .halo~.crown{bottom:calc(100% + 6px)}
.np svg.px{image-rendering:pixelated;shape-rendering:crispEdges;display:block}
.np .fx{position:absolute;pointer-events:none}
.np .stars{inset:0}.np .stars i{position:absolute;width:6px;height:6px;background:#cfe0ff;clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%);animation:npTwinkle 2.6s ease-in-out infinite}
.np .stars i:nth-child(1){left:-8px;top:-7px}.np .stars i:nth-child(2){right:-8px;top:-4px;animation-delay:.7s}.np .stars i:nth-child(3){left:30%;top:-11px;animation-delay:1.4s}.np .stars i:nth-child(4){right:22%;bottom:-8px;animation-delay:2s}
.np .embers{left:0;right:0;bottom:100%;height:24px}.np .embers i{position:absolute;bottom:0;width:2px;height:2px;background:#ffc66a;box-shadow:0 0 4px #ff6a1a;animation:npEmber 2.2s linear infinite}
.np .embers i:nth-child(1){left:12%}.np .embers i:nth-child(2){left:30%;animation-delay:.5s;--dx:-3px}.np .embers i:nth-child(3){left:50%;animation-delay:1.1s}.np .embers i:nth-child(4){left:68%;animation-delay:.3s;--dx:-2px}.np .embers i:nth-child(5){left:86%;animation-delay:1.6s}.np .embers i:nth-child(6){left:40%;animation-delay:1.9s;--dx:4px}
.np .rays{left:50%;top:50%;width:150px;height:150px;margin:-75px 0 0 -75px;z-index:-3;border-radius:50%;background:repeating-conic-gradient(from 0deg,var(--ray,rgba(255,255,255,.16)) 0 5deg,transparent 5deg 30deg);-webkit-mask:radial-gradient(circle,#000 25%,transparent 68%);mask:radial-gradient(circle,#000 25%,transparent 68%);animation:npSpin 20s linear infinite}
.np.t11 .rays{--ray:rgba(61,220,132,.2)}
.np .code{left:4px;right:4px;bottom:100%;height:20px;overflow:hidden;display:flex;justify-content:space-between}
.np .code i{font:16px/16px ${FONT.body};font-style:normal;color:#3ddc84;text-shadow:0 0 4px #3ddc84;opacity:0;animation:npDrip 1.5s linear infinite}
.np .code i:nth-child(2){animation-delay:.4s}.np .code i:nth-child(3){animation-delay:.9s}.np .code i:nth-child(4){animation-delay:.2s}.np .code i:nth-child(5){animation-delay:1.2s}.np .code i:nth-child(6){animation-delay:.7s}
.np .shades{left:50%;bottom:100%;transform:translate(-50%,-2px);filter:drop-shadow(0 0 3px #3ddc84);z-index:3}
@keyframes npBreathe{50%{opacity:.95;transform:translate(-50%,-50%) scale(1.08)}}
@keyframes npBob{50%{transform:translate(-50%,-2px)}}
@keyframes npTwinkle{0%,100%{opacity:0;transform:scale(.4)}50%{opacity:1;transform:scale(1)}}
@keyframes npEmber{0%{opacity:0;transform:translate(0,0)}15%{opacity:1}100%{opacity:0;transform:translate(var(--dx,3px),-22px)}}
@keyframes npSpin{to{transform:rotate(360deg)}}
@keyframes npDrip{0%{opacity:0;transform:translateY(-6px)}20%{opacity:1}100%{opacity:0;transform:translateY(16px)}}
@media (prefers-reduced-motion: reduce){.np *{animation:none!important}}
`;
