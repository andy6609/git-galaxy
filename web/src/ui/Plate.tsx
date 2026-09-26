// 박물관 명판. 모르는 값은 —로 쓰고 0으로 쓰지 않는다 (DIRECTION K6).
//   행성 명판   궤도에 도착했을 때: repo 하나
//   행성계 명판 행성계 전체를 볼 때: 계정 하나와 그 repo들 (만든 순서)
import type { World } from '../data'
import { goToPlanet, showSystem } from '../nav'
import { ARCHETYPES, ARCHETYPE_LABEL, STYLES, STYLE_LABEL } from '../seed'
import { repoDetail, useStore } from '../store'
import { routesOf } from '../world/Lines'

const CHIPS = 8
const ordinal = (k: number) => ['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째', '일곱째', '여덟째'][k] ?? `${k + 1}번째`
const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString())

function chip(world: World, i: number, label = world.planets[i].n) {
  return (
    <li key={i}>
      <button type="button" onClick={() => goToPlanet(world, i, 'route')}>
        {label}
      </button>
    </li>
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
  const show = k !== null && focus === null && phase === 'survey'
  if (k === null || !world.systems[k]) return <aside className="plate" />
  const s = world.systems[k]
  const d = details[s.id]
  const members = world.members[k]
  const first = members.map((i) => world.planets[i].c).filter(Boolean).sort()[0]
  const langs = new Map<string, number>()
  for (const i of members) {
    const l = world.planets[i].l
    if (l) langs.set(l, (langs.get(l) ?? 0) + 1)
  }
  const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l)
  return (
    <aside className={`plate ${show ? 'is-shown' : ''}`} aria-live="polite">
      <h1>
        <span className="p-repo">{s.login}</span>
      </h1>
      {d?.name && <p className="p-desc">{d.name}</p>}
      <p className="p-meta">
        {s.kind === 'organization' ? '조직' : '사용자'} · 행성 {s.n}개{s.truncated ? ' (최근 100개만 관측)' : ''}
        {topLangs.length > 0 && ` · ${topLangs.join(' · ')}`}
      </p>
      <p className="p-meta p-dim">
        {world.galaxies[s.gal]?.name ?? '관계 미확정'}
        {world.regions[s.reg] && ` · ${world.regions[s.reg].name}`}
        {first && ` · 첫 repo ${first.slice(0, 7)}`}
      </p>
      {s.gal >= 0 && s.reg < 0 && (
        <p className="p-note">이 우주에 아직 비슷한 계정이 적어서, 가장 가까운 은하의 변두리에 자리 잡았습니다.</p>
      )}
      <section>
        <h2>
          행성 — 안쪽 궤도일수록 먼저 만든 것 <span>{members.length}</span>
        </h2>
        <ul className="chips">
          {members.slice(0, 16).map((i) => chip(world, i, world.planets[i].n.split('/')[1]))}
          {members.length > 16 && <li className="more">+{members.length - 16}</li>}
        </ul>
      </section>
      <a className="p-link" href={`https://github.com/${s.login}`} target="_blank" rel="noreferrer">
        GitHub에서 보기 ↗
      </a>
    </aside>
  )
}
