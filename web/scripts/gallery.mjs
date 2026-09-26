// 갤러리 캡처: node scripts/gallery.mjs <출력 폴더> seed=1 seed=5 "ids=1,2,3"
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.URL ?? 'http://localhost:5173'
const [out = 'shots', ...queries] = process.argv.slice(2)
mkdirSync(out, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('[error]', m.text().slice(0, 400)))
for (const q of queries.length ? queries : ['seed=1']) {
  await page.goto(`${BASE}/?view=gallery&${q}`, { waitUntil: 'networkidle0' })
  await new Promise((r) => setTimeout(r, 2200))
  await page.screenshot({ path: `${out}/gallery-${q.replace(/[^a-z0-9]/gi, '_')}.png` })
}
await browser.close()
