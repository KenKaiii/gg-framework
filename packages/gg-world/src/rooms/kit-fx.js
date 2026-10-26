// @ts-check
// Room kit, part 2: window & door units, moonbeams, dust motes, glow sprites, flicker helpers.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as TX from './tex.js';
import { ROOM_NAMES } from './floorplan.js';

const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, ...o });
const box = (w, h, d, m, r = 0.02) => { const g = new THREE.Mesh(r ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)) : new THREE.BoxGeometry(w, h, d), m); g.castShadow = g.receiveShadow = true; return g; };

/**
 * Window in a wall opening (local wall coords: x along wall, y up, +z into the room, wall body at z<0).
 * op: { at, w, h, y, view?: Texture, frame?: string, blinds?: boolean|string, curtains?: string, sill?: string, rain?: boolean }
 */
export function windowUnit(parent, op, T) {
  const g = new THREE.Group(); g.position.set(op.at, op.y, 0); parent.add(g);
  const fc = op.frame || '#e9dccb', fm = M(fc, { roughness: 0.6 });
  const W = op.w, H = op.h;
  // view (unlit so the night sky reads), set back into the wall
  const view = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: op.view || TX.nightView({ seed: Math.round(op.at * 10) + 3 }) }));
  view.position.set(0, H / 2, -T + 0.01); g.add(view);
  if (op.rain) { const rt = TX.rainTex().clone(); rt.needsUpdate = true; rt.repeat.set(W / 0.8, H / 1.2); const rm = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: rt, transparent: true, depthWrite: false, opacity: 0.7 })); rm.position.set(0, H / 2, -T + 0.03); rm.userData.live = true; rm.userData.tick = (t) => { rt.offset.y = (t * 1.6) % 1; }; g.add(rm); g.userData.rain = rm; }
  // glass sheen
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ color: '#9fb8ff', transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0.2, depthWrite: false }));
  glass.position.set(0, H / 2, -T / 2); g.add(glass);
  // frame: outer + mullions
  const t = 0.07;
  for (const [x, y, w, h] of [[0, -t / 2 + 0.012, W + 2 * t, t], [0, H + t / 2 - 0.012, W + 2 * t, t], [-W / 2 - t / 2 + 0.012, H / 2, t, H], [W / 2 + t / 2 - 0.012, H / 2, t, H], [0, H / 2, 0.05, H], [0, H * 0.55, W, 0.05]]) { // 12 mm into the opening (no flush faces)
    const b = box(w, h, T + 0.04, fm, 0.01); b.position.set(x, y, -T / 2 + 0.01); g.add(b);
  }
  // sill
  const sill = box(W + 0.36, 0.06, 0.28, M(op.sill || fc, { roughness: 0.55 }), 0.02); sill.position.set(0, -0.06, 0.1); g.add(sill);
  // blinds: horizontal slats, half drawn; they cast striped moon shadows
  if (op.blinds) {
    const bm = M(typeof op.blinds === 'string' ? op.blinds : '#d9d4c7', { roughness: 0.5 }); const n = 14, top = H * 0.98, bottom = H * 0.35;
    for (let i = 0; i < n; i++) { const y = top - i * (top - bottom) / (n - 1); const s = box(W + 0.06, 0.012, 0.08, bm, 0); s.position.set(0, y, 0.06); s.rotation.x = 0.55; g.add(s); }
    const rail = box(W + 0.12, 0.06, 0.1, bm, 0.01); rail.position.set(0, H + 0.02, 0.06); g.add(rail);
  }
  // curtains: soft folded fabric on both sides
  if (op.curtains) {
    const cm = M(op.curtains, { roughness: 0.95, side: THREE.DoubleSide });
    for (const sgn of [-1, 1]) {
      const cw = 0.42, ch = H + 0.55; const geo = new THREE.PlaneGeometry(cw, ch, 12, 1); const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i); p.setZ(i, Math.sin((x / cw + 0.5) * Math.PI * 5) * 0.035); }
      geo.computeVertexNormals(); const c = new THREE.Mesh(geo, cm); c.castShadow = true; c.position.set(sgn * (W / 2 + 0.12), H / 2 - 0.12, 0.14); g.add(c);
    }
    const rod = box(W + 1.1, 0.03, 0.03, M('#3b2b22', { metalness: 0.4, roughness: 0.4 }), 0.01); rod.position.set(0, H + 0.2, 0.14); g.add(rod);
  }
  return g;
}

/** Doorway with frame; to = label shown on a small sign; glow = colour of light spilling from the next room. */
export function doorUnit(parent, op, T) {
  const g = new THREE.Group(); g.position.set(op.at, 0, 0); parent.add(g);
  const W = op.w, H = 2.2, fm = M(op.frame || '#e9dccb', { roughness: 0.6 });
  for (const [x, y, w, h] of [[-W / 2 - 0.038, H / 2, 0.1, H + 0.05], [W / 2 + 0.038, H / 2, 0.1, H + 0.05], [0, H + 0.038, W + 0.2, 0.1]]) { const b = box(w, h, T + 0.08, fm, 0.01); /* inner faces 12 mm inside the opening: not flush with the wall cut (z-fight) */ b.position.set(x, y, -T / 2 + 0.02); g.add(b); }
  // warm light from the room beyond
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: doorGlow(op.glow || '#ffb86b') }));
  back.position.set(0, H / 2, -T - 0.02); g.add(back);
  if (op.to || op.label) { const s = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.22), new THREE.MeshBasicMaterial({ map: TX.label(op.label || op.to, '#fff4e0', '#2b2236', 256, 64, '39px m5x7'), toneMapped: false })); s.position.set(0, H + 0.28, 0.03); g.add(s); }
  return g;
}
/** Open archway between two rooms on the same floor: chunky frame, no door, nothing behind (you see the next room). */
// Openings between rooms must be obvious (owner: "didn't even notice where they are"). Each one gets:
//  - a chunky light trim frame with a warm lit strip under the lintel (hides with the wall when it's cut away),
//  - name signs over the opening on BOTH faces: each face names the room you'd walk INTO,
//  - a glowing threshold on the floor through the opening (always visible, even with walls cut down).
// Wall-local coords: x along the wall, +z into the room that owns the wall, the wall body at z in [-T, 0].
const ARCH_TRIM = new THREE.MeshStandardMaterial({ color: '#6a5242', roughness: 0.75, metalness: 0.05 });
function thresholdTex() {
  return TX.canvasTex('threshold2', 128, 128, (x, w, h) => {
    // soft elliptical spill: brightest in the opening, fading smoothly in every direction (no line, no edge)
    const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,214,170,1)'); g.addColorStop(0.35, 'rgba(255,200,150,0.55)'); g.addColorStop(0.7, 'rgba(255,190,140,0.15)'); g.addColorStop(1, 'rgba(255,190,140,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  });
}
export function archUnit(parent, op, T, floorParent) {
  const g = new THREE.Group(); g.position.set(op.at, 0, 0); parent.add(g);
  const W = op.w, H = op.h || 2.6;
  for (const [x, y, w, h] of [[-W / 2 - 0.058, H / 2, 0.14, H], [W / 2 + 0.058, H / 2, 0.14, H], [0, H + 0.058, W + 0.28, 0.14]]) { const b = box(w, h, T + 0.1, ARCH_TRIM, 0.02); /* 12 mm into the opening: no flush faces */ b.position.set(x, y, -T / 2); g.add(b); }
  // small brass plaque over the opening: this face (into the owning room) names the neighbour, the far face the owner
  const sign = (txt, z, ry) => { if (!txt) return; const s = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(1.5, W * 0.6 + 0.2), 0.24), new THREE.MeshStandardMaterial({ map: TX.label(txt, '#e8d3a6', '#2a2019', 384, 60, '45px m5x7'), roughness: 0.6, metalness: 0.2 }));
    s.position.set(0, H + 0.3, z); s.rotation.y = ry; g.add(s); };
  sign(ROOM_NAMES[op.to], 0.03, 0); sign(ROOM_NAMES[op.from], -T - 0.03, Math.PI);
  if (floorParent) {
    // casing stubs either side: the wall's own frame, still there when the camera cuts the wall down (no glow)
    for (const sx of [-1, 1]) { const post = box(0.16, 0.5, T + 0.12, ARCH_TRIM, 0.02); post.position.set(op.at + sx * (W / 2 + 0.08), 0.25, -T / 2); floorParent.add(post); }
    // faint warm spill across the opening, like light from the next room (tone mapped, so it never blooms)
    const f = new THREE.Mesh(new THREE.PlaneGeometry(W + 1.4, 3.2), new THREE.MeshBasicMaterial({ map: thresholdTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.16 }));
    f.rotation.x = -Math.PI / 2; f.position.set(op.at, 0.014, -T / 2); f.renderOrder = 2; f.userData.live = true; floorParent.add(f);
  }
  return g;
}
function doorGlow(c) { return TX.canvasTex('doorglow' + c, 64, 128, (x, w, h) => { const g = x.createLinearGradient(0, h, 0, 0); g.addColorStop(0, c); g.addColorStop(1, '#1a1426'); x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, h * 0.82, w, h * 0.18); }); }

/**
 * Additive light shaft (moonbeam through a window, lamp cone). from = top point, to = floor point, width at top/bottom.
 * @returns {THREE.Mesh}
 */
export function beam(from, to, wTop = 0.9, wBot = 1.8, color = '#9fb8ff', opacity = 0.22) {
  const dir = new THREE.Vector3().subVectors(to, from); const len = dir.length();
  const geo = new THREE.CylinderGeometry(wTop / 2, wBot / 2, len, 4, 1, true); geo.rotateY(Math.PI / 4); geo.translate(0, -len / 2, 0);
  const m = new THREE.MeshBasicMaterial({ color, map: TX.beamTex(), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const b = new THREE.Mesh(geo, m); b.position.copy(from); b.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize()); b.renderOrder = 5; b.userData.live = true; return b;
}

/** Floating dust motes inside a box. Returns Points with userData.tick. */
export function motes(n, min, max, color = '#cfe0ff', size = 0.05) {
  const p = new Float32Array(n * 3), ph = new Float32Array(n);
  for (let i = 0; i < n; i++) { p[i * 3] = min.x + Math.random() * (max.x - min.x); p[i * 3 + 1] = min.y + Math.random() * (max.y - min.y); p[i * 3 + 2] = min.z + Math.random() * (max.z - min.z); ph[i] = Math.random() * 6.28; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ color, size, map: TX.dotTex(), transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const pts = new THREE.Points(g, m); pts.userData.live = true; const base = p.slice();
  pts.userData.tick = (t) => { for (let i = 0; i < n; i++) { p[i * 3] = base[i * 3] + Math.sin(t * 0.3 + ph[i]) * 0.15; p[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * 0.21 + ph[i] * 2) * 0.12; p[i * 3 + 2] = base[i * 3 + 2] + Math.cos(t * 0.26 + ph[i]) * 0.15; } g.attributes.position.needsUpdate = true; };
  return pts;
}

/** Soft glow sprite (halo around bulbs, screens, candles). */
export function glow(color = '#ffcf8a', size = 0.6, opacity = 0.55) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.dotTex(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  s.scale.setScalar(size); s.userData.live = true; return s;
}

/** Flicker value in [1-amp, 1] (candles, CRTs, neon). Deterministic per seed. */
// Calmer than the rooms asked for (owner: "areas with lights flickering"): every caller gets 45% of its amplitude at
// 55% of its speed, so candles and old bulbs breathe instead of buzzing. One place, all rooms.
export function flicker(t, seed = 0, amp = 0.15, speed = 1) { amp *= 0.45; speed *= 0.55; const n = Math.sin(t * 13.1 * speed + seed) * 0.5 + Math.sin(t * 7.3 * speed + seed * 2.1) * 0.3 + Math.sin(t * 23.7 * speed + seed * 0.7) * 0.2; return 1 - amp * (0.5 + 0.5 * n); }

/** Rising steam/smoke puffs from a point. Returns a Group with userData.tick. */
export function steam(at, color = '#ffffff', n = 6, height = 0.6) {
  const g = new THREE.Group(); g.position.copy(at); g.userData.live = true; const m = new THREE.SpriteMaterial({ map: TX.dotTex(), color, transparent: true, opacity: 0.25, depthWrite: false });
  const ss = []; for (let i = 0; i < n; i++) { const s = new THREE.Sprite(m.clone()); s.userData.ph = i / n; g.add(s); ss.push(s); }
  g.userData.tick = (t) => { for (const s of ss) { const k = (t * 0.35 + s.userData.ph) % 1; s.position.set(Math.sin(k * 6 + s.userData.ph * 9) * 0.06, k * height, 0); s.scale.setScalar(0.08 + k * 0.22); s.material.opacity = 0.32 * Math.sin(k * Math.PI); } };
  return g;
}
