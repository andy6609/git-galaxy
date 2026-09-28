import { useMemo, useRef, useState } from 'react'
import { suggest, type World } from '../data'
import { copyFor } from '../i18n'
import { submitQuery } from '../nav'
import { setState, useStore } from '../store'

export function Search({ world }: { world: World }) {
  const phase = useStore((s) => s.phase)
  const notFound = useStore((s) => s.notFound)
  const ingesting = useStore((s) => s.ingesting)
  const language = useStore((s) => s.language)
  const c = copyFor(language)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const options = useMemo(() => suggest(world, q, 6, language), [world, q, language])

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
          <h1>{c.heroTitle}</h1>
          <p>{c.heroBody}</p>
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
          placeholder={c.placeholder}
          aria-label={c.searchLabel}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={!q.trim()}>
          {phase === 'intro' ? c.createSystem : c.find}
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
          {c.observing(ingesting)}
        </p>
      )}
      {notFound && !ingesting && (
        <p className="notfound">
          {c.notFound(notFound)}
        </p>
      )}
    </div>
  )
}
