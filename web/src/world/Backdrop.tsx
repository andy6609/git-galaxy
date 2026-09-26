// 원경 연출 (DIRECTION D15, D17). 선택할 수 없고 repo 수로 세지 않는다 (K7).
//   은하의 빛  실제 행성계가 모인 곳을 따라 빛나는 원반. 은하마다 빛깔이 다르다
//              모양을 덧씌우지 않는다 — 빛은 행성계와 지역이 있는 자리에서만 난다 (B)
//   하늘       카메라를 따라다니는 배경 별(은하수 띠, 밝은 별의 십자 광채)
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import { mulberry32 } from '../seed'
import { rt } from './runtime'

// ---------------------------------------------------------------- 셰이더

/** 화면 크기(px)가 고정된 작은 별. 아주 가까우면 사라진다 */
const dustVS = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uDpr;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  vColor = aColor;
  vAlpha = aAlpha * smoothstep(6.0, 60.0, dist);
  gl_PointSize = aSize * uDpr;
  gl_Position = projectionMatrix * mv;
}
`
const dustFS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, (1.0 - smoothstep(0.1, 1.0, d)) * vAlpha);
  #include <colorspace_fragment>
}
`

/** 월드 크기를 가진 부드러운 빛(또는 먼지). 화면을 덮을 만큼 커지면 사라진다 */
const glowVS = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
uniform float uDpr;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.001);
  float px = aSize * uScale / dist;
  vColor = aColor;
  vAlpha = aAlpha * (1.0 - smoothstep(180.0, 520.0, px)) * smoothstep(1.5, 6.0, px);
  gl_PointSize = min(px, 520.0) * uDpr;
  gl_Position = projectionMatrix * mv;
}
`
const glowFS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, exp(-d * d * 3.5) * vAlpha);
  #include <colorspace_fragment>
}
`

/** 배경의 밝은 별: 둥근 빛 + 십자 광채 */
const brightFS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = (gl_PointCoord - 0.5) * 2.0;
  float d = length(c);
  float core = exp(-d * d * 60.0);
  float halo = exp(-d * d * 9.0) * 0.35;
  float spikes = (exp(-abs(c.x) * 40.0) + exp(-abs(c.y) * 40.0)) * (1.0 - smoothstep(0.0, 1.0, d)) * 0.8;
  gl_FragColor = vec4(vColor, (core + halo + spikes) * vAlpha);
  #include <colorspace_fragment>
}
`

type Buf = { pos: number[]; color: number[]; size: number[]; alpha: number[] }
const buf = (): Buf => ({ pos: [], color: [], size: [], alpha: [] })

function points(b: Buf, vs: string, fs: string, blending: THREE.Blending, uniforms: Record<string, THREE.IUniform>) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(b.color, 3))
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(b.size, 1))
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(b.alpha, 1))
  const m = new THREE.ShaderMaterial({
    vertexShader: vs,
    fragmentShader: fs,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending,
  })
  const p = new THREE.Points(g, m)
  p.frustumCulled = false
  return p
}

function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const col = (hex: string) => {
  const c = new THREE.Color(hex)
  return [c.r, c.g, c.b]
}

// 별의 색: 파랑 → 하양 → 노랑 → 주황 (드문 것부터)
const STAR_COLORS: [number, number[]][] = [
  [0.1, col('#A9C1FF')],
  [0.3, col('#DCE6FF')],
  [0.62, col('#FFF6E8')],
  [0.86, col('#FFE0B5')],
  [1.0, col('#FFC08C')],
]
const starColor = (u: number) => STAR_COLORS.find(([p]) => u <= p)![1]

// ---------------------------------------------------------------- 은하의 빛

/** 은하마다 다른 빛깔 (연출). 네온은 피한다 */
const GALAXY_TINTS = ['#BBD0EA', '#F2D6A8', '#CFE3D6', '#E8C8CF', '#D8D3EA', '#F0E6D8', '#C7DCEF', '#EAD9B8']

function basis(n: [number, number, number]) {
  const nv = new THREE.Vector3(...n).normalize()
  const u = new THREE.Vector3().crossVectors(nv, new THREE.Vector3(0, 0, 1))
  if (u.lengthSq() < 1e-6) u.crossVectors(nv, new THREE.Vector3(1, 0, 0))
  u.normalize()
  return { n: nv, u, v: new THREE.Vector3().crossVectors(nv, u) }
}

function galaxyLight(world: World) {
  const rand = mulberry32(20260926)
  const dust = buf()
  const glow = buf()
  const add = (b: Buf, x: number, y: number, z: number, c: number[], size: number, alpha: number) => {
    b.pos.push(x, y, z)
    b.color.push(...c)
    b.size.push(size)
    b.alpha.push(alpha)
  }
  const warm = col('#FFE2B8')
  const tint = world.galaxies.map((g) => col(GALAXY_TINTS[g.id % GALAXY_TINTS.length]))
  const glowTint = world.galaxies.map((g) => {
    const c = new THREE.Color(GALAXY_TINTS[g.id % GALAXY_TINTS.length]).multiplyScalar(0.55)
    return [c.r, c.g, c.b]
  })
  const white = col('#EEF2F6')
  const pink = col('#F0A0B0')

  // 행성계 둘레의 별빛: 빛은 데이터가 있는 자리에서만 난다
  world.systems.forEach((sys, k) => {
    const c = tint[sys.gal] ?? white
    const r = world.systemRadius(k) * 1.8 + 6
    // 행성이 많은 행성계일수록 빛이 쌓이므로 수는 천천히 늘리고 하나하나는 옅게
    const m = Math.round(8 + Math.sqrt(sys.n) * 4)
    for (let j = 0; j < m; j++) {
      add(dust, sys.c[0] + gauss(rand) * r, sys.c[1] + gauss(rand) * r * 0.4, sys.c[2] + gauss(rand) * r,
        rand() < 0.35 ? white : c, 0.9 + rand() * 1.3, 0.04 + rand() * 0.12)
    }
  })
  // 지역: 부드러운 빛과 드문 성운
  for (const reg of world.regions) {
    const g = world.galaxies[reg.gal]
    if (!g) continue
    const b = basis(g.nrm)
    const n = Math.round(6 + reg.r / (25 * world.scale))
    for (let k = 0; k < n; k++) {
      const a = gauss(rand) * reg.r * 0.45
      const bb = gauss(rand) * reg.r * 0.45
      const x = reg.c[0] + b.u.x * a + b.v.x * bb
      const y = reg.c[1] + b.u.y * a + b.v.y * bb
      const z = reg.c[2] + b.u.z * a + b.v.z * bb
      add(glow, x, y, z, glowTint[reg.gal], reg.r * (0.35 + rand() * 0.4), 0.025 + rand() * 0.025)
    }
    if (rand() < 0.5) {
      const cx = reg.c[0] + gauss(rand) * reg.r * 0.3
      const cz = reg.c[2] + gauss(rand) * reg.r * 0.3
      const q = world.scale
      for (let j = 0; j < 60; j++) add(dust, cx + gauss(rand) * 16 * q, reg.c[1] + gauss(rand) * 6 * q, cz + gauss(rand) * 16 * q, pink, 1 + rand() * 1.4, 0.25 + rand() * 0.35)
      add(glow, cx, reg.c[1], cz, col('#B0566A'), 90 * q, 0.1)
    }
  }
  // 은하: 원반의 흐린 별빛, 무게중심의 따뜻한 빛, 멀리서 보이는 큰 빛무리
  for (const g of world.galaxies) {
    const b = basis(g.nrm)
    const members = world.systems.filter((s) => s.gal === g.id)
    const n = Math.min(16000, members.length * 10)
    for (let k = 0; k < n; k++) {
      // 실제 행성계 하나를 골라 그 둘레에 넓게 뿌린다 (원반은 행성계가 있는 곳을 따라간다)
      const s = members[Math.floor(rand() * members.length)]
      const spread = g.r * 0.12
      const a = gauss(rand) * spread
      const bb = gauss(rand) * spread
      const h = gauss(rand) * spread * 0.15
      add(dust, s.c[0] + b.u.x * a + b.v.x * bb + b.n.x * h, s.c[1] + b.u.y * a + b.v.y * bb + b.n.y * h,
        s.c[2] + b.u.z * a + b.v.z * bb + b.n.z * h, tint[g.id], 0.8 + rand(), 0.03 + rand() * 0.06)
    }
    add(glow, g.c[0], g.c[1], g.c[2], warm, g.r * 0.45, 0.07)
    add(glow, g.c[0], g.c[1], g.c[2], glowTint[g.id], g.r * 2.1, 0.05)
  }
  return { dust, glow }
}

// ---------------------------------------------------------------- 하늘

function sky(world: World) {
  const rand = mulberry32(7)
  const D = Math.min(world.meta.stats.radius * 3, 9000)
  const faint = buf()
  const bright = buf()
  // 은하수 띠: 기울어진 대원 둘레에 몰린다
  const band = new THREE.Vector3(0.3, 0.9, 0.2).normalize()
  const bu = new THREE.Vector3().crossVectors(band, new THREE.Vector3(1, 0, 0)).normalize()
  const bv = new THREE.Vector3().crossVectors(band, bu)
  const dir = new THREE.Vector3()
  for (let i = 0; i < 9000; i++) {
    if (rand() < 0.45) {
      const a = rand() * Math.PI * 2
      const lat = gauss(rand) * 0.12
      dir.copy(bu).multiplyScalar(Math.cos(a) * Math.cos(lat)).addScaledVector(bv, Math.sin(a) * Math.cos(lat)).addScaledVector(band, Math.sin(lat))
    } else {
      const y = rand() * 2 - 1
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(1 - y * y)
      dir.set(r * Math.cos(a), y, r * Math.sin(a))
    }
    const m = Math.pow(rand(), 4) // 대부분 흐리고 드물게 밝다
    const c = starColor(rand())
    faint.pos.push(dir.x * D, dir.y * D, dir.z * D)
    faint.color.push(...c)
    faint.size.push(0.9 + m * 2.2)
    faint.alpha.push(0.15 + m * 0.75)
  }
  for (let i = 0; i < 26; i++) {
    const y = rand() * 2 - 1
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(1 - y * y)
    bright.pos.push(r * Math.cos(a) * D, y * D, r * Math.sin(a) * D)
    bright.color.push(...(rand() < 0.5 ? col('#BFD4FF') : starColor(rand())))
    bright.size.push(14 + rand() * 22)
    bright.alpha.push(0.6 + rand() * 0.4)
  }
  const dpr = { value: 1 }
  const faintPts = points(faint, dustVS.replace('smoothstep(6.0, 60.0, dist)', '1.0'), dustFS, THREE.AdditiveBlending, { uDpr: dpr })
  const brightPts = points(bright, dustVS.replace('smoothstep(6.0, 60.0, dist)', '1.0'), brightFS, THREE.AdditiveBlending, { uDpr: dpr })

  const group = new THREE.Group()
  group.add(faintPts, brightPts)
  return { group, dpr }
}

export function Backdrop({ world }: { world: World }) {
  const { light, skyGroup, uniforms } = useMemo(() => {
    const L = galaxyLight(world)
    const shared = { uDpr: { value: 1 }, uScale: { value: 1 } }
    const light = new THREE.Group()
    const glow = points(L.glow, glowVS, glowFS, THREE.AdditiveBlending, shared)
    const dust = points(L.dust, dustVS, dustFS, THREE.AdditiveBlending, shared)
    glow.renderOrder = -4
    dust.renderOrder = -3
    light.add(glow, dust)
    const s = sky(world)
    s.group.renderOrder = -10
    s.group.traverse((o) => (o.renderOrder = -10))
    return { light, skyGroup: s.group, uniforms: { shared, skyDpr: s.dpr } }
  }, [world])

  useFrame(({ camera, gl }) => {
    uniforms.shared.uDpr.value = gl.getPixelRatio()
    uniforms.shared.uScale.value = rt.pxScale
    uniforms.skyDpr.value = gl.getPixelRatio()
    // 하늘은 카메라를 따라다닌다 (시차 없음 = 아주 멀다)
    skyGroup.position.copy(camera.position)
  })

  return (
    <>
      <primitive object={skyGroup} />
      <primitive object={light} />
    </>
  )
}
