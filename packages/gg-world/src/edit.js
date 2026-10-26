// @ts-check
// Edit mode (B): only in your own room (bedroom). Click an editable to select, click floor to move (0.5 grid), R rotates.
import * as THREE from 'three';

/** @param {any} S @param {any} U @param {HTMLElement} root */
export function initEdit(S, U, root) {
  const bar = document.createElement('div'); bar.className = 'card editbar'; bar.innerHTML = 'edit room: click item, click floor to move, <kbd>R</kbd> rotate, <kbd>B</kbd> done'; root.appendChild(bar);
  let sel = null; const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3(), box = new THREE.Box3();
  const R = () => S.room; const own = () => R() === S.rooms.bedroom && (R().editables || []).length;
  const free = o => { o.updateMatrixWorld(true); box.setFromObject(o); R().grid.rect(box.min.x + 0.05, box.min.z + 0.05, box.max.x - 0.05, box.max.z - 0.05, 0); };
  const block = o => { try { R().blockObj(o); } catch { /* optional */ } };
  const mark = (o, on) => o.traverse(m => { if (m.isMesh && m.material?.emissive) { if (on) { m.userData.em = m.material.emissive.getHex(); m.material = m.material.clone(); m.material.emissive.set('#1d4d30'); } else if (m.userData.em != null) m.material.emissive.setHex(m.userData.em); } });
  const E = {
    toggle() { if (U.editing) return E.stop(); if (!own()) { U.toast?.('you can only edit your own room (bedroom)'); return; } U.editing = true; bar.style.display = 'block'; },
    stop() { if (sel) mark(sel, false); sel = null; U.editing = false; bar.style.display = 'none'; },
    click(ray) {
      const eds = R().editables || []; const hits = ray.intersectObjects(eds, true);
      if (hits.length) { const o = eds.find(e => { let p = hits[0].object; while (p) { if (p === e) return true; p = p.parent; } return false; }); if (o) { if (sel) mark(sel, false); sel = o; mark(o, true); return; } }
      if (sel && ray.ray.intersectPlane(plane, hit)) {
        const hw = R().w / 2 - 0.6, hd = R().d / 2 - 0.6; free(sel); hit.sub(R().root.position);
        sel.position.x = Math.max(-hw, Math.min(hw, Math.round(hit.x * 2) / 2)); sel.position.z = Math.max(-hd, Math.min(hd, Math.round(hit.z * 2) / 2)); block(sel); S.perfCtl?.shadowDirty();
      }
    },
    update() {},
  };
  addEventListener('keydown', e => { if (U.editing && sel && e.code === 'KeyR') { free(sel); sel.rotation.y += Math.PI / 2; block(sel); S.perfCtl?.shadowDirty(); } });
  return E;
}
