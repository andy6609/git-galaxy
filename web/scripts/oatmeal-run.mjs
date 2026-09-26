// 오트밀 테스트 페이지가 끝까지 도는지 확인하고 화면을 캡처한다 (답은 무작위로 고른다)
//   node scripts/oatmeal-run.mjs <출력 폴더>
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.URL ?? 'http://localhost:5173'
const out = process.argv[2] ?? 'shots'
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${BASE}/?view=oatmeal&seed=42`, { waitUntil: 'networkidle0' })
await page.waitForSelector('.om-card button')
await page.screenshot({ path: `${out}/om-1-intro.png` })
await page.click('.om-card button')
await sleep(1500)
await page.screenshot({ path: `${out}/om-2-study.png` })
await sleep(6 * 5000)
await page.screenshot({ path: `${out}/om-3-test.png` })
for (let k = 0; k < 6; k++) {
  await page.keyboard.press(String(1 + (k % 4)))
  await sleep(700)
}
await sleep(500)
await page.screenshot({ path: `${out}/om-4-done.png` })
const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('gg-oatmeal') ?? '[]').at(-1))
console.log(JSON.stringify({ score: rec?.score, random: rec?.random, sameArch: rec?.sameArch, trials: rec?.trials?.length, errors }))
await browser.close()
