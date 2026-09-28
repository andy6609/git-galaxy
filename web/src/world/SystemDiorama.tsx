import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { RepoDetail, World } from '../data'
import { fnv1a, PALETTES } from '../seed'
import { useStore } from '../store'
import { markDirty, writeInstance } from './Planets'
import { createPlanetGeometry, createPlanetMaterial } from './planetMaterial'
import { rt } from './runtime'
import { starTint } from './Systems'
import {
  portraitLayout,
  portraitOrbitPoint,
  portraitOrbitRotation,
  portraitPositionAt,
  portraitWorldPosition,
  PORTRAIT_CENTER_Y,
  PORTRAIT_ECCENTRICITY,
  PORTRAIT_RADIUS,
  type PortraitHero,
} from './systemPortrait'

const ROLE_LABEL: Record<'en' | 'ko', Record<PortraitHero['role'], string>> = {
  en: { first: 'first repository', recent: 'recent repository', signal: 'distant signal', variety: 'different material', archive: 'repository across time' },
  ko: { first: '첫 저장소', recent: '최근 저장소', signal: '멀리 보이는 저장소', variety: '다른 결의 저장소', archive: '시간축의 저장소' },
}

function Orbit({ hero }: { hero: PortraitHero }) {
  return (
    <group position={[0, PORTRAIT_CENTER_Y, 0]} rotation={hero.orbitRotation}>
      <mesh rotation-x={-Math.PI / 2} scale={[1, PORTRAIT_ECCENTRICITY, 1]} renderOrder={1}>
        <ringGeometry args={[hero.orbit - 0.035, hero.orbit + 0.035, 128]} />
        <meshBasicMaterial color="#d8cfbc" transparent opacity={0.23} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function AccountStar({ tint }: { tint: THREE.Color }) {
  const haloTint = useMemo(() => tint.clone().lerp(new THREE.Color('#f2b867'), 0.28), [tint])
  const glow = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.16, 'rgba(255,250,226,0.92)')
    gradient.addColorStop(0.42, 'rgba(255,230,183,0.28)')
    gradient.addColorStop(1, 'rgba(255,220,170,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 128, 128)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }, [])

  useEffect(() => () => glow.dispose(), [glow])

  return (
    <group position={[0, PORTRAIT_CENTER_Y, 0]}>
      <sprite scale={[11, 11, 1]} renderOrder={1}>
        <spriteMaterial
          map={glow}
          color={haloTint}
          transparent
          opacity={0.88}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <mesh renderOrder={2}>
        <icosahedronGeometry args={[2.1, 4]} />
        <meshBasicMaterial color={tint.clone().lerp(new THREE.Color('#fffdf2'), 0.72)} toneMapped={false} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} renderOrder={3}>
        <torusGeometry args={[2.9, 0.085, 8, 64]} />
        <meshBasicMaterial color="#f2b867" transparent opacity={0.55} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}

function Observatory({ scale, accent }: { scale: number; accent: string }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.22, 0]}>
        <cylinderGeometry args={[0.34, 0.42, 0.44, 8]} />
        <meshStandardMaterial color="#e3d5b8" roughness={0.82} />
      </mesh>
      <mesh position={[0, 0.48, 0]} scale={[1, 0.56, 1]}>
        <sphereGeometry args={[0.34, 16, 10]} />
        <meshStandardMaterial color={accent} roughness={0.7} emissive={accent} emissiveIntensity={0.08} />
      </mesh>
      <mesh position={[0, 0.83, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.42, 6]} />
        <meshStandardMaterial color="#f2b867" emissive="#f2b867" emissiveIntensity={0.35} />
      </mesh>
    </group>
  )
}

function PackageDock({ scale, accent }: { scale: number; accent: string }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[0.72, 0.4, 0.52]} />
        <meshStandardMaterial color="#d8cfbc" roughness={0.9} />
      </mesh>
      <mesh position={[0.48, 0.28, 0]} rotation-y={Math.PI / 2}>
        <torusGeometry args={[0.2, 0.055, 8, 18]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.12} roughness={0.65} />
      </mesh>
    </group>
  )
}

function SignalTower({ scale, accent }: { scale: number; accent: string }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.34, 0]}>
        <boxGeometry args={[0.38, 0.68, 0.38]} />
        <meshStandardMaterial color="#e3d5b8" roughness={0.88} />
      </mesh>
      <mesh position={[0, 0.78, 0]}>
        <coneGeometry args={[0.28, 0.28, 6]} />
        <meshStandardMaterial color={accent} roughness={0.68} />
      </mesh>
      <pointLight position={[0, 1.0, 0]} color={accent} intensity={0.34} distance={3} />
    </group>
  )
}

function ToyPlanet({
  world,
  hero,
  detail,
  material,
  systemCenter,
}: {
  world: World
  hero: PortraitHero
  detail?: RepoDetail
  material: THREE.ShaderMaterial
  systemCenter: [number, number, number]
}) {
  const group = useRef<THREE.Group>(null)
  const language = useStore((s) => s.language)
  const p = world.planets[hero.index]
  const look = world.looks[hero.index]
  const palette = PALETTES[look.palette]
  const accent = palette[3]
  const hash = fnv1a(`toy:${p.id}`)
  const hasPackage = !!detail?.packages.length
  const hasSignal = (detail?.topics.length ?? 0) >= 2 || (detail?.stars ?? p.s ?? 0) > 0
  const main = hash % 3
  const geometry = useMemo(() => createPlanetGeometry(72, 48, 1), [])
  const portraitLook = useMemo(() => ({ ...look, radius: hero.radius }), [hero.radius, look])
  const planetRotation = world.rotation(hero.index)

  useEffect(() => () => geometry.dispose(), [geometry])

  useFrame(() => {
    if (!group.current) return
    const [x, y, z] = portraitPositionAt(hero, rt.portraitTime)
    group.current.position.set(x, PORTRAIT_CENTER_Y + y, z)
    // 기존 행성과 동일한 seed 지형을 그리되, 디오라마의 현재 공전 위치를 canonical center로 전달한다.
    // 셰이더가 absolute world coordinate를 사용하므로 부모 group의 이동은 건물에만 적용된다.
    const center: [number, number, number] = [
      systemCenter[0] + x,
      systemCenter[1] + PORTRAIT_CENTER_Y + y,
      systemCenter[2] + z,
    ]
    const star: [number, number, number] = [
      systemCenter[0],
      systemCenter[1] + PORTRAIT_CENTER_Y,
      systemCenter[2],
    ]
    writeInstance(geometry, 0, center, portraitLook, 1, planetRotation, star)
    geometry.instanceCount = 1
    markDirty(geometry)
  })

  return (
    <group ref={group} position={[hero.x, PORTRAIT_CENTER_Y + hero.y, hero.z]}>
      <mesh
        geometry={geometry}
        material={material}
        scale={hero.radius * 1.08}
        frustumCulled={false}
        onPointerOver={(e) => {
          e.stopPropagation()
          ;(e.nativeEvent.target as HTMLElement).style.cursor = 'pointer'
        }}
        onPointerOut={(e) => {
          ;(e.nativeEvent.target as HTMLElement).style.cursor = 'grab'
        }}
        userData={{ label: `${p.n} · ${ROLE_LABEL[language][hero.role]}` }}
      />
      <group position={[0, hero.radius * 1.04, 0]} rotation-y={(hash % 11) * 0.31}>
        {main === 0 && <Observatory scale={1.02 + hero.radius * 0.12} accent={accent} />}
        {main === 1 && <PackageDock scale={1.02 + hero.radius * 0.1} accent={accent} />}
        {main === 2 && <SignalTower scale={0.96 + hero.radius * 0.1} accent={accent} />}
        {hasPackage && (
          <group position={[0.84, 0.02, -0.26]} rotation-y={0.7}>
            <PackageDock scale={0.78} accent={accent} />
          </group>
        )}
        {hasSignal && (
          <group position={[-0.76, 0.02, 0.22]} rotation-z={-0.06}>
            <SignalTower scale={0.72} accent={accent} />
          </group>
        )}
      </group>
      <mesh rotation-x={Math.PI / 2}>
        <torusGeometry args={[hero.radius * 1.24, 0.028, 6, 48]} />
        <meshBasicMaterial color={accent} transparent opacity={0.36} depthWrite={false} />
      </mesh>
    </group>
  )
}

function RepoBelt({ world, system, heroes }: { world: World; system: number; heroes: PortraitHero[] }) {
  const points = useMemo(() => {
    const heroSet = new Set(heroes.map((h) => h.index))
    const rest = world.members[system].filter((i) => !heroSet.has(i))
    const positions = new Float32Array(rest.length * 3)
    const colors = new Float32Array(rest.length * 3)
    const warm = new THREE.Color('#f2b867')
    const cool = new THREE.Color('#75aaa2')
    rest.forEach((index, n) => {
      const h = fnv1a(`belt:${world.planets[index].id}`)
      const angle = (n / Math.max(rest.length, 1)) * Math.PI * 2 + ((h % 1000) / 1000 - 0.5) * 0.12
      const radius = PORTRAIT_RADIUS + ((h >>> 8) % 1000) / 1000 * 2.4
      const rotation = portraitOrbitRotation(world.systems[system].id, world.planets[index].id, 0.72)
      const [x, y, z] = portraitOrbitPoint(radius, angle, rotation)
      positions.set([x, PORTRAIT_CENTER_Y + y, z], n * 3)
      const c = cool.clone().lerp(warm, ((h >>> 4) % 1000) / 1000)
      colors.set([c.r, c.g, c.b], n * 3)
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return { geometry, count: rest.length }
  }, [heroes, system, world])

  if (!points.count) return null
  return (
    <points geometry={points.geometry}>
      <pointsMaterial size={0.34} vertexColors transparent opacity={0.78} sizeAttenuation depthWrite={false} />
    </points>
  )
}

export function SystemDiorama({ world }: { world: World }) {
  const system = useStore((s) => s.system)
  const focus = useStore((s) => s.focus)
  const details = useStore((s) => s.details)
  const planetMaterial = useMemo(() => {
    const material = createPlanetMaterial()
    // 디오라마에서는 작은 행성에서도 층과 무늬가 읽히도록 노출만 살짝 높인다.
    material.uniforms.uExposure.value = 1.14
    return material
  }, [])
  const heroes = useMemo(() => (system === null ? [] : portraitLayout(world, system)), [system, world])
  useEffect(() => () => planetMaterial.dispose(), [planetMaterial])
  useEffect(() => {
    rt.portraitTime = 0
  }, [system])
  if (system === null || focus !== null) return null

  const s = world.systems[system]
  const detail = details[s.id]
  const detailById = new Map(detail?.repos.map((repo) => [repo.id, repo]) ?? [])
  const tint = starTint(s.id)

  return (
    <group position={s.c}>
      <ambientLight color="#d8cfbc" intensity={0.9} />
      <hemisphereLight color="#fff1d2" groundColor="#203536" intensity={1.1} />
      <directionalLight position={[14, 24, 16]} color="#fff0d0" intensity={1.8} />
      <pointLight position={[0, 5, 0]} color={tint} intensity={7} distance={34} decay={2} />
      {heroes.map((hero) => (
        <Orbit key={`orbit-${hero.index}`} hero={hero} />
      ))}
      <AccountStar tint={tint} />
      {heroes.map((hero) => (
        <ToyPlanet
          key={hero.index}
          world={world}
          hero={hero}
          detail={detailById.get(world.planets[hero.index].id)}
          material={planetMaterial}
          systemCenter={s.c}
        />
      ))}
      <RepoBelt world={world} system={system} heroes={heroes} />
    </group>
  )
}

export { portraitWorldPosition }
