// 캔버스 안의 세계: 카메라 갱신 → 가리키기 → 오버레이. 입력은 캔버스에 직접 붙인다.
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import { goToPlanet, openFromUrl, showSystem } from '../nav'
import { getState, setState } from '../store'
import { Backdrop } from './Backdrop'
import { GalaxyPoints } from './GalaxyPoints'
import { Routes } from './Lines'
import { Planets } from './Planets'
import { projector } from './project'
import { rt } from './runtime'
import { starCore, Systems } from './Systems'

const HIT_PX = 10
const out = new Float32Array(3)

/** 포인터 아래의 행성. 구체면 화면상 반지름까지, 점이면 HIT_PX까지 */
function pick(world: World, cam: THREE.PerspectiveCamera, width: number, height: number, at: { x: number; y: number }) {
  const pr = projector(cam, width, height)
  const P = world.positions
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < world.count; i++) {
    if (!pr.project(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], out)) continue
    const dx = out[0] - at.x
    const dy = out[1] - at.y
    const sd = Math.sqrt(dx * dx + dy * dy)
    const projR = (world.looks[i].radius * rt.pxScale) / out[2]
    if (sd > Math.max(projR + 4, HIT_PX)) continue
    const score = sd - projR + out[2] * 0.0005
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/** 포인터 아래의 중심별 (행성이 없을 때만) */
function pickStar(world: World, cam: THREE.PerspectiveCamera, width: number, height: number, at: { x: number; y: number }) {
  const pr = projector(cam, width, height)
  let best = -1
  let bestD = Infinity
  world.systems.forEach((s, k) => {
    if (!pr.project(s.c[0], s.c[1], s.c[2], out)) return
    const d = Math.hypot(out[0] - at.x, out[1] - at.y)
    const reach = Math.max((2 * starCore(s.n) * rt.pxScale) / out[2] + 4, HIT_PX)
    if (d < reach && d < bestD) {
      bestD = d
      best = k
    }
  })
  return best
}

export function Scene({ world }: { world: World }) {
  const { camera, gl, size } = useThree()

  useEffect(() => {
    // 첫 화면: 은하 전체가 화면을 채우는 거리
    const R = world.meta.stats.radius
    // 은하들이 화면을 채우도록 비스듬히 내려다본다 (가장자리의 관계 미확정 고리는 기준에서 뺀다)
    const Rg = Math.max(...world.galaxies.map((g) => Math.hypot(g.c[0], g.c[2]) + g.r), 1000)
    rt.rig.spherical.set(Rg * 1.45, 0.85, 0.4)
    rt.rig.maxRadius = R * 3.4
    rt.camera = camera as THREE.PerspectiveCamera
    rt.camera.far = Math.max(16000, R * 7)
    rt.camera.updateProjectionMatrix()
    rt.rig.update(0, rt.camera)
    // 공유 링크: 은하 전체를 잠깐 보여준 뒤 짧게 항해한다 (PLAN.md L)
    const t = setTimeout(() => openFromUrl(world), 700)
    return () => clearTimeout(t)
  }, [camera, world])

  useEffect(() => {
    const el = gl.domElement
    const pointers = new Map<number, { x: number; y: number }>()
    let press: { moved: number } | null = null
    let pinch = 0
    const local = (e: PointerEvent | MouseEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const spread = () => {
      const [a, b] = [...pointers.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const leaveIntro = () => {
      if (getState().phase === 'intro') setState({ phase: 'survey' })
    }
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      const p = local(e)
      pointers.set(e.pointerId, p)
      rt.pointer = p
      press = pointers.size === 1 ? { moved: 0 } : null
      if (pointers.size === 2) pinch = spread()
      rt.dragging = true
    }
    const onMove = (e: PointerEvent) => {
      const p = local(e)
      if (e.pointerType === 'mouse') rt.pointer = p
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      pointers.set(e.pointerId, p)
      if (pointers.size === 1 && press) {
        const dx = p.x - prev.x
        const dy = p.y - prev.y
        press.moved += Math.abs(dx) + Math.abs(dy)
        if (press.moved > 4 && !rt.rig.traveling) {
          rt.rig.rotate(dx, dy)
          leaveIntro()
        }
      } else if (pointers.size === 2 && !rt.rig.traveling) {
        const d = spread()
        rt.rig.zoom((pinch - d) * 4)
        pinch = d
      }
    }
    const onUp = (e: PointerEvent) => {
      const p = local(e)
      pointers.delete(e.pointerId)
      rt.dragging = pointers.size > 0
      if (press && press.moved < 6 && pointers.size === 0) {
        if (rt.rig.traveling) rt.rig.skip()
        else if (rt.camera) {
          const near = rt.camera.position.distanceTo(rt.rig.look) < 1500 * world.scale
          const i = near ? pick(world, rt.camera, size.width, size.height, p) : -1
          if (i >= 0) goToPlanet(world, i, 'click')
          else {
            const k = pickStar(world, rt.camera, size.width, size.height, p)
            if (k >= 0) showSystem(world, k, 'system')
          }
        }
      }
      press = null
      if (e.pointerType !== 'mouse') rt.pointer = null
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (rt.rig.traveling) return
      rt.rig.zoom(e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY)
      leaveIntro()
    }
    const onLeave = () => {
      rt.pointer = null
    }
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT'
      if (e.key === 'Escape' || (e.key === ' ' && !typing)) {
        if (rt.rig.traveling) {
          e.preventDefault()
          rt.rig.skip()
        }
      }
      if (typing) return
      if (e.key === 'ArrowLeft') rt.rig.rotate(-40, 0)
      if (e.key === 'ArrowRight') rt.rig.rotate(40, 0)
      if (e.key === 'ArrowUp') rt.rig.rotate(0, -30)
      if (e.key === 'ArrowDown') rt.rig.rotate(0, 30)
      if (e.key === '+' || e.key === '=') rt.rig.zoom(-240)
      if (e.key === '-') rt.rig.zoom(240)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [gl, world, size.width, size.height])

  // 카메라를 가장 먼저 움직여야 이 프레임의 라벨·가리키기가 흔들리지 않는다
  useFrame((state, dt) => {
    const cam = state.camera as THREE.PerspectiveCamera
    rt.pxScale = state.size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2))
    rt.rig.update(Math.min(dt, 0.25), cam)
    // 우주가 넓어서 near를 고정하면 멀리서 깊이 정밀도가 모자란다 (궤도면이 행성을 뚫고 보인다): 보는 곳까지의 거리에 맞춘다
    const lookDist = cam.position.distanceTo(rt.rig.look)
    const zNear = THREE.MathUtils.clamp(lookDist * 0.002, 0.02, 8)
    if (Math.abs(zNear - cam.near) > cam.near * 0.1) {
      cam.near = zNear
      cam.updateProjectionMatrix()
    }
    cam.updateMatrixWorld()
    const canHover = rt.pointer && !rt.dragging && !rt.rig.traveling
    // 멀리서는 행성계(별)만 가리킨다. 수만 개의 작은 점을 하나하나 고를 수는 없다
    const near = lookDist < 1500 * world.scale
    rt.hover = canHover && near ? pick(world, cam, state.size.width, state.size.height, rt.pointer!) : -1
    rt.hoverStar = canHover && rt.hover < 0 ? pickStar(world, cam, state.size.width, state.size.height, rt.pointer!) : -1
    gl.domElement.style.cursor = rt.hover >= 0 || rt.hoverStar >= 0 ? 'pointer' : rt.dragging ? 'grabbing' : 'grab'
    rt.drawOverlay?.()
  }, -2)

  return (
    <>
      <Backdrop world={world} />
      <GalaxyPoints world={world} />
      <Systems world={world} />
      <Planets world={world} />
      <Routes world={world} />
    </>
  )
}
