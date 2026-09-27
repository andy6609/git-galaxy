// 박물관 명판. 모르는 값은 —로 쓰고 0으로 쓰지 않는다 (DIRECTION K6).
//   행성 명판   궤도에 도착했을 때: repo 하나
//   행성계 명판 행성계 전체를 볼 때: 계정 하나와 그 repo들 (만든 순서)
import { useEffect, useState } from 'react'
import type { World } from '../data'
import { goToPlanet, showSystem } from '../nav'
import { ARCHETYPES, ARCHETYPE_LABEL, PALETTES, STYLES, STYLE_LABEL } from '../seed'
import { repoDetail, useStore } from '../store'
import { nextSystems } from '../world/destinations'
import { routesOf } from '../world/Lines'
import { portraitIndices } from '../world/systemPortrait'

const CHIPS = 8
const ordinal = (k: number) => ['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째', '일곱째', '여덟째'][k] ?? `${k + 1}번째`
const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString())

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    const clipboardResult = await Promise.race([
      navigator.clipboard.writeText(value).then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => window.setTimeout(() => resolve(false), 350)),
    ])
    if (clipboardResult) return true
  }
  // 권한이 없거나 응답이 멈춘 브라우저에서는 선택 영역 복사를 한 번 더 시도한다.
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  Object.assign(textarea.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' })
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, value.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()
  return copied
}

function chip(world: World, i: number, label = world.planets[i].n) {
  return (
    <li key={i}>
      <button type="button" onClick={() => goToPlanet(world, i, 'route')}>
        {label}
      </button>
    </li>
  )
}

function NextDestinations({ world, current }: { world: World; current: number }) {
  const destinations = nextSystems(world, current)
  if (destinations.length === 0) return null
  return (
    <section className="next-section">
      <h2>
        <i className="swatch s-next" /> 다음 항해 <span>{destinations.length}</span>
      </h2>
      <ol className="next-systems">
        {destinations.map(({ system, reason }, order) => {
          const target = world.systems[system]
          return (
            <li key={target.id}>
              <button type="button" onClick={() => showSystem(world, system, 'route')}>
                <span className="next-order">0{order + 1}</span>
                <span className="next-copy">
                  <b>@{target.login}</b>
                  <small>{reason}</small>
                </span>
                <span className="next-arrow" aria-hidden>
                  →
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function Plate({ world }: { world: World }) {
  const focus = useStore((s) => s.focus)
  const phase = useStore((s) => s.phase)
  const details = useStore((s) => s.details)
  const show = focus !== null && phase === 'orbit'
  if (focus === null || !world.planets[focus]) return <aside className="plate" />

  const p = world.planets[focus]
  const sys = world.systems[p.sys]
  const d = repoDetail(world, focus, details)
  const [owner, repo] = p.n.split('/')
  const { out, inc, hiddenIncoming } = routesOf(world, focus, details)
  const stars = d?.stars ?? p.s
  const meta = [
    stars === null ? '★ —' : `★ ${fmt(stars)}`,
    p.l ?? '언어 —',
    p.c ? p.c.slice(0, 4) : '생성 —',
    d ? (d.license ? d.license.toUpperCase() : '라이선스 미확인') : '…',
  ]
  const look = world.looks[focus]
  return (
    <aside className={`plate ${show ? 'is-shown' : ''}`} aria-live="polite">
      <h1>
        <span className="p-owner">{owner}/</span>
        <span className="p-repo">{repo}</span>
      </h1>
      {d?.desc && <p className="p-desc">{d.desc}</p>}
      <p className="p-meta">{meta.join(' · ')}</p>
      {sys && (
        <p className="p-meta p-place">
          <button type="button" onClick={() => showSystem(world, p.sys, 'system')}>
            {sys.login}의 행성계
          </button>
          <span>
            {' '}
            · {ordinal(p.ring)} 궤도{p.c && ` · ${p.c} 생성`}
          </span>
        </p>
      )}
      <p className="p-meta p-dim">
        지형 · {ARCHETYPE_LABEL[ARCHETYPES[look.arch]]}
        {look.style > 0 && ` · ${STYLE_LABEL[STYLES[look.style]]}`}
        {d?.archived && ' · 보존된 세계 (archived)'}
        {sys && ` · ${world.galaxies[sys.gal]?.name ?? '관계 미확정'}`}
        {d && ` · 관측 ${(d.observed ?? '').slice(0, 10) || '—'}`}
      </p>
      {out.length > 0 && (
        <section>
          <h2>
            <i className="swatch s-out" />
            딛고 선 곳 <span>{out.length}</span>
          </h2>
          <ul className="chips">
            {out.slice(0, CHIPS).map((r) => chip(world, r.to))}
            {out.length > CHIPS && <li className="more">+{out.length - CHIPS}</li>}
          </ul>
        </section>
      )}
      {inc.length > 0 && (
        <section>
          <h2>
            <i className="swatch s-in" />이 위에 선 곳 <span>{inc.length + hiddenIncoming}</span>
          </h2>
          <ul className="chips">
            {inc.slice(0, CHIPS).map((r) => chip(world, r.to))}
            {inc.length + hiddenIncoming > CHIPS && <li className="more">+{inc.length + hiddenIncoming - CHIPS}</li>}
          </ul>
        </section>
      )}
      {d && out.length === 0 && inc.length === 0 && (
        <p className="p-note">관측한 행성들 사이에서 확인된 항로가 없습니다.</p>
      )}
      <NextDestinations world={world} current={p.sys} />
      <a className="p-link" href={`https://github.com/${p.n}`} target="_blank" rel="noreferrer">
        GitHub에서 보기 ↗
      </a>
    </aside>
  )
}

export function SystemPlate({ world }: { world: World }) {
  const k = useStore((s) => s.system)
  const phase = useStore((s) => s.phase)
  const focus = useStore((s) => s.focus)
  const details = useStore((s) => s.details)
  const [showAll, setShowAll] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    setShowAll(false)
    setCopyState('idle')
  }, [k])
  const show = k !== null && focus === null && phase === 'survey'
  if (k === null || !world.systems[k]) return <aside className="plate" />
  const s = world.systems[k]
  const d = details[s.id]
  const members = world.members[k]
  const heroes = portraitIndices(world, k)
  const hidden = Math.max(0, members.length - heroes.length)
  const first = members.map((i) => world.planets[i].c).filter(Boolean).sort()[0]
  const langs = new Map<string, number>()
  for (const i of members) {
    const l = world.planets[i].l
    if (l) langs.set(l, (langs.get(l) ?? 0) + 1)
  }
  const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l)
  const copyAddress = async () => {
    const url = `${location.origin}${location.pathname}?u=${encodeURIComponent(s.login)}`
    const copied = await copyText(url)
    setCopyState(copied ? 'copied' : 'failed')
    window.setTimeout(() => setCopyState('idle'), 2200)
  }
  return (
    <aside className={`plate system-plate ${show ? 'is-shown' : ''}`} aria-live="polite">
      <p className="system-kicker">{s.kind === 'organization' ? '조직 행성계' : '나의 오픈소스 행성계'}</p>
      <h1 className="system-title">
        <span className="p-repo">@{s.login}</span>
      </h1>
      {d?.name && <p className="p-desc">{d.name}</p>}
      <p className="system-summary">
        공개 저장소 <b>{s.n}개</b>{s.truncated ? ' 중 최근 100개를 관측했습니다.' : '로 만든 작은 우주입니다.'}
      </p>
      <p className="p-meta p-dim">
        {topLangs.length > 0 && `${topLangs.join(' · ')} · `}
        {first ? `${first.slice(0, 4)}년부터` : '생성 시점 미확인'}
      </p>
      {s.gal >= 0 && s.reg < 0 && (
        <p className="p-note">이 우주에 아직 비슷한 계정이 적어서, 가장 가까운 은하의 변두리에 자리 잡았습니다.</p>
      )}
      <section className="hero-section">
        <h2>
          지금 보이는 대표 행성 <span>{heroes.length}</span>
        </h2>
        <ul className="hero-repos">
          {heroes.map((i) => {
            const p = world.planets[i]
            const color = PALETTES[world.looks[i].palette][3]
            return (
              <li key={i}>
                <button type="button" onClick={() => goToPlanet(world, i, 'route')}>
                  <i style={{ backgroundColor: color }} />
                  <span>{p.n.split('/')[1]}</span>
                  <small>{p.l ?? (p.c ? p.c.slice(0, 4) : 'repo')}</small>
                </button>
              </li>
            )
          })}
        </ul>
        {hidden > 0 && <p className="belt-note">나머지 {hidden}개 저장소는 바깥 벨트의 빛으로 남아 있습니다.</p>}
      </section>
      <NextDestinations world={world} current={k} />
      <div className="system-actions">
        <button
          type="button"
          className={`share-system ${copyState === 'failed' ? 'is-failed' : ''}`}
          onClick={copyAddress}
          aria-live="polite"
        >
          {copyState === 'copied'
            ? '주소를 복사했습니다'
            : copyState === 'failed'
              ? '복사하지 못했습니다'
              : '이 행성계 공유하기'}
        </button>
        <a href={`https://github.com/${s.login}`} target="_blank" rel="noreferrer">
          GitHub 보기
        </a>
      </div>
      <button type="button" className="all-repos-toggle" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
        {showAll ? '전체 저장소 접기' : `저장소 ${members.length}개 모두 보기`}
      </button>
      {showAll && (
        <ul className="all-repos">
          {members.map((i) => (
            <li key={i}>
              <button type="button" onClick={() => goToPlanet(world, i, 'route')}>
                <span>{world.planets[i].n.split('/')[1]}</span>
                <small>{world.planets[i].l ?? world.planets[i].c?.slice(0, 4) ?? 'repo'}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
