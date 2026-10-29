import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { VoiceStatus } from '../voice/types';
import { dustFragment, dustVertex, glowFragment, latticeFragment, latticeVertex, ringFragment, ringVertex, shellFragment, shellVertex } from './shaders';

interface Look {
  deep: string;
  glow: string;
  energy: number;
  swirl: number;
  spread: number;
  spin: number;
}

/** What the core looks like in each conversation state. */
const LOOKS: Record<VoiceStatus, Look> = {
  idle: { deep: '#06222c', glow: '#3cc8e8', energy: 0.25, swirl: 0.0, spread: 0.0, spin: 0.25 },
  connecting: { deep: '#141038', glow: '#7d8cff', energy: 0.45, swirl: 0.5, spread: 0.1, spin: 0.9 },
  listening: { deep: '#06303a', glow: '#55e6ff', energy: 0.55, swirl: 0.05, spread: 0.05, spin: 0.35 },
  hearing: { deep: '#073c47', glow: '#8ff6ff', energy: 0.75, swirl: 0.1, spread: -0.12, spin: 0.5 },
  thinking: { deep: '#1a0f45', glow: '#a48bff', energy: 0.8, swirl: 1.0, spread: 0.2, spin: 1.6 },
  speaking: { deep: '#06333f', glow: '#8eefff', energy: 0.9, swirl: 0.15, spread: 0.35, spin: 0.7 },
  error: { deep: '#3a0b10', glow: '#ff6b6b', energy: 0.4, swirl: 0.0, spread: 0.0, spin: 0.2 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ring with uv.x = position around the circle, uv.y = across its width (for segment/sweep shading). */
function ringGeometry(inner: number, outer: number, segments = 256): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c * inner, s * inner, 0, c * outer, s * outer, 0);
    uv.push(i / segments, 0, i / segments, 1);
    if (i < segments) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * The assistant's "core": a living light sphere that breathes with the conversation.
 * Shell + lattice share one GPU displacement; dust orbits around; reactor rings spin; bloom on top.
 */
export class CoreScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private group = new THREE.Group();
  private rings: THREE.Mesh[] = [];
  private uniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uEnergy: { value: LOOKS.idle.energy },
    uSwirl: { value: 0 },
    uSpread: { value: 0 },
    uDeep: { value: new THREE.Color(LOOKS.idle.deep) },
    uGlow: { value: new THREE.Color(LOOKS.idle.glow) },
    uPixelRatio: { value: 1 },
  };
  private target: Look = LOOKS.idle;
  private targetDeep = new THREE.Color(LOOKS.idle.deep);
  private targetGlow = new THREE.Color(LOOKS.idle.glow);
  private spin = LOOKS.idle.spin;
  private level = 0;
  private raf = 0;
  private last = performance.now();
  private pointer = new THREE.Vector2();
  private disposed = false;
  private resizeObs: ResizeObserver;

  constructor(
    private host: HTMLElement,
    private getLevel: () => number = () => 0,
    opts: { lite?: boolean } = {},
  ) {
    const lite = opts.lite ?? (matchMedia('(max-width: 760px)').matches || navigator.hardwareConcurrency <= 4);
    this.renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: true, powerPreference: 'high-performance' });
    const dpr = Math.min(window.devicePixelRatio, lite ? 1.5 : 2);
    this.renderer.setPixelRatio(dpr);
    this.uniforms.uPixelRatio.value = dpr;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 0, 6.2);
    this.scene.add(this.group);
    this.build(lite);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.55, 0.14);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    window.addEventListener('pointermove', this.onPointer);
    this.loop();
  }

  private build(lite: boolean): void {
    const u = this.uniforms;
    const detail = lite ? 48 : 80;

    const shellGeo = new THREE.IcosahedronGeometry(1, detail);
    const shell = new THREE.Mesh(
      shellGeo,
      new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: shellVertex,
        fragmentShader: shellFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.group.add(shell);

    const lattice = new THREE.Points(
      new THREE.IcosahedronGeometry(1, lite ? 20 : 30),
      new THREE.ShaderMaterial({ uniforms: u, vertexShader: latticeVertex, fragmentShader: latticeFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.group.add(lattice);

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 1.9),
      new THREE.ShaderMaterial({ uniforms: u, vertexShader: ringVertex, fragmentShader: glowFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.scene.add(glow); // not in the rotating group: always faces the camera

    const count = lite ? 1800 : 4200;
    const radius = new Float32Array(count);
    const speed = new Float32Array(count);
    const phase = new Float32Array(count);
    const tilt = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 1.35 + Math.pow(Math.random(), 1.8) * 2.1;
      radius[i] = r;
      speed[i] = ((0.04 + Math.random() * 0.16) * (Math.random() < 0.5 ? 1 : -1)) / r;
      phase[i] = Math.random() * Math.PI * 2;
      tilt[i] = (Math.random() - 0.5) * 1.2;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    dustGeo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    dustGeo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    dustGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    dustGeo.setAttribute('aTilt', new THREE.BufferAttribute(tilt, 1));
    dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5);
    const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: dustVertex, fragmentShader: dustFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(dust);

    const ringDefs = [
      { inner: 1.42, outer: 1.445, segments: 64, speed: 0.06, opacity: 0.9, tilt: [1.25, 0.15] },
      { inner: 1.62, outer: 1.635, segments: 14, speed: -0.035, opacity: 0.7, tilt: [1.05, -0.5] },
      { inner: 1.86, outer: 1.87, segments: 160, speed: 0.02, opacity: 0.45, tilt: [1.45, 0.6] },
    ];
    for (const d of ringDefs) {
      const ring = new THREE.Mesh(
        ringGeometry(d.inner, d.outer),
        new THREE.ShaderMaterial({
          uniforms: { ...u, uSegments: { value: d.segments }, uSpeed: { value: d.speed }, uOpacity: { value: d.opacity } },
          vertexShader: ringVertex,
          fragmentShader: ringFragment,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.set(d.tilt[0]!, d.tilt[1]!, 0);
      ring.userData.spin = d.speed * 4;
      this.rings.push(ring);
      this.scene.add(ring);
    }
  }

  setState(status: VoiceStatus): void {
    this.target = LOOKS[status];
    this.targetDeep.set(this.target.deep);
    this.targetGlow.set(this.target.glow);
  }

  private onPointer = (e: PointerEvent) => {
    this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  };

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    // keep the whole core visible on tall phone screens
    this.camera.position.z = w / h < 0.8 ? 6.2 / Math.max(0.55, w / h / 0.8) : 6.2;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.watchPerformance(now - this.lastFrame);
    this.lastFrame = now;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const k = 1 - Math.exp(-dt * 3.2); // smooth state transitions

    // loudness: fast attack, slower release
    const raw = this.getLevel();
    this.level = raw > this.level ? lerp(this.level, raw, 0.5) : lerp(this.level, raw, 0.08);

    const u = this.uniforms;
    u.uTime.value += dt * (reduce ? 0.3 : 1);
    u.uLevel.value = this.level;
    u.uEnergy.value = lerp(u.uEnergy.value, this.target.energy, k);
    u.uSwirl.value = lerp(u.uSwirl.value, this.target.swirl, k);
    u.uSpread.value = lerp(u.uSpread.value, this.target.spread, k);
    u.uDeep.value.lerp(this.targetDeep, k);
    u.uGlow.value.lerp(this.targetGlow, k);
    this.spin = lerp(this.spin, this.target.spin, k);

    this.group.rotation.y += dt * 0.12 * this.spin;
    this.group.rotation.x = lerp(this.group.rotation.x, this.pointer.y * 0.18, 0.04);
    this.group.rotation.z = lerp(this.group.rotation.z, -this.pointer.x * 0.12, 0.04);
    for (const r of this.rings) r.rotation.z += dt * (r.userData.spin as number) * this.spin;
    const pulse = 1 + this.level * 0.06 + Math.sin(u.uTime.value * 1.3) * 0.008;
    this.group.scale.setScalar(pulse);
    // bounded: additive layers + bloom must never wash the core out to a white blob
    this.bloom.strength = Math.min(1.0, 0.45 + u.uEnergy.value * 0.3 + this.level * 0.35);

    this.composer.render();
  };

  private lastFrame = performance.now();
  private slowFrames = 0;
  private frames = 0;
  private degraded = false;

  /** Weak laptops: if the core keeps dropping frames, turn bloom off and render at 1x so audio and UI stay smooth. */
  private watchPerformance(frameMs: number): void {
    if (this.degraded || document.hidden) return;
    this.frames++;
    if (frameMs > 34) this.slowFrames++;
    if (this.frames < 180) return;
    if (this.slowFrames / this.frames > 0.3) {
      this.degraded = true;
      this.bloom.enabled = false;
      this.renderer.setPixelRatio(1);
      this.uniforms.uPixelRatio.value = 1;
      this.resize();
    }
    this.frames = 0;
    this.slowFrames = 0;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    window.removeEventListener('pointermove', this.onPointer);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}
