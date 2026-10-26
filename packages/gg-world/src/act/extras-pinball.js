// @ts-check
// World extras (pinball builder): a 'GIT PUSH --FORCE' pinball cabinet against the den's east wall + its hotspot.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mat, glowMat, rbox, put, mesh } from '../rooms/kit.js';
import * as FX from '../rooms/kit-fx.js';
import * as TX from '../rooms/tex.js';

/** Printed playfield (seen through the glass). */
function fieldTex() {
  return TX.canvasTex('pinball-field', 128, 256, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2a2440'); g.addColorStop(1, '#1e2240'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(110,231,160,0.18)'; for (let i = 0; i < w; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); } for (let i = 0; i < h; i += 8) { x.beginPath(); x.moveTo(0, i); x.lineTo(w, i); x.stroke(); }
    x.strokeStyle = '#c9ccd8'; x.lineWidth = 3; x.beginPath(); x.arc(64, 64, 58, Math.PI, 0); x.lineTo(122, 250); x.moveTo(6, 64); x.lineTo(6, 200); x.lineTo(40, 230); x.stroke();
    for (const [cx, cy, c] of [[44, 80, '#ff4fd8'], [84, 80, '#3ddc84'], [64, 110, '#ffb36b']]) { x.fillStyle = c; x.beginPath(); x.arc(cx, cy, 11, 0, 7); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.arc(cx, cy, 4, 0, 7); x.fill(); }
    x.fillStyle = '#ffb36b'; x.font = '18px m5x7'; x.textAlign = 'center'; x.fillText('D E P L O Y', 60, 36);
    x.fillStyle = '#ff4fd8'; x.font = '14px m5x7'; x.fillText('MERGE CONFLICT', 62, 142);
    for (let i = 0; i < 4; i++) { x.fillStyle = ['#3ddc84', '#ffb36b', '#ff4fd8', '#6ee7a0'][i]; x.beginPath(); x.moveTo(62, 160 + i * 14); x.lineTo(54, 170 + i * 14); x.lineTo(70, 170 + i * 14); x.fill(); }
    x.fillStyle = '#e0a458'; x.fillRect(30, 222, 22, 5); x.fillRect(72, 222, 22, 5);
    x.fillStyle = '#ff5050'; x.font = '21px m5x7'; x.fillText('PROD', 62, 250);
  });
}
function titleTex() {
  return TX.canvasTex('pinball-title', 256, 160, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2a1440'); g.addColorStop(1, '#120a20'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#ff4fd8'; x.lineWidth = 4; x.strokeRect(6, 6, w - 12, h - 12);
    x.textAlign = 'center'; x.shadowColor = '#ff4fd8'; x.shadowBlur = 14; x.fillStyle = '#ffd0f4'; x.font = 'italic 51px m5x7'; x.fillText('GIT PUSH', w / 2, 62);
    x.shadowColor = '#ffb36b'; x.fillStyle = '#ffe2b0'; x.font = 'italic 57px m5x7'; x.fillText('--FORCE', w / 2, 106);
    x.shadowBlur = 0; x.fillStyle = '#6ee7a0'; x.font = '21px m5x7'; x.fillText('1 PLAYER  ·  NO REVIEWS', w / 2, 138);
  });
}

export default {
  id: 'pinball',
  /** @param {any} ctx */
  install({ rooms, THREE }) {
    const R = rooms.den; if (!R) return;
    const X = 4.9, Z = 4.95; // room-local; v4: SE corner, backbox against the south wall (east wall has the screening-room opening)
    const g = new THREE.Group(); g.position.set(X, 0, Z); g.rotation.y = Math.PI; R.live.add(g);
    // local frame: player at +z, backbox at -z. Body 0.72 wide, 1.3 long.
    const wood = mat('#2a1a22', { roughness: 0.6 }), chrome = mat('#c9ccd8', { metalness: 0.9, roughness: 0.25 }), dark = mat('#14101a', { roughness: 0.7 });
    const legs = [];
    for (const [lx, lz] of [[-0.31, 0.58], [0.31, 0.58], [-0.31, -0.55], [0.31, -0.55]]) { const c = new THREE.CylinderGeometry(0.035, 0.03, 0.62, 8); c.translate(lx, 0.31, lz); legs.push(c); const f = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8); f.translate(lx, 0.015, lz); legs.push(f); }
    put(g, mesh(mergeGeometries(legs), chrome), 0, 0, 0);
    const tilt = -0.07;
    const body = new THREE.Group(); body.position.set(0, 0.78, 0); body.rotation.x = tilt; g.add(body);
    put(body, rbox(0.74, 0.28, 1.32, wood, 0.03), 0, 0, 0);
    // side neon trim strips (one merged mesh)
    const trim = [new THREE.BoxGeometry(0.012, 0.03, 1.3).translate(-0.375, 0.04, 0), new THREE.BoxGeometry(0.012, 0.03, 1.3).translate(0.375, 0.04, 0)];
    put(body, mesh(mergeGeometries(trim), glowMat('#ff4fd8', 2.2)), 0, 0, 0);
    // chrome lockdown rails
    const rails = [new THREE.BoxGeometry(0.03, 0.03, 1.32).translate(-0.355, 0.15, 0), new THREE.BoxGeometry(0.03, 0.03, 1.32).translate(0.355, 0.15, 0), new THREE.BoxGeometry(0.74, 0.03, 0.06).translate(0, 0.15, 0.64)];
    put(body, mesh(mergeGeometries(rails), chrome), 0, 0, 0);
    const field = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 1.2), new THREE.MeshBasicMaterial({ map: fieldTex(), color: new THREE.Color(1.5, 1.5, 1.5), toneMapped: false }));
    field.rotation.x = -Math.PI / 2; put(body, field, 0, 0.142, -0.02); field.rotation.x = -Math.PI / 2;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 1.24), new THREE.MeshStandardMaterial({ color: '#8fa8ff', transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0.4, depthWrite: false }));
    glass.rotation.x = -Math.PI / 2; put(body, glass, 0, 0.16, -0.02); glass.rotation.x = -Math.PI / 2;
    // backbox
    const bb = put(g, rbox(0.74, 0.7, 0.2, wood, 0.03), 0, 1.3, -0.6); void bb;
    const bglass = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.42), new THREE.MeshBasicMaterial({ map: titleTex(), color: new THREE.Color(1.8, 1.8, 1.8), toneMapped: false }));
    put(g, bglass, 0, 1.36, -0.495);
    const dmd = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.09), new THREE.MeshBasicMaterial({ color: '#ff8a30', toneMapped: false })); put(g, dmd, 0, 1.06, -0.495);
    // coin door + plunger + flipper buttons
    put(g, rbox(0.3, 0.26, 0.02, chrome, 0.01), 0, 0.5, 0.665);
    const slots = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.05), glowMat('#ff5050', 2)); put(g, slots, 0, 0.56, 0.677);
    const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.16, 8), chrome); pl.rotation.x = Math.PI / 2; put(g, pl, 0.27, 0.74, 0.72); pl.rotation.x = Math.PI / 2;
    const btn = [new THREE.CylinderGeometry(0.025, 0.025, 0.03, 10).rotateZ(Math.PI / 2).translate(-0.38, 0.8, 0.5), new THREE.CylinderGeometry(0.025, 0.025, 0.03, 10).rotateZ(Math.PI / 2).translate(0.38, 0.8, 0.5), new THREE.SphereGeometry(0.03, 10, 8).translate(0.27, 0.74, 0.81)];
    put(g, mesh(mergeGeometries(btn), glowMat('#ffb36b', 2)), 0, 0, 0);
    const gl1 = FX.glow('#ff4fd8', 1.6, 0.35); put(g, gl1, 0, 1.35, -0.4);
    const gl2 = FX.glow('#6ee7a0', 1.4, 0.22); put(g, gl2, 0, 0.95, 0);
    // floor + hotspot
    R.block(X - 0.42, Z - 0.7, X + 0.42, Z + 0.95);
    R.slots = R.slots.filter(s => Math.abs(s.x - X) > 0.7 || Math.abs(s.z - Z) > 1.0);
    R.interact.push({ id: 'pinball', x: X, z: Z - 1.05, r: 1.1, label: 'Play pinball', kind: 'pinball' });
    const fm = /** @type {any} */ (field.material), bm = /** @type {any} */ (bglass.material);
    return (t) => {
      const f = FX.flicker(t, 4, 0.1); bm.color.setScalar(1.6 + 0.4 * Math.sin(t * 3) * f); gl1.material.opacity = 0.28 + 0.1 * Math.sin(t * 3);
      fm.color.setScalar(1.3 + 0.3 * (Math.sin(t * 7) > 0.6 ? 1 : 0)); dmd.material.color.setRGB(2 * f, 0.9 * f, 0.2);
    };
  },
};
