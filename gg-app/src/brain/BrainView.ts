import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  type IUniform,
} from "three";
import {
  BRAIN_CENTER,
  HEMI_OFFSET,
  HEMI_RADII,
  rng,
  type BrainModel,
  type Vec3,
} from "./brain-model";

export interface BrainPalette {
  /** Unlit cortex. */
  dim: string;
  /** A charged region. */
  lit: string;
  /** Wavefronts, pulses and hover. */
  hot: string;
  /** The cerebellum and stem as the whole brain fills. */
  core: string;
  /** Glow adds light on dark; on light it would wash out, so it blends normally. */
  dark: boolean;
}

export interface BrainViewOptions {
  onHover?: (region: number) => void;
  onPick?: (region: number) => void;
  /** Something changed that needs a frame drawn (resize, drag, hover). */
  onInvalidate?: () => void;
}

const VERT = /* glsl */ `
#define REGIONS __REGIONS__
uniform float uTime, uLevel, uSize, uScale, uDensity, uTwinkle, uHover, uGrow;
uniform float uCharge[REGIONS];
uniform vec4 uPulse[3]; uniform float uPulseAmp[3];
uniform vec3 uDim, uLit, uHot, uCore;
attribute float region, dA, rank, fold, seed;
varying vec3 vColor; varying float vAlpha;
void main(){
  bool core = region < -0.5;
  float c = core ? uLevel : uCharge[int(region + 0.5)];
  float lit = core ? smoothstep(0.0, 1.0, uLevel) : step(dA, c - 0.0001);
  float front = core ? 0.0 : exp(-pow((dA - c) * 11.0, 2.0)) * step(0.002, c) * step(c, 0.998);
  float pulse = 0.0;
  for (int i = 0; i < 3; i++) {
    float d = distance(position, uPulse[i].xyz); float r = uPulse[i].w * 1.3;
    pulse += uPulseAmp[i] * exp(-pow((d - r) * 9.0, 2.0)) * (1.0 - clamp(uPulse[i].w / 1.6, 0.0, 1.0));
  }
  float tw = 0.5 + 0.5 * sin(uTime * (1.2 + seed * 2.5) + seed * 50.0);
  float hov = abs(region - uHover) < 0.5 ? 1.0 : 0.0;
  vec3 dim = uDim * (0.45 + 0.55 * fold);
  vec3 litc = uLit * (0.55 + 0.45 * fold) + uLit * tw * uTwinkle;
  vec3 col = core ? mix(dim, mix(uLit, uCore, 0.6) * (0.5 + 0.5 * fold), lit * 0.9) : mix(dim, litc, lit);
  col += uHot * (front * 1.2 + pulse) + uHot * hov * 0.4;
  vColor = col;
  vAlpha = step(rank, uDensity) * (0.34 + 0.5 * fold * (1.0 - lit) + 0.7 * lit + front + pulse + hov * 0.35);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, uSize * uGrow * uScale * (0.8 + 0.45 * lit + front + pulse + hov * 0.3) / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor; varying float vAlpha;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * clamp(vAlpha, 0.0, 1.6);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

const FIT_RADIUS = 1.08;
const REST_YAW = -1.05;
const REST_PITCH = 0.2;
const PULSE_LIFE = 1.6;

/**
 * The brain itself: a three.js point cloud whose provider regions charge up as
 * providers connect, and whose look upgrades with the tier (denser, brighter,
 * twinkling, ringed). Owns no loop: the page calls `step` and `render`.
 */
export class BrainView {
  readonly anchors: Vec3[];
  readonly canvas: HTMLCanvasElement;
  /** CSS px per world unit at the brain's centre, for sizing 2D overlays. */
  pxPerUnit = 200;
  hover = -1;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(34, 1, 0.1, 50);
  private readonly group = new Group();
  private readonly u: Record<string, IUniform>;
  private readonly charge: number[];
  private readonly target: number[];
  private level = 0;
  private levelTarget = 0;
  private tierNow = 0;
  private yaw = REST_YAW;
  private pitch = REST_PITCH;
  private sway = 0;
  private idleUntil = 0;
  private time = 0;
  private nextWave = 0;
  private pulses: { at: Vec3; t: number; amp: number }[] = [];
  private readonly rings: { points: Points; material: PointsMaterial; vis: number }[] = [];
  private readonly glow: Sprite;
  private readonly hits = new Group();
  private readonly ray = new Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly cleanup: (() => void)[] = [];
  private width = 1;
  private height = 1;

  constructor(
    private readonly host: HTMLElement,
    model: BrainModel,
    private readonly opts: BrainViewOptions = {},
  ) {
    const regions = Math.max(1, model.anchors.length);
    this.anchors = model.anchors;
    this.charge = new Array<number>(regions).fill(0);
    this.target = new Array<number>(regions).fill(0);
    // Throws where WebGL is unavailable; the page shows its cards without the brain.
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.className = "brain-canvas";
    host.append(this.canvas);
    this.scene.add(this.group);

    this.u = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uSize: { value: 0.03 },
      uScale: { value: 300 },
      uDensity: { value: 0.45 },
      uTwinkle: { value: 0 },
      uHover: { value: -9 },
      uGrow: { value: 1 },
      uCharge: { value: this.charge.slice() },
      uPulse: { value: [0, 1, 2].map(() => new Vector4(0, 0, 0, 9)) },
      uPulseAmp: { value: [0, 0, 0] },
      uDim: { value: new Color() },
      uLit: { value: new Color() },
      uHot: { value: new Color() },
      uCore: { value: new Color() },
    };
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(model.position, 3));
    geo.setAttribute("region", new BufferAttribute(model.region, 1));
    geo.setAttribute("dA", new BufferAttribute(model.dA, 1));
    geo.setAttribute("rank", new BufferAttribute(model.rank, 1));
    geo.setAttribute("fold", new BufferAttribute(model.fold, 1));
    geo.setAttribute("seed", new BufferAttribute(model.seed, 1));
    const cloud = new ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT.replace("__REGIONS__", String(regions)),
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.group.add(new Points(geo, cloud));
    this.buildRings();
    this.glow = this.buildGlow();
    // Invisible ellipsoids, one per hemisphere, for hover and click picking.
    for (const side of [-1, 1]) {
      const m = new Mesh(new SphereGeometry(1, 20, 14), new MeshBasicMaterial({ visible: false }));
      m.scale.set(HEMI_RADII[0] * 1.05, HEMI_RADII[1] * 1.05, HEMI_RADII[2] * 1.05);
      m.position.set(side * HEMI_OFFSET * 1.2, 0.06, 0);
      this.hits.add(m);
    }
    this.group.add(this.hits);
    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  private buildRings(): void {
    // The upgrades: a halo at Focused, a second ring at Brilliant, motes at Genius.
    const make = (radius: number, count: number, tilt: [number, number], size: number): void => {
      const g = new BufferGeometry();
      const p = new Float32Array(count * 3);
      const R = rng(count);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const j = (R() - 0.5) * 0.04;
        p.set([Math.cos(a) * (radius + j), (R() - 0.5) * 0.02, Math.sin(a) * (radius + j)], i * 3);
      }
      g.setAttribute("position", new BufferAttribute(p, 3));
      const material = new PointsMaterial({
        size,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const points = new Points(g, material);
      points.rotation.set(tilt[0], 0, tilt[1]);
      points.visible = false;
      this.scene.add(points);
      this.rings.push({ points, material, vis: 0 });
    };
    make(0.98, 200, [1.3, 0.25], 0.02);
    make(1.06, 150, [1.05, -0.5], 0.018);
    make(0.9, 36, [0.4, 0.9], 0.04);
  }

  private buildGlow(): Sprite {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    if (x) {
      const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(255,255,255,0.9)");
      gr.addColorStop(0.35, "rgba(255,255,255,0.25)");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = gr;
      x.fillRect(0, 0, 128, 128);
    }
    const s = new Sprite(
      new SpriteMaterial({
        map: new CanvasTexture(c),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    s.scale.setScalar(1.8);
    this.group.add(s);
    return s;
  }

  setPalette(p: BrainPalette): void {
    // The cloud's shader writes its colours without the sRGB step. On dark that
    // deepens them, so the additive glow builds to the accent where points
    // crowd; on light (normal blending, no build-up) they go in as the tokens.
    const space = p.dark ? SRGBColorSpace : LinearSRGBColorSpace;
    (this.u.uDim!.value as Color).setStyle(p.dim, space);
    (this.u.uLit!.value as Color).setStyle(p.lit, space);
    (this.u.uHot!.value as Color).setStyle(p.hot, space);
    (this.u.uCore!.value as Color).setStyle(p.core, space);
    const blending = p.dark ? AdditiveBlending : NormalBlending;
    this.scene.traverse((o) => {
      const m = (o as Points).material as
        ShaderMaterial | PointsMaterial | SpriteMaterial | undefined;
      if (!m || Array.isArray(m) || !m.transparent) return;
      m.blending = blending;
      m.needsUpdate = true;
    });
    for (const r of this.rings) r.material.color.set(p.lit);
    this.glow.material.color.set(p.dark ? p.lit : "#ffffff");
  }

  /** Which regions are charged. `animate` false snaps instead of spreading. */
  setCharged(regions: ReadonlySet<number>, total: number, tier: number): void {
    for (let i = 0; i < this.target.length; i++) this.target[i] = regions.has(i) ? 1 : 0;
    this.levelTarget = total > 0 ? regions.size / total : 0;
    this.tierNow = tier;
  }

  /** Jump straight to the current targets (first paint, reduced motion, background windows). */
  settle(): void {
    for (let i = 0; i < this.charge.length; i++) this.charge[i] = this.target[i] ?? 0;
    this.level = this.levelTarget;
    for (const r of this.rings) r.vis = this.ringWant(this.rings.indexOf(r));
    this.pulses = [];
  }

  pulse(region: number, amp = 1): void {
    const at = this.anchors[region];
    if (!at) return;
    if (this.pulses.length >= 3) this.pulses.shift();
    this.pulses.push({ at, t: 0, amp });
  }

  setHover(region: number): void {
    this.hover = region;
    this.u.uHover!.value = region < 0 ? -9 : region;
  }

  /** Heartbeat swell (1 = rest), applied on top of the tier's growth for this frame. */
  beat = 0;

  private ringWant(i: number): number {
    const t = this.tierNow;
    return [t >= 3 ? 0.55 : 0, t >= 4 ? 0.45 : 0, t >= 5 ? 0.9 : 0][i] ?? 0;
  }

  /**
   * Advance by dt seconds. `live` false holds still (no sway, twinkle or
   * waves) but still finishes any charge in progress. Returns whether anything
   * is still changing.
   */
  step(dt: number, live: boolean): boolean {
    this.time += dt;
    let busy = false;
    const speed = 0.75;
    for (let i = 0; i < this.charge.length; i++) {
      const c = this.charge[i]!;
      const g = this.target[i]!;
      if (c !== g) {
        busy = true;
        this.charge[i] = g > c ? Math.min(g, c + dt * speed) : Math.max(g, c - dt * speed * 1.6);
      }
    }
    if (Math.abs(this.level - this.levelTarget) > 0.001) {
      busy = true;
      this.level += (this.levelTarget - this.level) * Math.min(1, dt * 2);
    } else this.level = this.levelTarget;
    const L = this.level;
    const tier = this.tierNow;
    this.u.uCharge!.value = this.charge.slice();
    this.u.uLevel!.value = L;
    this.u.uDensity!.value = 0.45 + 0.55 * L;
    this.u.uTwinkle!.value = live ? 0.1 + 0.4 * L : 0;
    this.u.uTime!.value = this.time;
    this.u.uGrow!.value = (1 + 0.12 * L) * (1 + 0.05 * this.beat);
    // Thought waves come more often as it upgrades.
    if (live && tier >= 2 && this.time > this.nextWave) {
      const lit = this.target.flatMap((v, i) => (v ? [i] : []));
      if (lit.length) this.pulse(lit[Math.floor(Math.random() * lit.length)]!, 0.35 + 0.1 * tier);
      this.nextWave = this.time + 7 - tier;
    }
    this.pulses = this.pulses.filter((p) => p.t < PULSE_LIFE);
    for (let i = 0; i < 3; i++) {
      const p = this.pulses[i];
      if (p) {
        p.t += dt;
        busy = true;
      }
      (this.u.uPulse!.value as Vector4[])[i]!.set(
        p?.at[0] ?? 0,
        p?.at[1] ?? 0,
        p?.at[2] ?? 0,
        p?.t ?? 9,
      );
      (this.u.uPulseAmp!.value as number[])[i] = p && p.t < PULSE_LIFE ? p.amp : 0;
    }
    this.rings.forEach((r, i) => {
      const want = this.ringWant(i);
      r.vis += (want - r.vis) * Math.min(1, dt * 2);
      if (Math.abs(want - r.vis) > 0.01) busy = true;
      r.material.opacity = r.vis;
      r.points.visible = r.vis > 0.01;
      if (live) r.points.rotation.y += dt * (0.15 + i * 0.12) * (i === 1 ? -1 : 1);
    });
    this.glow.material.opacity =
      (0.05 + 0.3 * L) *
      (1 + 0.9 * this.beat) *
      (live ? 0.85 + 0.15 * Math.sin(this.time * 1.7) : 1);
    this.glow.scale.setScalar(1.3 + 1.1 * L);
    if (live && this.time > this.idleUntil) {
      // Sway around a three-quarter view (a brain reads as a brain from the side).
      this.sway += dt * (0.12 + 0.18 * L);
      const want = REST_YAW + Math.sin(this.sway) * (0.8 + 0.5 * L);
      this.yaw += (want - this.yaw) * Math.min(1, dt * 1.5);
      this.pitch += (REST_PITCH - this.pitch) * Math.min(1, dt * 0.8);
      this.group.position.y = Math.sin(this.time * 0.8) * 0.02;
    }
    this.group.rotation.set(this.pitch, this.yaw, 0);
    return busy;
  }

  render(): void {
    this.group.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
  }

  /** A brain-local point in the host's CSS px. */
  project(v: Vec3): { x: number; y: number } {
    const w = new Vector3(v[0], v[1], v[2])
      .applyMatrix4(this.group.matrixWorld)
      .project(this.camera);
    return { x: ((w.x + 1) / 2) * this.width, y: ((1 - w.y) / 2) * this.height };
  }

  center(): { x: number; y: number } {
    return this.project(BRAIN_CENTER);
  }

  private regionAt(cx: number, cy: number): number {
    const b = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(
      new Vector2(((cx - b.left) / b.width) * 2 - 1, -((cy - b.top) / b.height) * 2 + 1),
      this.camera,
    );
    const hit = this.ray.intersectObjects(this.hits.children, false)[0];
    if (!hit) return -1;
    const p = this.group.worldToLocal(hit.point.clone());
    let best = -1;
    let bestD = 0.62;
    this.anchors.forEach((a, i) => {
      const d = Math.hypot(a[0] - p.x, a[1] - p.y, a[2] - p.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private bindPointer(): void {
    const cv = this.canvas;
    let down: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      cv.addEventListener(type, fn);
      this.cleanup.push(() => cv.removeEventListener(type, fn));
    };
    on("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    on("pointermove", (e) => {
      if (down) {
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (Math.hypot(dx, dy) > 4) down.moved = true;
        if (down.moved) {
          // Drag to turn it; it eases back to its sway a few seconds after you let go.
          this.yaw = down.yaw + dx * 0.008;
          this.pitch = Math.max(-0.7, Math.min(0.9, down.pitch + dy * 0.006));
          this.idleUntil = this.time + 3;
          cv.classList.add("is-dragging");
          this.opts.onInvalidate?.();
        }
        return;
      }
      const r = this.regionAt(e.clientX, e.clientY);
      if (r !== this.hover) {
        this.setHover(r);
        this.opts.onHover?.(r);
        this.opts.onInvalidate?.();
      }
      cv.classList.toggle("is-pickable", r >= 0);
    });
    const end = (e: PointerEvent): void => {
      if (down && !down.moved && e.type === "pointerup") {
        const r = this.regionAt(e.clientX, e.clientY);
        if (r >= 0) this.opts.onPick?.(r);
      }
      down = null;
      cv.classList.remove("is-dragging");
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("pointerleave", () => {
      if (!down && this.hover !== -1) {
        this.setHover(-1);
        this.opts.onHover?.(-1);
        this.opts.onInvalidate?.();
      }
    });
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    const v = (this.camera.fov * Math.PI) / 360;
    const hf = Math.atan(Math.tan(v) * this.camera.aspect);
    const dist = FIT_RADIUS / Math.sin(Math.min(v, hf));
    this.camera.position.set(0, 0.05, dist);
    this.camera.lookAt(0, -0.03, 0);
    this.camera.updateProjectionMatrix();
    this.u.uScale!.value = this.renderer.getDrawingBufferSize(new Vector2()).y / 2;
    this.pxPerUnit = h / (2 * Math.tan(v) * dist);
    this.width = w;
    this.height = h;
    this.opts.onInvalidate?.();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const f of this.cleanup) f();
    this.scene.traverse((o) => {
      const mesh = o as Mesh;
      mesh.geometry?.dispose();
      const m = mesh.material as MeshBasicMaterial | SpriteMaterial | undefined;
      if (m && !Array.isArray(m)) {
        m.map?.dispose();
        m.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
