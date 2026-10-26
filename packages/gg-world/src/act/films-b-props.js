// @ts-check
// Films B: small homage props built in code (room-local origin, y = 0 floor unless noted). Static parts are merged
// with bake(); animated parts are returned separately and tagged live.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, bake } from '../rooms/kit.js';
import * as TX from '../rooms/tex.js';
import { glow } from '../rooms/kit-fx.js';

const cyl = (rt, rb, h, m, s = 12) => mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
const live = o => { o.userData.live = true; return o; };
/** Bake a group's static meshes and tag it live (so the room's own bake leaves it alone). */
export const baked = g => { bake(g); g.userData.live = true; return g; };
const flat = (w, h, m) => { const p = mesh(new THREE.PlaneGeometry(w, h), m); p.rotation.x = -Math.PI / 2; p.castShadow = false; return p; };

/** Overlook-style interlocking hexagon carpet. */
export function hexCarpetTex() {
  return TX.canvasTex('fb-hexcarpet', 222, 192, (x, w, h) => {
    x.fillStyle = '#6a2414'; x.fillRect(0, 0, w, h);
    const s = 32, hx = s * Math.sqrt(3);
    const hex = (cx, cy, r) => { x.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i + Math.PI / 6; x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } x.closePath(); };
    for (let row = -1; row < h / (s * 1.5) + 1; row++) for (let col = -1; col < w / hx + 1; col++) {
      const cx = col * hx + (row % 2 ? hx / 2 : 0), cy = row * s * 1.5;
      hex(cx, cy, s * 0.98); x.fillStyle = '#c4581e'; x.fill();
      hex(cx, cy, s * 0.72); x.fillStyle = '#6a2414'; x.fill();
      hex(cx, cy, s * 0.46); x.fillStyle = '#2a120c'; x.fill();
      hex(cx, cy, s * 0.2); x.fillStyle = '#c4581e'; x.fill();
    }
    const r = TX.rand(13); for (let i = 0; i < 2500; i++) { x.fillStyle = `rgba(0,0,0,${r() * 0.15})`; x.fillRect(r() * w, r() * h, 2, 2); }
  }, { repeat: true });
}
export function hexRug(len = 3.4, wid = 1.5) {
  const t = hexCarpetTex().clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, len / (wid / 2 * 192 / 222)); t.needsUpdate = true;
  return flat(wid, len, mat('#ffffff', { map: t, roughness: 1 }));
}

/** Lowball glass with a White Russian (attach to a hand bone; rig units). */
export function whiteRussian() {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.085, 0.075, 0.17, 14, 1, true), new THREE.MeshStandardMaterial({ color: '#cfe0ff', roughness: 0.05, transparent: true, opacity: 0.35, side: THREE.DoubleSide })), 0, 0.09, 0);
  put(g, cyl(0.078, 0.07, 0.12, mat('#efe4cf', { roughness: 0.4 }), 14), 0, 0.07, 0);
  put(g, cyl(0.079, 0.079, 0.03, mat('#6a4428', { roughness: 0.4 }), 14), 0, 0.02, 0);
  return g;
}

/** Briefcase on a table top (y = 0 is the table). Returns { g, lid, beam, halo }. */
export function briefcase() {
  // hard-shell attache: black leather shells with a stitched seam band, brass corner caps, two combination latches,
  // a curved leather handle on brass mounts. Body baked; the lid is one baked group (pivot at the back hinge).
  const g = new THREE.Group(), lea = mat('#121216', { roughness: 0.45 }), seam = mat('#2a2a30', { roughness: 0.6 }), brass = mat('#c99a4a', { metalness: 0.85, roughness: 0.3 });
  put(g, rbox(0.52, 0.065, 0.36, lea, 0.02), 0, 0.0325, 0);
  put(g, rbox(0.525, 0.008, 0.365, seam, 0.004), 0, 0.064, 0);                                   // seam band
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.035, 0.05, 0.035, brass, 0.01), sx * 0.248, 0.03, sz * 0.168); // corner caps
  for (const sx of [-1, 1]) { put(g, rbox(0.06, 0.035, 0.012, brass, 0.004), sx * 0.15, 0.06, 0.183);           // latches + dials
    for (let d = 0; d < 3; d++) { const w = cyl(0.007, 0.007, 0.012, mat('#8a6a2a', { metalness: 0.9, roughness: 0.4 }), 8); w.rotation.x = Math.PI / 2; w.position.set(sx * 0.15 - 0.016 + d * 0.016, 0.045, 0.188); g.add(w); } }
  for (const sx of [-1, 1]) put(g, rbox(0.022, 0.02, 0.02, brass, 0.005), sx * 0.07, 0.07, 0.19);              // handle mounts
  const hg = new THREE.TorusGeometry(0.07, 0.012, 6, 14, Math.PI); const handle = mesh(hg, lea); handle.position.set(0, 0.075, 0.2); handle.scale.set(1, 0.45, 1); g.add(handle);
  baked(g);
  const lid = live(new THREE.Group()); lid.position.set(0, 0.07, -0.18); g.add(lid);
  put(lid, rbox(0.52, 0.045, 0.36, lea, 0.02), 0, 0.0225, 0.18);
  for (const sx of [-1, 1]) for (const sz of [0, 1]) put(lid, rbox(0.035, 0.04, 0.035, brass, 0.01), sx * 0.248, 0.022, sz ? 0.348 : 0.012);
  for (const sx of [-1, 1]) put(lid, cyl(0.008, 0.008, 0.06, brass, 8), sx * 0.12, 0, 0).rotation.z = Math.PI / 2;  // hinges
  bake(lid);
  const inside = mesh(new THREE.PlaneGeometry(0.48, 0.32), glowMat('#ffcf6a', 1.5)); inside.rotation.x = -Math.PI / 2; inside.position.set(0, 0.071, 0); inside.visible = false; inside.userData.live = true; g.add(inside);
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.17, 0.7, 20, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffc24a'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  cone.position.set(0, 0.42, 0.02); live(cone); g.add(cone);
  const halo = glow('#ffc24a', 0.8, 0); halo.position.set(0, 0.25, 0); g.add(halo);
  return { g, lid, inside, cone, halo };
}

function ringTex() {
  return TX.canvasTex('fb-ring', 128, 128, (x, w, h) => {
    x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 6; x.beginPath(); x.arc(w / 2, h / 2, 54, 0, 7); x.stroke();
    x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = 4; x.beginPath(); x.arc(w / 2, h / 2, 40, 0, 7); x.stroke();
  });
}
/** Glass of water on a counter (y = 0 is the counter). Returns { g, rings }. */
export function waterGlass() {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.065, 0.055, 0.17, 18, 1, true), new THREE.MeshStandardMaterial({ color: '#d8ecff', roughness: 0.05, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })), 0, 0.085, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.06, 0.053, 0.13, 18), new THREE.MeshStandardMaterial({ color: '#7aa8c8', roughness: 0.1, transparent: true, opacity: 0.45, depthWrite: false })), 0, 0.066, 0);
  const rm = new THREE.MeshBasicMaterial({ map: ringTex(), color: '#cfe6ff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const rings = [0, 1].map(() => { const r = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), rm.clone()); r.rotation.x = -Math.PI / 2; r.position.y = 0.132; g.add(r); return r; });
  live(g); return { g, rings };
}

function textTex(key, word, color) {
  return TX.canvasTex(key, 256, 96, (x, w, h) => {
    x.clearRect(0, 0, w, h); x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '87px m5x7';
    x.fillStyle = color; x.globalAlpha = 0.9; x.fillText(word, w / 2, h / 2);
    x.globalAlpha = 0.6; for (let i = 0; i < 12; i++) { const dx = 30 + i * 17; x.fillRect(dx, h / 2 + 16, 2, 6 + (i * 7) % 18); }
  });
}
function mirrorTex() {
  return TX.canvasTex('fb-mirror', 64, 160, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#6a7890'); g.addColorStop(0.5, '#3a4458'); g.addColorStop(1, '#252a3a'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,0.18)'; x.beginPath(); x.moveTo(8, 0); x.lineTo(26, 0); x.lineTo(4, 60); x.lineTo(0, 60); x.fill(); x.beginPath(); x.moveTo(34, 0); x.lineTo(40, 0); x.lineTo(18, 60); x.lineTo(12, 60); x.fill();
  });
}
/** Standing mirror (faces +z). Returns { g, word, redrum, murder }. */
export function standingMirror() {
  const g = new THREE.Group(), wood = mat('#3a2418', { roughness: 0.7 });
  const W = 0.62, H = 1.5;
  put(g, rbox(W + 0.1, H + 0.1, 0.05, wood, 0.02), 0, 0.25 + H / 2, -0.02);
  put(g, mesh(new THREE.PlaneGeometry(W, H), mat('#ffffff', { map: mirrorTex(), roughness: 0.15, metalness: 0.1 })), 0, 0.25 + H / 2, 0.006);
  for (const sx of [-1, 1]) { const l = put(g, rbox(0.05, 0.6, 0.05, wood, 0.01), sx * 0.3, 0.28, -0.2); l.rotation.x = -0.45; }
  put(g, rbox(0.8, 0.04, 0.12, wood, 0.01), 0, 0.02, -0.12);
  baked(g);
  const redrum = textTex('fb-redrum', 'REDRUM', '#b0121a'), murder = textTex('fb-murder', 'MURDER', '#b0121a');
  const word = live(mesh(new THREE.PlaneGeometry(0.56, 0.21), new THREE.MeshBasicMaterial({ map: redrum, transparent: true, depthWrite: false })));
  word.castShadow = false; word.position.set(0, 1.25, 0.012); word.rotation.z = -0.06; g.add(word);
  return { g, word, redrum, murder };
}

/** Red stapler (on a desk; y = 0 the desk top). A Swingline-style side profile extruded with a bevel: a long red arm
 *  with a rounded nose and a sloped hinge hump, on a black base with a chrome anvil and hinge pin. Baked to few draws. */
export function stapler() {
  const g = new THREE.Group(), red = mat('#c4161c', { roughness: 0.22, metalness: 0.1 }), dark = mat('#141418', { roughness: 0.5 }), chrome = mat('#d8dce4', { metalness: 0.9, roughness: 0.2 });
  const ext = (pts, depth, bev, m) => { const sh = new THREE.Shape(); pts.forEach(([x, y], i) => i ? sh.lineTo(x, y) : sh.moveTo(x, y)); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 6 }); geo.translate(0, 0, -depth / 2); return mesh(geo, m); };
  // base: low slab, rounded front
  g.add(ext([[-0.1, 0.004], [0.095, 0.004], [0.104, 0.012], [0.1, 0.02], [-0.1, 0.02]], 0.042, 0.004, dark));
  // arm: curve built from a smooth top line (hump at the hinge, gentle slope to the nose)
  const top = []; for (let i = 0; i <= 12; i++) { const k = i / 12, xx = -0.1 + k * 0.205; top.push([xx, 0.05 + Math.cos(k * Math.PI * 0.5) * 0.018 - k * k * 0.006]); }
  const arm = ext([[-0.1, 0.03], [0.1, 0.034], [0.108, 0.04], ...top.reverse()], 0.04, 0.006, red); arm.rotation.z = 0.02; g.add(arm);
  // chrome anvil plate at the nose + hinge pin + a stud of chrome trim along the arm
  put(g, mesh(new THREE.BoxGeometry(0.04, 0.003, 0.03), chrome), 0.075, 0.022, 0);
  const pin = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.056, 8), chrome); pin.rotation.x = Math.PI / 2; pin.position.set(-0.088, 0.03, 0); g.add(pin);
  put(g, mesh(new THREE.BoxGeometry(0.12, 0.002, 0.012), chrome), 0.0, 0.066, 0);
  return baked(g);
}

/** Smashed laser printer on the floor. Returns { g, err } (err = blinking error light). */
export function smashedPrinter() {
  const g = new THREE.Group(), body = mat('#bdb6a2', { roughness: 0.8 }), dark = mat('#2a2a2e'), paper = mat('#ece6d8', { roughness: 1 });
  const p = put(g, new THREE.Group(), 0, 0, 0); p.rotation.set(0.0, 0, 0.22);
  put(p, rbox(0.62, 0.36, 0.5, body, 0.03), 0, 0.2, 0);
  put(p, rbox(0.5, 0.06, 0.04, dark, 0.01), 0, 0.3, 0.25);
  put(p, rbox(0.14, 0.06, 0.02, mat('#5a7a4a'), 0.005), 0.18, 0.4, 0.2); // LCD
  const tray = put(g, rbox(0.42, 0.02, 0.3, body, 0.008), 0.45, 0.04, 0.25); tray.rotation.set(0.1, 0.6, 0.35);
  const panel = put(g, rbox(0.3, 0.02, 0.22, body, 0.008), -0.5, 0.012, 0.35); panel.rotation.y = 1.1;
  for (let i = 0; i < 6; i++) { const s = put(g, flat(0.21, 0.29, paper), -0.3 + (i * 0.37) % 1.1, 0.006 + i * 0.002, 0.5 + ((i * 0.53) % 0.6)); s.rotation.z = i * 1.3; }
  for (let i = 0; i < 5; i++) put(g, rbox(0.04, 0.02, 0.03, i % 2 ? dark : mat('#2e6a3a'), 0.005), 0.2 + i * 0.09, 0.01, -0.35 + (i % 3) * 0.12, i);
  baked(g);
  const err = live(mesh(new THREE.SphereGeometry(0.018, 8, 6), glowMat('#ff3a2a', 3))); err.position.set(-0.17, 0.43, 0.22); g.add(err);
  const sp = glow('#ffd08a', 0.35, 0); sp.position.set(0.0, 0.42, 0.2); g.add(sp);
  return { g, err, spark: sp };
}

/** Proton-pack homage leaning on a wall (back toward -z). Returns { g, lights } (lights = cyclotron glow mesh). */
export function protonPack() {
  // alice frame with straps, a ribbed olive power cell with vents and a gauge, the cyclotron as a lathe drum with
  // a bevelled rim (the 4 red lights orbit its face), a ribbed hose (tube along a curve) into a bevelled wand with
  // an orange tip and a grip. Baked to a handful of draws.
  const g = new THREE.Group(), lean = put(g, new THREE.Group()); lean.rotation.x = -0.12;
  const black = mat('#1c1c20', { roughness: 0.6 }), grey = mat('#5a5e66', { metalness: 0.6, roughness: 0.4 }), olive = mat('#4a4c3a', { roughness: 0.7 }), steel = mat('#a8aeb8', { metalness: 0.8, roughness: 0.3 });
  put(lean, rbox(0.46, 0.8, 0.05, black, 0.02), 0, 0.5, -0.08);                                      // alice frame
  for (const sx of [-1, 1]) put(lean, rbox(0.05, 0.7, 0.02, mat('#2a2620', { roughness: 0.9 }), 0.008), sx * 0.15, 0.55, -0.11); // straps
  put(lean, rbox(0.42, 0.42, 0.2, olive, 0.035), 0, 0.62, 0.06);                                      // power cell
  for (let i = 0; i < 5; i++) put(lean, rbox(0.3, 0.014, 0.012, black, 0.004), 0, 0.5 + i * 0.05, 0.165); // ribs / vents
  put(lean, rbox(0.12, 0.28, 0.08, grey, 0.02), 0.17, 0.75, 0.2);                                     // booster
  const gauge = put(lean, cyl(0.028, 0.028, 0.012, steel, 12), 0.17, 0.82, 0.245); gauge.rotation.x = Math.PI / 2;
  put(lean, cyl(0.03, 0.03, 0.3, mat('#c9a227', { roughness: 0.5 }), 10), -0.2, 0.55, 0.14);          // gold tube
  const drum = mesh(new THREE.LatheGeometry([[0, 0.07], [0.15, 0.07], [0.17, 0.06], [0.175, 0.03], [0.17, 0], [0.15, -0.01], [0.12, -0.02]].map(([r, y]) => new THREE.Vector2(r, y)), 20), grey);
  drum.rotation.x = Math.PI / 2; drum.position.set(0, 0.27, 0.03); lean.add(drum);                    // cyclotron (face toward +z)
  const rim = mesh(new THREE.TorusGeometry(0.155, 0.012, 6, 24), steel); rim.position.set(0, 0.27, 0.1); lean.add(rim);
  const hose = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[-0.2, 0.4, 0.14], [-0.28, 0.28, 0.2], [-0.3, 0.2, 0.3], [-0.31, 0.2, 0.08]].map(([a, b2, c2]) => new THREE.Vector3(a, b2, c2))), 16, 0.022, 6, false), black); lean.add(hose);
  const wand = put(lean, rbox(0.07, 0.08, 0.42, grey, 0.025), -0.32, 0.2, 0.28); wand.rotation.y = 0.2;
  put(lean, rbox(0.035, 0.07, 0.04, black, 0.01), -0.31, 0.15, 0.2).rotation.y = 0.2;               // grip
  for (let i = 0; i < 3; i++) put(lean, rbox(0.075, 0.01, 0.01, steel, 0.003), -0.32 + i * 0.008, 0.245, 0.2 + i * 0.07).rotation.y = 0.2; // clamp bands
  put(lean, cyl(0.025, 0.03, 0.1, mat('#e07a2a', { roughness: 0.4 }), 10), -0.37, 0.2, 0.52).rotation.x = Math.PI / 2;
  baked(g);
  const lights = live(new THREE.InstancedMesh(new THREE.SphereGeometry(0.032, 8, 6), glowMat('#ff2a1a', 3), 4)); lights.position.copy(lean.position); lights.rotation.copy(lean.rotation); g.add(lights);
  const hal = glow('#ff3a2a', 0.5, 0.35); hal.position.set(0, 0.28, 0.2); g.add(hal);
  return { g, lights, halo: hal };
}

/** Hoverboard homage leaning against a wall (no logos). Returns { g, board, pads }. */
export function hoverboard() {
  // a surfboard-ish deck: extruded rounded outline with a bevel (pink), a yellow racing stripe + green accent decals,
  // a grip strip with a foot strap, and two dark rounded pods with glowing undersides. Deck baked; pads stay live.
  const g = new THREE.Group(), board = live(put(g, new THREE.Group(), 0, 0, 0));
  const pink = mat('#e0508e', { roughness: 0.3 }), yel = mat('#f2c83a', { roughness: 0.4 }), grn = mat('#3ad6a0', { roughness: 0.4 }), dark = mat('#26222e', { roughness: 0.5 }), grip = mat('#8a2a5a', { roughness: 0.95 });
  const sh = new THREE.Shape(), L = 0.46, Wd = 0.15; sh.moveTo(-Wd + 0.03, -L); sh.quadraticCurveTo(0, -L - 0.04, Wd - 0.03, -L);
  sh.bezierCurveTo(Wd + 0.01, -L * 0.4, Wd + 0.01, L * 0.4, Wd - 0.02, L - 0.04); sh.quadraticCurveTo(0, L + 0.06, -Wd + 0.02, L - 0.04);
  sh.bezierCurveTo(-Wd - 0.01, L * 0.4, -Wd - 0.01, -L * 0.4, -Wd + 0.03, -L);
  const deck = new THREE.ExtrudeGeometry(sh, { depth: 0.018, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 10 }); deck.translate(0, 0.46, -0.009);
  board.add(mesh(deck, pink));
  put(board, rbox(0.035, 0.7, 0.006, yel, 0.003), -0.035, 0.46, 0.019);                // stripe
  put(board, rbox(0.012, 0.6, 0.006, grn, 0.003), 0.01, 0.46, 0.019);
  put(board, rbox(0.17, 0.14, 0.004, grip, 0.002), 0.06, 0.66, 0.017);                 // grip pad beside the stripes
  for (const y of [0.18, 0.74]) { const pod = mesh(new THREE.CapsuleGeometry(0.045, 0.16, 3, 8).rotateZ(Math.PI / 2), dark); pod.scale.z = 0.55; pod.position.set(0, y, -0.03); board.add(pod); }
  bake(board);
  const pm = glowMat('#5ad8ff', 2.4); const pads = [0.18, 0.74].map(y => put(board, mesh(new THREE.PlaneGeometry(0.2, 0.06), pm), 0, y, -0.056)); for (const p of pads) { p.rotation.y = Math.PI; p.userData.live = true; }
  const hal = glow('#5ad8ff', 0.9, 0); hal.position.set(0, 0.46, -0.1); board.add(hal);
  board.rotation.x = 0.16; g.userData.live = true;
  return { g, board, halo: hal };
}

/** Bike-with-a-basket silhouette for the moon crossing (kid pedalling, little passenger in a blanket). */
export function bikeTex() {
  return TX.canvasTex('fb-bike', 256, 128, (x, w, h) => {
    x.clearRect(0, 0, w, h); x.fillStyle = x.strokeStyle = '#05050c'; x.lineWidth = 5; x.lineCap = 'round';
    const wheel = cx => { x.beginPath(); x.arc(cx, 100, 22, 0, 7); x.stroke(); };
    wheel(70); wheel(180);
    x.beginPath(); x.moveTo(70, 100); x.lineTo(115, 100); x.lineTo(155, 68); x.lineTo(100, 68); x.lineTo(115, 100); x.moveTo(100, 68); x.lineTo(70, 100); x.moveTo(155, 68); x.lineTo(180, 100); x.moveTo(155, 68); x.lineTo(160, 52); x.stroke();
    x.fillRect(92, 60, 20, 6); // seat
    x.beginPath(); x.moveTo(104, 60); x.lineTo(130, 20); x.lineTo(146, 24); x.lineTo(118, 64); x.fill(); // torso
    x.beginPath(); x.arc(138, 14, 11, 0, 7); x.fill(); // head
    x.beginPath(); x.moveTo(140, 28); x.lineTo(160, 50); x.stroke(); // arm
    x.beginPath(); x.moveTo(108, 62); x.lineTo(126, 82); x.lineTo(118, 100); x.stroke(); // leg
    x.fillRect(158, 46, 34, 22); // basket
    x.beginPath(); x.moveTo(166, 46); x.quadraticCurveTo(176, 22, 188, 46); x.fill(); // blanket bundle
    x.beginPath(); x.ellipse(178, 24, 9, 7, 0.3, 0, 7); x.fill(); // passenger head
  });
}
