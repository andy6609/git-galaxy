// 관측 범위와 출처를 밝힌다. "GitHub 전체"를 암시하지 않는다 (DIRECTION D7).
import { useState } from 'react'
import type { World } from '../data'
import { copyFor } from '../i18n'
import { useStore } from '../store'

export function Info({ world }: { world: World }) {
  const [open, setOpen] = useState(false)
  const language = useStore((s) => s.language)
  const c = copyFor(language)
  const sourceUse = (name: string, value?: string) => {
    if (!value) return ''
    if (name === 'GitHub REST API') return language === 'ko' ? 'include 목록, 서버의 새 계정' : 'included accounts and newly searched accounts'
    return value
  }
  const m = world.meta
  return (
    <div className={`info ${open ? 'is-open' : ''}`}>
      <button type="button" className="info-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {c.observationInfo}
      </button>
      {open && (
        <div className="info-panel">
          <p>
            {c.accounts} <b>{m.stats.accounts.toLocaleString()}</b> · {c.planets}{' '}
            <b>{m.stats.planets.toLocaleString()}</b> · {c.routes} <b>{m.stats.edges.toLocaleString()}</b> · {c.galaxies}{' '}
            {m.stats.galaxies} · {c.regions} {m.stats.regions}
          </p>
          <p>
            {c.infoModel}
          </p>
          <p>
            {c.infoIngestion(m.placement_version)}
          </p>
          <p className="p-dim">{c.infoDecoration}</p>
          <ul>
            {m.sources.map((s) => (
              <li key={s.name}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.name}
                </a>
                {s.license && ` — ${s.license}`}
                {s.use && ` — ${sourceUse(s.name, s.use)}`}
              </li>
            ))}
          </ul>
          <p className="p-dim">{c.data}: {m.data_license}</p>
          <p className="p-dim">{c.controls}</p>
        </div>
      )}
    </div>
  )
}
