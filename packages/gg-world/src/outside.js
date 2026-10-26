// @ts-check
// The outside: a city block around the house instead of a black void (owner idea). You can see it, you can't go there.
// It follows real UTC time (night, dawn, morning, day, dusk) and a weather that changes every 3 hours (clear, cloudy,
// rain), the same for everyone. It never touches the rooms' lighting (owner: lighting must not swing): only the outside
// surfaces, the sky (scene background) and the rain change.
//   streets: a road ring round the block with pavements, kerbs, lane marks, zebra crossings (one painted ground texture)
//   city:    low buildings across the street, taller rows behind, a skyline fading into the sky. Heights are capped by
//            distance (h <= (d - 2) / 1.414 at the 35 deg camera) so nothing outside ever hides the house.
//   life:    street lamps (light pools at night), trees, parked cars, a few cars driving round the block, rain + splashes
// Cost: ~10 draw calls, no shadows, MeshBasic only; per frame only a few uniforms + 5 car matrices.
// Debug / tests: ?outside=0 (off), ?time=dusk|night|dawn|morning|day|<utc hour>, ?weather=clear|cloudy|rain; S.outside.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOORS } from './rooms/floorplan.js';
import { buildHood } from './outside-hood.js';

const rnd = seed => { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };
const C = h => new THREE.Color(h);

// ---- time of day + weather -------------------------------------------------------------------------------------------
const KEYS = [[0, 'night'], [5, 'night'], [6.2, 'dawn'], [7.6, 'morning'], [11, 'day'], [16, 'day'], [18, 'dusk'], [19.6, 'night'], [24, 'night']];
const LOOK = { // tint: multiplies the outside's painted colours; sky: background; lamp / win: street lamps, lit windows
  night: { tint: '#66709c', sky: '#10142a', lamp: 1, win: 1 },
  dawn: { tint: '#c8aeb0', sky: '#d8a08c', lamp: 0.45, win: 0.35 },
  morning: { tint: '#d8d2c4', sky: '#8ab4d8', lamp: 0, win: 0.1 },
  day: { tint: '#ece6d8', sky: '#8eb8dc', lamp: 0, win: 0.04 },
  dusk: { tint: '#d6a080', sky: '#b86a6a', lamp: 0.7, win: 0.65 },
};
const WX = { clear: { dim: 1, grey: 0, wet: 0, rain: 0, cloud: 0.12 }, cloudy: { dim: 0.8, grey: 0.45, wet: 0, rain: 0, cloud: 0.5 }, rain: { dim: 0.62, grey: 0.6, wet: 1, rain: 1, cloud: 0.7 } };
const hash01 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
/** weather for a UTC moment: one roll per 3-hour block, same for everyone */
export function weatherAt(d = new Date()) { const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${Math.floor(d.getUTCHours() / 3)}`; const r = hash01(k); return r < 0.16 ? 'rain' : r < 0.46 ? 'cloudy' : 'clear'; }
const PHASE_HOUR = { night: 1, dawn: 6.4, morning: 9, day: 13, dusk: 18.3 };
function lookAt(hour) { let i = 0; while (i < KEYS.length - 2 && hour >= KEYS[i + 1][0]) i++; const [h0, a] = KEYS[i], [h1, b] = KEYS[i + 1]; const k = Math.min(1, Math.max(0, (hour - h0) / Math.max(0.001, h1 - h0)));
  const A = LOOK[a], B = LOOK[b], s = k * k * (3 - 2 * k); return { tint: C(A.tint).lerp(C(B.tint), s), sky: C(A.sky).lerp(C(B.sky), s), lamp: A.lamp + (B.lamp - A.lamp) * s, win: A.win + (B.win - A.win) * s, phase: s < 0.5 ? a : b }; }

function noiseTexture(n = 128, seed = 3) { const c = document.createElement('canvas'); c.width = c.height = n; const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); const r = rnd(seed);
  for (let k = 0; k < 90; k++) { const x = r() * n, y = r() * n, rad = 8 + r() * 26; const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(255,255,255,${0.25 + r() * 0.35})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) { g.fillStyle = gr; g.save(); g.translate(ox, oy); g.fillRect(x - rad, y - rad, rad * 2, rad * 2); g.restore(); } }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; }
const radialTex = () => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); };

// ---- geometry helpers --------------------------------------------------------------------------------------------------
/** quad (non-indexed) with uv + colour */
function quad(pos, uv, col, a, b, c2, d, ua, ub, uc, ud, color) { for (const [p, u] of [[a, ua], [b, ub], [c2, uc], [a, ua], [c2, uc], [d, ud]]) { pos.push(...p); uv.push(...u); col.push(color.r, color.g, color.b); } }
const geo = (pos, uv, col) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); return g; };
// baked light (MeshBasic has none): tops full, sides darker by direction, so boxes read as solid shapes, not flat cut-outs
const LDIR = new THREE.Vector3(0.45, 1, 0.3).normalize();
const shadeOf = (nx, ny, nz) => 0.58 + 0.42 * Math.max(0, nx * LDIR.x + ny * LDIR.y + nz * LDIR.z) + (ny > 0.9 ? 0.06 : 0);
const colored = (g, color) => { g = g.index ? g.toNonIndexed() : g; const N = g.attributes.normal; const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const k = N ? shadeOf(N.getX(i), N.getY(i), N.getZ(i)) : 1; a[i * 3] = color.r * k; a[i * 3 + 1] = color.g * k; a[i * 3 + 2] = color.b * k; }
  g.deleteAttribute('normal'); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };

/** @param {any} S @param {THREE.Scene} scene */
export function makeOutside(S, scene) {
  const q = new URLSearchParams(location.search); if (q.get('outside') === '0') return null;
  const rooms = Object.values(FLOORS.main.rooms); const B = { x0: Math.min(...rooms.map(r => r.x - r.w / 2)) - 0.3, x1: Math.max(...rooms.map(r => r.x + r.w / 2)) + 0.3, z0: Math.min(...rooms.map(r => r.z - r.d / 2)) - 0.3, z1: Math.max(...rooms.map(r => r.z + r.d / 2)) + 0.3 };
  const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2, P = 60, GY = -0.62, r = rnd(42);
  const root = new THREE.Group(); root.name = 'outside'; scene.add(root);
  const U = { uTint: { value: C('#ffffff') }, uSky: { value: C('#0e1122') }, uB: { value: new THREE.Vector4(B.x0, B.z0, B.x1, B.z1) }, uFade: { value: new THREE.Vector2(46, 60) },
    uTime: { value: 0 }, uCloud: { value: 0.1 }, uWet: { value: 0 }, uCloudTex: { value: noiseTexture(128, 3) } };
  // shared shader bits: fade to the sky towards the edge, drifting cloud shadows, wet sheen (only where it says so)
  const patch = (m, opt = {}) => { m.onBeforeCompile = sh => { Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#ifdef USE_INSTANCING\nvWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWP; uniform vec3 uTint; uniform vec3 uSky; uniform vec4 uB; uniform vec2 uFade; uniform float uTime; uniform float uCloud; uniform float uWet; uniform sampler2D uCloudTex;`)
      .replace('#include <opaque_fragment>', `{
  vec2 dd = max(max(uB.xy - vWP.xz, vWP.xz - uB.zw), 0.0); float bd = max(dd.x, dd.y);
  ${opt.tint === false ? '' : 'outgoingLight *= uTint;'}
  ${opt.focus === false || opt.tint === false ? '' : 'float foc = mix(0.78, 0.26, smoothstep(2.0, 26.0, bd)); outgoingLight *= foc; float lm0 = dot(outgoingLight, vec3(0.3, 0.59, 0.11)); outgoingLight = mix(vec3(lm0), outgoingLight, mix(0.7, 0.35, smoothstep(4.0, 28.0, bd))); outgoingLight = mix(outgoingLight, uSky * 0.5, smoothstep(10.0, 34.0, bd) * 0.55);'}
  ${opt.water ? 'outgoingLight = mix(outgoingLight, uSky * 0.95, 0.42) + vec3(0.05) * smoothstep(0.55, 0.8, texture2D(uCloudTex, vWP.xz * 0.09 + uTime * vec2(0.012, 0.007)).r);' : ''}
  ${opt.grain ? 'outgoingLight *= 0.9 + 0.2 * texture2D(uCloudTex, vWP.xz * 0.35).r;' : ''}
  ${opt.ground ? `float cs = texture2D(uCloudTex, vWP.xz * 0.012 + uTime * vec2(0.0035, 0.002)).r; outgoingLight *= 1.0 - uCloud * 0.45 * smoothstep(0.15, 0.6, cs);
  float pud = smoothstep(0.55, 0.75, texture2D(uCloudTex, vWP.xz * 0.06).r) * uWet; outgoingLight = outgoingLight * (1.0 - 0.28 * uWet) + uSky * pud * 0.22;` : ''}
  outgoingLight = mix(outgoingLight, uSky, smoothstep(uFade.x, uFade.y, bd));
}
#include <opaque_fragment>`); }; m.customProgramCacheKey = () => 'outside' + JSON.stringify(opt); return m; };

  // the neighbourhood (outside-hood.js): plot, street, park, houses, trees, lamps, cars
  const hood = buildHood({ root, B, GY, P, patch, r, colored, quad, geo, radialTex });
  const { glowM, pools, bulbs } = hood;

  // rain: streaks + splashes, round the camera target, never inside the house
  const NR = 1100, rp = new Float32Array(NR * 6), rs = new Float32Array(NR * 6); for (let i = 0; i < NR; i++) { const a = r(), b = r(), c3 = r(); for (let v = 0; v < 2; v++) { rs.set([a, b, c3], i * 6 + v * 3); rp.set([0, v, 0], i * 6 + v * 3); } }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rg.setAttribute('seed', new THREE.BufferAttribute(rs, 3));
  const RU = { uT: { value: 0 }, uO: { value: new THREE.Vector3() }, uB: U.uB, uA: { value: 0 }, uC: { value: C('#b8c8e0') } };
  const rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({ uniforms: RU, transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 seed; uniform float uT; uniform vec3 uO; uniform vec4 uB; varying float vA;
      void main(){ float H = 16.0; vec3 p; p.x = uO.x + (seed.x - 0.5) * 70.0; p.z = uO.z + (seed.z - 0.5) * 70.0; p.y = mod(seed.y * H - uT * 15.0, H) - 0.6;
        p += vec3(0.35, 0.9, 0.2) * position.y; vec2 dd = max(max(uB.xy - p.xz, p.xz - uB.zw), 0.0); vA = max(dd.x, dd.y) > 0.6 ? 1.0 : 0.0;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uA; uniform vec3 uC; varying float vA; void main(){ if (vA < 0.5) discard; gl_FragColor = vec4(uC, 0.42 * uA); }` }));
  rain.frustumCulled = false; rain.renderOrder = 5; root.add(rain);
  const NS = 260, sp = new Float32Array(NS * 3); for (let i = 0; i < NS; i++) sp.set([r(), r(), r()], i * 3);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const SU = { uT: RU.uT, uO: RU.uO, uB: U.uB, uA: RU.uA, uPx: { value: devicePixelRatio || 1 } };
  const splash = new THREE.Points(sg, new THREE.ShaderMaterial({ uniforms: SU, transparent: true, depthWrite: false,
    vertexShader: `uniform float uT; uniform vec3 uO; uniform vec4 uB; uniform float uPx; varying float vL; varying float vIn;
      void main(){ float life = fract(position.y + uT * 1.6); float cyc = floor(position.y + uT * 1.6); vec2 h = fract(sin(vec2(position.x * 91.7 + cyc * 3.1, position.z * 47.3 + cyc * 1.7)) * 43758.5453);
        vec3 p = vec3(uO.x + (h.x - 0.5) * 60.0, ${GY.toFixed(2)} + 0.02, uO.z + (h.y - 0.5) * 60.0); vec2 dd = max(max(uB.xy - p.xz, p.xz - uB.zw), 0.0); vIn = max(dd.x, dd.y) > 0.6 ? 1.0 : 0.0;
        vL = life; gl_PointSize = (2.0 + life * 7.0) * uPx; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uA; varying float vL; varying float vIn; void main(){ if (vIn < 0.5) discard; vec2 c = gl_PointCoord - 0.5; float d = length(c); float ring = smoothstep(0.5, 0.38, d) * smoothstep(0.22, 0.34, d);
        gl_FragColor = vec4(vec3(0.78, 0.84, 0.95), ring * (1.0 - vL) * 0.55 * uA); }` }));
  splash.frustumCulled = false; splash.renderOrder = 5; root.add(splash);
  for (const o of root.children) { o.castShadow = false; o.receiveShadow = false; }

  // ---- state + update ----------------------------------------------------------------------------------------------
  const force = { time: q.get('time'), weather: q.get('weather') };
  const st = { phase: '', weather: '', hour: 0, wx: { ...WX.clear }, wxTarget: WX.clear, nextLook: 0 };
  const sky = new THREE.Color(), tint = new THREE.Color(), GREY = C('#7a7e88'), GREYSKY = C('#5a6070');
  const forcedHour = () => { const v = force.time; if (!v) return null; if (PHASE_HOUR[v] != null) return PHASE_HOUR[v]; const n = parseFloat(v); return isFinite(n) ? n : null; };
  const api = {
    root, get state() { return { phase: st.phase, weather: st.weather, hour: +st.hour.toFixed(2) }; },
    /** tests / dev: force a time ('dusk' or an hour) and/or weather; null = live UTC */
    set(o) { if ('time' in o) force.time = o.time == null ? null : String(o.time); if ('weather' in o) force.weather = o.weather; st.nextLook = 0; if (o.instant) { st.wx = { ...WX[force.weather || weatherAt()] }; } },
    update(dt, t) {
      root.visible = S.floor === 'main';
      U.uTime.value = t; RU.uT.value = t; RU.uO.value.set(S.target.x, 0, S.target.z);
      if ((st.nextLook -= dt) <= 0) { st.nextLook = 2;
        const now = new Date(); const fh = forcedHour(); st.hour = fh ?? (now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600);
        st.weather = force.weather && WX[force.weather] ? force.weather : weatherAt(now); st.wxTarget = WX[st.weather]; }
      // weather eases (rain starts / stops over ~20 s)
      const k = Math.min(1, dt / 8); for (const key in st.wx) st.wx[key] += (st.wxTarget[key] - st.wx[key]) * k;
      const L = lookAt(st.hour); st.phase = L.phase; const w = st.wx;
      tint.copy(L.tint).lerp(GREY, w.grey * 0.5).multiplyScalar(w.dim); sky.copy(L.sky).lerp(GREYSKY, w.grey * 0.7).multiplyScalar(0.55 + 0.45 * w.dim);
      U.uTint.value.copy(tint); U.uSky.value.copy(sky); U.uCloud.value = w.cloud; U.uWet.value = w.wet;
      const dark = Math.max(L.lamp, w.rain * 0.5 * (1 - L.lamp) + L.lamp); glowM.opacity = Math.max(L.win, w.grey * 0.3) * 0.95; pools.material.opacity = dark * 0.85; bulbs.material.color.set('#ffe2a8').multiplyScalar(0.25 + dark * 0.9);
      RU.uA.value = w.rain; rain.visible = splash.visible = w.rain > 0.02;
      // skip draw calls for effects that are fully faded out (day: no lamp pools, no lit windows, no headlights)
      glowM.visible = glowM.opacity > 0.01; pools.material.visible = pools.material.opacity > 0.01;
      // background: sky on the ground floor and the roof, the old dark in the basement
      if (S.floor !== 'basement') { if (!(scene.background instanceof THREE.Color)) scene.background = new THREE.Color(); /** @type {THREE.Color} */ (scene.background).copy(sky); }
      else /** @type {THREE.Color} */ (scene.background).set('#0b0a12');
      hood.traffic.update(dt, L, w);
    },
  };
  api.debugCars = () => hood.traffic.debug();
  return api;
}
