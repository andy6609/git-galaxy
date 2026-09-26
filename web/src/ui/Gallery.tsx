// 행성을 격자로 나란히 본다. 은하 밖이라 카메라 기준 주광을 쓰고, 도착 구도대로 행성을 돌린다.
//   ?view=gallery&seed=3              표본에서 무작위 12개 (&blind: 이름 숨김)
//   ?view=gallery&ids=1,2,3           repo ID 지정
//   ?view=probe&ids=...&turn=1        E2 대리 지표용 8×5 격자 (turn=1·2: 다른 각도에서 본 모습)
import { useEffect, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import { ARCHETYPES, ARCHETYPE_LABEL, mulberry32, STYLES, STYLE_LABEL } from '../seed'
import { landmarkRotation } from '../world/arrival'
import { markDirty, writeInstance } from '../world/Planets'
import { createPlanetGeometry, createPlanetMaterial, VIEW_LIGHT } from '../world/planetMaterial'

export const GAP = 2.4
export const FOV = 45

export type Grid = { cols: number; rows: number }

/** 격자가 화면 높이를 채우는 카메라 거리. pad: 위아래 여백(칸 단위, 이름표 자리) */
export const camZFor = (rows: number, pad = 0) => ((rows + pad) * GAP) / 2 / Math.tan(THREE.MathUtils.degToRad(FOV) / 2)

export const cellPos = (k: number, g: Grid): [number, number, number] => [
  ((k % g.cols) - (g.cols - 1) / 2) * GAP,
  -(Math.floor(k / g.cols) - (g.rows - 1) / 2) * GAP,
  0,
]

const turnBy = (yaw: number, pitch: number) =>
  new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yaw))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(pitch)))

/** 다른 각도에서 본 모습. 1: 40°·-15°, 2: 65°·-20° */
export const TURNS = [new THREE.Quaternion(), turnBy(40, -15), turnBy(65, -20)]

export function galleryPlanets(world: World, count = 12): number[] {
  const q = new URLSearchParams(location.search)
  const ids = q.get('ids')
  if (ids) {
    return ids
      .split(',')
      .map((id) => world.byId.get(id.trim()))
      .filter((i): i is number => i !== undefined)
      .slice(0, count)
  }
  const rand = mulberry32(Number(q.get('seed') ?? 1))
  const picked = new Set<number>()
  while (picked.size < Math.min(count, world.count)) picked.add(Math.floor(rand() * world.count))
  return [...picked]
}

export function PlanetGrid({
  world,
  indices,
  grid,
  turn = 0,
  detail = 200,
  pad = 0,
  onReady,
}: {
  world: World
  indices: number[]
  grid: Grid
  turn?: number
  detail?: number
  pad?: number
  onReady?: () => void
}) {
  const { camera } = useThree()
  const material = useMemo(createPlanetMaterial, [])
  const geo = useMemo(
    () => createPlanetGeometry(detail, Math.round(detail * 0.64), grid.cols * grid.rows),
    [detail, grid.cols, grid.rows],
  )

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.fov = FOV
    cam.position.set(0, 0, camZFor(grid.rows, pad))
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    indices.forEach((i, k) => {
      const c = new THREE.Vector3(...cellPos(k, grid))
      const toCam = cam.position.clone().sub(c).normalize()
      const q = landmarkRotation(new THREE.Vector3(...world.looks[i].axis), toCam)
      if (turn) q.premultiply(TURNS[turn])
      writeInstance(geo, k, cellPos(k, grid), world.looks[i], 1, [q.x, q.y, q.z, q.w])
    })
    geo.instanceCount = indices.length
    markDirty(geo)
    let frames = 0
    const tick = () => (++frames < 3 ? requestAnimationFrame(tick) : onReady?.())
    requestAnimationFrame(tick)
  }, [camera, geo, indices, world, grid, turn, pad, onReady])

  useFrame(({ camera: cam }) => {
    material.uniforms.uLight.value.set(...VIEW_LIGHT).normalize().applyQuaternion(cam.quaternion)
  })

  return <mesh geometry={geo} material={material} frustumCulled={false} />
}

export function GalleryLabels({ world, indices, grid, pad = 0 }: { world: World; indices: number[]; grid: Grid; pad?: number }) {
  const [h, setH] = useState(innerHeight)
  const [w, setW] = useState(innerWidth)
  useEffect(() => {
    const onResize = () => {
      setH(innerHeight)
      setW(innerWidth)
    }
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])
  const px = h / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2)) / camZFor(grid.rows, pad)
  const hideNames = new URLSearchParams(location.search).has('blind')
  return (
    <div className="gallery-labels">
      {indices.map((i, k) => {
        const [x, y] = cellPos(k, grid)
        const p = world.planets[i]
        const look = world.looks[i]
        return (
          <div key={i} className="g-label" style={{ left: w / 2 + x * px, top: h / 2 - y * px + 1.05 * px }}>
            <span className="g-num">{k + 1}</span>
            {!hideNames && <span className="g-name">{p.n}</span>}
            <span className="g-arch">
              {ARCHETYPE_LABEL[ARCHETYPES[look.arch]]} · {STYLE_LABEL[STYLES[look.style]]}
            </span>
          </div>
        )
      })}
    </div>
  )
}
