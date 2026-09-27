// 가까운 행성은 구체로 그린다. 선택 행성은 같은 셰이더의 고해상도 구.
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import type { Look } from '../seed'
import { getState } from '../store'
import { createPlanetGeometry, createPlanetMaterial, INSTANCE_ATTRIBUTES, VIEW_LIGHT } from './planetMaterial'
import { rt } from './runtime'

const CAPACITY = 800
const MIN_PX = 5

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 인스턴스 슬롯 하나를 채운다 */
export function writeInstance(
  geo: THREE.InstancedBufferGeometry,
  slot: number,
  center: ArrayLike<number>,
  look: Look,
  fade: number,
  rot: ArrayLike<number> = IDENTITY,
  star: ArrayLike<number> | null = null,
) {
  const a = geo.attributes as Record<string, THREE.InstancedBufferAttribute>
  const o = slot * 4
  const set = (name: string, x: number, y: number, z: number, w: number) => {
    const arr = a[name].array as Float32Array
    arr[o] = x
    arr[o + 1] = y
    arr[o + 2] = z
    arr[o + 3] = w
  }
  set('iCenter', center[0], center[1], center[2], look.radius)
  set('iShape', look.arch, look.palette, look.steps, fade)
  set('iAxis', look.axis[0], look.axis[1], look.axis[2], look.style)
  set('iParams', ...look.params)
  set('iGrain', ...look.grain)
  set('iNoise', look.noise[0], look.noise[1], look.noise[2], 0)
  set('iRot', rot[0], rot[1], rot[2], rot[3])
  if (star) set('iStar', star[0], star[1], star[2], 1)
  else set('iStar', 0, 0, 0, 0)
  set('iStyle', ...look.styleAxis)
  set('iSecond', ...look.second)
}

const IDENTITY = [0, 0, 0, 1]

export function markDirty(geo: THREE.InstancedBufferGeometry) {
  for (const name of INSTANCE_ATTRIBUTES) {
    ;(geo.attributes[name] as THREE.InstancedBufferAttribute).needsUpdate = true
  }
}

/** 행성 i를 은하 안의 모습 그대로 슬롯에 쓴다 (방향·별빛 포함) */
export function writePlanet(geo: THREE.InstancedBufferGeometry, slot: number, world: World, i: number, fade: number) {
  const sys = world.planets[i].sys
  writeInstance(
    geo,
    slot,
    world.positions.subarray(i * 3, i * 3 + 3),
    world.looks[i],
    fade,
    world.rotation(i),
    sys >= 0 ? world.systems[sys].c : null,
  )
}

export function Planets({ world }: { world: World }) {
  const material = useMemo(createPlanetMaterial, [])
  // 선택 행성만 도착 연출(빛이 서서히 들어옴)을 받는다
  const focusMaterial = useMemo(createPlanetMaterial, [])
  const lo = useMemo(() => createPlanetGeometry(40, 28, CAPACITY), [])
  const hi = useMemo(() => createPlanetGeometry(320, 200, 1), [])
  const scratch = useMemo(
    () => ({ diam: new Float32Array(world.count), order: new Int32Array(world.count), fwd: new THREE.Vector3(), light: new THREE.Vector3() }),
    [world],
  )

  useFrame(({ camera, size }) => {
    const cam = camera as THREE.PerspectiveCamera
    const { diam, order, fwd } = scratch
    const P = world.positions
    const cx = cam.position.x
    const cy = cam.position.y
    const cz = cam.position.z
    cam.getWorldDirection(fwd)
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)
    const aspect = size.width / size.height
    const cosLimit = Math.cos(Math.atan(tanV * Math.sqrt(1 + aspect * aspect)) + 0.08)
    const { focus, system } = getState()
    let n = 0
    for (let i = 0; i < world.count; i++) {
      // 계정 초상에서는 같은 repo를 canonical 좌표와 디오라마에 두 번 그리지 않는다.
      if (system !== null && focus === null && world.planets[i].sys === system) continue
      const dx = P[i * 3] - cx
      const dy = P[i * 3 + 1] - cy
      const dz = P[i * 3 + 2] - cz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < 1e-4) continue
      const r = world.looks[i].radius
      // 시야 원뿔 밖이면 건너뛴다 (가까운 큰 구는 반지름만큼 여유)
      if ((dx * fwd.x + dy * fwd.y + dz * fwd.z) / dist < cosLimit - r / dist) continue
      const d = (2 * r * rt.pxScale) / dist
      if (d < MIN_PX) continue
      diam[i] = d
      order[n++] = i
    }
    const idx = Array.from(order.subarray(0, n)).sort((a, b) => diam[b] - diam[a])
    let slot = 0
    let focusVisible = false
    for (const i of idx) {
      if (i === focus) {
        focusVisible = true
        continue
      }
      if (slot >= CAPACITY) break
      writePlanet(lo, slot++, world, i, smoothstep(6, 12, diam[i]))
    }
    lo.instanceCount = slot
    markDirty(lo)
    if (focus !== null && focusVisible) {
      writePlanet(hi, 0, world, focus, smoothstep(6, 12, diam[focus]))
      hi.instanceCount = 1
      markDirty(hi)
    } else {
      hi.instanceCount = 0
    }
    rt.visibleSpheres = idx

    // 행성계가 없는 행성은 카메라 기준 좌상단 주광. 선택 행성은 도착 직전 어둡다가 빛이 들어온다
    scratch.light.set(...VIEW_LIGHT).normalize().applyQuaternion(cam.quaternion)
    material.uniforms.uLight.value.copy(scratch.light)
    focusMaterial.uniforms.uLight.value.copy(scratch.light)
    focusMaterial.uniforms.uExposure.value = 0.18 + 0.82 * rt.rig.reveal
  })

  return (
    <>
      <mesh geometry={lo} material={material} frustumCulled={false} />
      <mesh geometry={hi} material={focusMaterial} frustumCulled={false} />
    </>
  )
}
