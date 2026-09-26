// 설치된 Chrome으로 장면을 캡처하고 프레임 시간을 잰다.
//   npm run shot -- [출력 폴더]      (dev 서버가 떠 있어야 한다: npm run dev)
// 장면: 은하 전체 → 항해 중 → 도착(궤도) → 개인 별자리 → 갤러리
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.URL ?? 'http://localhost:5173'
const OUT = process.argv[2] ?? 'shots'
const TARGET = process.env.TARGET ?? 'andy6609/My_interest_solarsystem---BrisHack2026'
const OWNER = process.env.OWNER ?? 'andy6609'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`[${m.type()}]`, m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

async function frameStats(ms = 2000) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const t = []
        let last = performance.now()
        const end = last + ms
        const tick = (now) => {
          t.push(now - last)
          last = now
          if (now < end) requestAnimationFrame(tick)
          else {
            t.sort((a, b) => a - b)
            const avg = t.reduce((a, b) => a + b, 0) / t.length
            resolve({ frames: t.length, avg: +avg.toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(1) })
          }
        }
        requestAnimationFrame(tick)
      }),
    ms,
  )
}

const waitPhase = (phase, timeout = 20000) =>
  page.waitForFunction((p) => window.__gg?.getState().phase === p, { timeout, polling: 100 }, phase)

await page.goto(BASE, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => !!window.__gg, { timeout: 15000 })
const renderer = await page.evaluate(() => {
  const gl = document.querySelector('canvas').getContext('webgl2')
  const ext = gl?.getExtension('WEBGL_debug_renderer_info')
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
})
console.log('renderer:', renderer)

await sleep(4200)
await page.screenshot({ path: `${OUT}/1-galaxy.png` })
console.log('galaxy frames', await frameStats())

// 검색 → 항해
await page.type('.search input', TARGET)
await page.keyboard.press('Enter')
await sleep(1600)
await page.screenshot({ path: `${OUT}/2-departure.png` })
await sleep(2200)
await page.screenshot({ path: `${OUT}/3-transit.png` })
console.log('travel frames', await frameStats(1200))
await waitPhase('orbit')
await sleep(1400)
await page.screenshot({ path: `${OUT}/4-orbit.png` })
console.log('orbit frames', await frameStats())

// 궤도에서 드래그로 돌아본다
const box = { x: 720, y: 450 }
await page.mouse.move(box.x, box.y)
await page.mouse.down()
for (let k = 0; k < 20; k++) await page.mouse.move(box.x + k * 14, box.y + k * 3)
await page.mouse.up()
await sleep(1200)
await page.screenshot({ path: `${OUT}/5-orbit-rotated.png` })

// 항로를 따라 다음 행성으로
const hasRoute = await page.$('.chips button')
if (hasRoute) {
  const name = await page.$eval('.chips button', (b) => b.textContent)
  console.log('route →', name)
  await hasRoute.click()
  await waitPhase('orbit')
  await sleep(1400)
  await page.screenshot({ path: `${OUT}/6-next-planet.png` })
}

// 개인 별자리
await page.goto(`${BASE}/?u=${OWNER}`, { waitUntil: 'networkidle0' })
await waitPhase('survey', 20000).catch(() => {})
await sleep(1500)
await page.screenshot({ path: `${OUT}/7-owner.png` })

// 갤러리
await page.goto(`${BASE}/?view=gallery&seed=${process.env.SEED ?? 1}`, { waitUntil: 'networkidle0' })
await sleep(2500)
await page.screenshot({ path: `${OUT}/8-gallery.png` })

await browser.close()
