// @ts-check
// The Roof: surface textures (the view around the roof is the neighbourhood in outside.js).
import * as TX from './tex.js';

/** Tar + gravel roof surface. */
export function gravel() {
  return TX.canvasTex('roof-gravel', 512, 512, (x, w, h) => {
    x.fillStyle = '#3a3542'; x.fillRect(0, 0, w, h); const r = TX.rand(91);
    for (let i = 0; i < 9000; i++) { const v = 30 + r() * 40 | 0; x.fillStyle = `rgba(${v},${v - 4},${v + 8},${0.5 + r() * 0.5})`; x.fillRect(r() * w, r() * h, 1 + r() * 2.5, 1 + r() * 2); }
    x.strokeStyle = 'rgba(10,8,14,0.55)'; x.lineWidth = 3; for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(0, r() * h); x.bezierCurveTo(w * .3, r() * h, w * .6, r() * h, w, r() * h); x.stroke(); }
  }, { repeat: true });
}
/** Concrete parapet / hut stucco. */
export function stucco() { return TX.plaster('#3a2a34', 33); }
