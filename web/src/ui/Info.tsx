// 관측 범위와 출처를 밝힌다. "GitHub 전체"를 암시하지 않는다 (DIRECTION D7).
import { useState } from 'react'
import type { World } from '../data'

export function Info({ world }: { world: World }) {
  const [open, setOpen] = useState(false)
  const m = world.meta
  return (
    <div className={`info ${open ? 'is-open' : ''}`}>
      <button type="button" className="info-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        관측 정보
      </button>
      {open && (
        <div className="info-panel">
          <p>
            계정 <b>{m.stats.accounts.toLocaleString()}</b> · 행성(repo) <b>{m.stats.planets.toLocaleString()}</b> · 확인된
            항로 <b>{m.stats.edges.toLocaleString()}</b> · 은하 {m.stats.galaxies} · 지역 {m.stats.regions}
          </p>
          <p>
            별 하나가 계정 하나이고, 그 둘레를 도는 행성이 그 계정의 공개 repo입니다(fork 제외). 안쪽 궤도일수록 먼저 만든
            repo입니다. 비슷한 일을 하는 계정들이 모여 지역과 은하가 됩니다 — 모양은 데이터가 만듭니다.
          </p>
          <p>
            아직 없는 계정을 검색하면 GitHub에서 가져와 이 우주에 들이고, 그 뒤로는 모두에게 보입니다. 한 번 놓인
            행성계는 움직이지 않습니다 (배치 v{m.placement_version}).
          </p>
          <p className="p-dim">은하의 빛·배경 별은 연출이고, 가리킬 수 있는 점만 실제 계정과 repo입니다.</p>
          <ul>
            {m.sources.map((s) => (
              <li key={s.name}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.name}
                </a>
                {s.license && ` — ${s.license}`}
                {s.use && ` — ${s.use}`}
              </li>
            ))}
          </ul>
          <p className="p-dim">데이터: {m.data_license}</p>
          <p className="p-dim">드래그 둘러보기 · 휠 확대 · 클릭 이동 · Esc 건너뛰기</p>
        </div>
      )}
    </div>
  )
}
