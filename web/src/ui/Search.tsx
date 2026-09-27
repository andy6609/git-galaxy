import { useMemo, useRef, useState } from 'react'
import { suggest, type World } from '../data'
import { submitQuery } from '../nav'
import { setState, useStore } from '../store'

export function Search({ world }: { world: World }) {
  const phase = useStore((s) => s.phase)
  const notFound = useStore((s) => s.notFound)
  const ingesting = useStore((s) => s.ingesting)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const options = useMemo(() => suggest(world, q), [world, q])

  const go = (value: string, via: 'search' | 'suggest') => {
    setQ('')
    setActive(-1)
    input.current?.blur()
    void submitQuery(world, value, via)
  }

  return (
    <div className={`search ${phase === 'intro' ? 'is-intro' : ''}`}>
      {phase === 'intro' && (
        <div className="intro-copy">
          <h1>당신의 GitHub가 작은 우주가 됩니다.</h1>
          <p>아이디만 입력하세요. 로그인 없이 공개 저장소로 행성계를 먼저 보여 드립니다.</p>
        </div>
      )}
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (active >= 0 && options[active]) go(options[active].value, 'suggest')
          else if (q.trim()) go(q, 'search')
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(-1)
            if (notFound) setState({ notFound: null })
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(options.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(-1, a - 1))
            } else if (e.key === 'Escape') {
              setQ('')
              input.current?.blur()
            }
          }}
          placeholder="username 또는 owner/repo"
          aria-label="username, owner/repo, GitHub URL 또는 패키지 이름"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={!q.trim()}>
          {phase === 'intro' ? '내 행성계 만들기' : '찾기'}
        </button>
      </form>
      {options.length > 0 && (
        <ul className="suggest" role="listbox">
          {options.map((o, k) => (
            <li
              key={o.value}
              role="option"
              aria-selected={k === active}
              className={k === active ? 'is-active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                go(o.value, 'suggest')
              }}
            >
              <span className="s-label">{o.label}</span>
              <span className="s-sub">{o.sub}</span>
            </li>
          ))}
        </ul>
      )}
      {ingesting && (
        <p className="notfound is-busy">
          <b>{ingesting}</b>의 공개 저장소를 관측해 행성계를 만들고 있습니다. 그동안 우주를 둘러보셔도 됩니다.
        </p>
      )}
      {notFound && !ingesting && (
        <p className="notfound">
          <b>{notFound}</b> — 찾지 못했습니다. GitHub username이나 owner/repo를 확인해 주세요.
        </p>
      )}
    </div>
  )
}
