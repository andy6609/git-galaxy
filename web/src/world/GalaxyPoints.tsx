// 원경의 확인된 층 (DIRECTION K7). 장식(은하의 빛·하늘)은 Backdrop.tsx.
//   확인된 행성 — 광점. 가까워지면 같은 자리에서 구체로 바뀐다
//   집계 밀도   — 광점에서 파생한 옅은 안개
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import { PALETTES } from '../seed'
import { useStore } from '../store'
import { rt } from './runtime'

const pointVS = /* glsl */ `
attribute float aRadius;
attribute float aHalo;
attribute vec3 aColor;
attribute float aSys;
uniform float uFocusSys;
uniform float uDioramaSys;
uniform float uScale;
uniform float uDpr;
uniform float uMinPx;
uniform float uFar;
uniform float uUnit;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.001);
  float diam = 2.0 * aRadius * uScale / dist;
  // 구체가 보이기 시작하는 6–12px 구간에서 점은 사라진다
  float sphere = smoothstep(6.0, 12.0, diam);
  float far = 1.0 - smoothstep(uFar * 0.5, uFar, dist);
  // 은하 배율에서는 팔의 빛이 주인공이다. 광점은 작고 흐리게 물러난다
  float galaxyScale = smoothstep(400.0 * uUnit, 2000.0 * uUnit, dist);
  // 보고 있는 행성계의 행성은 궤도가 촘촘해도 점으로 또렷하게 (자리는 그대로, 크기·밝기만)
  float mine = abs(aSys - uFocusSys) < 0.5 ? 1.0 : 0.0;
  float inDiorama = abs(aSys - uDioramaSys) < 0.5 ? 1.0 : 0.0;
  vAlpha = (1.0 - inDiorama) * (1.0 - sphere) * mix(mix(0.62, 1.0, aHalo - 1.0) * far * mix(1.0, 0.22, galaxyScale), 1.0, mine);
  vColor = aColor;
  float minPx = mix(uMinPx * aHalo * mix(1.0, 0.7, galaxyScale), 4.5 * aHalo, mine);
  gl_PointSize = max(minPx, diam * 1.2) * uDpr;
  gl_Position = projectionMatrix * mv;
}
`
const pointFS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = ((1.0 - smoothstep(0.2, 0.62, d)) + exp(-d * d * 5.0) * 0.45) * vAlpha;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`

const hazeVS = /* glsl */ `
uniform float uScale;
uniform float uDpr;
uniform float uWorldSize;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.001);
  float size = uWorldSize * uScale / dist;
  // 가까이 오면 안개가 화면을 덮지 않도록 사라진다
  // 행성마다 하나씩이라 밀집한 곳에서 금방 포화된다 (행성 7만 개) → 아주 옅게
  vAlpha = 0.0065 * (1.0 - smoothstep(80.0, 360.0, size)) * smoothstep(2.0, 8.0, size);
  gl_PointSize = min(size, 420.0) * uDpr;
  gl_Position = projectionMatrix * mv;
}
`
const hazeFS = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(uColor, exp(-d * d * 3.2) * vAlpha);
  #include <colorspace_fragment>
}
`

/** stars는 원경 광점의 크기·밝기에만, 최대 2배까지 (DIRECTION K1) */
export const haloFor = (stars: number | null) => 1 + Math.min(1, Math.log10(1 + (stars ?? 0)) / 5)

export function GalaxyPoints({ world }: { world: World }) {
  const { points, haze } = useMemo(() => {
    const n = world.count
    const radius = new Float32Array(n)
    const halo = new Float32Array(n)
    const color = new Float32Array(n * 3)
    const sys = new Float32Array(n)
    const bone = new THREE.Color('#E8E0CF')
    const c = new THREE.Color()
    world.planets.forEach((p, i) => {
      const look = world.looks[i]
      radius[i] = look.radius
      halo[i] = haloFor(p.s)
      sys[i] = p.sys
      c.set(PALETTES[look.palette][1]).lerp(bone, 0.55)
      color.set([c.r, c.g, c.b], i * 3)
    })
    const pos = new THREE.BufferAttribute(world.positions, 3)

    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', pos)
    pg.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1))
    pg.setAttribute('aHalo', new THREE.BufferAttribute(halo, 1))
    pg.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
    pg.setAttribute('aSys', new THREE.BufferAttribute(sys, 1))
    const shared = { uScale: { value: 1 }, uDpr: { value: 1 } }
    const pm = new THREE.ShaderMaterial({
      vertexShader: pointVS,
      fragmentShader: pointFS,
      // 우주 크기에 맞춰 먼 광점이 흐려진다 (가장 먼 은하까지 보이게)
      uniforms: {
        ...shared,
        uMinPx: { value: 2.0 },
        uFar: { value: world.meta.stats.radius * 5 },
        uUnit: { value: world.scale },
        uFocusSys: { value: -1 },
        uDioramaSys: { value: -1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    const hg = new THREE.BufferGeometry()
    hg.setAttribute('position', pos)
    const hm = new THREE.ShaderMaterial({
      vertexShader: hazeVS,
      fragmentShader: hazeFS,
      uniforms: { ...shared, uWorldSize: { value: 70 * world.scale }, uColor: { value: new THREE.Color('#6F8FB4') } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    return {
      points: new THREE.Points(pg, pm),
      haze: new THREE.Points(hg, hm),
    }
  }, [world])

  useFrame(({ gl }) => {
    const u = (points.material as THREE.ShaderMaterial).uniforms
    u.uScale.value = rt.pxScale
    u.uDpr.value = gl.getPixelRatio()
    const { focus, system } = useStore.getState()
    u.uFocusSys.value = focus !== null ? (world.planets[focus]?.sys ?? -1) : (system ?? -1)
    u.uDioramaSys.value = focus === null ? (system ?? -1) : -1
  })

  return (
    <>
      <primitive object={haze} frustumCulled={false} renderOrder={-1} />
      <primitive object={points} frustumCulled={false} renderOrder={1} />
    </>
  )
}
