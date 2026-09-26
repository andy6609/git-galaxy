// 목적지 확정(Resolve) → 항해 시작. 검색·클릭·항로·URL이 모두 여기로 온다.
// 이 브라우저가 모르는 계정은 서버에 묻고, 서버도 모르면 그 자리에서 들인다 (Git City처럼, DIRECTION D18).
import * as THREE from 'three'
import { ingest, loadWorld, normalizeQuery, resolveOnServer, resolveQuery, type World } from './data'
import { ensureDetail, getState, setState } from './store'
import { logNav, rt, type NavVia } from './world/runtime'

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
      history.replaceState(null, '', `?p=${p.id}`)
    },
  })
}

/** 행성계(계정) 전체가 들어오는 자리로 간다 */
export function showSystem(world: World, k: number, via: NavVia) {
  const cam = rt.camera
  if (!cam) return
  const s = world.systems[k]
  const radius = world.systemRadius(k) + 4
  setState({ focus: null, system: k, phase: 'travel', notFound: null })
  ensureDetail(world, k)
  logNav(via, `user:${s.login}`)
  rt.rig.frame(cam, new THREE.Vector3(...s.c), radius * 1.05, () => {
    setState({ phase: 'survey' })
    history.replaceState(null, '', `?u=${s.login}`)
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
    setState({ notFound: `${q} — 서버에 닿지 않습니다` })
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
    setState({ ingesting: null, notFound: `${r.login} — ${res.message}` })
  } catch {
    setState({ ingesting: null, notFound: `${r.login} — 지금은 가져올 수 없습니다` })
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
