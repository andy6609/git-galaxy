// 항로(확인된 dependency).
// 가늘게 새겨진 선. 평소엔 옅고, 가리킨 대상의 선만 선명해진다 (PLAN.md K).
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { World } from '../data'
import { getState, routesFor, useStore } from '../store'
import { rt } from './runtime'

const lineVS = /* glsl */ `
attribute float aT;
attribute float aKind;
attribute float aTarget;
uniform float uHover;
uniform float uOpacity;
uniform float uBase;
uniform vec3 uColors[4];
varying vec3 vColor;
varying float vAlpha;
void main() {
  int k = int(aKind + 0.5);
  vColor = uColors[k];
  float lit = abs(aTarget - uHover) < 0.5 ? 1.0 : 0.0;
  // 출발점에서 진하고 멀어질수록 옅어진다
  vAlpha = uOpacity * mix(uBase, 0.9, lit) * mix(1.0, 0.35, aT);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const lineFS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
  #include <colorspace_fragment>
}
`

export const ROUTE_COLORS = {
  out: '#D8CFBC', // 딛고 선 곳
  in: '#719C96', // 이 위에 선 곳
}

const MAX_INCOMING = 24

/** base: 가리키지 않았을 때의 밝기 */
function makeLines(colors: string[], base: number) {
  const geo = new THREE.BufferGeometry()
  const mat = new THREE.ShaderMaterial({
    vertexShader: lineVS,
    fragmentShader: lineFS,
    uniforms: {
      uHover: { value: -1 },
      uOpacity: { value: 0 },
      uBase: { value: base },
      uColors: { value: colors.map((c) => new THREE.Color(c)) },
    },
    transparent: true,
    depthWrite: false,
  })
  const obj = new THREE.LineSegments(geo, mat)
  obj.frustumCulled = false
  return obj
}

type Seg = { a: THREE.Vector3; b: THREE.Vector3; kind: number; target: number }

function fill(obj: THREE.LineSegments, segs: Seg[]) {
  const pos = new Float32Array(segs.length * 6)
  const t = new Float32Array(segs.length * 2)
  const kind = new Float32Array(segs.length * 2)
  const target = new Float32Array(segs.length * 2)
  segs.forEach((s, i) => {
    pos.set([s.a.x, s.a.y, s.a.z, s.b.x, s.b.y, s.b.z], i * 6)
    t.set([0, 1], i * 2)
    kind.set([s.kind, s.kind], i * 2)
    target.set([s.target, s.target], i * 2)
  })
  const g = obj.geometry
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1))
  g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1))
  g.setAttribute('aTarget', new THREE.BufferAttribute(target, 1))
  g.computeBoundingSphere()
}

const vec = (world: World, i: number) => new THREE.Vector3(...world.planets[i].pos)

/** 이 행성에서 보이는 항로. 들어오는 쪽이 많으면 가까운 것부터. 행성계 상세를 받기 전에는 비어 있다 */
export function routesOf(world: World, focus: number, details = getState().details) {
  const here = vec(world, focus)
  const { out, inc: all } = routesFor(world, focus, details)
  const inc = [...all]
    .sort((a, b) => here.distanceToSquared(vec(world, a.to)) - here.distanceToSquared(vec(world, b.to)))
    .slice(0, MAX_INCOMING)
  return { out, inc, hiddenIncoming: all.length - inc.length }
}

export function Routes({ world }: { world: World }) {
  const focus = useStore((s) => s.focus)
  const phase = useStore((s) => s.phase)
  const details = useStore((s) => s.details)
  const obj = useMemo(() => makeLines([ROUTE_COLORS.out, ROUTE_COLORS.in, ROUTE_COLORS.out, ROUTE_COLORS.in], 0.16), [])

  useEffect(() => {
    if (focus === null) return fill(obj, [])
    const here = vec(world, focus)
    const r = world.looks[focus].radius
    const segs: Seg[] = []
    const { out, inc } = routesOf(world, focus, details)
    for (const [list, base] of [[out, 0], [inc, 1]] as const) {
      for (const route of list) {
        const there = vec(world, route.to)
        const dir = there.clone().sub(here).normalize()
        segs.push({ a: here.clone().addScaledVector(dir, r * 1.12), b: there, kind: base, target: route.to })
      }
    }
    fill(obj, segs)
  }, [world, focus, obj, details])

  useFrame((_, dt) => {
    const u = (obj.material as THREE.ShaderMaterial).uniforms
    const want = phase === 'orbit' ? 1 : phase === 'travel' ? rt.rig.reveal : 0
    u.uOpacity.value += (want - u.uOpacity.value) * (1 - Math.exp(-dt * 4))
    u.uHover.value = rt.hover
  })

  return <primitive object={obj} />
}
