// 목적지 확정(Resolve) → 항해 시작. 검색·클릭·항로·URL이 모두 여기로 온다.
// 이 브라우저가 모르는 계정은 서버에 묻고, 서버도 모르면 그 자리에서 들인다 (Git City처럼, DIRECTION D18).
import * as THREE from 'three'
import { ingest, loadWorld, normalizeQuery, resolveOnServer, resolveQuery, type World } from './data'
import { copyFor } from './i18n'
import { ensureDetail, getState, setState } from './store'
import { logNav, rt, type NavVia } from './world/runtime'

function navigationUrl(query: string, via: NavVia) {
  const next = `${location.pathname}${query}`
  const current = `${location.pathname}${location.search}`
  if (next === current) return
  if (via === 'url') history.replaceState(null, '', next)
  else history.pushState(null, '', next)
}

export function arrivalDistance(radius: number, fov: number) {
  // 행성이 화면 높이의 약 55%를 차지한다 (PROTOTYPE_SPEC §9)
  return radius / Math.sin(THREE.MathUtils.degToRad(fov) * 0.275)
}

export function goToPlanet(world: World, index: number, via: NavVia) {
  const cam = rt.camera
  if (!cam) return
  const p = world.planets[index]
  const look = world.looks[index]
  const dest = new THREE.Vector3(...p.pos)
  setState({ focus: index, system: null, phase: 'travel', notFound: null })
  navigationUrl(`?p=${encodeURIComponent(p.id)}`, via)
  document.title = `${p.n} · Git Galaxy`
  ensureDetail(world, p.sys)
  logNav(via, p.n)
  rt.rig.flyTo(cam, {
    dest,
    arriveDir: world.arrivalDir(index),
    arriveDistance: arrivalDistance(look.radius, cam.fov),
    minRadius: look.radius * 1.45,
    // 공유 링크로 들어온 사람은 긴 항해 대신 3–5초 축약본을 본다 (PLAN.md L)
    revisit: via === 'url' || !!getState().visited[index],
    onArrive: () => {
      setState((s) => ({ phase: 'orbit', visited: { ...s.visited, [index]: true } }))
    },
  })
}

/** 행성계(계정) 전체가 들어오는 자리로 간다 */
export function showSystem(world: World, k: number, via: NavVia) {
  const cam = rt.camera
  if (!cam) return
  const s = world.systems[k]
  setState({ focus: null, system: k, phase: 'travel', notFound: null })
  navigationUrl(`?u=${encodeURIComponent(s.login)}`, via)
  const language = getState().language
  document.title = `${copyFor(language).systemOf(`@${s.login}`)} · Git Galaxy`
  ensureDetail(world, k)
  logNav(via, `user:${s.login}`)
  // canonical 궤도는 장부에 유지하되, 계정의 첫 화면은 고정된 장난감 디오라마로 보여 준다 (D20).
  const center = new THREE.Vector3(...s.c)
  const direction = new THREE.Vector3(0.82, 0.62, 1).normalize()
  rt.rig.flyTo(cam, {
    dest: center,
    arriveDir: direction,
    // 서로 다른 궤도면이 위아래로 벌어져도 대표 행성 여섯 개가 한 프레임에 남도록 여유를 둔다 (D21).
    arriveDistance: innerWidth < 640 ? 60 : 50,
    minRadius: innerWidth < 640 ? 50 : 40,
    // 계정 검색은 결과 확인이 목적이다. 첫 진입도 6초 안쪽의 축약 항해를 쓴다.
    revisit: true,
    onArrive: () => {
      setState({ phase: 'survey' })
    },
  })
}

/** 쿼리가 없는 주소로 돌아왔을 때 첫 은하 관측 화면을 복원한다. */
export function showGalaxy(world: World) {
  const cam = rt.camera
  if (!cam) return
  const radius = Math.max(...world.galaxies.map((g) => Math.hypot(g.c[0], g.c[2]) + g.r), 1000)
  setState({ focus: null, system: null, phase: 'travel', notFound: null })
  document.title = 'Git Galaxy'
  rt.rig.flyTo(cam, {
    dest: new THREE.Vector3(),
    arriveDir: new THREE.Vector3(0.34, 0.66, 0.67).normalize(),
    arriveDistance: radius * 1.45,
    minRadius: 6,
    revisit: true,
    onArrive: () => setState({ phase: 'survey' }),
  })
}

function go(world: World, r: ReturnType<typeof resolveQuery>, via: NavVia) {
  if (r.kind === 'planet') goToPlanet(world, r.index, via)
  else if (r.kind === 'system') showSystem(world, r.index, via)
  return r.kind !== 'none'
}

/** 검색: 이 브라우저 → 서버 → (없으면) 새로 들이기. 들이는 동안에도 우주는 그대로 둘러볼 수 있다 */
export async function submitQuery(world: World, query: string, via: NavVia = 'search') {
  if (go(world, resolveQuery(world, query), via)) return true
  const q = normalizeQuery(query)
  let r
  try {
    r = await resolveOnServer(q)
  } catch {
    setState({ notFound: q })
    return false
  }
  if (r.kind !== 'unknown') {
    // 패키지 이름처럼 서버만 풀 수 있던 것: 이미 이 브라우저에 있으면 바로 간다
    const li = r.kind === 'planet' ? world.byId.get(r.id) : undefined
    const lk = world.bySystemId.get(r.kind === 'planet' ? r.account : r.id)
    if (li !== undefined) {
      goToPlanet(world, li, via)
      return true
    }
    if (lk !== undefined && r.kind === 'system') {
      showSystem(world, lk, via)
      return true
    }
    // 다른 사람이 그 뒤에 들인 계정: 우주를 새로 받는다
    const fresh = await loadWorld()
    setState({ world: fresh })
    const i = r.kind === 'planet' ? fresh.byId.get(r.id) : undefined
    const k = fresh.bySystemId.get(r.kind === 'planet' ? r.account : r.id)
    if (i !== undefined) goToPlanet(fresh, i, via)
    else if (k !== undefined) showSystem(fresh, k, via)
    return true
  }
  if (!r.ingestable) {
    setState({ notFound: q })
    return false
  }
  setState({ ingesting: r.login, notFound: null })
  try {
    const res = await ingest(r.login)
    const cur = getState().world ?? world
    if (res.status === 'added') {
      const { world: next, system } = cur.withSystem(res.system, res.planets)
      setState({ world: next, ingesting: null })
      // 새 World로 다시 그려진 뒤에 출발한다
      requestAnimationFrame(() => {
        const repo = r.repo ? next.byName.get(r.repo.toLowerCase()) : undefined
        if (repo !== undefined) goToPlanet(next, repo, via)
        else showSystem(next, system, via)
      })
      return true
    }
    if (res.status === 'exists') {
      const fresh = await loadWorld()
      setState({ world: fresh, ingesting: null })
      const k = fresh.bySystemId.get(res.id)
      if (k !== undefined) requestAnimationFrame(() => showSystem(fresh, k, via))
      return true
    }
    setState({ ingesting: null, notFound: r.login })
  } catch {
    setState({ ingesting: null, notFound: r.login })
  }
  return false
}

/** ?p=ID, ?r=owner/repo, ?u=username */
export function openFromUrl(world: World) {
  const q = new URLSearchParams(location.search)
  const id = q.get('p')
  if (id && world.byId.has(id)) {
    goToPlanet(world, world.byId.get(id)!, 'url')
    return true
  }
  const target = q.get('r') ?? q.get('u')
  if (target) {
    void submitQuery(world, target, 'url')
    return true
  }
  return false
}
