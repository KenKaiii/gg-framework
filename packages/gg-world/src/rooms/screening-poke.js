// @ts-check
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// One-shot prop reactions shared by the screening/diner/library/... rooms: a poked prop wiggles, hops, spins, tips,
// squashes or swings, then settles back exactly where it was. Only active pokes are ticked (no per-frame allocation);
// the matrix is auto-updated only while moving, so frozen static props work too.

/** @typedef {'puff'|'pull'|'wheel'|'roll'|'wiggle'|'hop'|'spin'|'tip'|'squash'|'swing'|'nod'|'lift'} PokeKind */

/** @returns {{ poke(o: any, kind?: PokeKind, dur?: number, amp?: number): void, tick(t: number): void }} */
export function poker() {
  /** @type {any[]} */ const list = []; let now = 0;
  const reset = (o, b) => { o.position.set(b[0], b[1], b[2]); o.rotation.set(b[3], b[4], b[5]); o.scale.set(b[6], b[7], b[8]); };
  return {
    poke(o, kind = 'wiggle', dur = 0.9, amp = 1) {
      if (!o) return;
      const u = o.userData;
      if (!u.pk0) u.pk0 = [o.position.x, o.position.y, o.position.z, o.rotation.x, o.rotation.y, o.rotation.z, o.scale.x, o.scale.y, o.scale.z];
      o.matrixAutoUpdate = true;
      let e = null; for (const x of list) if (x.o === o) e = x;
      if (!e) { e = { o, kind, t0: now, dur, amp }; list.push(e); } else { reset(o, u.pk0); e.kind = kind; e.t0 = now; e.dur = dur; e.amp = amp; }
    },
    tick(t) {
      now = t;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i], o = e.o, b = o.userData.pk0, u = (t - e.t0) / e.dur;
        if (u >= 1 || u < 0) { reset(o, b); o.updateMatrix(); o.matrixAutoUpdate = false; list.splice(i, 1); continue; }
        const env = Math.sin(Math.PI * u), dec = 1 - u, a = e.amp;
        switch (e.kind) {
          case 'wiggle': o.rotation.z = b[5] + Math.sin(u * Math.PI * 6) * 0.12 * a * dec; break;
          case 'swing': o.rotation.x = b[3] + Math.sin(u * Math.PI * 4) * 0.25 * a * dec; break;
          case 'nod': o.rotation.x = b[3] - env * 0.5 * a; break;
          case 'tip': o.rotation.z = b[5] + env * 0.35 * a; break;
          case 'roll': o.rotation.x = b[3] + (1 - dec * dec) * Math.PI * 3 * a; o.rotation.z = b[5] + (1 - dec * dec) * Math.PI * 2 * a; o.position.y = b[1] + Math.abs(Math.sin(u * Math.PI * 2)) * 0.12 * dec; break;
          case 'wheel': o.rotation.z = b[5] + (1 - dec * dec) * Math.PI * 2 * a; break;
          case 'pull': o.position.x = b[0] + env * 0.15 * a; o.rotation.z = b[5] + env * 0.15 * a; break;
          case 'puff': { const k = 1 + 1.6 * env * a; o.scale.set(b[6] * k, b[7] * (1 + 2.2 * env * a), b[8] * k); break; }
          case 'hop': o.position.y = b[1] + Math.abs(Math.sin(u * Math.PI * 2)) * 0.08 * a * dec; break;
          case 'lift': o.position.y = b[1] + env * 0.2 * a; o.rotation.y = b[4] + env * 0.3 * a; break;
          case 'spin': { const s = 1 - dec * dec; o.rotation.y = b[4] + s * Math.PI * 2 * a; o.position.y = b[1] + env * 0.05; break; }
          case 'squash': { const k = Math.sin(u * Math.PI * 3) * 0.12 * a * dec; o.scale.set(b[6] * (1 + k * 0.5), b[7] * (1 - k), b[8] * (1 + k * 0.5)); break; }
        }
      }
    },
  };
}

/** Collapse a prop group into one mesh per material (group-local space) and mark it live, so animating it costs few draw calls. @param {any} g */
export function solidify(g) {
  g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), by = new Map(), drop = [];
  g.traverse(o => { if (!o.isMesh || o === g) return; const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()); for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)); const k = o.material; if (!by.has(k)) by.set(k, []); by.get(k).push(geo); drop.push(o); });
  for (const o of drop) o.removeFromParent();
  for (const c of [...g.children]) if (!c.isMesh) g.remove(c);
  for (const [m, gs] of by) { const out = new THREE.Mesh(mergeGeometries(gs, false), m); out.castShadow = out.receiveShadow = true; g.add(out); }
  g.userData.live = true; return g;
}
