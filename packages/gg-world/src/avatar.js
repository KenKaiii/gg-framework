// @ts-check
// Builds a KayKit character on the shared Rig_Medium from mix-and-match parts, recolours it, and layers
// procedural motion (look-at, wave, typing, chin-think, breathing) on top of the shared clips.
import * as THREE from 'three';
import { sillyProp, SILLY, mergeGroup } from './silly.js';
import { mat } from './rooms/kit.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchRecolor, HAIR_REF } from './recolor.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export const SCALE = 0.72;
const PREFIX = { knight: 'Knight', mage: 'Mage', rogue: 'Rogue', barbarian: 'Barbarian', hooded: 'Rogue' };
const HEAD = { knight: 'Knight_Head', mage: 'Mage_Head', rogue: 'Rogue_Head', barbarian: 'Barbarian_Head', hooded: 'Rogue_Head_Hooded' };
const HATS = { wizard: ['mage', 'Mage_Hat'], helmet: ['knight', 'Knight_Helmet'], fur: ['barbarian', 'Barbarian_Hat'] };

/** Per-character-texture analysis: which atlas colours are hair and skin. */
const analysis = new Map();
const texCache = new Map();

function pixels(tex) {
  const img = tex.image; const w = img.width, h = img.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  x.drawImage(img, 0, 0);
  return { c, x, w, h, data: x.getImageData(0, 0, w, h) };
}
function modeColour(px, geo, pick) {
  const pos = geo.attributes.position, uv = geo.attributes.uv; const counts = new Map();
  for (let i = 0; i < pos.count; i++) {
    if (!pick(pos.getX(i), pos.getY(i), pos.getZ(i))) continue;
    const u = Math.min(px.w - 1, Math.max(0, Math.floor(uv.getX(i) * px.w))), v = Math.min(px.h - 1, Math.max(0, Math.floor(uv.getY(i) * px.h)));
    const o = (v * px.w + u) * 4; const d = px.data.data; const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = 0, bk = 0; for (const [k, n] of counts) if (n > best) { best = n; bk = k; }
  return [bk >> 16 & 255, bk >> 8 & 255, bk & 255];
}
function analyse(key, headMesh) {
  if (analysis.has(key)) return analysis.get(key);
  const tex = headMesh.material.map; const px = pixels(tex); const g = headMesh.geometry;
  g.computeBoundingBox(); const b = g.boundingBox; const hy = b.max.y - b.min.y, hz = b.max.z - b.min.z;
  const hair = modeColour(px, g, (x, y) => y > b.max.y - hy * 0.12);
  const skin = modeColour(px, g, (x, y, z) => z > b.max.z - hz * 0.12 && y < b.max.y - hy * 0.45 && y > b.min.y + hy * 0.2);
  const a = { px, hair, skin }; analysis.set(key, a); return a;
}
/** Remap hair + skin swatches of a character atlas. */
function remapped(key, headMesh, hairHex, skinHex) {
  const ck = key + hairHex + skinHex; if (texCache.has(ck)) return texCache.get(ck);
  const a = analyse(key, headMesh); const src = a.px.data.data;
  const c = document.createElement('canvas'); c.width = a.px.w; c.height = a.px.h; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const out = x.createImageData(a.px.w, a.px.h); const d = out.data;
  const hc = new THREE.Color(hairHex), sc = new THREE.Color(skinHex);
  const H = [hc.r * 255, hc.g * 255, hc.b * 255], S = [sc.r * 255, sc.g * 255, sc.b * 255];
  const lum = p => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11 + 1;
  const hl = lum(a.hair), sl = lum(a.skin), same = a.hair.join() === a.skin.join();
  for (let i = 0; i < src.length; i += 4) {
    const p = [src[i], src[i + 1], src[i + 2]]; d[i + 3] = src[i + 3];
    const dh = Math.abs(p[0] - a.hair[0]) + Math.abs(p[1] - a.hair[1]) + Math.abs(p[2] - a.hair[2]);
    const ds = Math.abs(p[0] - a.skin[0]) + Math.abs(p[1] - a.skin[1]) + Math.abs(p[2] - a.skin[2]);
    let t = null, r = 1;
    if (!same && dh < 60 && dh <= ds) { t = H; r = lum(p) / hl; } else if (ds < 60) { t = S; r = lum(p) / sl; }
    if (t) { d[i] = Math.min(255, t[0] * r); d[i + 1] = Math.min(255, t[1] * r); d[i + 2] = Math.min(255, t[2] * r); }
    else { d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; }
  }
  x.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter;
  texCache.set(ck, tex); return tex;
}

function findMesh(scene, name) { let m = null; scene.traverse(o => { if (o.name === name && o.isMesh) m = o; }); return m; }

const _q = new THREE.Quaternion(), _e = new THREE.Euler();
/** How long each emote lasts (s). */
const EMOTE_SECS = /** @type {Record<string, number>} */ ({ cringe: 4, wave: 2.4, dance: 5, kiss: 2.6, sleep: 7, worm: 4.2 });
/** A little heart sprite at the avatar's head (blow a kiss). @param {any} av */
function heart(av) { return emSprite(av, '#ff6b9a', (g, w) => { g.beginPath(); g.moveTo(w / 2, w * 0.8); g.bezierCurveTo(w * 0.05, w * 0.45, w * 0.2, w * 0.08, w / 2, w * 0.32); g.bezierCurveTo(w * 0.8, w * 0.08, w * 0.95, w * 0.45, w / 2, w * 0.8); g.fill(); }, 0.28); }
/** Z's over a sleeping avatar. @param {any} av */
function zzz(av) { return emSprite(av, '#cfe0ff', (g, w) => { g.font = `700 ${w * 0.7}px Sora, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('z', w * 0.35, w * 0.6); g.font = `700 ${w * 0.45}px Sora, sans-serif`; g.fillText('z', w * 0.72, w * 0.3); }, 0.32); }
/** @param {any} av @param {string} color @param {(g: CanvasRenderingContext2D, w: number) => void} draw @param {number} size */
function emSprite(av, color, draw, size) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); g.fillStyle = color; draw(g, 64);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })); sp.scale.setScalar(size); sp.position.set(0.15, 1.15, 0.1);
  av.root.add(sp); const rm = sp.removeFromParent.bind(sp); /** @type {any} */ (sp).remove = () => { rm(); tex.dispose(); sp.material.dispose(); }; return sp;
}
export const DEFAULT_LOOK = { body: 'rogue', head: 'rogue', skin: '#f2c6a0', hair: '#5a3825', top: '#6fa8dc', bottom: '#4a4e69', acc: 'headphones', accColor: '#f28b82' };

export class Avatar {
  /** Live avatars (blob shadows etc.). Removed by dispose(). @type {Set<Avatar>} */
  static all = new Set();
  /** @param {any} A assets @param {any} look */
  constructor(A, look) {
    this.A = A; this.root = new THREE.Group(); this.root.userData.avatar = this; Avatar.all.add(this);
    // culled (invisible) characters skip their whole subtree (~45 bones + meshes) in three.js's per-frame matrix walk;
    // getWorldPosition() still works for them (it updates the ancestor chain on demand)
    this.root.updateMatrixWorld = function (force) { if (this.visible) THREE.Object3D.prototype.updateMatrixWorld.call(this, force); };
    /** per-avatar GPU resources of the current look (freed on setLook/dispose) @type {{dispose(): void}[]} */ this.own = [];
    this.rig = SkeletonUtils.clone(A.chars.knight.scene);
    const drop = []; this.rig.traverse(o => { if (o.isMesh) drop.push(o); });
    drop.forEach(o => o.removeFromParent());
    this.rig.scale.setScalar(SCALE); this.root.add(this.rig);
    this.bones = {}; this.rig.traverse(o => { if (o.isBone) this.bones[o.name] = o; });
    // Procedural layers (look-at, typing, emotes) multiply onto bone rotations each frame. Clips that don't key a bone
    // (e.g. the head in walk/sit) would let those rotations pile up frame after frame -> spinning heads. So every frame
    // starts from this rest pose for those bones before the mixer and the layers run.
    // three.js strips '.' from bone names (upperarm.l -> upperarml); accept both spellings
    this.bone = n => this.bones[n] || this.bones[n.replace(/\./g, '')];
    this.layerBones = ['head', 'chest', 'hips', 'upperarm.l', 'upperarm.r', 'lowerarm.l', 'lowerarm.r'].map(n => this.bone(n)).filter(Boolean);
    this.restQ = this.layerBones.map(b => b.quaternion.clone());
    // Some KayKit clips (Running_A) pop the hips ~11 deg for a single frame each stride; spine/chest/head ride along.
    // Low-pass the torso chain after the mixer so motion stays but the one-frame snaps don't jerk the head.
    this.smoothBones = ['hips', 'spine', 'chest', 'head'].map(n => this.bone(n)).filter(Boolean);
    this.smoothQ = this.smoothBones.map(b => b.quaternion.clone()); this.smoothInit = false;
    this.parts = []; this.mixer = new THREE.AnimationMixer(this.rig); this.actions = {};
    for (const c of A.clips) this.actions[c.name] = this.mixer.clipAction(c);
    this.current = null; this.fx = { look: null, wave: 0, type: 0, think: 0, sip: 0, clap: 0 };
    this.t = Math.random() * 10; this.yawLook = 0;
    this.setLook(look); this.play('Idle');
  }
  setLook(look) {
    this.look = { ...DEFAULT_LOOK, ...look };
    for (const p of this.parts) p.removeFromParent(); this.parts = []; this._free(); this.mug = undefined;
    const L = this.look, bodySrc = this.A.chars[L.body].scene, headSrc = this.A.chars[L.head].scene, P = PREFIX[L.body];
    const headMesh = findMesh(headSrc, HEAD[L.head]);
    const bodyHead = findMesh(bodySrc, HEAD[L.body]);
    const mk = (src, tex, tint) => {
      if (!src) return;
      const m = src.clone(); m.material = src.material.clone(); this.own.push(m.material); patchRecolor(m.material, { skin: L.skin, hair: L.hair, hairRef: tex, head: !!tex });
      m.material.color = new THREE.Color(tint || '#ffffff'); m.material.roughness = 0.85; m.material.metalness = 0;
      m.material.emissive = new THREE.Color(tint || L.skin).multiplyScalar(0.13).add(new THREE.Color('#0d0b1c')); m.material.emissiveIntensity = 1;
      m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
      if (src.isSkinnedMesh) {
        const sk = new THREE.Skeleton(src.skeleton.bones.map(b => this.bones[b.name]), src.skeleton.boneInverses); this.own.push(sk);
        this.rig.getObjectByName(src.parent.name)?.add(m) || this.rig.add(m); m.bind(sk, src.bindMatrix);
      } else { (this.bones[src.parent.name] || this.rig).add(m); }
      this.parts.push(m); return m;
    };
    const top = new THREE.Color(L.top).lerp(new THREE.Color('#ffffff'), 0.15), bot = new THREE.Color(L.bottom).lerp(new THREE.Color('#ffffff'), 0.15);
    const arm = top.clone().lerp(new THREE.Color('#fff'), 0.35);
    const body = [['_Body', top], ['_ArmLeft', arm], ['_ArmRight', arm], ['_LegLeft', bot], ['_LegRight', bot]].map(([n, c]) => [findMesh(bodySrc, P + n), c]).filter(e => e[0]);
    if (!this._mergeBody(body, L)) for (const [s, c] of body) mk(s, null, c);
    mk(headMesh, HAIR_REF[L.head], null);
    if (HATS[L.acc]) { const [c, n] = HATS[L.acc]; const s = findMesh(this.A.chars[c].scene, n); mk(s, null, L.accColor); }
    if (L.acc === 'glasses' || L.acc === 'headphones') this.parts.push(this._prop(L.acc, L.accColor));
    for (const k of (L.silly || [])) if (SILLY.includes(k)) this.parts.push(...sillyProp(k, this.bones));
    const sc = L.scale || {}; this.headScale = sc.head || 1; this.root.scale.set(sc.width || 1, sc.height || 1, sc.width || 1);
    if (L.prop === 'mug') { const s = findMesh(this.A.chars.barbarian.scene, 'Mug'); if (s) this.mug = mk(s, null, '#ffffff'); }
    for (const p of this.parts) p.traverse(o => { o.castShadow = false; });
    for (const p of this.parts) for (const m of p.userData.ownMaterials || []) this.own.push(m);
  }
  /**
   * One SkinnedMesh for the body-character parts when they share bones, bind pose and transform; per-part tint goes
   * into a vertex colour (recolor.js keeps skin untinted and adds the per-part emissive). Returns false -> caller falls back.
   * @param {[any, THREE.Color][]} body @param {any} L
   */
  _mergeBody(body, L) {
    if (body.length < 2) return false;
    const [s0] = body[0], attrs = g => Object.keys(g.attributes).sort().join() + !!g.index + Object.keys(g.morphAttributes).length;
    const same = body.every(([s]) => s.isSkinnedMesh && s.parent?.name === s0.parent?.name && s.material.map === s0.material.map && attrs(s.geometry) === attrs(s0.geometry)
      && s.skeleton.bones.length === s0.skeleton.bones.length && s.bindMatrix.equals(s0.bindMatrix) && s.matrix.equals(s0.matrix));
    if (!same) return false;
    // KayKit parts carry different inverse-bind matrices for the same bone, so build one joint list of (bone, inverse)
    // pairs (a bone may appear twice) and remap each part's skinIndex into it
    /** @type {string[]} */ const jb = []; /** @type {THREE.Matrix4[]} */ const ji = []; const keyOf = new Map();
    const joint = (name, inv) => { const k = name + '|' + inv.elements.map(v => v.toFixed(5)).join(); if (!keyOf.has(k)) { keyOf.set(k, jb.length); jb.push(name); ji.push(inv); } return keyOf.get(k); };
    const gs = body.map(([s, c]) => {
      const g = s.geometry.clone(); const n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      const map = s.skeleton.bones.map((bn, i) => joint(bn.name, s.skeleton.boneInverses[i]));
      const si = g.attributes.skinIndex, out = new Uint16Array(si.count * 4);
      for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = map[si.getComponent(i, k)];
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(out, 4)); return g;
    });
    const geo = mergeGeometries(gs, false); gs.forEach(g => g.dispose()); if (!geo) return false;
    const m = new THREE.SkinnedMesh(geo, s0.material.clone()); m.name = 'AvatarBody';
    m.position.copy(s0.position); m.quaternion.copy(s0.quaternion); m.scale.copy(s0.scale);
    const mt = m.material; patchRecolor(mt, { skin: L.skin, hair: L.hair, head: false, vertexTint: 0.13 });
    mt.vertexColors = true; mt.color = new THREE.Color('#ffffff'); mt.roughness = 0.85; mt.metalness = 0;
    mt.emissive = new THREE.Color('#0d0b1c'); mt.emissiveIntensity = 1;
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    if (jb.some(n => !this.bones[n])) { geo.dispose(); mt.dispose(); return false; }
    const sk = new THREE.Skeleton(jb.map(n => this.bones[n]), ji);
    (this.rig.getObjectByName(s0.parent.name) || this.rig).add(m); m.bind(sk, s0.bindMatrix);
    this.own.push(geo, mt, sk); this.parts.push(m); return true;
  }
  _free() { for (const r of this.own) r.dispose(); this.own = []; }
  /** Detach from the scene and free per-avatar GPU resources (shared caches are kept). */
  dispose() {
    Avatar.all.delete(this); for (const p of this.parts) p.removeFromParent(); this.parts = []; this._free();
    this.mixer.stopAllAction(); this.root.removeFromParent();
  }
  _prop(kind, col) {
    const g = new THREE.Group(); const cm = mat(col, { roughness: 0.5 }); // shared across avatars by colour
    const dark = mat('#2b2d42', { roughness: 0.4 });
    if (kind === 'glasses') {
      for (const s of [-1, 1]) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 6, 16), dark); r.position.set(s * 0.22, 0, 0); g.add(r); }
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.04), dark); g.add(br); g.position.set(0, 0.62, 0.56);
    } else {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 6, 20, Math.PI), cm); band.position.y = 0.55; g.add(band);
      for (const s of [-1, 1]) { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 14), dark); cup.rotation.z = Math.PI / 2; cup.position.set(s * 0.6, 0.5, 0); g.add(cup); }
    }
    mergeGroup(g, 'acc-' + kind); this.bones.head.add(g); return g;
  }
  /**
   * Emotes, keys 1-5 (owner: each a unique, funny thing): 1 wave, 2 dance (the floss), 3 blow a kiss, 4 lie down and
   * sleep on the floor, 5 the worm (well, a breakdance flop). Layered procedurally on the bones; no new clips. The old
   * ones (facepalm, slowclap, flip, cringe) are kept for activities that use them (the diner).
   * @param {string} n
   */
  startEmote(n) {
    this.em = n; this.emT = EMOTE_SECS[n] ?? 2.6; this.em0 = this.emT;
    if (n === 'flip') this.play('Jump_Full_Short', { once: true });
    if (n === 'cringe') this.play('Cheer');
    if (n === 'dance') this.play('Cheer');
    if (n === 'sleep') this.play('Sit_Floor_Idle', { fade: 0.35 });
    if (n === 'worm') this.play('Sit_Floor_Idle', { fade: 0.2 });
    if (n === 'wave' || n === 'kiss') this.play('Idle');
  }
  /** Stop an emote (walking interrupts it). */
  endEmote() { if (!this.em) return; this.em = null; this.rig.rotation.set(0, 0, 0); this.rig.position.set(0, 0, 0); this.emFx?.remove?.(); this.emFx = null; }
  emote(dt) {
    if (!this.em) return; this.emT -= dt; const t = this.t, k = Math.min(1, this.emT * 2), into = Math.min(1, (this.em0 - this.emT) * 3);
    if (this.emT <= 0) { this.endEmote(); this.play('Idle'); return; }
    if (this.em === 'facepalm') { this.fxq = 1; this.rot('upperarm.r', -1.25 * k, 0, 0.75 * k); this.rot('lowerarm.r', -2.2 * k, 0, 0); this.rot('head', 0.35 * k, 0, Math.sin(t * 3) * 0.12 * k); }
    if (this.em === 'slowclap') { const s = Math.max(0, Math.sin(t * 3.2)) * 0.45; this.rot('upperarm.l', -0.9 * k, 0, -0.4 - s); this.rot('upperarm.r', -0.9 * k, 0, 0.4 + s); this.rot('lowerarm.l', -0.8 * k, 0, 0); this.rot('lowerarm.r', -0.8 * k, 0, 0); this.rot('head', 0.1, 0, 0.15); }
    if (this.em === 'flip') { this.rot('upperarm.l', 0, 0, -2.4 * k); this.rot('upperarm.r', 0, 0, 2.4 * k); }
    if (this.em === 'cringe') { this.rig.rotation.z = Math.sin(t * 9) * 0.18; this.rig.position.y = Math.abs(Math.sin(t * 9)) * 0.08; this.rot('hips', 0, Math.sin(t * 9) * 0.5, 0); this.rot('head', 0, -Math.sin(t * 9) * 0.6, 0); }
    // 1 wave (rig axes, measured: upperarm +x raises the arm, ~1.25 rad = up and out; y swings it in/out; z fore/aft,
    // mirrored per side; past ~2 rad the arm crosses behind the head): arm up and out, waving side to side; a bounce
    if (this.em === 'wave') { const w = Math.sin(t * 8); this.rot('upperarm.r', (1.25 + w * 0.15) * k, w * 0.55 * k, 0); this.rot('lowerarm.r', (0.5 + w * 0.4) * k, 0, 0); this.rot('chest', 0, 0, -0.1 * k); this.rot('head', 0, 0.25 * k, -0.1 * k); this.rig.position.y = Math.abs(Math.sin(t * 4)) * 0.06 * k; }
    // 2 dance: the floss: both arms down and out, swinging across the body together (fore/aft) while the hips swing the
    // other way; hopping on the beat, turning slowly
    if (this.em === 'dance') { const b = Math.sin(t * 7), s = Math.sign(b) * Math.pow(Math.abs(b), 0.6) * k;
      this.rot('upperarm.l', 0.5 * k, 0, -s * 1.1); this.rot('upperarm.r', 0.5 * k, 0, s * 1.1); this.rot('lowerarm.l', 0.2 * k, 0, 0); this.rot('lowerarm.r', 0.2 * k, 0, 0);
      this.rot('hips', 0, s * 0.7, -s * 0.3); this.rot('chest', 0, -s * 0.4, s * 0.2); this.rot('head', 0, s * 0.3, -s * 0.15); this.rig.position.y = Math.abs(Math.sin(t * 7)) * 0.1 * k; this.rig.rotation.y = Math.sin(t * 1.2) * 0.5 * k; }
    // 3 blow a kiss: hand up to the lips (arm forward + raised, elbow bent), lean in, then fling it out wide and up; a heart
    if (this.em === 'kiss') { const p = 1 - this.emT / this.em0, out = Math.max(0, (p - 0.45) / 0.55);
      this.rot('upperarm.r', (1.25 - out * 0.25) * k, 0, (0.85 - out * 0.85) * k); this.rot('lowerarm.r', (1.5 - out * 1.4) * k, 0, 0); this.rot('upperarm.l', out * 1.0 * k, 0, 0); this.rot('head', (0.25 - out * 0.55) * k, 0, 0.2 * k); this.rot('chest', (0.22 - out * 0.4) * k, 0, 0); this.rig.position.y = out * 0.08 * k; this.rig.rotation.y = out * 0.5 * k;
      if (out > 0 && !this.emFx) this.emFx = heart(this); if (this.emFx) { this.emFx.position.y += dt * 0.6; this.emFx.position.z += dt * 0.25; this.emFx.material.opacity = Math.max(0, 1 - out * 1.1); } }
    if (this.em === 'sleep') { const d = Math.min(1, into) * k; this.rig.rotation.x = -1.45 * d; this.rig.position.y = 0.12 * d; this.rig.position.z = -0.35 * d;
      this.rot('chest', Math.sin(t * 1.4) * 0.05, 0, 0); this.rot('upperarm.l', 0, 0, -0.3); this.rot('upperarm.r', 0, 0, 0.3); this.rot('head', 0.2, 0.5, 0);
      if (!this.emFx && into >= 1) this.emFx = zzz(this); if (this.emFx) { const m = this.emFx; m.position.y = 0.9 + ((t * 0.35) % 1) * 0.7; m.material.opacity = 0.9 - ((t * 0.35) % 1) * 0.9; } }
    // 5 the worm: flop down and ripple along the floor, then hop back up
    if (this.em === 'worm') { const d = Math.min(1, into) * k, w = Math.sin(t * 8); this.rig.rotation.x = -1.35 * d; this.rig.position.y = (0.15 + Math.max(0, w) * 0.12) * d;
      this.rot('hips', w * 0.5 * d, 0, 0); this.rot('chest', -w * 0.6 * d, 0, 0); this.rot('head', w * 0.4 * d, 0, 0); this.rot('upperarm.l', 0, 0, -1.2 * d); this.rot('upperarm.r', 0, 0, 1.2 * d); }
  }
  /** @param {string} name @param {{once?: boolean, fade?: number, speed?: number}} [o] */
  play(name, o = {}) {
    const a = this.actions[name]; if (!a || (this.current === a && !o.once)) return a;
    if (this.current === a && a.isRunning() && a.getEffectiveWeight() > 0.5) { a.time = 0; a.paused = false; a.setEffectiveWeight(1); return a; }
    a.reset(); a.setLoop(o.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = !!o.once; a.timeScale = o.speed || 1;
    const fade = o.fade ?? 0.25; a.enabled = true; a.setEffectiveWeight(1); a.fadeIn(fade); a.play();
    for (const k in this.actions) { const x = this.actions[k]; if (x !== a && x.isRunning() && x.getEffectiveWeight() > 0) x.fadeOut(fade); }
    this.current = a; this.currentName = name; return a;
  }
  rot(b, x, y, z) { const bone = this.bone(b); if (bone) bone.quaternion.multiply(_q.setFromEuler(_e.set(x, y, z))); }
  /** @param {number} dt */
  update(dt) {
    this.t += dt; for (let i = 0; i < this.layerBones.length; i++) this.layerBones[i].quaternion.copy(this.restQ[i]); this.mixer.update(dt); const f = this.fx, t = this.t;
    { const k = this.smoothInit ? 1 - Math.exp(-dt * 8) : 1; this.smoothInit = true;
      for (let i = 0; i < this.smoothBones.length; i++) { const q = this.smoothQ[i]; q.slerp(this.smoothBones[i].quaternion, k); this.smoothBones[i].quaternion.copy(q); } }
    if (this.bones.head) this.bones.head.scale.setScalar(this.headScale || 1);
    this.emote(dt);
    // look at a world point (head yaw, clamped), smoothed
    let want = 0;
    if (f.look) { const p = new THREE.Vector3(); this.root.getWorldPosition(p); const ang = Math.atan2(f.look.x - p.x, f.look.z - p.z) - this.root.rotation.y; want = Math.atan2(Math.sin(ang), Math.cos(ang)); want = Math.max(-1.1, Math.min(1.1, want)); }
    this.yawLook += (want - this.yawLook) * Math.min(1, dt * 5);
    this.rot('head', 0, this.yawLook * 0.75, 0); this.rot('chest', 0, this.yawLook * 0.25, 0);
    this.rot('chest', Math.sin(t * 1.7) * 0.015, 0, 0);
    if (f.type > 0) { this.rot('lowerarm.l', Math.sin(t * 22) * 0.12 * f.type, 0, 0); this.rot('lowerarm.r', Math.sin(t * 19 + 1) * 0.12 * f.type, 0, 0); this.rot('head', 0.12 * f.type, 0, 0); }
    if (f.think > 0) { const k = f.think; this.rot('upperarm.r', -1.0 * k, 0, 0.5 * k); this.rot('lowerarm.r', -1.9 * k, 0, 0); this.rot('chest', -0.12 * k, 0, 0); this.rot('head', -0.12 * k, 0, Math.sin(t * 0.8) * 0.06 * k); }
    if (f.wave > 0) { const k = Math.min(1, f.wave); this.rot('upperarm.r', 0, 0, 2.3 * k); this.rot('lowerarm.r', 0, 0, (0.6 + Math.sin(t * 12) * 0.45) * k); f.wave = Math.max(0, f.wave - dt); }
    if (f.clap > 0) { const k = Math.min(1, f.clap); const s = Math.abs(Math.sin(t * 9)) * 0.35; this.rot('upperarm.l', -0.9 * k, 0, -0.4 * k - s * k); this.rot('upperarm.r', -0.9 * k, 0, 0.4 * k + s * k); this.rot('lowerarm.l', -0.8 * k, 0, 0); this.rot('lowerarm.r', -0.8 * k, 0, 0); f.clap = Math.max(0, f.clap - dt); }
    if (f.sip > 0) { const k = Math.min(1, f.sip); this.rot('upperarm.r', -0.7 * k, 0, 0.3 * k); this.rot('lowerarm.r', -1.7 * k, 0, 0); f.sip = Math.max(0, f.sip - dt); }
  }
}
