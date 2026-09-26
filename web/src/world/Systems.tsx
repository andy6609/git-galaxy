// 행성계의 중심별과 궤도 (DIRECTION D16, D19)
// 별은 계정이다 (repo가 아니다). 행성은 그 계정의 repo이고 궤도 하나에 하나, 안쪽 궤도일수록 먼저 만든 것.
// 별을 고르면 그 행성계를 비춘다. 궤도는 행성계마다 사각형 하나에 셰이더로 그린다 (궤도가 7만 개).
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import { fnv1a, mulberry32 } from '../seed'
import { useStore } from '../store'
import { rt } from './runtime'

const starVS = /* glsl */ `
attribute float aCore;
attribute vec3 aTint;
varying vec3 vTint;
uniform float uScale;
uniform float uDpr;
uniform float uUnit;
varying float vCore;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.001);
  float galaxyScale = smoothstep(500.0 * uUnit, 2400.0 * uUnit, dist);
  float corePx = max(2.0 * aCore * uScale / dist, mix(2.6, 1.4, galaxyScale));
  float size = min(corePx * mix(7.0, 4.0, galaxyScale), 360.0);
  vCore = corePx / size;
  vTint = aTint;
  // 아주 가까우면 번짐을 줄이고, 은하 배율에서는 흐리게
  vAlpha = (1.0 - 0.6 * smoothstep(120.0, 360.0, corePx * 7.0)) * mix(1.0, 0.35, galaxyScale);
  gl_PointSize = size * uDpr;
  gl_Position = projectionMatrix * mv;
}
`
const starFS = /* glsl */ `
varying float vCore;
varying float vAlpha;
varying vec3 vTint;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(vCore * 0.55, vCore, d);
  float glow = exp(-d * d * 7.0) * 0.55 * vAlpha;
  vec3 col = mix(vTint, vec3(1.0, 0.97, 0.92), core);
  gl_FragColor = vec4(col, max(core * mix(1.0, vAlpha, 0.6), glow));
  #include <colorspace_fragment>
}
`

const orbitVS = /* glsl */ `
attribute vec3 iCenter;
attribute vec3 iU;
attribute vec3 iV;
attribute float iCount;
attribute float iSys;
uniform float uR0;
uniform float uGap;
uniform float uFocusSys;
uniform float uOthers;
uniform float uScale;
varying vec2 vLocal;
varying float vCount;
varying float vMine;
varying float vAlpha;
void main() {
  float mine = abs(iSys - uFocusSys) < 0.5 ? 1.0 : 0.0;
  float d = length((modelViewMatrix * vec4(iCenter, 1.0)).xyz);
  // 다른 행성계의 궤도는 궤도 간격이 화면에서 몇 px은 될 만큼 가까울 때만
  float gapPx = uGap * uScale / max(d, 0.001);
  vAlpha = mine > 0.5 ? 0.34 : uOthers * smoothstep(1.5, 5.0, gapPx);
  vMine = mine;
  vCount = iCount;
  vLocal = vec2(0.0);
  if (vAlpha < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 q = position.xy * (uR0 + iCount * uGap);
  vLocal = q;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iCenter + iU * q.x + iV * q.y, 1.0);
}
`
const orbitFS = /* glsl */ `
uniform float uR0;
uniform float uGap;
uniform float uFocusRing;
varying vec2 vLocal;
varying float vCount;
varying float vMine;
varying float vAlpha;
void main() {
  float r = length(vLocal);
  float w = max(fwidth(r), 1e-4);
  float f = (r - uR0) / uGap;
  float k = floor(f + 0.5);
  if (k < 0.0 || k > vCount - 1.0) discard;
  float line = 1.0 - smoothstep(0.35 * w, 1.1 * w, abs(f - k) * uGap);
  // 궤도가 화면에서 촘촘하면 선을 옅게 해서 결이 생기지 않게. 다른 행성계는 선이 갈라져 보일 때만
  float density = mix(vMine > 0.5 ? 0.28 : 0.0, 1.0, smoothstep(2.5, 10.0, uGap / w));
  float focus = vMine > 0.5 && abs(k - uFocusRing) < 0.5 ? 2.2 : 1.0;
  float a = line * vAlpha * density * focus;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.85, 0.81, 0.74, min(a, 0.9));
  #include <colorspace_fragment>
}
`

/** 별의 색: 계정 id로 정해지는 별의 온도 (연출). 파랑은 드물고 노랑·주황이 흔하다 */
const TINTS: [number, string][] = [
  [0.08, '#8FB2FF'],
  [0.25, '#CFDDFF'],
  [0.55, '#FFF1D6'],
  [0.82, '#F2C487'],
  [1.0, '#E89A62'],
]
export function starTint(key: string) {
  const u = mulberry32(fnv1a(`star:${key}`))()
  return new THREE.Color(TINTS.find(([p]) => u <= p)![1])
}

/** 중심별의 크기: 구성원 수에 따라 좁은 범위에서만 (0.6–2.1). 첫 궤도(반지름 6)보다 늘 작다 */
export const starCore = (n: number) => 0.6 + 0.22 * Math.log2(Math.max(1, n))

export function Systems({ world }: { world: World }) {
  const focus = useStore((s) => s.focus)
  const phase = useStore((s) => s.phase)
  const system = useStore((s) => s.system)
  const { stars, orbits } = useMemo(() => {
    const n = world.systems.length
    const pos = new Float32Array(n * 3)
    const core = new Float32Array(n)
    const tint = new Float32Array(n * 3)
    world.systems.forEach((s, k) => {
      pos.set(s.c, k * 3)
      core[k] = starCore(s.n)
      const c = starTint(s.id)
      tint.set([c.r, c.g, c.b], k * 3)
    })
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    sg.setAttribute('aCore', new THREE.BufferAttribute(core, 1))
    sg.setAttribute('aTint', new THREE.BufferAttribute(tint, 3))
    const sm = new THREE.ShaderMaterial({
      vertexShader: starVS,
      fragmentShader: starFS,
      uniforms: { uScale: { value: 1 }, uDpr: { value: 1 }, uUnit: { value: world.scale } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    const quad = new THREE.PlaneGeometry(2, 2)
    const og = new THREE.InstancedBufferGeometry()
    og.index = quad.index
    og.setAttribute('position', quad.getAttribute('position'))
    const iCenter = new Float32Array(n * 3)
    const iU = new Float32Array(n * 3)
    const iV = new Float32Array(n * 3)
    const iCount = new Float32Array(n)
    const iSys = new Float32Array(n)
    const u = new THREE.Vector3()
    const v = new THREE.Vector3()
    world.systems.forEach((s, k) => {
      const nrm = new THREE.Vector3(...s.nrm)
      u.crossVectors(nrm, new THREE.Vector3(0, 0, 1))
      if (u.lengthSq() < 1e-6) u.crossVectors(nrm, new THREE.Vector3(1, 0, 0))
      u.normalize()
      v.crossVectors(nrm, u)
      iCenter.set(s.c, k * 3)
      iU.set([u.x, u.y, u.z], k * 3)
      iV.set([v.x, v.y, v.z], k * 3)
      iCount[k] = s.orbits
      iSys[k] = k
    })
    og.setAttribute('iCenter', new THREE.InstancedBufferAttribute(iCenter, 3))
    og.setAttribute('iU', new THREE.InstancedBufferAttribute(iU, 3))
    og.setAttribute('iV', new THREE.InstancedBufferAttribute(iV, 3))
    og.setAttribute('iCount', new THREE.InstancedBufferAttribute(iCount, 1))
    og.setAttribute('iSys', new THREE.InstancedBufferAttribute(iSys, 1))
    og.instanceCount = n
    const om = new THREE.ShaderMaterial({
      vertexShader: orbitVS,
      fragmentShader: orbitFS,
      uniforms: {
        uR0: { value: world.meta.orbit.r0 },
        uGap: { value: world.meta.orbit.gap },
        uFocusSys: { value: -1 },
        uFocusRing: { value: -1 },
        uOthers: { value: 0.16 },
        uScale: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const stars = new THREE.Points(sg, sm)
    const orbits = new THREE.Mesh(og, om)
    stars.frustumCulled = orbits.frustumCulled = false
    return { stars, orbits }
  }, [world])

  useFrame(({ gl }, dt) => {
    const su = (stars.material as THREE.ShaderMaterial).uniforms
    su.uScale.value = rt.pxScale
    su.uDpr.value = gl.getPixelRatio()
    const ou = (orbits.material as THREE.ShaderMaterial).uniforms
    ou.uFocusSys.value = focus !== null ? (world.planets[focus]?.sys ?? -1) : (system ?? rt.hoverStar)
    ou.uFocusRing.value = focus !== null ? (world.planets[focus]?.ring ?? -1) : -1
    ou.uScale.value = rt.pxScale
    // 행성에 도착해 있으면 다른 행성계의 궤도는 지운다 (그 행성의 행성계만 남긴다)
    const want = phase === 'orbit' ? 0 : 0.12
    ou.uOthers.value += (want - ou.uOthers.value) * (1 - Math.exp(-dt * 3))
  })

  return (
    <>
      <primitive object={orbits} renderOrder={0} />
      <primitive object={stars} renderOrder={2} />
    </>
  )
}
