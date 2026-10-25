/** 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT). */
export const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

/** Shared displacement so the shell, its lattice of light points and the glow move as one body. */
const DISPLACE = /* glsl */ `
uniform float uTime;
uniform float uLevel;   // live loudness 0..1 (mic or voice)
uniform float uEnergy;  // state: idle 0.2 .. speaking 1
uniform float uSwirl;   // thinking: faster, twisting surface
float displacement(vec3 p){
  float t = uTime;
  float slow = snoise(p * 1.25 + vec3(t * 0.18, t * 0.12, -t * 0.15));
  float swirl = snoise(p * 2.6 + vec3(-t * (0.35 + uSwirl * 1.4)));
  float ripple = snoise(p * 5.5 + vec3(t * 1.6)) * uLevel;
  return slow * (0.03 + uEnergy * 0.045) + swirl * (0.012 + uSwirl * 0.055) + ripple * 0.14;
}
`;

export const shellVertex = /* glsl */ `
${SIMPLEX}
${DISPLACE}
varying vec3 vView;
varying vec3 vWorldNormal;
varying vec3 vObj;
varying float vDisp;
void main(){
  float d = displacement(position);
  vec3 p = position + normal * d;
  vDisp = d;
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = -mv.xyz;
  vWorldNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

export const shellFragment = /* glsl */ `
${SIMPLEX}
uniform vec3 uDeep;
uniform vec3 uGlow;
uniform float uLevel;
uniform float uEnergy;
uniform float uSwirl;
uniform float uTime;
varying vec3 vView;
varying vec3 vObj;
varying float vDisp;
void main(){
  // true normal of the displaced surface from screen-space derivatives
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 v = normalize(vView);
  float facing = abs(dot(n, v));
  float rim = pow(1.0 - facing, 3.0);
  // plasma veins: thin bright filaments drifting over the surface
  float t = uTime * (0.25 + uSwirl * 0.8);
  float f1 = 1.0 - abs(snoise(vObj * 2.2 + vec3(t, -t * 0.7, t * 0.4)));
  float f2 = 1.0 - abs(snoise(vObj * 4.4 - vec3(t * 0.6, t, -t * 0.3)));
  float veins = pow(f1, 9.0) * 0.9 + pow(f2, 14.0) * 0.6;
  vec3 body = mix(uDeep, uGlow, smoothstep(-0.06, 0.12, vDisp) * 0.4);
  vec3 col = body * (0.06 + uEnergy * 0.14)
    + uGlow * rim * (0.8 + uLevel * 0.55)
    + uGlow * veins * (0.28 + uEnergy * 0.34 + uLevel * 0.4) * (0.35 + 0.65 * facing);
  float alpha = clamp(0.12 + rim * 0.85 + veins * 0.45, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

/** Lattice: the shell's own vertices drawn as tiny lights. */
export const latticeVertex = /* glsl */ `
${SIMPLEX}
${DISPLACE}
uniform float uPixelRatio;
varying float vBright;
void main(){
  float d = displacement(position);
  vec3 p = position + normal * (d + 0.004);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vBright = smoothstep(-0.05, 0.2, d);
  gl_PointSize = (1.4 + vBright * 2.2 + uLevel * 1.0) * uPixelRatio * (3.2 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const latticeFragment = /* glsl */ `
uniform vec3 uGlow;
uniform float uEnergy;
varying float vBright;
void main(){
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r) * (0.18 + vBright * 0.6) * (0.4 + uEnergy * 0.6);
  gl_FragColor = vec4(uGlow * (0.8 + vBright), a);
}
`;

/** Orbiting dust: positions computed on the GPU from radius / speed / phase per particle. */
export const dustVertex = /* glsl */ `
attribute float aRadius;
attribute float aSpeed;
attribute float aPhase;
attribute float aTilt;
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uSpread;
uniform float uPixelRatio;
varying float vFade;
void main(){
  float ang = aPhase + uTime * aSpeed;
  float r = aRadius * (1.0 + uSpread * 0.35 + uLevel * 0.12 * sin(aPhase * 7.0 + uTime * 3.0));
  vec3 p = vec3(cos(ang) * r, sin(ang * 0.7 + aPhase) * 0.18 * r, sin(ang) * r);
  float ct = cos(aTilt), st = sin(aTilt);
  p = vec3(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float twinkle = 0.55 + 0.45 * sin(uTime * (1.0 + aSpeed * 4.0) + aPhase * 13.0);
  vFade = twinkle * smoothstep(3.6, 1.3, aRadius) * (0.4 + uEnergy * 0.6);
  gl_PointSize = (1.3 + twinkle * 2.1) * uPixelRatio * (4.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const dustFragment = /* glsl */ `
uniform vec3 uGlow;
varying float vFade;
void main(){
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  gl_FragColor = vec4(uGlow, smoothstep(0.5, 0.0, r) * vFade);
}
`;

/** Reactor rings: segmented arcs with a travelling highlight. */
export const ringVertex = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const ringFragment = /* glsl */ `
uniform vec3 uGlow;
uniform float uTime;
uniform float uSegments;
uniform float uSpeed;
uniform float uOpacity;
uniform float uEnergy;
varying vec2 vUv;
void main(){
  float a = vUv.x; // 0..1 around the ring (RingGeometry maps angle to u after our remap)
  float seg = step(0.18, fract(a * uSegments));
  float sweep = pow(fract(a - uTime * uSpeed), 6.0);
  float edge = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
  float alpha = (seg * 0.35 + sweep * 1.4) * edge * uOpacity * (0.5 + uEnergy * 0.5);
  gl_FragColor = vec4(uGlow * (1.0 + sweep * 1.5), alpha);
}
`;

/** Inner light: a soft additive sprite in the middle of the core. */
export const glowFragment = /* glsl */ `
uniform vec3 uGlow;
uniform float uLevel;
uniform float uEnergy;
varying vec2 vUv;
void main(){
  float r = length(vUv - 0.5) * 2.0;
  float hot = exp(-r * r * (60.0 - uLevel * 30.0));      // white-hot point
  float core = exp(-r * r * (16.0 - uLevel * 6.0));
  float halo = exp(-r * 3.6) * 0.22;
  vec3 col = mix(uGlow, vec3(1.0), clamp(hot * 1.2, 0.0, 1.0));
  gl_FragColor = vec4(col, (hot * 0.8 + core * (0.26 + uEnergy * 0.26) + halo * uEnergy) * (0.78 + uLevel * 0.25));
}
`;
