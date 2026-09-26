// 라벨·가리키기 링·목적지 표식. DOM을 직접 움직인다 (프레임마다 React를 다시 그리지 않는다).
// 이름 수를 제한하고 겹치지 않게 놓는다 (PLAN.md N-2).
// 배율에 따라 이름이 바뀐다: 우주 → 은하 이름, 은하 → 지역 이름, 가까이 → 행성계(계정) 이름, 궤도 → 항로와 이웃 행성
import { useEffect, useRef } from 'react'
import type { World } from '../data'
import { getState, repoDetail, routesFor } from '../store'
import { projector } from './project'
import { rt } from './runtime'
import { starCore } from './Systems'

type Kind = 'galaxy' | 'region' | 'system' | 'landmark' | 'out' | 'in' | 'near'
type Candidate = { x: number; y: number; z: number; text: string; kind: Kind; radius: number; key: string }
type Rect = { x: number; y: number; w: number; h: number }

const POOL = 40
const LIMIT: Record<Kind, number> = { galaxy: 12, region: 14, system: 14, landmark: 4, out: 8, in: 8, near: 6 }
const CHAR_PX: Record<string, number> = { galaxy: 9.5, region: 8.2, default: 6.7 }
const LINE_H = 16

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function relation(world: World, focus: number | null, i: number) {
  if (focus === null || focus === i) return null
  const f = world.planets[focus].n
  const { out, inc } = routesFor(world, focus)
  if (out.some((x) => x.to === i)) return `${f}이(가) 딛고 선 곳`
  if (inc.some((x) => x.to === i)) return `${f} 위에 선 곳`
  if (world.planets[i].sys === world.planets[focus].sys) return `같은 행성계 · ${world.owner(i).login}`
  return null
}

class Layer {
  private labels: HTMLDivElement[] = []
  private text: string[] = []
  private ring: HTMLDivElement
  private dest: HTMLDivElement
  private card: HTMLDivElement
  private cardFor = ''
  private landmarks: number[]
  private out = new Float32Array(3)

  constructor(
    private root: HTMLDivElement,
    private world: World,
  ) {
    for (let k = 0; k < POOL; k++) {
      const el = document.createElement('div')
      el.className = 'label'
      root.appendChild(el)
      this.labels.push(el)
      this.text.push('')
    }
    this.ring = this.make('ring')
    this.dest = this.make('ring dest')
    this.card = this.make('hover-card')
    // 원경의 길잡이: 이름이 알려진 프로젝트 (PLAN.md C "유명한 대상이 길잡이가 된다")
    this.landmarks = world.planets
      .map((p, i) => [p.s ?? 0, i] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 40)
      .map(([, i]) => i)
  }

  private make(cls: string) {
    const el = document.createElement('div')
    el.className = cls
    this.root.appendChild(el)
    return el
  }

  dispose() {
    this.root.replaceChildren()
  }

  private planet(i: number, kind: Kind): Candidate {
    const P = this.world.positions
    return { x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2], text: this.world.planets[i].n, kind, radius: this.world.looks[i].radius, key: `p${i}` }
  }

  private candidates(): Candidate[] {
    const world = this.world
    const cam = rt.camera!
    const { phase, focus, system } = getState()
    const camDist = cam.position.distanceTo(rt.rig.look)
    const c: Candidate[] = []
    if (focus !== null && (phase === 'orbit' || (phase === 'travel' && rt.rig.reveal > 0.6))) {
      const { out, inc } = routesFor(world, focus)
      for (const r of out) c.push(this.planet(r.to, 'out'))
      for (const r of inc) c.push(this.planet(r.to, 'in'))
      for (const i of rt.visibleSpheres.slice(0, 12)) c.push(this.planet(i, 'near'))
    }
    // 행성계 전체를 보고 있으면 그 행성들의 이름
    if (system !== null && focus === null) for (const i of world.members[system].slice(0, 24)) c.push(this.planet(i, 'near'))
    // 가까운 중심별의 이름
    const u = world.scale
    if (camDist < 900 * u) {
      const { x, y, z } = cam.position
      const near = world.systems
        .map((s, k) => [k, (s.c[0] - x) ** 2 + (s.c[1] - y) ** 2 + (s.c[2] - z) ** 2] as const)
        .filter(([, d2]) => d2 < (700 * u) ** 2)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 30)
      for (const [k] of near) {
        const s = world.systems[k]
        c.push({ x: s.c[0], y: s.c[1], z: s.c[2], text: s.login, kind: 'system', radius: starCore(s.n), key: `s${k}` })
      }
    }
    if (camDist > 2400 * u) {
      for (const g of world.galaxies) c.push({ x: g.c[0], y: g.c[1], z: g.c[2], text: g.name, kind: 'galaxy', radius: 0, key: `g${g.id}` })
    } else if (camDist > 500 * u) {
      for (const r of [...world.regions].sort((a, b) => b.r - a.r)) {
        c.push({ x: r.c[0], y: r.c[1], z: r.c[2], text: r.name, kind: 'region', radius: 0, key: `r${r.id}` })
      }
    }
    if (camDist > 300 * u && camDist < 2400 * u) for (const i of this.landmarks) c.push(this.planet(i, 'landmark'))
    return c
  }

  draw() {
    const cam = rt.camera
    if (!cam) return
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    const pr = projector(cam, w, h)
    const { phase, focus } = getState()
    const world = this.world
    const P = world.positions
    const o = this.out
    const px = (r: number) => (r * rt.pxScale) / o[2]

    // 궤도 행성 뒤에 있는 이름은 가린다
    let fx = 0
    let fy = 0
    let fr = -1
    let fz = 0
    if (focus !== null && pr.project(P[focus * 3], P[focus * 3 + 1], P[focus * 3 + 2], o)) {
      ;[fx, fy, fz] = o
      fr = px(world.looks[focus].radius) * 1.08
    }
    const hidden = (sx: number, sy: number, depth: number) =>
      fr > 0 && depth > fz && (sx - fx) ** 2 + (sy - fy) ** 2 < fr * fr

    const placed: Rect[] = []
    const used = new Set<string>([focus !== null ? `p${focus}` : '', rt.hover >= 0 ? `p${rt.hover}` : ''])
    const count: Record<Kind, number> = { galaxy: 0, region: 0, system: 0, landmark: 0, out: 0, in: 0, near: 0 }
    let n = 0
    for (const c of this.candidates()) {
      if (n >= POOL) break
      if (used.has(c.key) || count[c.kind] >= LIMIT[c.kind] || !c.text) continue
      if (!pr.project(c.x, c.y, c.z, o)) continue
      const [sx, sy, depth] = o
      if (sx < 0 || sy < 0 || sx > w || sy > h || hidden(sx, sy, depth)) continue
      const charPx = CHAR_PX[c.kind] ?? CHAR_PX.default
      const width = c.text.length * charPx + 12
      const centered = c.kind === 'region' || c.kind === 'galaxy'
      const rect = centered
        ? { x: sx - width / 2, y: sy - LINE_H / 2, w: width, h: LINE_H }
        : { x: sx + px(c.radius) + 6, y: sy - LINE_H / 2, w: width, h: LINE_H }
      if (!centered && rect.x + rect.w > w) rect.x = sx - px(c.radius) - 6 - rect.w
      if (placed.some((r) => overlaps(r, rect))) continue
      placed.push(rect)
      used.add(c.key)
      count[c.kind]++
      const el = this.labels[n]
      if (this.text[n] !== c.text) {
        el.textContent = c.text
        this.text[n] = c.text
      }
      el.dataset.kind = c.kind
      el.style.transform = `translate3d(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px, 0)`
      el.style.opacity = '1'
      n++
    }
    for (let k = n; k < POOL; k++) this.labels[k].style.opacity = '0'

    // 목적지 표식: 은하의 작은 한 점에 얇은 링 (PLAN.md G 14–16초)
    if (phase === 'travel' && focus !== null && pr.project(P[focus * 3], P[focus * 3 + 1], P[focus * 3 + 2], o)) {
      const r = Math.max(px(world.looks[focus].radius) + 8, 9)
      this.place(this.dest, o[0], o[1], r, Math.max(0, 1 - rt.rig.reveal * 1.6))
      this.dest.dataset.name = world.planets[focus].n
    } else {
      this.dest.style.opacity = '0'
    }

    this.drawHover(pr, w, h)
  }

  private drawHover(pr: ReturnType<typeof projector>, w: number, h: number) {
    const world = this.world
    const o = this.out
    const { focus } = getState()
    let key = ''
    let at: [number, number, number] | null = null
    let r = 0
    if (rt.hover >= 0) {
      const i = rt.hover
      key = `p${i}`
      at = [world.positions[i * 3], world.positions[i * 3 + 1], world.positions[i * 3 + 2]]
      r = world.looks[i].radius
    } else if (rt.hoverStar >= 0) {
      const s = world.systems[rt.hoverStar]
      key = `s${rt.hoverStar}`
      at = s.c
      r = starCore(s.n) * 2
    }
    if (!at || !pr.project(at[0], at[1], at[2], o)) {
      this.ring.style.opacity = '0'
      this.card.style.opacity = '0'
      this.cardFor = ''
      return
    }
    this.place(this.ring, o[0], o[1], Math.max((r * rt.pxScale) / o[2] + 5, 8), 1)
    if (this.cardFor !== key) {
      this.card.replaceChildren()
      const line = (cls: string, text: string) => {
        const d = document.createElement('div')
        d.className = cls
        d.textContent = text
        this.card.appendChild(d)
      }
      if (rt.hover >= 0) {
        const p = world.planets[rt.hover]
        line('hc-name', p.n)
        const d = repoDetail(world, rt.hover)
        if (d?.desc) line('hc-desc', d.desc)
        else line('hc-desc', [p.l, p.c?.slice(0, 4)].filter(Boolean).join(' · '))
        const rel = relation(world, focus, rt.hover)
        if (rel) line('hc-rel', rel)
      } else {
        const s = world.systems[rt.hoverStar]
        line('hc-name', `${s.login}의 행성계`)
        line('hc-desc', `행성 ${s.n}개${s.truncated ? '+' : ''} · ${world.galaxies[s.gal]?.name ?? '관계 미확정'}`)
        line('hc-rel', '별은 계정, 행성은 그 계정의 repo — 안쪽 궤도일수록 먼저 만든 것')
      }
      this.cardFor = key
    }
    const cx = Math.min(o[0] + 16, w - 300)
    const cy = Math.min(o[1] + 16, h - 90)
    this.card.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`
    this.card.style.opacity = '1'
  }

  private place(el: HTMLDivElement, x: number, y: number, r: number, opacity: number) {
    el.style.width = el.style.height = `${(r * 2).toFixed(1)}px`
    el.style.transform = `translate3d(${(x - r).toFixed(1)}px, ${(y - r).toFixed(1)}px, 0)`
    el.style.opacity = String(opacity)
  }
}

export function Overlay({ world }: { world: World }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const layer = new Layer(root.current!, world)
    rt.drawOverlay = () => layer.draw()
    return () => {
      rt.drawOverlay = null
      layer.dispose()
    }
  }, [world])
  return <div ref={root} className="overlay" aria-hidden />
}
