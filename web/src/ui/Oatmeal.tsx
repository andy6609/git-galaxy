// ?view=oatmeal — 사람 대상 오트밀 테스트 (docs/PROTOTYPE_SPEC.md E2)
//   행성 6개를 하나씩 5초 동안 본다 (이름 없음, 도착 구도)
//   → 다른 각도(65°)에서 본 행성 4개 중 앞에서 본 것을 고른다. 6문제.
//     1–3번: 방해 행성은 무작위 / 4–6번: 방해 행성이 같은 원형 (원형 안에서도 구별되나)
//   통과선: 75% (PROTOTYPE_SPEC E2). 결과는 localStorage 'gg-oatmeal'에 쌓이고 JSON으로 복사할 수 있다.
//   ?look=1 이면 E1의 외형(v1)으로 같은 테스트를 한다. ?seed=N 으로 문제를 고정할 수 있다.
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { create } from 'zustand'
import type { World } from '../data'
import { mulberry32, requestedAppearance } from '../seed'
import { useStore } from '../store'
import { camZFor, cellPos, FOV, PlanetGrid, type Grid } from './Gallery'

const STUDY = 6
const STUDY_MS = 5000
const OPTIONS = 4
const PASS = 0.75
const STUDY_GRID: Grid = { cols: 1, rows: 1 }
const TEST_GRID: Grid = { cols: OPTIONS, rows: 1 }
const STUDY_PAD = 0.35
const TEST_PAD = 2.3

type Trial = { target: number; options: number[]; kind: 'random' | 'same-arch'; choice?: number; ms?: number }
type Stage = 'intro' | 'study' | 'test' | 'done'
type State = { stage: Stage; studyIdx: number; trialIdx: number; study: number[]; trials: Trial[]; seed: number; shownAt: number }

const useOatmeal = create<State>(() => ({
  stage: 'intro',
  studyIdx: 0,
  trialIdx: 0,
  study: [],
  trials: [],
  seed: 0,
  shownAt: 0,
}))

function shuffle<T>(xs: T[], rand: () => number) {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function makeSession(world: World, seed: number) {
  const rand = mulberry32(seed)
  const pick = () => Math.floor(rand() * world.count)
  const study = new Set<number>()
  while (study.size < STUDY) study.add(pick())
  const studyList = [...study]
  const trials: Trial[] = shuffle(studyList, rand).map((target, k) => {
    const kind = k < STUDY / 2 ? 'random' : 'same-arch'
    const arch = world.looks[target].arch
    const pool =
      kind === 'same-arch'
        ? world.looks.map((l, i) => (l.arch === arch ? i : -1)).filter((i) => i >= 0 && !study.has(i))
        : null
    const distract = new Set<number>()
    while (distract.size < OPTIONS - 1) {
      const i = pool ? pool[Math.floor(rand() * pool.length)] : pick()
      if (!study.has(i)) distract.add(i)
    }
    return { target, kind, options: shuffle([target, ...distract], rand) }
  })
  // 방해 종류가 순서대로 나오지 않게 섞는다
  return { study: studyList, trials: shuffle(trials, rand) }
}

export function OatmealScene({ world }: { world: World }) {
  const { stage, studyIdx, trialIdx, study, trials } = useOatmeal()
  if (stage === 'study') {
    return <PlanetGrid key={`s${studyIdx}`} world={world} indices={[study[studyIdx]]} grid={STUDY_GRID} pad={STUDY_PAD} />
  }
  if (stage === 'test') {
    return (
      <PlanetGrid
        key={`t${trialIdx}`}
        world={world}
        indices={trials[trialIdx].options}
        grid={TEST_GRID}
        pad={TEST_PAD}
        turn={2}
      />
    )
  }
  return null
}

function save(world: World, s: State) {
  const look = requestedAppearance()
  const right = s.trials.filter((t) => t.choice === t.target)
  const kindScore = (kind: Trial['kind']) => {
    const ts = s.trials.filter((t) => t.kind === kind)
    return `${ts.filter((t) => t.choice === t.target).length}/${ts.length}`
  }
  const record = {
    t: new Date().toISOString(),
    seed: s.seed,
    look,
    score: `${right.length}/${s.trials.length}`,
    accuracy: +(right.length / s.trials.length).toFixed(3),
    random: kindScore('random'),
    sameArch: kindScore('same-arch'),
    study: s.study.map((i) => world.planets[i].id),
    trials: s.trials.map((t) => ({
      kind: t.kind,
      target: world.planets[t.target].id,
      options: t.options.map((i) => world.planets[i].id),
      choice: t.choice !== undefined ? world.planets[t.choice].id : null,
      ms: t.ms,
    })),
  }
  try {
    const log = JSON.parse(localStorage.getItem('gg-oatmeal') ?? '[]')
    log.push(record)
    localStorage.setItem('gg-oatmeal', JSON.stringify(log))
  } catch {
    // 저장소를 못 쓰면 화면의 JSON으로 대신한다
  }
  return record
}

export function OatmealUI({ world }: { world: World }) {
  const language = useStore((state) => state.language)
  const ko = language === 'ko'
  const s = useOatmeal()
  const [record, setRecord] = useState<ReturnType<typeof save> | null>(null)
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => {
    const onResize = () => setSize({ w: innerWidth, h: innerHeight })
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])

  const start = () => {
    const q = new URLSearchParams(location.search)
    const seed = Number(q.get('seed') ?? Math.floor(Math.random() * 1e9))
    const { study, trials } = makeSession(world, seed)
    useOatmeal.setState({ stage: 'study', studyIdx: 0, trialIdx: 0, study, trials, seed, shownAt: performance.now() })
    setRecord(null)
  }

  // 학습 단계: 5초마다 다음 행성
  useEffect(() => {
    if (s.stage !== 'study') return
    const t = setTimeout(() => {
      if (s.studyIdx + 1 < STUDY) useOatmeal.setState({ studyIdx: s.studyIdx + 1 })
      else useOatmeal.setState({ stage: 'test', trialIdx: 0, shownAt: performance.now() })
    }, STUDY_MS)
    return () => clearTimeout(t)
  }, [s.stage, s.studyIdx])

  const choose = (k: number) => {
    const st = useOatmeal.getState()
    if (st.stage !== 'test') return
    const trials = st.trials.map((t, i) =>
      i === st.trialIdx ? { ...t, choice: t.options[k], ms: Math.round(performance.now() - st.shownAt) } : t,
    )
    if (st.trialIdx + 1 < trials.length) {
      useOatmeal.setState({ trials, trialIdx: st.trialIdx + 1, shownAt: performance.now() })
    } else {
      const done = { ...st, trials, stage: 'done' as const }
      useOatmeal.setState(done)
      setRecord(save(world, done))
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = Number(e.key) - 1
      if (k >= 0 && k < OPTIONS) choose(k)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const px = size.h / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2)) / camZFor(TEST_GRID.rows, TEST_PAD)
  const buttons = useMemo(
    () => Array.from({ length: OPTIONS }, (_, k) => size.w / 2 + cellPos(k, TEST_GRID)[0] * px),
    [size.w, px],
  )

  return (
    <div className="oatmeal">
      {s.stage === 'intro' && (
        <div className="om-card">
          <h1>{ko ? '오트밀 테스트' : 'Oatmeal test'}</h1>
          <p>
            {ko
              ? `행성 ${STUDY}개를 하나씩 ${STUDY_MS / 1000}초 동안 보여드립니다. 이름은 없습니다.`
              : `You will see ${STUDY} unnamed planets, one at a time for ${STUDY_MS / 1000} seconds each.`}
          </p>
          <p>
            {ko ? (
              <>그다음 <b>다른 각도</b>에서 본 행성 {OPTIONS}개 중 앞에서 본 것을 고르세요. {STUDY}문제입니다. 숫자 키(1–{OPTIONS})나 클릭으로 고릅니다.</>
            ) : (
              <>Then identify it among {OPTIONS} planets shown from <b>another angle</b>. There are {STUDY} rounds. Click or press 1–{OPTIONS}.</>
            )}
          </p>
          <button type="button" onClick={start}>
            {ko ? '시작' : 'Start'}
          </button>
          {requestedAppearance() !== 2 && <p className="p-dim">{ko ? '외형' : 'Appearance'} v{requestedAppearance()}</p>}
        </div>
      )}
      {s.stage === 'study' && (
        <div className="om-top">
          <span>
            {ko ? '기억하세요' : 'Remember this planet'} · {s.studyIdx + 1} / {STUDY}
          </span>
          <i key={s.studyIdx} className="om-bar" style={{ animationDuration: `${STUDY_MS}ms` }} />
        </div>
      )}
      {s.stage === 'test' && (
        <>
          <div className="om-top">
            <span>
              {ko ? '앞에서 본 행성은?' : 'Which planet did you see?'} · {s.trialIdx + 1} / {s.trials.length}
            </span>
          </div>
          {buttons.map((x, k) => (
            <button
              key={k}
              type="button"
              className="om-pick"
              style={{ left: x - px * 1.1, width: px * 2.2, top: size.h / 2 - px * 1.1, height: px * 2.2 }}
              onClick={() => choose(k)}
              aria-label={ko ? `${k + 1}번` : `Option ${k + 1}`}
            >
              <span>{k + 1}</span>
            </button>
          ))}
        </>
      )}
      {s.stage === 'done' && record && (
        <div className="om-card">
          <h1>
            {record.score}{' '}
            {record.accuracy >= PASS ? (ko ? '· 통과선 이상' : '· above threshold') : (ko ? '· 통과선 아래' : '· below threshold')}
          </h1>
          <p>
            {ko ? '무작위 방해' : 'Random distractors'} {record.random} · {ko ? '같은 원형 방해' : 'Same-archetype distractors'} {record.sameArch} · {ko ? '통과선' : 'threshold'} {PASS * 100}%
          </p>
          <pre>{JSON.stringify(record, null, 1)}</pre>
          <button type="button" onClick={() => navigator.clipboard?.writeText(JSON.stringify(record))}>
            {ko ? '결과 복사' : 'Copy result'}
          </button>{' '}
          <button type="button" onClick={start}>
            {ko ? '다시' : 'Restart'}
          </button>
        </div>
      )}
    </div>
  )
}
