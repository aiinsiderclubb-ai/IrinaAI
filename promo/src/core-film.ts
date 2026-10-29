/**
 * The cabinet's "core" (web/src/core/CoreScene.ts) rebuilt for film: same geometry and shaders,
 * but every frame is a pure function of the time and state passed in, so HyperFrames can seek it.
 * Bundled to assets/js/core.js as window.FilmCore.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { dustFragment, dustVertex, glowFragment, latticeFragment, latticeVertex, ringFragment, ringVertex, shellFragment, shellVertex } from '../../web/src/core/shaders';

type State = 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking';
interface Look { deep: string; glow: string; energy: number; swirl: number; spread: number; spin: number }

// same values as the cabinet
const LOOKS: Record<State, Look> = {
  idle: { deep: '#06222c', glow: '#3cc8e8', energy: 0.25, swirl: 0.0, spread: 0.0, spin: 0.25 },
  listening: { deep: '#06303a', glow: '#55e6ff', energy: 0.55, swirl: 0.05, spread: 0.05, spin: 0.35 },
  hearing: { deep: '#073c47', glow: '#8ff6ff', energy: 0.75, swirl: 0.1, spread: -0.12, spin: 0.5 },
  thinking: { deep: '#1a0f45', glow: '#a48bff', energy: 0.8, swirl: 1.0, spread: 0.2, spin: 1.6 },
  speaking: { deep: '#06333f', glow: '#8eefff', energy: 0.9, swirl: 0.15, spread: 0.35, spin: 0.7 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** keyframes: [[time, state], ...] sorted; each state change blends over `blend` seconds */
export interface FrameInput {
  /** shader clock (noise, pulse) */
  time: number;
  /** clock the keys are written in; defaults to time */
  at?: number;
  keys: [number, State][];
  blend?: number;
  level?: number;
  /** extra uniform scale of the whole core */
  scale?: number;
}

class FilmCore {
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
    uEnergy: { value: 0.25 },
    uSwirl: { value: 0 },
    uSpread: { value: 0 },
    uDeep: { value: new THREE.Color(LOOKS.idle.deep) },
    uGlow: { value: new THREE.Color(LOOKS.idle.glow) },
    uPixelRatio: { value: 1 },
  };

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    // the film's ground #04090D; the composer encodes to sRGB once more on output, so give it pre-linearised
    this.renderer.setClearColor(new THREE.Color().setRGB(0.000085, 0.00019, 0.00029), 1);
    this.camera.aspect = width / height;
    this.camera.position.set(0, 0, 6.2);
    this.camera.updateProjectionMatrix();
    this.scene.add(this.group);
    this.build();
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(width, height);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.7, 0.55, 0.14);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  private build(): void {
    const u = this.uniforms;
    const rnd = mulberry32(7);
    this.group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1, 80), new THREE.ShaderMaterial({ uniforms: u, vertexShader: shellVertex, fragmentShader: shellFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    this.group.add(new THREE.Points(new THREE.IcosahedronGeometry(1, 30), new THREE.ShaderMaterial({ uniforms: u, vertexShader: latticeVertex, fragmentShader: latticeFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9), new THREE.ShaderMaterial({ uniforms: u, vertexShader: ringVertex, fragmentShader: glowFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

    const count = 4200;
    const radius = new Float32Array(count);
    const speed = new Float32Array(count);
    const phase = new Float32Array(count);
    const tilt = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 1.35 + Math.pow(rnd(), 1.8) * 2.1;
      radius[i] = r;
      speed[i] = ((0.04 + rnd() * 0.16) * (rnd() < 0.5 ? 1 : -1)) / r;
      phase[i] = rnd() * Math.PI * 2;
      tilt[i] = (rnd() - 0.5) * 1.2;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    dustGeo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    dustGeo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    dustGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    dustGeo.setAttribute('aTilt', new THREE.BufferAttribute(tilt, 1));
    dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5);
    this.scene.add(new THREE.Points(dustGeo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: dustVertex, fragmentShader: dustFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

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

  /** the look at time t: the last key's state, blended in from the previous one */
  private lookAt(t: number, keys: [number, State][], blend: number): Look & { spinInt: number } {
    let cur = LOOKS[keys[0]![1]];
    let spinInt = 0; // integral of spin over time, for rotation
    let lastT = 0;
    let lastSpin = cur.spin;
    for (let i = 1; i < keys.length; i++) {
      const [kt, ks] = keys[i]!;
      if (kt > t) break;
      spinInt += lastSpin * (kt - lastT);
      lastT = kt;
      const next = LOOKS[ks];
      const k = smooth((t - kt) / blend);
      cur = {
        deep: '#' + new THREE.Color(cur.deep).lerp(new THREE.Color(next.deep), k).getHexString(),
        glow: '#' + new THREE.Color(cur.glow).lerp(new THREE.Color(next.glow), k).getHexString(),
        energy: lerp(cur.energy, next.energy, k),
        swirl: lerp(cur.swirl, next.swirl, k),
        spread: lerp(cur.spread, next.spread, k),
        spin: lerp(cur.spin, next.spin, k),
      };
      lastSpin = next.spin;
    }
    spinInt += cur.spin * Math.max(0, t - lastT);
    return { ...cur, spinInt };
  }

  render(f: FrameInput): void {
    const look = this.lookAt(f.at ?? f.time, f.keys, f.blend ?? 0.6);
    const u = this.uniforms;
    const level = f.level ?? 0;
    u.uTime.value = f.time;
    u.uLevel.value = level;
    u.uEnergy.value = look.energy;
    u.uSwirl.value = look.swirl;
    u.uSpread.value = look.spread;
    u.uDeep.value.set(look.deep);
    u.uGlow.value.set(look.glow);
    this.group.rotation.y = 0.12 * look.spinInt;
    this.group.rotation.x = 0.06;
    this.group.rotation.z = -0.03;
    for (const r of this.rings) r.rotation.z = (r.userData.spin as number) * look.spinInt;
    const pulse = (1 + level * 0.06 + Math.sin(f.time * 1.3) * 0.008) * (f.scale ?? 1);
    this.group.scale.setScalar(pulse);
    for (const r of this.rings) r.scale.setScalar(f.scale ?? 1);
    this.bloom.strength = Math.min(1.0, 0.45 + look.energy * 0.3 + level * 0.35);
    this.composer.render();
  }
}

(window as unknown as { FilmCore: typeof FilmCore }).FilmCore = FilmCore;
