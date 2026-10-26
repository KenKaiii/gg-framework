// @ts-check
// Click marker: shows where you clicked to go. Floor click = a pale ring that drops in and pulses at the destination;
// clicking something to use = a gold ring round that thing. It stays while you walk there and fades once you arrive
// (or when you take over with WASD). One small mesh, drawn on top of the floor, no lights.
import * as THREE from 'three';

export function makeMarker(S) {
  const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.strokeStyle = '#fff'; g.lineWidth = 9; g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.stroke(); // ring
    g.globalAlpha = 0.35; g.lineWidth = 4; g.beginPath(); g.arc(64, 64, 38, 0, Math.PI * 2); g.stroke();      // inner ring
    g.globalAlpha = 1; g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 7, 0, Math.PI * 2); g.fill();         // centre dot
    // four small ticks pointing in
    for (let k = 0; k < 4; k++) { g.save(); g.translate(64, 64); g.rotate(k * Math.PI / 2); g.fillRect(-3, -62, 6, 12); g.restore(); }
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; })();
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: new THREE.Color('#bfe0ff'), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, toneMapped: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat); m.renderOrder = 9; m.visible = false; S.scene.add(m);
  const COL = { move: new THREE.Color('#bfe0ff'), use: new THREE.Color('#ffc86a') };
  let t = 0, life = 0, size = 0.9, target = /** @type {any} */ (null);
  return {
    /** show at world (x, z). kind 'move' | 'use'; r = radius of the thing being used */
    show(x, z, kind = 'move', r = 0.45, follow = null) { m.position.set(x, 0.035, z); mat.color.copy(COL[kind] || COL.move); size = kind === 'use' ? Math.max(0.9, r * 2.2) : 0.9; t = 0; life = 1; target = follow; m.visible = true; },
    hide() { life = Math.min(life, 0.3); },
    update(dt) {
      if (!m.visible) return; t += dt;
      // still on the way? (path, pending use, or a floor click not yet reached). Arrived or WASD -> fade.
      const going = !!S.me.path || !!S.pending; if (!going && t > 0.25) life -= dt * 2.2; if (target && target.root) target.root.getWorldPosition(m.position).setY(0.035);
      const drop = Math.min(1, t / 0.18), pulse = 1 + Math.sin(t * 6) * 0.06;
      m.scale.setScalar(size * (1.6 - 0.6 * (1 - (1 - drop) ** 3)) * pulse); m.rotation.y = t * 0.6;
      mat.opacity = Math.max(0, Math.min(1, life)) * (0.55 + 0.45 * drop) * 0.9;
      if (life <= 0) m.visible = false;
    },
  };
}
