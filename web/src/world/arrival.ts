// 도착 구도와 행성의 방향 (DIRECTION D11, D13)
//
// 행성계 안의 행성은 자기 별의 빛을 받는다. 각 행성은 지형(정체성)은 그대로 두고 방향만 정해서,
// 도착한 카메라에서 볼 때 별빛이 화면 좌상단에서 비껴 들어오고 랜드마크가 그 빛 쪽 26°에 놓이게 한다.
// 행성계가 없는 행성(관계 미확정)은 카메라 기준 주광을 쓰고 방향을 돌리지 않는다.
import * as THREE from 'three'
import { VIEW_LIGHT } from './planetMaterial'

const UP = new THREE.Vector3(0, 1, 0)
const OFFSET_ANGLE = THREE.MathUtils.degToRad(26)
/** 화면 좌상단 — 주광이 오는 쪽 */
const OFFSET_SCREEN = [-0.77, 0.64] as const
const VL = new THREE.Vector3(...VIEW_LIGHT).normalize()

function cameraBasis(dir: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3) {
  right.crossVectors(UP, dir).normalize()
  up.crossVectors(dir, right)
}

function screenOffset(dir: THREE.Vector3) {
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  cameraBasis(dir, right, up)
  return right.multiplyScalar(OFFSET_SCREEN[0]).addScaledVector(up, OFFSET_SCREEN[1]).normalize()
}

/** 랜드마크가 화면 중심에서 좌상단 26°에 보이는 카메라 방향 (행성 기준, 단위 벡터) */
export function landmarkViewDir(axis: THREE.Vector3) {
  const dir = axis.clone()
  for (let k = 0; k < 4; k++) {
    dir.copy(axis).addScaledVector(screenOffset(dir), -Math.sin(OFFSET_ANGLE)).normalize()
  }
  return dir
}

/** 카메라가 고정된 곳(갤러리)에서 행성을 돌려 같은 도착 구도를 만든다 */
export function landmarkRotation(axis: THREE.Vector3, toCamera: THREE.Vector3) {
  const offset = new THREE.Vector3(OFFSET_SCREEN[0], OFFSET_SCREEN[1], 0)
  offset.addScaledVector(toCamera, -offset.dot(toCamera)).normalize()
  const want = toCamera.clone().multiplyScalar(Math.cos(OFFSET_ANGLE)).addScaledVector(offset, Math.sin(OFFSET_ANGLE))
  return new THREE.Quaternion().setFromUnitVectors(axis.clone().normalize(), want.normalize())
}

/**
 * 별빛 방향 l(행성 → 별)이 주어졌을 때, 그 빛이 화면에서 VIEW_LIGHT 자리(좌상단 옆)로 보이는 카메라 방향.
 * roll 없이(world up) 카메라를 세우고, 예상 빛 방향이 실제 l과 맞을 때까지 카메라를 돌린다.
 */
export function starlitViewDir(l: THREE.Vector3) {
  const c = l.clone()
  const side = new THREE.Vector3().crossVectors(l, UP)
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
  c.applyAxisAngle(side.normalize(), -Math.acos(VL.z))
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const predicted = new THREE.Vector3()
  const q = new THREE.Quaternion()
  for (let k = 0; k < 16; k++) {
    cameraBasis(c, right, up)
    predicted.copy(right).multiplyScalar(VL.x).addScaledVector(up, VL.y).addScaledVector(c, VL.z).normalize()
    q.setFromUnitVectors(predicted, l)
    c.applyQuaternion(q).normalize()
  }
  // 거의 수직이면 world up 기준 카메라가 흔들린다
  c.y = THREE.MathUtils.clamp(c.y, -0.85, 0.85)
  return c.normalize()
}

export type Arrival = { dir: THREE.Vector3; rotation: THREE.Quaternion; starlit: boolean }

/** 행성 하나의 도착 방향과 방향(회전) */
export function arrivalFor(axis: THREE.Vector3, planet: THREE.Vector3, star: THREE.Vector3 | null): Arrival {
  if (!star) return { dir: landmarkViewDir(axis), rotation: new THREE.Quaternion(), starlit: false }
  const l = star.clone().sub(planet).normalize()
  const dir = starlitViewDir(l)
  const want = dir.clone().multiplyScalar(Math.cos(OFFSET_ANGLE)).addScaledVector(screenOffset(dir), Math.sin(OFFSET_ANGLE))
  return {
    dir,
    rotation: new THREE.Quaternion().setFromUnitVectors(axis.clone().normalize(), want.normalize()),
    starlit: true,
  }
}
