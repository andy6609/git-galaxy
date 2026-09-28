// 행성 외형 seed. repo ID와 appearance version으로만 정해진다.
// stars·활동은 외형에 들어오지 않는다 (DIRECTION K1, K2). 채널을 나눠서
// 한 채널의 범위를 바꿔도 다른 채널이 뒤섞이지 않게 한다 (PLAN.md N-2).

export const APPEARANCE_VERSION = 2

/**
 * 옛 외형 버전을 그대로 재현한다 (PLAN.md D "render version").
 *   v1: 원형 6개, 팔레트 5개, 무늬·부차 분화구 없음 (E1)
 *   v2: 원형 12개, 팔레트 7개, 무늬 5종, 부차 분화구 (E2)
 * ?look=1 로 갤러리·대리 지표에서 v1을 볼 수 있다.
 */
const VERSIONS = {
  1: { archetypes: 6, palettes: 5, extras: false },
  2: { archetypes: 12, palettes: 7, extras: true },
} as const
export type AppearanceVersion = keyof typeof VERSIONS

export function requestedAppearance(): AppearanceVersion {
  const v = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('look')) : 0
  return v === 1 ? 1 : APPEARANCE_VERSION
}

export const ARCHETYPES = [
  'basin',
  'ring',
  'spire',
  'rift',
  'cliff',
  'terraces',
  'twin',
  'ridge',
  'spiral',
  'mesas',
  'triple',
  'crown',
] as const
export type Archetype = (typeof ARCHETYPES)[number]

export const ARCHETYPE_LABEL = {
  en: {
    basin: 'great basin', ring: 'ring canyon', spire: 'spire', rift: 'rift', cliff: 'hemisphere cliff',
    terraces: 'stepped plateau', twin: 'twin basins', ridge: 'equatorial ridge', spiral: 'spiral groove',
    mesas: 'mesa archipelago', triple: 'three-way rift', crown: 'crown',
  },
  ko: {
    basin: '거대 분지', ring: '고리 협곡', spire: '첨탑', rift: '균열', cliff: '반구 절벽',
    terraces: '계단 고원', twin: '쌍둥이 분지', ridge: '적도 산맥', spiral: '나선 홈',
    mesas: '탁상 군도', triple: '세 갈래 균열', crown: '왕관',
  },
} satisfies Record<'en' | 'ko', Record<Archetype, string>>

/** 무늬: 어느 각도에서 봐도 보이는 큰 명암 (E2) */
export const STYLES = ['plain', 'twotone', 'bands', 'maria', 'polar'] as const
export type Style = (typeof STYLES)[number]
export const STYLE_LABEL = {
  en: { plain: 'plain', twotone: 'two-tone', bands: 'bands', maria: 'dark maria', polar: 'polar cap' },
  ko: { plain: '무늬 없음', twotone: '두 빛깔', bands: '띠', maria: '어두운 바다', polar: '극관' },
} satisfies Record<'en' | 'ko', Record<Style, string>>

/** [낮은 곳, 중간, 높은 곳, 강조] — PLAN.md K장 팔레트에서 파생 */
export const PALETTES: [string, string, string, string][] = [
  ['#4F6E6A', '#CFC5B0', '#EEE7D8', '#E6AC68'], // 뼈색
  ['#2C4644', '#719C96', '#D2E1D9', '#D8CFBC'], // 청록
  ['#5E4E3C', '#C4A276', '#EFE2C8', '#719C96'], // 황토
  ['#283235', '#7D8A89', '#D8CFBC', '#CA6D52'], // 석판
  ['#4F332D', '#B0806C', '#E9D8C6', '#719C96'], // 녹
  ['#1C2528', '#3E4D4F', '#9AA7A2', '#E6AC68'], // 먹
  ['#6E5236', '#D9B77E', '#F4E8CF', '#CA6D52'], // 모래
]

export type Look = {
  arch: number
  axis: [number, number, number]
  params: [number, number, number, number]
  radius: number
  palette: number
  steps: number
  /** 결 방향 xyz + 주기. 주기 0이면 결 없음 (언어 미확인) */
  grain: [number, number, number, number]
  noise: [number, number, number]
  style: number
  /** 무늬의 축 xyz + 값 (띠: 주기, 바다: 문턱, 극관: 크기) */
  styleAxis: [number, number, number, number]
  /** 부차 분화구 방향 xyz + 크기(rad). 크기 0이면 없음 */
  second: [number, number, number, number]
}

export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const channel = (id: string, name: string, version: number) => mulberry32(fnv1a(`${id}:${name}:v${version}`))

function unitVector(rand: () => number, flatten = 1): [number, number, number] {
  const y = (rand() * 2 - 1) * flatten
  const t = rand() * Math.PI * 2
  const r = Math.sqrt(1 - y * y)
  return [r * Math.cos(t), y, r * Math.sin(t)]
}

export function lookFor(id: string, lang: string | null, version: AppearanceVersion = APPEARANCE_VERSION): Look {
  const V = VERSIONS[version]
  const ch = (name: string) => channel(id, name, version)
  const arch = Math.floor(ch('arch')() * V.archetypes)
  // 극에 가까운 축은 도착 구도에서 카메라가 위아래로 쏠리므로 적도 쪽으로 눕힌다
  const axis = unitVector(ch('axis'), 0.7)
  const q = ch('params')
  const params: Look['params'] = [q(), q(), q(), q()]
  const radius = 0.6 + ch('radius')() * 0.3
  const m = ch('material')
  const palette = Math.floor(m() * V.palettes)
  const steps = 12 + Math.floor(m() * 5)
  const n = ch('noise')
  const noise: Look['noise'] = [n() * 100, n() * 100, n() * 100]
  const st = ch('style')
  const style = V.extras ? Math.floor(st() * STYLES.length) : 0
  const sAxis = unitVector(st)
  // STYLES 순서: 무늬 없음, 두 빛깔, 띠(주기), 어두운 바다(문턱), 극관(크기)
  const sValue = [0, 0, 5 + st() * 4, 0.02 + st() * 0.12, 0.18 + st() * 0.14][style]
  const styleAxis: Look['styleAxis'] = [sAxis[0], sAxis[1], sAxis[2], sValue]
  const sc = ch('second')
  let second: Look['second'] = [0, 0, 0, 0]
  if (V.extras && sc() < 0.75) {
    // 랜드마크에서 70° 이상 떨어진 곳
    for (let k = 0; k < 32; k++) {
      const v = unitVector(sc)
      if (v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2] < 0.34) {
        second = [v[0], v[1], v[2], 0.14 + sc() * 0.1]
        break
      }
    }
  }
  let grain: Look['grain'] = [0, 1, 0, 0]
  if (lang) {
    const g = mulberry32(fnv1a(`lang:${lang.toLowerCase()}`))
    const d = unitVector(g)
    grain = [d[0], d[1], d[2], 14 + g() * 26]
  }
  return { arch, axis, params, radius, palette, steps, grain, noise, style, styleAxis, second }
}
