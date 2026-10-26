// @ts-check
// Doc's Garage: in-world effects driven by the room tick: 88 MPH (fire trails, vanish, smoke), the amp shockwave
// ring and the escaped ghost. Triggers are plain flags (set by act/garage.js through R.gx), timed by the room clock.
import * as THREE from 'three';
import * as TX from './tex.js';
import { circuitTex } from './garage-props.js';

const add = (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
function flameTex() {
  return TX.canvasTex('gar-flame', 256, 32, x => {
    const g = x.createLinearGradient(0, 0, 0, 32); g.addColorStop(0, 'rgba(255,90,20,0)'); g.addColorStop(0.35, 'rgba(255,140,40,0.9)'); g.addColorStop(0.5, 'rgba(255,240,170,1)'); g.addColorStop(0.65, 'rgba(255,140,40,0.9)'); g.addColorStop(1, 'rgba(255,90,20,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 32); x.globalCompositeOperation = 'destination-out';
    let s = 7; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(0,0,0,${0.3 + r() * 0.5})`; x.fillRect(r() * 256, r() < 0.5 ? 0 : 20 + r() * 12, 4 + r() * 14, 3 + r() * 8); }
  }, { wrap: true });
}

/**
 * @param {THREE.Group} L room live group
 * @param {{ car: any, carPos: {x:number,z:number}, trap: any, trapPos: {x:number,z:number}, ampPos: {x:number,z:number} }} o
 */
export function makeFX(L, o) {
  const st = { carWant: false, ampWant: false, ghostWant: false, carT: -1, ampT: -1, ghostT: -1 };
  const { car, carPos, trap, trapPos, ampPos } = o, nose = carPos.x - 2.15, LEN = 8.5;
  // fire trails (two lines from the nose, along -x)
  const ft = flameTex(); ft.wrapS = THREE.RepeatWrapping; ft.repeat.set(3, 1);
  const tm = new THREE.MeshBasicMaterial({ map: ft, color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const trails = [-0.82, 0.82].map(dz => { const p = new THREE.Mesh(new THREE.PlaneGeometry(LEN, 0.34), tm); p.rotation.x = -Math.PI / 2; p.position.set(nose - LEN / 2, 0.03, carPos.z + dz); p.visible = false; L.add(p); return p; });
  // smoke puffs
  const sm = Array.from({ length: 9 }, (_, i) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.dotTex(), color: '#c8cfe0', transparent: true, opacity: 0, depthWrite: false })); s.visible = false; s.userData.a = i * 0.7; L.add(s); return s; });
  // shockwave rings (floor + upright)
  const rings = [0, 1].map(k => { const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), add('#bfe8ff', 0)); if (!k) m.rotation.x = -Math.PI / 2; else m.rotation.y = Math.PI / 2; m.visible = false; L.add(m); return m; });
  // ghost
  const ghost = new THREE.Group(); ghost.visible = false; L.add(ghost);
  const pts = [[0, -0.32], [0.2, -0.25], [0.26, 0], [0.24, 0.18], [0.16, 0.3], [0, 0.34]].map(([x, y]) => new THREE.Vector2(x, y));
  const gm = add('#8affc0', 0.75); ghost.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 16), gm));
  const face = new THREE.MeshBasicMaterial({ color: '#0a1a10' });
  for (const x of [-0.08, 0.08]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), face); e.position.set(x, 0.14, 0.22); ghost.add(e); }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6), face); mouth.scale.set(1.2, 0.8, 0.5); mouth.position.set(0, 0.0, 0.23); ghost.add(mouth);
  for (const x of [-0.27, 0.27]) { const a = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), gm); a.scale.set(1.6, 0.6, 0.6); a.position.set(x, 0.05, 0); ghost.add(a); }
  const beamM = add('#d8f8ff', 0); const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.2, 1, 12, 1, true), beamM); beam.visible = false; L.add(beam);
  const speeds = [0, 11, 22, 33, 44, 55, 66, 77, 88];
  const show = (txt, c) => { car.display.material.map = circuitTex(txt, c); };
  const ease = k => k * k * (3 - 2 * k);

  /** @param {number} t */
  const update = t => {
    if (st.carWant) { st.carWant = false; st.carT = t; show('NOV 05 1955', '#ff5a3a'); }
    if (st.ampWant) { st.ampWant = false; st.ampT = t; }
    if (st.ghostWant) { st.ghostWant = false; st.ghostT = t; }
    // --- time car
    const base = car.g.userData.base || (car.g.userData.base = car.g.position.clone());
    let glow = 0.55 + 0.1 * Math.sin(t * 2.3);
    if (st.carT >= 0) {
      const k = t - st.carT;
      if (k > 1.4 && k < 2.6) { const sp = speeds[Math.min(8, Math.floor((k - 1.4) / 1.1 * 9))]; show(`${sp} MPH`, '#ffb36b'); const j = (k - 1.4) * 0.03; car.g.position.set(base.x + (Math.random() - 0.5) * j, base.y, base.z + (Math.random() - 0.5) * j); glow = 0.6 + (k - 1.4); }
      car.g.visible = !(k >= 2.6 && k < 4.6);
      if (k >= 2.6) car.g.position.copy(base);
      const tk = k - 2.6, on = tk >= 0 && tk < 3.4; tm.opacity = on ? (tk < 0.1 ? tk * 10 : Math.max(0, 1 - (tk - 0.4) / 3)) * (0.92 + 0.08 * Math.sin(t * 4)) : 0; ft.offset.x = -t * 1.6;
      for (const p of trails) p.visible = on;
      const sk = k - 4.6;
      for (const s of sm) { const on2 = sk >= 0 && sk < 3; s.visible = on2; if (!on2) continue; const a = s.userData.a, u = sk / 3;
        s.position.set(carPos.x + Math.cos(a) * (0.6 + u * 1.4), 0.4 + u * 1.6 + (a % 1), carPos.z + Math.sin(a) * (0.5 + u)); s.scale.setScalar(0.8 + u * 2.2); s.material.opacity = 0.5 * (1 - u); }
      if (k > 4.6 && k < 5.2) glow = 1.6;
      if (k > 4.6) show('OCT 26 1985', '#ff5a3a');
      if (k > 8) { st.carT = -1; show('OCT 26 1985', '#ff5a3a'); }
    }
    car.under.material.opacity = glow; car.strip.material.color.setScalar(0.8 + glow);
    car.fm.color.setScalar(1 + 0.6 * (0.5 + 0.5 * Math.sin(t * (st.carT >= 0 ? 8 : 2.5))));
    // --- amp shockwave
    for (let i = 0; i < 2; i++) { const k = st.ampT >= 0 ? t - st.ampT - i * 0.12 : -1, r = rings[i], on = k >= 0 && k < 0.9; r.visible = on;
      if (on) { const s = 0.4 + ease(k / 0.9) * (i ? 2.4 : 4.2); r.scale.setScalar(s); r.position.set(ampPos.x + 0.6 + (i ? k * 3 : 0), i ? 1.0 : 0.04, ampPos.z); r.material.opacity = 0.9 * (1 - k / 0.9); } }
    if (st.ampT >= 0 && t - st.ampT > 1.5) st.ampT = -1;
    // --- ghost: escape, fly laps, get sucked back into the trap
    let lid = 0; ghost.visible = false; beam.visible = false;
    if (st.ghostT >= 0) {
      const k = t - st.ghostT; ghost.visible = k < 6.6;
      const home = new THREE.Vector3(trapPos.x, 0.2, trapPos.z);
      const fly = new THREE.Vector3(Math.sin(k * 0.9) * 4.5 - 0.5, 1.9 + Math.sin(k * 3.1) * 0.35, Math.sin(k * 1.7) * 2.2);
      if (k < 0.7) { lid = k / 0.7; ghost.position.lerpVectors(home, fly, ease(k / 0.7)); ghost.scale.setScalar(0.3 + k); }
      else if (k < 5.4) { lid = Math.max(0, 1 - (k - 0.7) * 2); ghost.position.copy(fly); ghost.scale.setScalar(1); }
      else if (k < 6.6) { const u = (k - 5.4) / 1.2; lid = 1; ghost.position.lerpVectors(fly, home, ease(u)); ghost.scale.set(1 - u * 0.9, 1 + u * 1.5, 1 - u * 0.9);
        beam.visible = true; const h = Math.max(0.1, ghost.position.y - 0.2); beam.scale.set(1, h, 1); beam.position.set(trapPos.x, 0.2 + h / 2, trapPos.z); beamM.opacity = 0.7 * (0.85 + 0.15 * Math.sin(t * 4)); }
      else if (k > 7) st.ghostT = -1;
      ghost.rotation.y = Math.sin(k * 2) * 0.8 + k; ghost.rotation.z = Math.sin(k * 5) * 0.2;
      mouth.scale.y = 0.6 + 0.5 * Math.abs(Math.sin(k * 9)); // laughing
    }
    for (const l of trap.lids) l.rotation.x = l.userData.s * lid * 1.7;
    trap.led.material.color.setScalar(st.ghostT >= 0 ? (1.4 + 1.0 * Math.sin(t * 4)) : 0.6 + 0.4 * Math.sin(t * 3));
  };
  return { st, update, ghost };
}
