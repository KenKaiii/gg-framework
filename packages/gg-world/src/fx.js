// @ts-check
// Confetti bursts + window fireworks (single InstancedMesh pool) and coffee steam puffs.
import * as THREE from 'three';

export function makeFX(scene, steamSpots) {
  const N = 260, conf = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.08, 0.05), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), N);
  conf.instanceMatrix.setUsage(THREE.DynamicDrawUsage); conf.frustumCulled = false; scene.add(conf);
  const P = Array.from({ length: N }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), g: 1 }));
  const cols = ['#ff8fab', '#ffd166', '#7bdff2', '#80ed99', '#cdb4db', '#ff9f1c'].map(c => new THREE.Color(c));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), zero = new THREE.Vector3(0, 0, 0);
  let next = 0;
  const spawn = (at, n, speed, grav, up) => { for (let i = 0; i < n; i++) { const p = P[next]; next = (next + 1) % N; p.life = 1.6 + Math.random() * 1.2; p.p.copy(at); const a = Math.random() * 6.28, e = Math.random(); p.v.set(Math.cos(a) * speed * e, up + Math.random() * up * 0.5, Math.sin(a) * speed * e); p.g = grav; p.r.set(Math.random() * 6, Math.random() * 6, 0); conf.setColorAt(next, cols[i % cols.length]); } conf.instanceColor && (conf.instanceColor.needsUpdate = true); };
  // steam: soft sprites
  const sm = new THREE.SpriteMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false });
  const puffs = []; for (const at of steamSpots) for (let i = 0; i < 4; i++) { const sp = new THREE.Sprite(sm.clone()); sp.userData = { at, o: i / 4 }; scene.add(sp); puffs.push(sp); }
  return {
    confetti(at) { spawn(at.clone().setY(1.6), 70, 2.2, 5, 3.5); },
    firework(at) { spawn(at, 50, 3.2, 1.5, 0.8); },
    update(dt, t) {
      for (let i = 0; i < N; i++) { const p = P[i]; if (p.life > 0) { p.life -= dt; p.v.y -= p.g * dt; p.v.multiplyScalar(1 - dt * 1.2); p.p.addScaledVector(p.v, dt); if (p.p.y < 0.02) { p.p.y = 0.02; p.v.set(0, 0, 0); } p.r.x += dt * 6; p.r.y += dt * 4; q.setFromEuler(p.r); m4.compose(p.p, q, s); } else m4.compose(zero, q, zero.clone()); conf.setMatrixAt(i, m4); }
      conf.instanceMatrix.needsUpdate = true;
      for (const sp of puffs) { const k = (t * 0.5 + sp.userData.o) % 1; sp.position.set(sp.userData.at.x + Math.sin(t + k * 6) * 0.05, sp.userData.at.y + k * 0.7, sp.userData.at.z); sp.scale.setScalar(0.08 + k * 0.22); sp.material.opacity = 0.45 * (1 - k); }
    },
  };
}
