import { copyFor } from '../i18n'
import { setLanguage, useStore } from '../store'

export function LanguageSwitch() {
  const language = useStore((s) => s.language)
  const c = copyFor(language)
  const next = language === 'en' ? 'ko' : 'en'
  return (
    <button
      type="button"
      className="language-switch"
      onClick={() => setLanguage(next)}
      aria-label={next === 'ko' ? c.switchToKorean : c.switchToEnglish}
      lang={next}
    >
      {next === 'ko' ? c.closeKorean : c.closeEnglish}
    </button>
  )
}
