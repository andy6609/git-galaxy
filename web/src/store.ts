// UI가 구독하는 상태. 프레임마다 바뀌는 값(카메라·호버 위치)은 여기 두지 않는다 (PLAN.md N-2).
import { create } from 'zustand'
import { fetchSystem, type Route, type SystemDetail, type World } from './data'
import { initialLanguage, type Language } from './i18n'

export type Phase = 'intro' | 'survey' | 'travel' | 'orbit'

type State = {
  language: Language
  world: World | null
  phase: Phase
  /** 현재 목적지 또는 궤도에 있는 행성 */
  focus: number | null
  /** 행성계 전체를 보고 있을 때 그 행성계 */
  system: number | null
  notFound: string | null
  /** 서버가 새 계정을 들이는 중 */
  ingesting: string | null
  visited: Record<number, true>
  /** 행성계 id → 상세 (다가갈 때 받는다) */
  details: Record<string, SystemDetail>
}

export const useStore = create<State>(() => ({
  language: initialLanguage(),
  world: null,
  phase: 'intro',
  focus: null,
  system: null,
  notFound: null,
  ingesting: null,
  visited: {},
  details: {},
}))

export const getState = useStore.getState
export const setState = useStore.setState

export function setLanguage(language: Language) {
  try {
    localStorage.setItem('gg-language', language)
  } catch {
    // The language still changes for this session when storage is unavailable.
  }
  document.documentElement.lang = language
  setState({ language })
}

const inflight = new Set<string>()

/** 행성계 상세를 한 번만 받는다 */
export function ensureDetail(world: World, sys: number) {
  const id = world.systems[sys]?.id
  if (!id || getState().details[id] || inflight.has(id)) return
  inflight.add(id)
  fetchSystem(id)
    .then((d) => setState((s) => ({ details: { ...s.details, [id]: d } })))
    .catch(() => {})
    .finally(() => inflight.delete(id))
}

/** 행성 i의 항로. 상세를 아직 못 받았으면 비어 있다 */
export function routesFor(world: World, i: number, details = getState().details): { out: Route[]; inc: Route[] } {
  const p = world.planets[i]
  const d = details[world.systems[p.sys]?.id ?? '']
  if (!d) return { out: [], inc: [] }
  const map = (to: string, kind: string) => {
    const j = world.byId.get(to)
    return j === undefined ? null : { to: j, kind }
  }
  return {
    out: d.out.filter((e) => e.from === p.id).map((e) => map(e.to, e.kind)).filter((r): r is Route => r !== null),
    inc: d.inc.filter((e) => e.to === p.id).map((e) => map(e.from, e.kind)).filter((r): r is Route => r !== null),
  }
}

export function repoDetail(world: World, i: number, details = getState().details) {
  const p = world.planets[i]
  return details[world.systems[p.sys]?.id ?? '']?.repos.find((r) => r.id === p.id) ?? null
}
