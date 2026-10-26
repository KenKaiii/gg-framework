// @ts-check
// Paper Street props: stained concrete, peeling-wallpaper partitions, the taped fight ring, soap shelves, workbench,
// the old sofa, crates, punching bag, a TV on a crate, the rules board and the catalogue-perfect corner. Floor y=0.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const cyl = (rt, rb, h, m, seg = 14) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
export const WOOD = mat('#7a5a3a', { roughness: 0.85 }), DWOOD = mat('#4a3424', { roughness: 0.8 }), METAL = mat('#6a6e72', { metalness: 0.6, roughness: 0.45 });
export const SOAP = mat('#f2a6c0', { roughness: 0.6, emissive: '#5a2034', emissiveIntensity: 0.35 });
const SOFA = mat('#7a4a2e', { roughness: 0.95 }), CREAM = mat('#e8e0cc', { roughness: 0.7 }), BLK = mat('#1a1716', { roughness: 0.5 });

/** Stained light concrete with cracks and oil rings (readable, not dark). */
export function concrete() {
  return TX.canvasTex('fc-concrete', 256, 256, (x, w, h) => {
    x.fillStyle = '#9a948a'; x.fillRect(0, 0, w, h);
    const g = TX.rand(31);
    for (let i = 0; i < 3000; i++) { const v = g(); x.fillStyle = `rgba(${v > 0.5 ? '255,250,240' : '30,24,20'},${0.06 * g()})`; x.fillRect(g() * w, g() * h, 2, 2); }
    for (let i = 0; i < 7; i++) { const r = 14 + g() * 30; const gr = x.createRadialGradient(0, 0, 1, 0, 0, r); gr.addColorStop(0, 'rgba(60,44,30,0.22)'); gr.addColorStop(1, 'rgba(60,44,30,0)'); x.save(); x.translate(g() * w, g() * h); x.fillStyle = gr; x.fillRect(-r, -r, 2 * r, 2 * r); x.restore(); }
    x.strokeStyle = 'rgba(40,32,26,0.35)'; x.lineWidth = 1;
    for (let i = 0; i < 4; i++) { x.beginPath(); let px = g() * w, py = g() * h; x.moveTo(px, py); for (let k = 0; k < 6; k++) { px += (g() - 0.5) * 40; py += (g() - 0.5) * 40; x.lineTo(px, py); } x.stroke(); }
    x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(0, 0, w, 2); x.fillRect(0, 0, 2, h);
  }, { repeat: true });
}

/** Peeling floral wallpaper: faded mustard stripes with torn patches showing plaster. */
export function wallpaper() {
  return TX.canvasTex('fc-paper', 256, 256, (x, w, h) => {
    x.fillStyle = '#8a7650'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#7a6644' : '#94805a'; x.fillRect(i * 32, 0, 16, h); }
    const g = TX.rand(12);
    for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(120,60,50,0.5)'; x.beginPath(); x.arc((i % 8) * 32 + 8, Math.floor(i / 8) * 52 + 20, 4, 0, 7); x.fill(); }
    for (let i = 0; i < 5; i++) { x.fillStyle = '#b8ae98'; x.beginPath(); const cx = g() * w, cy = g() * h; x.moveTo(cx, cy); for (let k = 0; k < 7; k++) x.lineTo(cx + (g() - 0.3) * 50, cy + (g() - 0.3) * 50); x.fill(); }
    for (let i = 0; i < 6; i++) { const gx = g() * w; const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(50,36,20,0)'); gr.addColorStop(1, 'rgba(50,36,20,0.35)'); x.fillStyle = gr; x.fillRect(gx, h * g() * 0.5, 6 + g() * 10, h); }
  }, { repeat: true });
}

/** Free-standing wallpapered partition (stands in front of a wall the neighbours draw). */
export function partition(len, h = 2.7) {
  const t = wallpaper().clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(len / 2.2, h / 2.2); t.needsUpdate = true;
  const g = new THREE.Group();
  put(g, rbox(len, h, 0.12, mat('#ffffff', { map: t, roughness: 0.9 }), 0.01), 0, h / 2, 0);
  // base + cap overhang the wall ends by 1 cm so their end faces aren't coplanar with the wall's (z-fighting while walking)
  put(g, rbox(len + 0.02, 0.18, 0.16, DWOOD, 0.01), 0, 0.09, 0.01);
  put(g, rbox(len + 0.02, 0.06, 0.16, DWOOD, 0.01), 0, h, 0);
  return g;
}

/** Ring tape: a square of worn white tape on the floor with corner marks (transparent plane). */
export function ringTape(s) {
  const tex = TX.canvasTex('fc-ring', 256, 256, (x, w, h) => {
    x.clearRect(0, 0, w, h); x.strokeStyle = 'rgba(240,236,220,0.9)'; x.lineWidth = 7; x.setLineDash([46, 6]); x.strokeRect(8, 8, w - 16, h - 16);
    x.setLineDash([]); x.strokeStyle = 'rgba(200,40,40,0.75)'; x.lineWidth = 5; x.beginPath(); x.arc(w / 2, h / 2, 34, 0, 7); x.stroke();
    x.fillStyle = 'rgba(240,236,220,0.8)'; x.fillRect(w / 2 - 30, h / 2 - 3, 60, 6);
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.8 }));
  m.rotation.x = -Math.PI / 2; return m;
}

/** Bare bulb on a cord with a tin shade. Bulb is emissive. */
export function bulb(cord = 1.0) {
  const g = new THREE.Group();
  put(g, cyl(0.008, 0.008, cord, BLK, 5), 0, -cord / 2, 0);
  put(g, cyl(0.06, 0.26, 0.16, METAL, 16), 0, -cord - 0.05, 0);
  put(g, mesh(new THREE.SphereGeometry(0.07, 12, 10), glowMat('#ffe2a8', 2.4)), 0, -cord - 0.15, 0);
  return g;
}

/** Wooden shelf unit stacked with pink soap (bars instanced by the room). */
export function shelf(w = 2.4, h = 2.2) {
  const g = new THREE.Group();
  for (const sx of [-w / 2 + 0.04, w / 2 - 0.04]) put(g, rbox(0.06, h, 0.5, DWOOD, 0.01), sx, h / 2, 0);
  for (let i = 0; i < 4; i++) put(g, rbox(w, 0.05, 0.5, WOOD, 0.01), 0, 0.12 + i * (h - 0.2) / 3, 0);
  return g;
}

/** Workbench with vise, pots for rendering fat and a hanging pegboard. */
export function workbench() {
  const g = new THREE.Group();
  put(g, rbox(2.6, 0.1, 0.8, WOOD, 0.02), 0, 0.92, 0);
  for (const x of [-1.2, 1.2]) for (const z of [-0.32, 0.32]) put(g, rbox(0.08, 0.9, 0.08, DWOOD, 0.01), x, 0.45, z);
  put(g, rbox(2.5, 0.05, 0.7, DWOOD, 0.01), 0, 0.25, 0);
  put(g, rbox(2.6, 1.0, 0.04, mat('#a08a64', { roughness: 0.9 }), 0.01), 0, 1.75, -0.38);
  for (let i = 0; i < 6; i++) put(g, rbox(0.04, 0.3, 0.04, METAL, 0.01), -1.0 + i * 0.4, 1.8, -0.33);
  const pot = cyl(0.2, 0.17, 0.3, METAL, 18); put(g, pot, -0.7, 1.12, 0.05);
  put(g, cyl(0.17, 0.17, 0.02, mat('#e8d8a0', { roughness: 0.3, emissive: '#4a3a10', emissiveIntensity: 0.4 }), 18), -0.7, 1.26, 0.05);
  put(g, cyl(0.13, 0.13, 0.22, METAL, 14), -0.2, 1.08, 0.12);
  put(g, rbox(0.5, 0.06, 0.3, WOOD, 0.01), 0.5, 1.0, 0.05);
  put(g, rbox(0.12, 0.18, 0.18, METAL, 0.02), 1.05, 1.06, 0.2);
  return g;
}

/** Saggy old sofa, cracked leatherette. */
export function sofa(w = 2.4) {
  const g = new THREE.Group();
  put(g, rbox(w, 0.42, 0.9, SOFA, 0.1), 0, 0.25, 0);
  put(g, rbox(w, 0.7, 0.22, SOFA, 0.1), 0, 0.6, -0.36);
  for (const s of [-1, 1]) put(g, rbox(0.22, 0.6, 0.9, SOFA, 0.09), s * (w / 2 - 0.11), 0.35, 0);
  for (let i = 0; i < 3; i++) put(g, rbox(w / 3 - 0.1, 0.12, 0.66, mat('#8a5a3a', { roughness: 0.95 }), 0.05), -w / 3 + i * w / 3, 0.5, 0.08);
  put(g, rbox(0.4, 0.06, 0.3, mat('#d8c8a0', { roughness: 1 }), 0.02), w / 3, 0.58, 0.15);
  return g;
}

/** Wooden crate seat. */
export function crate(s = 0.5) {
  const g = new THREE.Group();
  put(g, rbox(s, s * 0.9, s, WOOD, 0.02), 0, s * 0.45, 0);
  for (const y of [0.15, 0.75]) put(g, rbox(s + 0.02, 0.06, s + 0.02, DWOOD, 0.01), 0, s * y, 0);
  return g;
}

/** Punching bag (hang point at origin top, y down). */
export function bag() {
  const g = new THREE.Group();
  put(g, cyl(0.01, 0.01, 0.5, METAL, 5), 0, -0.25, 0);
  put(g, cyl(0.22, 0.22, 1.0, mat('#8a2a22', { roughness: 0.6 }), 16), 0, -1.0, 0);
  put(g, cyl(0.225, 0.225, 0.06, mat('#d8d0c0'), 16), 0, -0.7, 0);
  put(g, cyl(0.225, 0.225, 0.06, mat('#d8d0c0'), 16), 0, -1.3, 0);
  return g;
}

/** Old CRT TV (returns group + screen mesh for live updates). */
export function tv() {
  const g = new THREE.Group();
  put(g, rbox(0.8, 0.62, 0.6, mat('#5a4a3a', { roughness: 0.7 }), 0.06), 0, 0.31, 0);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), new THREE.MeshBasicMaterial({ color: '#9ab8c8', toneMapped: false }));
  put(g, scr, -0.06, 0.33, 0.305);
  put(g, rbox(0.1, 0.4, 0.03, BLK, 0.01), 0.3, 0.33, 0.3);
  for (const s of [-1, 1]) { const a = cyl(0.006, 0.006, 0.5, METAL, 4); a.rotation.z = s * 0.5; put(g, a, s * 0.12, 0.82, -0.05); }
  return { g, scr };
}

/** Rules board on an easel: a framed slate (chalk-dust smudges, chalk lettering, first two rules bleeped), bevelled
 * wood frame, a chalk tray with sticks and a rear prop leg. Matches the 2D close-up (fightclub-rules.js). Frame + legs
 * are merged into one mesh (one draw call); slate and chalk are two more. */
export function rulesBoard() {
  const tex = TX.canvasTex('fc-rules2', 512, 384, (x, w, h) => {
    const sg = x.createRadialGradient(w * 0.45, h * 0.4, 20, w / 2, h / 2, w * 0.7); sg.addColorStop(0, '#3a4a3e'); sg.addColorStop(1, '#1e2a22'); x.fillStyle = sg; x.fillRect(0, 0, w, h);
    const g = TX.rand(17);
    for (let i = 0; i < 14; i++) { x.fillStyle = 'rgba(230,240,230,0.05)'; x.beginPath(); x.ellipse(g() * w, g() * h, 40 + g() * 50, 10 + g() * 12, g() * 3, 0, 7); x.fill(); } // erased smudges
    for (let i = 0; i < 2500; i++) { x.fillStyle = `rgba(${g() > 0.5 ? '255,255,255' : '0,0,0'},${0.05 * g()})`; x.fillRect(g() * w, g() * h, 2, 2); }
    const chalk = (s, X, Y, size, col) => { x.font = size + 'px m5x7'; x.fillStyle = 'rgba(10,16,12,0.7)'; x.fillText(s, X + 2, Y + 2); x.fillStyle = col; x.fillText(s, X, Y); x.globalAlpha = 0.25; x.fillText(s, X + 1, Y - 1); x.globalAlpha = 1; };
    chalk('THE RULES', 150, 58, 60, '#f0ece0'); x.fillStyle = 'rgba(240,236,224,0.6)'; x.fillRect(150, 66, 212, 3);
    const L = ['1. You do not ', '2. You DO NOT ', '3. Someone yells stop', '4. Two guys to a fight', '5. One fight at a time', '6. No shirts, no shoes', '7. As long as it takes', '8. First night? Fight.'];
    L.forEach((t, i) => { const y = 106 + i * 36; chalk(t, 28, y, 40, i < 2 ? '#ff9aa8' : '#e8ece0'); if (i < 2) { x.fillStyle = '#ff9aa8'; x.fillRect(250, y - 26, 110, 30); x.fillRect(380, y - 26, 70, 30); } });
  });
  const g = new THREE.Group(), lean = -0.1;
  // frame + easel legs, merged
  const parts = [], add = (geo, px, py, pz, rx = 0) => { geo = geo.index ? geo.toNonIndexed() : geo; const m = new THREE.Matrix4().makeRotationX(rx).setPosition(px, py, pz); geo.applyMatrix4(m); parts.push(geo); };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  for (const sx of [-1, 1]) add(box(0.06, 1.95, 0.06), sx * 0.62, 0.97, 0, lean);          // front legs
  add(box(0.05, 1.8, 0.05), 0, 0.9, -0.42, 0.28);                                            // rear prop leg
  add(box(1.5, 0.08, 0.07), 0, 1.92, 0.05); add(box(1.5, 0.08, 0.07), 0, 0.84, 0.05);        // top / bottom rails
  for (const sx of [-1, 1]) add(box(0.08, 1.16, 0.07), sx * 0.71, 1.38, 0.05);               // stiles
  add(box(1.5, 0.03, 0.16), 0, 0.79, 0.11);                                                    // chalk tray
  add(box(1.5, 0.04, 0.02), 0, 0.81, 0.19);                                                    // tray lip
  const frame = new THREE.Mesh(mergeGeometries(parts), mat('#6a4630', { roughness: 0.75 })); frame.castShadow = true; g.add(frame);
  // inner bevel strip (lighter wood) as a thin merged ring
  const bev = []; const ring = (geo, px, py) => { geo = geo.toNonIndexed(); geo.translate(px, py, 0.09); bev.push(geo); };
  ring(box(1.36, 0.02, 0.01), 0, 1.875); ring(box(1.36, 0.02, 0.01), 0, 0.885); ring(box(0.02, 1.0, 0.01), -0.67, 1.38); ring(box(0.02, 1.0, 0.01), 0.67, 1.38);
  g.add(new THREE.Mesh(mergeGeometries(bev), mat('#a8744c', { roughness: 0.6 })));
  const slate = new THREE.Mesh(new THREE.PlaneGeometry(1.34, 0.99), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.3 }));
  put(g, slate, 0, 1.38, 0.086);
  // chalk sticks + a felt eraser on the tray (one merged mesh, vertex colours)
  const ch = []; const stick = (px, rz, col) => { const geo = new THREE.CylinderGeometry(0.012, 0.012, 0.09, 6).toNonIndexed(); geo.rotateZ(Math.PI / 2 + rz); geo.translate(px, 0.82, 0.12); const c = new THREE.Color(col), n = geo.attributes.position.count; geo.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]), 3)); ch.push(geo); };
  stick(-0.35, 0.1, '#f0ece0'); stick(-0.22, -0.2, '#f2a6c0'); stick(0.1, 0.05, '#f0ece0');
  const er = new THREE.BoxGeometry(0.16, 0.04, 0.06).toNonIndexed(); er.translate(0.4, 0.83, 0.12); const n = er.attributes.position.count, top = new THREE.Color('#8a7a5a'), fel = new THREE.Color('#3a3a40');
  er.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, (_, i) => { const c = er.attributes.position.getY(i) > 0.83 ? top : fel; return [c.r, c.g, c.b]; }).flat(), 3)); ch.push(er);
  g.add(new THREE.Mesh(mergeGeometries(ch), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })));
  return g;
}

/** The catalogue corner: pale rug, crisp sofa-chair, glass coffee table, yin-yang table, paper lamp. */
export function catalogue() {
  const g = new THREE.Group();
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6), mat('#d8cfb8', { roughness: 1 })); rug.rotation.x = -Math.PI / 2; put(g, rug, 0, 0.01, 0);
  const tag = mat('#f0eadb', { roughness: 0.6 }), birch = mat('#d8b884', { roughness: 0.5 });
  const ch = new THREE.Group(); put(ch, rbox(0.9, 0.3, 0.8, mat('#6a8a9a', { roughness: 0.8 }), 0.08), 0, 0.35, 0); put(ch, rbox(0.9, 0.6, 0.16, mat('#6a8a9a', { roughness: 0.8 }), 0.07), 0, 0.7, -0.33);
  for (const x of [-0.42, 0.42]) put(ch, rbox(0.06, 0.35, 0.8, birch, 0.02), x, 0.3, 0); put(g, ch, -0.7, 0, -0.5, 0.3);
  put(g, rbox(1.0, 0.04, 0.6, mat('#bcd8e0', { transparent: true, opacity: 0.55, roughness: 0.1 }), 0.01), 0.5, 0.42, 0.3);
  for (const x of [0.05, 0.95]) for (const z of [0.05, 0.55]) put(g, rbox(0.03, 0.4, 0.03, birch, 0.01), x, 0.2, z);
  const yy = cyl(0.3, 0.3, 0.04, tag, 24); put(g, yy, 1.1, 0.55, -0.7); put(g, cyl(0.04, 0.04, 0.5, BLK, 8), 1.1, 0.27, -0.7);
  put(g, cyl(0.15, 0.15, 0.045, BLK, 16), 1.02, 0.555, -0.7);
  put(g, cyl(0.015, 0.015, 1.5, BLK, 6), -1.3, 0.75, 0.9);
  put(g, mesh(new THREE.SphereGeometry(0.24, 14, 10), glowMat('#fff0d0', 1.4)), -1.3, 1.6, 0.9);
  // price tags
  for (const [x, y, z] of [[-0.7, 0.9, -0.2], [0.9, 0.46, 0.3], [-1.3, 1.25, 1.0]]) put(g, rbox(0.12, 0.08, 0.01, mat('#ffe14a', { emissive: '#806a10', emissiveIntensity: 0.5 }), 0.005), x, y, z);
  return g;
}

/** Space-monkey helmet (little round dome). */
export function helmet() {
  const g = new THREE.Group();
  put(g, mesh(new THREE.SphereGeometry(0.16, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), mat('#e8e8e0', { roughness: 0.4 })), 0, 0.05, 0);
  put(g, mesh(new THREE.SphereGeometry(0.12, 12, 8, -0.8, 1.6, 0.9, 0.6), mat('#3a5a7a', { metalness: 0.6, roughness: 0.2 })), 0, 0.05, 0.05);
  return g;
}
