// @ts-check
// Stable bloom ("dual filter" / dual-Kawase, Bjørge 2015). Replaces three's UnrealBloomPass, whose mip chain downsamples
// with single bilinear taps: when the view moved by one pixel, small bright things (bulbs, neon, lit stair treads)
// aliased in and out of the coarse mips and their glow visibly shimmered (measured with tools/flicker-scan.mjs: ~90% of
// the remaining "moves -> flickers" pixels). Dual filtering prefilters every level over a 4x4 footprint, so a 1 px shift
// changes almost nothing. Also cheaper: 5 down + 5 up passes, 5 and 8 taps, no separable 9..21-tap blurs.
// API kept close to UnrealBloomPass: .enabled, .strength, .threshold, .radius (0..1 = how far the glow spreads),
// .resolution (ignored, sizes follow setSize), setSize(w, h).
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const DOWN = `uniform sampler2D tSrc; uniform vec2 hp; uniform float thr; uniform float knee; uniform int first; varying vec2 vUv;
vec3 pre(vec3 c){ if (first == 0) return c; float br = max(c.r, max(c.g, c.b)); float s = clamp(br - thr + knee, 0.0, 2.0 * knee); s = s * s / (4.0 * knee + 1e-4);
  return c * max(s, br - thr) / max(br, 1e-4); }
void main(){ vec3 s = pre(texture2D(tSrc, vUv).rgb) * 4.0;
  s += pre(texture2D(tSrc, vUv - hp).rgb); s += pre(texture2D(tSrc, vUv + hp).rgb);
  s += pre(texture2D(tSrc, vUv + vec2(hp.x, -hp.y)).rgb); s += pre(texture2D(tSrc, vUv - vec2(hp.x, -hp.y)).rgb);
  gl_FragColor = vec4(min(s / 8.0, vec3(64.0)), 1.0); }`;
const UP = `uniform sampler2D tSrc; uniform sampler2D tAdd; uniform vec2 hp; uniform float mixK; varying vec2 vUv;
void main(){ vec3 s = texture2D(tSrc, vUv + vec2(-hp.x * 2.0, 0.0)).rgb + texture2D(tSrc, vUv + vec2(hp.x * 2.0, 0.0)).rgb
  + texture2D(tSrc, vUv + vec2(0.0, hp.y * 2.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, -hp.y * 2.0)).rgb
  + (texture2D(tSrc, vUv + vec2(-hp.x, hp.y)).rgb + texture2D(tSrc, vUv + vec2(hp.x, hp.y)).rgb
   + texture2D(tSrc, vUv + vec2(hp.x, -hp.y)).rgb + texture2D(tSrc, vUv + vec2(-hp.x, -hp.y)).rgb) * 2.0;
  gl_FragColor = vec4(s / 12.0 * mixK + texture2D(tAdd, vUv).rgb, 1.0); }`;
const COMP = `uniform sampler2D tSrc; uniform float strength; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb * strength, 1.0); }`;

export class StableBloomPass extends Pass {
  constructor(strength = 0.55, radius = 0.6, threshold = 0.85, levels = 5) {
    super(); this.strength = strength; this.radius = radius; this.threshold = threshold; this.levels = levels; this.needsSwap = false;
    this.resolution = new THREE.Vector2(); this.down = []; this.up = [];
    const opt = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    for (let i = 0; i < levels; i++) { this.down.push(new THREE.WebGLRenderTarget(1, 1, opt)); this.up.push(new THREE.WebGLRenderTarget(1, 1, opt)); }
    this.mDown = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: DOWN, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, hp: { value: new THREE.Vector2() }, thr: { value: threshold }, knee: { value: 0.25 }, first: { value: 0 } } });
    this.mUp = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: UP, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, tAdd: { value: null }, hp: { value: new THREE.Vector2() }, mixK: { value: 1 } } });
    this.mComp = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: COMP, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation, uniforms: { tSrc: { value: null }, strength: { value: strength } } });
    this.quad = new FullScreenQuad(); this.w = 1; this.h = 1;
  }
  setSize(w, h) { this.w = w; this.h = h; let x = w, y = h;
    for (let i = 0; i < this.levels; i++) { x = Math.max(1, Math.round(x / 2)); y = Math.max(1, Math.round(y / 2)); this.down[i].setSize(x, y); this.up[i].setSize(x, y); } }
  render(renderer, writeBuffer, readBuffer) {
    const auto = renderer.autoClear; renderer.autoClear = false; const n = this.levels;
    // down: full -> 1/2 (with threshold) -> ... -> 1/2^n
    let src = readBuffer.texture; const md = this.mDown.uniforms; md.thr.value = this.threshold; this.quad.material = this.mDown;
    for (let i = 0; i < n; i++) { const t = this.down[i]; md.tSrc.value = src; md.first.value = i === 0 ? 1 : 0; md.hp.value.set(0.5 / t.width, 0.5 / t.height);
      renderer.setRenderTarget(t); this.quad.render(renderer); src = t.texture; }
    // up: coarsest -> finest, each level adds its own down image; radius fades how much the coarse (wide) levels contribute
    const mu = this.mUp.uniforms; this.quad.material = this.mUp; let cur = this.down[n - 1].texture;
    for (let i = n - 2; i >= 0; i--) { const t = this.up[i]; const s = this.down[i + 1];
      mu.tSrc.value = cur; mu.tAdd.value = this.down[i].texture; mu.hp.value.set(0.5 / s.width, 0.5 / s.height); mu.mixK.value = 0.35 + this.radius * 0.65;
      renderer.setRenderTarget(t); this.quad.render(renderer); cur = t.texture; }
    // composite onto the frame (additive), like UnrealBloomPass does in place
    this.mComp.uniforms.tSrc.value = cur; this.mComp.uniforms.strength.value = this.strength / n * 1.6; this.quad.material = this.mComp;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer); this.quad.render(renderer);
    renderer.autoClear = auto;
  }
  dispose() { for (const t of [...this.down, ...this.up]) t.dispose(); this.mDown.dispose(); this.mUp.dispose(); this.mComp.dispose(); this.quad.dispose(); }
}
