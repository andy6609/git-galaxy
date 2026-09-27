import * as THREE from 'three'
import type { World } from '../data'
import { fnv1a, mulberry32 } from '../seed'

export const HERO_LIMIT = 6
export const PORTRAIT_RADIUS = 24
export const PORTRAIT_CENTER_Y = 3.2
export const PORTRAIT_ECCENTRICITY = 0.82

export type OrbitRotation = [number, number, number]

export type PortraitHero = {
  index: number
  x: number
  y: number
  z: number
  orbit: number
  angle: number
  orbitRotation: OrbitRotation
  radius: number
  role: 'first' | 'recent' | 'signal' | 'variety' | 'archive'
}

const ROLES: PortraitHero['role'][] = ['first', 'recent', 'signal', 'variety', 'variety', 'archive']
const ORBITS = [6.8, 9.8, 12.7, 15.6, 18.5, 21.2]

/**
 * 같은 계정과 repo는 언제 보아도 같은 궤도면을 갖는다.
 * 실제 난수 대신 ID 기반 난수를 써서 공유 화면과 재방문 구도가 흔들리지 않게 한다.
 */
export function portraitOrbitRotation(systemId: string, repoId: string, spread = 1): OrbitRotation {
  const systemRand = mulberry32(fnv1a(`portrait-plane:${systemId}:v3`))
  const rand = mulberry32(fnv1a(`portrait-orbit:${systemId}:${repoId}:v2`))
  // 계정마다 하나의 느슨한 기준면을 만들고, 각 repo는 그 주변에서만 조금 어긋난다.
  // 완전히 독립된 큰 기울기는 선들이 서로 베어 보이므로 피한다.
  const basePitch = THREE.MathUtils.degToRad((systemRand() - 0.5) * 8)
  const baseYaw = systemRand() * Math.PI * 2
  const baseRoll = THREE.MathUtils.degToRad((systemRand() - 0.5) * 8)
  const pitch = basePitch + THREE.MathUtils.degToRad((rand() - 0.5) * 7 * spread)
  const yaw = baseYaw + THREE.MathUtils.degToRad((rand() - 0.5) * 20 * spread)
  const roll = baseRoll + THREE.MathUtils.degToRad((rand() - 0.5) * 7 * spread)
  return [pitch, yaw, roll]
}

/** 링과 행성이 같은 3D 궤도면을 쓰도록 하는 공통 좌표 계산. */
export function portraitOrbitPoint(
  radius: number,
  angle: number,
  rotation: OrbitRotation,
): [number, number, number] {
  const point = new THREE.Vector3(
    Math.cos(angle) * radius,
    0,
    Math.sin(angle) * radius * PORTRAIT_ECCENTRICITY,
  )
  point.applyEuler(new THREE.Euler(...rotation, 'XYZ'))
  return [point.x, point.y, point.z]
}

/** 안쪽 약 12분, 바깥 약 21분. 사용자가 머무는 동안 위치가 조금씩 달라질 만큼만 움직인다. */
export function portraitOrbitAngle(hero: PortraitHero, elapsedSeconds: number) {
  const radiansPerSecond = 0.0088 * Math.pow(ORBITS[0] / hero.orbit, 0.52)
  return hero.angle + elapsedSeconds * radiansPerSecond
}

export function portraitPositionAt(hero: PortraitHero, elapsedSeconds: number): [number, number, number] {
  return portraitOrbitPoint(hero.orbit, portraitOrbitAngle(hero, elapsedSeconds), hero.orbitRotation)
}

/**
 * 계정의 첫 인상에 쓸 대표 저장소. stars 순위만 쓰지 않고 시간과 언어 다양성을 섞는다.
 * canonical 궤도와 좌표는 건드리지 않는다 (D20).
 */
export function portraitIndices(world: World, system: number, limit = HERO_LIMIT) {
  const members = world.members[system] ?? []
  if (members.length <= limit) return [...members]

  const picked: number[] = []
  const seen = new Set<number>()
  const add = (i: number | undefined) => {
    if (i === undefined || seen.has(i) || picked.length >= limit) return
    seen.add(i)
    picked.push(i)
  }

  // 시작과 현재를 먼저 보여 준다.
  add(members[0])
  add(members[members.length - 1])

  // 멀리서도 발견될 신호 하나. 인기도 순위가 화면 전체를 지배하지 않게 한 자리만 쓴다.
  add([...members].sort((a, b) => (world.planets[b].s ?? -1) - (world.planets[a].s ?? -1))[0])

  // 서로 다른 언어를 대표하는 세계를 최근 것부터 고른다.
  const languages = new Set<string>()
  for (let k = members.length - 1; k >= 0 && picked.length < limit - 1; k--) {
    const i = members[k]
    const language = world.planets[i].l?.toLowerCase()
    if (!language || languages.has(language)) continue
    languages.add(language)
    add(i)
  }

  // 시간축 중간의 repo도 남겨 행성계가 최근 작업만의 초상이 되지 않게 한다.
  for (const q of [0.25, 0.5, 0.75]) add(members[Math.floor((members.length - 1) * q)])

  // 데이터가 빈 계정도 결정론적으로 채운다.
  for (const i of members) add(i)
  return picked
}

export function portraitLayout(world: World, system: number): PortraitHero[] {
  const s = world.systems[system]
  const indices = portraitIndices(world, system)
  const rand = mulberry32(fnv1a(`portrait:${s?.id ?? system}:v1`))
  const start = rand() * Math.PI * 2
  return indices.map((index, slot) => {
    const orbit = ORBITS[slot]
    const angle = start + slot * 2.399963 + (rand() - 0.5) * 0.3
    const orbitRotation = portraitOrbitRotation(s?.id ?? `${system}`, world.planets[index].id)
    const [x, y, z] = portraitOrbitPoint(orbit, angle, orbitRotation)
    return {
      index,
      x,
      y,
      z,
      orbit,
      angle,
      orbitRotation,
      radius: 1.35 + rand() * 0.45,
      role: ROLES[slot],
    }
  })
}

export function portraitWorldPosition(
  world: World,
  system: number,
  hero: PortraitHero,
  elapsedSeconds = 0,
): [number, number, number] {
  const c = world.systems[system].c
  const [x, y, z] = portraitPositionAt(hero, elapsedSeconds)
  // 디오라마를 카메라 중심보다 조금 위에 두어 모바일 하단 시트와 겹치지 않게 한다.
  return [c[0] + x, c[1] + PORTRAIT_CENTER_Y + y, c[2] + z]
}
