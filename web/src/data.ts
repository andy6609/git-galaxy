// 서버(/api/world)에서 우주를 받아 인덱스를 만든다. 행성의 상세·항로는 행성계에 다가갈 때 받는다.
//   은하 → 지역 → 행성계(계정) → 행성(repo) (DIRECTION D16)
import * as THREE from 'three'
import type { Language } from './i18n'
import { lookFor, requestedAppearance, type Look } from './seed'
import { arrivalFor } from './world/arrival'

/** 행성: 좌표와 이름만. 나머지는 SystemDetail */
export type Planet = {
  id: string
  n: string
  sys: number
  /** 궤도 번호 (안쪽부터 0 — 만든 순서) */
  ring: number
  pos: [number, number, number]
  l: string | null
  /** 만든 날 YYYY-MM-DD */
  c: string | null
  s: number | null
}

/** 행성계 = 계정. 별은 repo가 아니라 계정이다 */
export type System = {
  id: string
  login: string
  kind: string
  c: [number, number, number]
  nrm: [number, number, number]
  /** 궤도 수. 궤도 하나에 행성 하나 (DIRECTION D19) */
  orbits: number
  n: number
  gal: number
  reg: number
  truncated: boolean
}

export type Region = { id: number; gal: number; name: string; c: [number, number, number]; r: number }
export type Galaxy = { id: number; name: string; c: [number, number, number]; nrm: [number, number, number]; r: number }

export type Meta = {
  placement_version: number
  generated_at: string
  sources: { name: string; url: string; license?: string; use?: string }[]
  data_license: string
  stats: { accounts: number; planets: number; edges: number; galaxies: number; regions: number; radius: number }
  /** k번째 궤도의 반지름 = r0 + k × gap */
  orbit: { r0: number; gap: number }
}

type PlanetArrays = {
  ids: string[]
  names: string[]
  sys: number[]
  ring: number[]
  pos: number[]
  lang: (string | null)[]
  created: (string | null)[]
  stars: (number | null)[]
}

export type RawWorld = { meta: Meta; galaxies: Galaxy[]; regions: Region[]; systems: System[]; planets: PlanetArrays }

export type RepoDetail = {
  id: string
  name: string
  desc: string | null
  topics: string[]
  lang: string | null
  stars: number | null
  archived: boolean
  created: string | null
  pushed: string | null
  license: string | null
  observed: string | null
  src: string
  packages: { eco: string; name: string }[]
  ring: number
}
export type Link = { from: string; to: string; kind: string; name: string }
export type SystemDetail = {
  id: string
  login: string
  kind: string
  name: string | null
  truncated: boolean
  src: string
  fetched_at: string
  repos: RepoDetail[]
  out: Link[]
  inc: Link[]
}

export type Route = { to: number; kind: string }

export class World {
  readonly raw: RawWorld
  readonly meta: Meta
  readonly galaxies: Galaxy[]
  readonly regions: Region[]
  readonly systems: System[]
  readonly planets: Planet[]
  /** 행성계 → 행성 번호 (궤도 안쪽부터) */
  readonly members: number[][]
  readonly looks: Look[]
  readonly positions: Float32Array
  /** 행성의 방향(쿼터니언 xyzw)과 도착 방향. 필요할 때 계산해 둔다 (행성이 수만 개) */
  private readonly rotations: Float32Array
  private readonly arrivalDirs: Float32Array
  private readonly arrivalReady: Uint8Array
  readonly byName = new Map<string, number>()
  readonly byId = new Map<string, number>()
  readonly byLogin = new Map<string, number>()
  readonly bySystemId = new Map<string, number>()
  /** 거리 기준의 배율: 화면의 거리 문턱값들은 은하 반지름 1,100일 때 맞춘 값이다 */
  readonly scale: number

  constructor(raw: RawWorld) {
    this.raw = raw
    this.meta = raw.meta
    const radii = raw.galaxies.map((g) => g.r).sort((a, b) => a - b)
    this.scale = Math.max(0.3, (radii[Math.floor(radii.length / 2)] ?? 1100) / 1100)
    this.galaxies = raw.galaxies
    this.regions = raw.regions
    this.systems = raw.systems
    const P = raw.planets
    const n = P.ids.length
    this.planets = new Array(n)
    this.positions = new Float32Array(P.pos)
    this.rotations = new Float32Array(n * 4)
    this.arrivalDirs = new Float32Array(n * 3)
    this.arrivalReady = new Uint8Array(n)
    this.members = raw.systems.map(() => [])
    raw.systems.forEach((s, k) => {
      this.byLogin.set(s.login.toLowerCase(), k)
      this.bySystemId.set(s.id, k)
    })
    const version = requestedAppearance()
    const looks: Look[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const p: Planet = {
        id: P.ids[i],
        n: P.names[i],
        sys: P.sys[i],
        ring: P.ring[i],
        pos: [P.pos[i * 3], P.pos[i * 3 + 1], P.pos[i * 3 + 2]],
        l: P.lang[i],
        c: P.created[i],
        s: P.stars[i],
      }
      this.planets[i] = p
      this.byName.set(p.n.toLowerCase(), i)
      this.byId.set(p.id, i)
      if (p.sys >= 0) this.members[p.sys].push(i)
      looks[i] = lookFor(p.id, p.l, version)
    }
    this.looks = looks
    for (const m of this.members) m.sort((a, b) => this.planets[a].ring - this.planets[b].ring)
  }

  get count() {
    return this.planets.length
  }

  private ensureArrival(i: number) {
    if (this.arrivalReady[i]) return
    const p = this.planets[i]
    const sys = this.systems[p.sys]
    const a = arrivalFor(
      new THREE.Vector3(...this.looks[i].axis),
      new THREE.Vector3(...p.pos),
      sys ? new THREE.Vector3(...sys.c) : null,
    )
    this.rotations.set([a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w], i * 4)
    this.arrivalDirs.set([a.dir.x, a.dir.y, a.dir.z], i * 3)
    this.arrivalReady[i] = 1
  }

  /** 행성 i의 방향 (쿼터니언 xyzw) */
  rotation(i: number) {
    this.ensureArrival(i)
    return this.rotations.subarray(i * 4, i * 4 + 4)
  }

  /** 행성 i에 도착할 때 카메라가 설 방향 */
  arrivalDir(i: number) {
    this.ensureArrival(i)
    return new THREE.Vector3().fromArray(this.arrivalDirs, i * 3)
  }

  orbitRadius(k: number) {
    return this.meta.orbit.r0 + k * this.meta.orbit.gap
  }

  /** 행성계 k의 가장 바깥 궤도 반지름 */
  systemRadius(k: number) {
    return this.orbitRadius(Math.max(0, this.systems[k].orbits - 1))
  }

  owner(i: number) {
    return this.systems[this.planets[i].sys]
  }

  /** 새로 들인 행성계를 붙인 새 World (서버 /api/ingest의 응답) */
  withSystem(system: System, planets: PlanetArrays) {
    const k = this.raw.systems.length
    const P = this.raw.planets
    const merged: RawWorld = {
      ...this.raw,
      meta: {
        ...this.raw.meta,
        stats: { ...this.raw.meta.stats, accounts: k + 1, planets: P.ids.length + planets.ids.length },
      },
      systems: [...this.raw.systems, system],
      planets: {
        ids: [...P.ids, ...planets.ids],
        names: [...P.names, ...planets.names],
        sys: [...P.sys, ...planets.sys.map(() => k)],
        ring: [...P.ring, ...planets.ring],
        pos: [...P.pos, ...planets.pos],
        lang: [...P.lang, ...planets.lang],
        created: [...P.created, ...planets.created],
        stars: [...P.stars, ...planets.stars],
      },
    }
    return { world: new World(merged), system: k }
  }
}

const api = (path: string) => `${import.meta.env.BASE_URL}api${path}`

export async function loadWorld(): Promise<World> {
  const res = await fetch(api('/world'))
  if (!res.ok) throw new Error(`/api/world ${res.status}`)
  return new World(await res.json())
}

export async function fetchSystem(id: string): Promise<SystemDetail> {
  const res = await fetch(api(`/system/${encodeURIComponent(id)}`))
  if (!res.ok) throw new Error(`/api/system ${res.status}`)
  return res.json()
}

export type ServerResolved =
  | { kind: 'planet'; id: string; account: string }
  | { kind: 'system'; id: string; missing_repo?: string }
  | { kind: 'unknown'; login: string; repo?: string; ingestable: boolean }

export async function resolveOnServer(q: string): Promise<ServerResolved> {
  const res = await fetch(api(`/resolve?q=${encodeURIComponent(q)}`))
  return res.json()
}

export type IngestResult =
  | { status: 'added'; seconds: number; system: System; planets: PlanetArrays; edges: number }
  | { status: 'exists'; id: string }
  | { status: 'failed'; message: string }

export async function ingest(login: string): Promise<IngestResult> {
  const res = await fetch(api(`/ingest/${encodeURIComponent(login)}`), { method: 'POST' })
  return res.json()
}

// ------------------------------------------------------------ 검색 (먼저 이 브라우저가 아는 것에서)

export type Resolved =
  | { kind: 'planet'; index: number }
  | { kind: 'system'; index: number }
  | { kind: 'none'; query: string }

/** GitHub URL, owner/repo, username을 받는다. 패키지 이름은 서버에 묻는다 */
export function normalizeQuery(raw: string): string {
  const q = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?github\.com\//i, '')
    .split(/[?#]/)[0]
    .replace(/\.git$/i, '')
  return q.split('/').filter(Boolean).slice(0, 2).join('/')
}

export function resolveQuery(world: World, raw: string): Resolved {
  const q = normalizeQuery(raw).toLowerCase()
  if (!q) return { kind: 'none', query: raw }
  if (q.includes('/') && !q.startsWith('@')) {
    const i = world.byName.get(q)
    if (i !== undefined) return { kind: 'planet', index: i }
    return { kind: 'none', query: raw }
  }
  const k = world.byLogin.get(q)
  if (k !== undefined) return { kind: 'system', index: k }
  return { kind: 'none', query: raw }
}

export type Suggestion = { label: string; sub: string; value: string }

/** 확실하지 않을 때만 짧은 후보를 보여준다 (PLAN.md G) */
export function suggest(world: World, raw: string, limit = 6, language: Language = 'en'): Suggestion[] {
  const q = normalizeQuery(raw).toLowerCase()
  if (q.length < 2) return []
  if (resolveQuery(world, raw).kind !== 'none') return []
  const out: Suggestion[] = []
  for (const [login, k] of world.byLogin) {
    if (login.startsWith(q) && out.length < 2)
      out.push({
        label: world.systems[k].login,
        sub: language === 'ko' ? `행성 ${world.systems[k].n}개` : `${world.systems[k].n} planets`,
        value: login,
      })
  }
  const scored: [number, number][] = []
  world.planets.forEach((p, i) => {
    const name = p.n.toLowerCase()
    const repo = name.split('/')[1] ?? ''
    let score = -1
    if (repo === q) score = 0
    else if (repo.startsWith(q)) score = 1
    else if (name.startsWith(q)) score = 2
    else if (name.includes(q)) score = 4
    if (score >= 0) scored.push([score, i])
  })
  scored.sort((a, b) => a[0] - b[0] || world.planets[a[1]].n.length - world.planets[b[1]].n.length)
  for (const [, i] of scored) {
    if (out.length >= limit) break
    out.push({ label: world.planets[i].n, sub: world.planets[i].l ?? '', value: world.planets[i].n })
  }
  return out
}
