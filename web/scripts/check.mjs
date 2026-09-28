// 흐름 스모크 테스트 (서버 + dev 서버가 떠 있어야 한다)
//   npm run check            NEW_LOGIN=계정 으로 새로 들일 계정을 바꿀 수 있다 (기본: torvalds)
// 검색 해석 · 행성계(계정) · 건너뛰기 · URL 진입 · 명판 상세 · 새 계정 들이기 · 이동 기록
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.URL ?? 'http://localhost:5173'
const NEW_LOGIN = process.env.NEW_LOGIN ?? 'torvalds'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const state = () =>
  page.evaluate(() => {
    const s = window.__gg.getState()
    const w = s.world
    return {
      phase: s.phase,
      focus: s.focus === null ? null : w.planets[s.focus].n,
      system: s.system === null ? null : w.systems[s.system].login,
      ingesting: s.ingesting,
      notFound: s.notFound,
      systems: w.systems.length,
    }
  })
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// The landing UI must not wait for the large world response. This protects the
// first impression from Vercel cold starts and slow mobile connections.
const landing = await browser.newPage()
await landing.setViewport({ width: 1280, height: 800 })
await landing.setRequestInterception(true)
let releaseWorld
const worldIntercepted = new Promise((resolve) => {
  landing.on('request', (request) => {
    if (request.url().includes('/api/world')) {
      releaseWorld = () => request.continue()
      resolve()
    } else request.continue()
  })
})
await landing.goto(BASE, { waitUntil: 'domcontentloaded' })
await Promise.race([worldIntercepted, sleep(2000)])
// 입장 애니메이션(0.12s 지연 + 0.7s)이 끝날 만큼만 기다린다. world는 아직 붙잡아 둔 채로
await sleep(1000)
const instantHero = await landing
  .$eval('.intro-copy h1', (element) => ({ text: element.textContent, visible: getComputedStyle(element).opacity !== '0' }))
  .catch(() => ({ text: '', visible: false }))
check('world 응답 전에도 랜딩 문구가 보인다', instantHero.visible && instantHero.text.includes('Your GitHub'), JSON.stringify(instantHero))
releaseWorld?.()
await landing.close()

const search = async (q) => {
  await page.click('.search input', { count: 3 })
  await page.keyboard.press('Backspace')
  await page.type('.search input', q)
  await page.keyboard.press('Enter')
  await sleep(400)
}
const waitFor = (fn, arg, timeout = 20000) =>
  page.waitForFunction(fn, { timeout, polling: 150 }, arg).then(
    () => true,
    () => false,
  )

await page.goto(BASE, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => !!window.__gg?.getState().world, { timeout: 30000 })
await page.evaluate(() => localStorage.removeItem('gg-navlog'))
let s = await state()
check('우주를 서버에서 받았다', s.systems > 100, `행성계 ${s.systems}`)

await search('andy6609')
s = await state()
check('username → 그 계정의 행성계', s.system === 'andy6609', JSON.stringify(s))
await waitFor(() => window.__gg.getState().phase === 'survey')
const plate = await page.$eval('.plate.is-shown h1', (e) => e.textContent).catch(() => '')
check('행성계 명판', plate.includes('andy6609'), plate)

await search('mrdoob/three.js')
s = await state()
check('owner/repo → 행성', s.focus === 'mrdoob/three.js' && s.phase === 'travel', JSON.stringify(s))
await page.keyboard.press('Escape')
const skipped = await waitFor(() => window.__gg.getState().phase === 'orbit', null, 3000)
check('Esc로 항해 건너뛰기', skipped)
const desc = await page.waitForSelector('.plate.is-shown .p-desc', { timeout: 8000 }).then(() => page.$eval('.plate.is-shown .p-desc', (e) => e.textContent)).catch(() => '')
check('명판: 서버에서 받은 설명', desc.length > 5, desc.slice(0, 50))
const place = await page.$eval('.plate.is-shown .p-place', (e) => e.textContent).catch(() => '')
check('명판: 행성계와 궤도', place.includes('mrdoob') && place.includes('Orbit'), place)

await search('https://github.com/pmndrs/zustand/tree/main')
s = await state()
check('GitHub URL → 행성', s.focus === 'pmndrs/zustand', JSON.stringify(s))
await page.keyboard.press('Escape')
await sleep(500)

await search('requests')
await waitFor(() => {
  const st = window.__gg.getState()
  return st.focus !== null && st.world.planets[st.focus].n.toLowerCase().includes('requests')
}, null, 8000)
s = await state()
check('패키지 이름 → 행성 (서버에 묻기)', !!s.focus && s.focus.toLowerCase().includes('requests'), JSON.stringify(s))
await page.keyboard.press('Escape')
await sleep(500)

const known = await page.evaluate((l) => window.__gg.getState().world.byLogin.has(l.toLowerCase()), NEW_LOGIN)
if (known) {
  check(`새 계정 들이기 (${NEW_LOGIN}는 이미 있음 — 건너뜀)`, true)
} else {
  const before = (await state()).systems
  await search(NEW_LOGIN)
  const busy = await waitFor((l) => window.__gg.getState().ingesting === l, NEW_LOGIN, 5000)
  const msg = await page.$eval('.notfound.is-busy', (e) => e.textContent).catch(() => '')
  check('모르는 계정 → 관측 중 표시', busy && msg.includes(NEW_LOGIN), msg.slice(0, 40))
  const added = await waitFor((l) => window.__gg.getState().system !== null && window.__gg.getState().world.systems[window.__gg.getState().system].login.toLowerCase() === l.toLowerCase(), NEW_LOGIN, 45000)
  s = await state()
  check('새 계정 → 행성계가 생기고 그리로 간다', added && s.systems === before + 1, JSON.stringify(s))
}

await page.goto(`${BASE}/?u=andy6609`, { waitUntil: 'networkidle0' })
const viaUrl = await waitFor(() => window.__gg?.getState().system !== null && window.__gg.getState().phase === 'survey', null, 20000)
check('?u= 진입 → 행성계', viaUrl, page.url())

const log = await page.evaluate(() => JSON.parse(localStorage.getItem('gg-navlog') ?? '[]').map((e) => e.via))
check('이동 기록 (E5용)', log.includes('url'), log.join(','))
check('페이지 오류 없음', errors.length === 0, errors.join(' | '))
await browser.close()
process.exit(failed ? 1 : 0)
