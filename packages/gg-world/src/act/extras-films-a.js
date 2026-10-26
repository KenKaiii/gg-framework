// @ts-check
// World extras for Films A: Neo asleep at the bedroom desk (+ the knock), the red eye on the basement rack, the W.O.P.R.
// CRT on the workbench, a flux capacitor, a lightsaber hilt in the den and a spice jar in the kitchen.
// Activities talk to this module through R.filmsA = { knock(), fire(id) } on their room (no shared module state).
import { Avatar } from '../avatar.js';
import { mat, glowMat, rbox, put, mesh } from '../rooms/kit.js';
import { glow } from '../rooms/kit-fx.js';
import * as TX from '../rooms/tex.js';

const NEO = { body: 'rogue', head: 'knight', skin: '#d9ad88', hair: '#050506', top: '#121216', bottom: '#141418', acc: 'none', accColor: '#000', silly: ['coat', 'shades'] };

export default {
  id: 'films-a',
  /** @param {any} ctx */
  install({ A, rooms, THREE }) {
    const ticks = [];
    const sprite = (tex, w, h) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })); s.scale.set(w, h, 1); s.userData.live = true; return s; };
    const addGlow = (L, col, size, op, x, y, z) => { const g = glow(col, size, op); g.position.set(x, y, z); L.add(g); return g; };

    // ---------- bedroom: Neo asleep at the desk
    const B = rooms.bedroom;
    if (B) {
      B.slots = B.slots.filter(s => s.id !== 'desk');
      const av = new Avatar(A, NEO); av.root.position.set(-3.7, 0, 2.6); av.root.rotation.y = -Math.PI / 2; av.play('Sit_Chair_Idle');
      av.root.userData.live = true; B.live.add(av.root);
      const zz = sprite(TX.label('z  z', '#9fe8c0', null, 128, 64), 0.5, 0.25); B.live.add(zz);
      const doorX = -3 - B.root.position.x;
      const knock = sprite(TX.label('*knock knock*', '#ffb36b', 'rgba(20,16,30,0.85)', 256, 64), 1.3, 0.33); knock.position.set(doorX, 2.1, -3.6); knock.visible = false; B.live.add(knock);
      const st = { want: false, at: -99, twitch: 9, k: 1 };
      B.filmsA = { knock: () => { st.want = true; }, fire: () => {} };
      ticks.push((t, dt) => {
        if (st.want) { st.want = false; st.at = t; }
        const since = t - st.at, awake = since >= 0 && since < 11;
        st.k += ((awake && since > 0.15 ? 0 : 1) - st.k) * Math.min(1, dt * (awake ? 9 : 1.2));
        av.update(dt); const k = st.k, br = Math.sin(t * 1.4) * 0.03;
        if (t > st.twitch) st.twitch = t + 5 + ((t * 7.3) % 6);
        const tw = Math.max(0, 0.25 - (st.twitch - t - 5 + 0.25)) > 0 && st.twitch - t > 4.75 ? 0.18 : 0;
        av.rot('chest', (0.45 + br) * k - (awake && since < 0.4 ? 0.25 : 0), 0, 0);
        const look = awake ? Math.sin(Math.max(0, since - 0.6) * 1.3) * 0.9 * Math.min(1, since) : 0;
        av.rot('head', 0.75 * k + tw, look, 0.15 * k);
        av.rot('upperarm.l', -1.9 * k, 0, -0.2 * k); av.rot('upperarm.r', -1.9 * k, 0, 0.2 * k);
        av.rot('lowerarm.l', -1.2 * k, 0, 0.5 * k); av.rot('lowerarm.r', -1.2 * k, 0, -0.5 * k);
        const zp = (t * 0.4) % 1; zz.position.set(-4.1, 1.35 + zp * 0.6, 2.6 + zp * 0.15); zz.material.opacity = k * Math.sin(zp * Math.PI) * 0.9;
        knock.visible = since >= 0 && since < 2.6; if (knock.visible) { knock.position.y = 2.1 + Math.abs(Math.sin(since * 9)) * 0.08; knock.material.opacity = Math.min(1, (2.6 - since) * 2); }
      });
    }

    // ---------- basement: red eye, W.O.P.R. CRT, flux capacitor
    const Bm = rooms.basement;
    if (Bm) {
      const L = Bm.live;
      const ring = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 24), mat('#9aa0aa', { metalness: 0.8, roughness: 0.3 })); ring.rotation.x = Math.PI / 2; ring.position.set(-6.02, 1.55, -4.63); ring.userData.live = true; L.add(ring);
      const eyeM = new THREE.MeshBasicMaterial({ color: '#ff2a1a', toneMapped: false });
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24), eyeM); eye.position.set(-6.02, 1.55, -4.615); eye.userData.live = true; L.add(eye);
      const eg = addGlow(L, '#ff3020', 0.55, 0.5, -6.02, 1.55, -4.55);
      Bm.interact.push({ id: 'hal', x: -6.9, z: -4.0, r: 0.9, label: 'Talk to the red eye', kind: 'server' });

      const crtG = new THREE.Group(); put(crtG, rbox(0.42, 0.36, 0.38, mat('#a9a48f', { roughness: 0.7 }), 0.04), 0, 0.18, 0);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.24), new THREE.MeshBasicMaterial({ toneMapped: false, map: TX.canvasTex('films-a-wopr', 128, 96, x => {
        x.fillStyle = '#02060c'; x.fillRect(0, 0, 128, 96); x.fillStyle = '#7fd6ff'; x.font = '16px m5x7'; x.fillText('SHALL WE PLAY', 10, 36); x.fillText('A GAME?', 10, 54); x.fillRect(64, 60, 6, 10);
        x.fillStyle = 'rgba(0,0,0,.35)'; for (let y = 0; y < 96; y += 3) x.fillRect(0, y, 128, 1); }) }));
      scr.position.set(0, 0.19, 0.192); crtG.add(scr);
      put(L, crtG, -7.55, 0.92, -0.5, Math.PI / 2); crtG.traverse(o => { o.userData.live = true; });
      addGlow(L, '#7fd6ff', 0.6, 0.25, -7.3, 1.12, -0.5);
      Bm.interact.push({ id: 'wopr', x: -6.7, z: -0.55, r: 0.8, label: 'Shall we play a game?', kind: 'pc' });

      const flux = new THREE.Group(); put(flux, rbox(0.46, 0.58, 0.14, mat('#6a6e74', { metalness: 0.6, roughness: 0.45 }), 0.02), 0, 0, 0);
      const fyM = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, map: TX.canvasTex('films-a-flux', 64, 80, x => {
        x.fillStyle = '#101418'; x.fillRect(4, 4, 56, 72); x.strokeStyle = '#ffe9a0'; x.lineWidth = 5; x.shadowColor = '#ffb36b'; x.shadowBlur = 8; x.beginPath();
        x.moveTo(14, 16); x.lineTo(32, 40); x.lineTo(50, 16); x.moveTo(32, 40); x.lineTo(32, 70); x.stroke(); }) });
      const fy = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.5), fyM); fy.position.z = 0.075; flux.add(fy);
      put(L, flux, 3.6, 1.7, -5.42); flux.traverse(o => { o.userData.live = true; });
      const fg = addGlow(L, '#ffcf8a', 0.8, 0.35, 3.6, 1.7, -5.3);
      Bm.interact.push({ id: 'flux', x: 4.0, z: -4.7, r: 0.6, label: 'Inspect the flux capacitor', kind: 'gadget' });
      const fs = { want: false, at: -99 };
      Bm.filmsA = { knock: () => {}, fire: () => { fs.want = true; } };
      ticks.push(t => {
        if (fs.want) { fs.want = false; fs.at = t; } const s = t - fs.at, hot = s >= 0 && s < 1.6;
        const p = (t * 3) % 1; fyM.opacity = hot ? 0.6 + 0.4 * Math.abs(Math.sin(s * 40)) : 0.55 + 0.45 * (p < 0.33 ? 1 : p < 0.66 ? 0.6 : 0.35);
        fg.scale.setScalar(hot ? 0.8 + (1.6 - s) * 1.8 : 0.8); fg.material.opacity = hot ? Math.min(0.9, (1.6 - s)) : 0.3;
        eg.material.opacity = 0.4 + 0.12 * Math.sin(t * 1.6); eyeM.color.setRGB(1, 0.12 + 0.06 * Math.sin(t * 1.6), 0.08);
      });
    }

    // ---------- den: lightsaber hilt under the figure shelf
    const D = rooms.den;
    if (D) {
      const hilt = mesh(new THREE.CylinderGeometry(0.025, 0.028, 0.26, 12), mat('#b8bcc4', { metalness: 0.85, roughness: 0.3 })); hilt.rotation.z = Math.PI / 2; hilt.position.set(-0.95, 1.18, -5.88); hilt.userData.live = true; D.live.add(hilt);
      const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 10), glowMat('#8fe8ff', 4)); blade.rotation.z = Math.PI / 2; blade.position.set(-0.82, 1.18, -5.88); blade.visible = false; blade.userData.live = true; D.live.add(blade);
      const bg = addGlow(D.live, '#6fd8ff', 1.4, 0, -0.4, 1.18, -5.8);
      D.interact.push({ id: 'saber', x: -0.7, z: -5.1, r: 0.8, label: 'Pick up the hilt', kind: 'gadget' });
      const ss = { want: false, at: -99 };
      D.filmsA = { knock: () => {}, fire: () => { ss.want = true; } };
      ticks.push(t => {
        if (ss.want) { ss.want = false; ss.at = t; } const s = t - ss.at, on = s >= 0 && s < 3.3;
        const len = on ? Math.min(1, s / 0.15, (3.3 - s) / 0.2) * 0.85 : 0;
        blade.visible = len > 0.01; blade.scale.y = Math.max(0.01, len); blade.position.x = -0.82 + len / 2;
        bg.material.opacity = len * (0.45 + 0.08 * Math.sin(t * 40)); bg.position.x = -0.82 + len / 2;
      });
    }

    // ---------- kitchen: spice jar on the west counter
    const K = rooms.kitchen;
    if (K) {
      const jar = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 14), mat('#d8e8f0', { transparent: true, opacity: 0.35, roughness: 0.1 })); jar.position.set(-3.55, 0.98, -0.2); jar.userData.live = true; K.live.add(jar);
      const spM = glowMat('#ff9a3a', 1.6); const sp = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.13, 14), spM); sp.position.set(-3.55, 0.95, -0.2); sp.userData.live = true; K.live.add(sp);
      const kg = addGlow(K.live, '#ffb36b', 0.45, 0.3, -3.55, 1.0, -0.2);
      K.interact.push({ id: 'spice', x: -2.95, z: -0.2, r: 0.7, label: 'Sniff the spice', kind: 'gadget' });
      const ks = { want: false, at: -99 };
      K.filmsA = { knock: () => {}, fire: () => { ks.want = true; } };
      ticks.push(t => { if (ks.want) { ks.want = false; ks.at = t; } const s = t - ks.at, hot = s >= 0 && s < 2.5;
        kg.material.opacity = hot ? 0.3 + (2.5 - s) * 0.25 : 0.22 + 0.06 * Math.sin(t * 2); kg.scale.setScalar(hot ? 0.45 + (2.5 - s) * 0.5 : 0.45); });
    }

    return (t, dt) => { for (const f of ticks) f(t, dt); };
  },
};
