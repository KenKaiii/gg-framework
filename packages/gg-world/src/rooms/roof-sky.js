// @ts-check
// The Roof: city skyline, sky, moon and textures (backdrop planes behind the parapet).
import * as THREE from 'three';
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

function skyline(seed, far, hz = 0) {
  return TX.canvasTex('roof-city' + seed + far + hz, 1024, 384, (x, w, h) => {
    const r = TX.rand(seed); let px = -10;
    while (px < w) {
      const bw = 40 + r() * 90, bh = h * ((far ? 0.25 : 0.35) + r() * (far ? 0.4 : 0.5)), top = h - bh;
      x.fillStyle = far ? '#151838' : '#0c0d22'; x.fillRect(px, top, bw, h);
      if (r() < 0.35) { x.fillRect(px + bw * .2, top - 14, bw * .3, 14); }
      for (let yy = top + 8; yy < h - 6; yy += far ? 9 : 12) for (let xx = px + 6; xx < px + bw - 6; xx += far ? 8 : 11) if (r() < (far ? 0.18 : 0.24)) { x.fillStyle = r() < 0.75 ? (far ? '#a6834f' : '#ffc773') : (r() < .5 ? '#8fb4ff' : '#b04fd8'); x.fillRect(xx, yy, far ? 3 : 5, far ? 4 : 6); }
      if (!far && r() < 0.3) { // water tower
        const tx = px + bw * (0.3 + r() * .4), ty = top; x.fillStyle = '#0c0d22';
        x.fillRect(tx - 2, ty - 26, 3, 26); x.fillRect(tx + 22, ty - 26, 3, 26); x.fillRect(tx - 4, ty - 58, 32, 34);
        x.beginPath(); x.moveTo(tx - 6, ty - 58); x.lineTo(tx + 12, ty - 72); x.lineTo(tx + 30, ty - 58); x.fill();
        x.strokeStyle = '#1c1d3c'; x.lineWidth = 1; for (let k = 0; k < 4; k++) { x.beginPath(); x.moveTo(tx - 4, ty - 50 + k * 8); x.lineTo(tx + 28, ty - 50 + k * 8); x.stroke(); }
      }
      px += bw + (far ? 0 : 4 + r() * 10);
    }
    const g = x.createLinearGradient(0, h * .6, 0, h); g.addColorStop(0, 'rgba(60,30,70,0)'); g.addColorStop(1, 'rgba(90,40,90,0.35)'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    if (hz) { const q = x.createLinearGradient(0, 0, 0, h); q.addColorStop(0, 'rgba(40,30,80,0)'); q.addColorStop(1, `rgba(70,45,100,${hz})`); x.globalCompositeOperation = 'source-atop'; x.fillStyle = q; x.fillRect(0, 0, w, h); x.globalCompositeOperation = 'source-over'; }
  });
}
function skyTex() {
  return TX.canvasTex('roof-sky', 1024, 512, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#070a1e'); g.addColorStop(0.7, '#141a44'); g.addColorStop(1, '#2a2050'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    const r = TX.rand(5); for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(220,225,255,${0.2 + r() * 0.6})`; const s = r() < 0.1 ? 2 : 1; x.fillRect(r() * w, r() * h * 0.75, s, s); }
  });
}
function moonTex() {
  return TX.canvasTex('roof-moon', 256, 256, (x, w, h) => {
    const gl = x.createRadialGradient(128, 128, 20, 128, 128, 128); gl.addColorStop(0, 'rgba(190,205,255,0.45)'); gl.addColorStop(1, 'rgba(190,205,255,0)'); x.fillStyle = gl; x.fillRect(0, 0, w, h);
    x.fillStyle = '#e8e6da'; x.beginPath(); x.arc(128, 128, 40, 0, 7); x.fill();
    x.fillStyle = 'rgba(150,150,175,0.4)'; for (const [a, b, c] of [[115, 118, 9], [142, 136, 6], [124, 146, 5], [140, 112, 4]]) { x.beginPath(); x.arc(a, b, c, 0, 7); x.fill(); }
  });
}
/** One merged backdrop texture per side: sky, stars, optional moon and three skyline layers fading into haze. */
function sideTex(k, moonU) {
  return TX.canvasTex('roof-side' + k + moonU, 2048, 600, (x, w, h) => {
    x.drawImage(skyTex().image, 0, 0, w, h);
    if (moonU >= 0) x.drawImage(moonTex().image, w * moonU - 120, h * 0.42, 200, 200);
    const layers = [[skyline(20 + k, true, 0.7), 0.50, 0.30], [skyline(30 + k, true, 0.4), 0.58, 0.27], [skyline(3 + k, false, 0.15), 0.66, 0.30]];
    for (const [t, top, hh] of layers) for (let rep = 0; rep < 2; rep++) x.drawImage(t.image, rep * w / 2, h * top, w / 2 + 2, h * hh);
    x.fillStyle = '#0c0d22'; x.fillRect(0, h * 0.955, w, h);
    x.fillStyle = '#141634'; x.fillRect(w * 0.8 - 3, h * 0.2, 6, h * 0.32); // radio mast
  });
}
/**
 * City backdrop: one plane per room side (n,s,e,w), one draw call each. show(camDir) keeps only the planes
 * behind the room (opposite the camera). Moon on n and s so it's in view from either default direction.
 */
export function backdrop(parent, w, d) {
  const groups = {}, blinks = [];
  const SIDE = { n: [0, -d / 2, 0, w], s: [0, d / 2, Math.PI, w], w: [-w / 2, 0, Math.PI / 2, d], e: [w / 2, 0, -Math.PI / 2, d] };
  const blinkM = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3030').multiplyScalar(3) });
  let k = 0;
  for (const side of /** @type {const} */ (['n', 'w', 's', 'e'])) {
    const [x, z, ry] = SIDE[side], g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; g.userData.live = true; parent.add(g); groups[side] = g;
    const PW = 56, PH = 16, Y0 = -9.5; // plane bottom below roof level: we're high up
    const m = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshBasicMaterial({ map: sideTex(k, side === 'n' ? 0.38 : side === 's' ? 0.6 : -1), fog: false }));
    m.position.set(0, Y0 + PH / 2, -8); g.add(m);
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), blinkM); b.position.set(PW * 0.3, Y0 + PH * 0.8 + 0.1, -7.9); g.add(b); blinks.push(b);
    k++;
  }
  const NRM = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] };
  /** @param {THREE.Vector3} camDir */
  const show = camDir => { for (const sd in groups) groups[sd].visible = NRM[sd][0] * camDir.x + NRM[sd][1] * camDir.z < -0.2; };
  return { blinks, show };
}
