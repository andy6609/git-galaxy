import type { World } from '../data'

export type NextSystem = {
  system: number
  reason: string
}

const distance2 = (a: [number, number, number], b: [number, number, number]) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

const languageCache = new WeakMap<World, string[][]>()

function languageIndex(world: World) {
  const cached = languageCache.get(world)
  if (cached) return cached
  const index = world.members.map((members) => {
    const counts = new Map<string, number>()
    for (const i of members) {
      const lang = world.planets[i].l
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang)
  })
  languageCache.set(world, index)
  return index
}

/**
 * 다음 목적지는 실제로 관측한 값만 사용한다. dependency가 아닌 이웃을 dependency처럼
 * 말하지 않고, 언어·공간·규모 중 사용자가 이해할 수 있는 근거 하나를 붙인다.
 */
export function nextSystems(world: World, current: number, limit = 3): NextSystem[] {
  const here = world.systems[current]
  if (!here) return []

  const languages = languageIndex(world)
  const mine = new Set(languages[current] ?? [])
  const candidates = world.systems
    .map((system, k) => {
      if (k === current) return null
      const shared = languages[k]?.find((lang) => mine.has(lang)) ?? null
      const sameRegion = here.reg >= 0 && system.reg === here.reg
      const sameGalaxy = here.gal >= 0 && system.gal === here.gal
      const d2 = distance2(here.c, system.c)
      const score = (shared ? 6 : 0) + (sameRegion ? 5 : 0) + (sameGalaxy ? 2 : 0) + 1 / (1 + Math.sqrt(d2))
      return { k, system, shared, sameRegion, sameGalaxy, d2, score }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const result: NextSystem[] = []
  const used = new Set<number>()
  const add = (candidate: (typeof candidates)[number] | undefined, reason: string) => {
    if (!candidate || used.has(candidate.k) || result.length >= limit) return
    used.add(candidate.k)
    result.push({ system: candidate.k, reason })
  }

  const near = [...candidates]
    .filter((x) => x.sameRegion || x.sameGalaxy)
    .sort((a, b) => Number(b.sameRegion) - Number(a.sameRegion) || a.d2 - b.d2)[0]
  if (near) {
    const region = near.sameRegion ? world.regions.find((r) => r.id === near.system.reg)?.name : null
    const galaxy = world.galaxies[near.system.gal]?.name
    add(near, `${region ?? galaxy ?? '이 지역'}에서 가까운 이웃`)
  }

  const shared = [...candidates]
    .filter((x) => x.shared && !used.has(x.k))
    .sort((a, b) => b.score - a.score || a.d2 - b.d2)[0]
  if (shared) add(shared, `${shared.shared} 저장소를 함께 가진 이웃`)

  const small = [...candidates]
    .filter((x) => !used.has(x.k))
    .sort((a, b) => a.system.n - b.system.n || a.d2 - b.d2)[0]
  if (small) add(small, `행성 ${small.system.n}개의 작은 행성계`)

  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || a.d2 - b.d2)) {
    const galaxy = world.galaxies[candidate.system.gal]?.name
    add(candidate, `${galaxy ?? '관계 미확정 지역'}의 다른 행성계`)
  }

  return result
}
