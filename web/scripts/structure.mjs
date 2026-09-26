// 배율별 캡처: 은하 → 지역 → 행성계 → 행성 도착
//   node scripts/structure.mjs <출력 폴더> [owner/repo]
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.URL ?? 'http://localhost:5173'
const [out = 'shots', target = 'andy6609/My_interest_solarsystem---BrisHack2026'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('[error]', m.text().slice(0, 300)))
const phase = (p, timeout = 20000) =>
  page.waitForFunction((x) => window.__gg?.getState().phase === x, { timeout, polling: 100 }, p)

await page.goto(BASE, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => !!window.__gg)
await sleep(3500)
await page.screenshot({ path: `${out}/s1-galaxy.png` })

const info = await page.evaluate((name) => {
  const { world } = window.__gg
  const i = world.byName.get(name.toLowerCase())
  const p = world.planets[i]
  const s = world.systems[p.sys]
  const reg = world.regions[s.reg]
  return { i, sys: p.sys, region: s.reg, galaxy: s.gal, sysName: s.login, regionName: reg ? reg.name : '변두리' }
}, target)
console.log(info)

// 지역 전체
await page.evaluate(({ region, galaxy }) => {
  const { world, rt } = window.__gg
  // 변두리 계정(지역 없음)이면 은하 전체를 비춘다
  const r = world.regions[region] ?? world.galaxies[galaxy]
  const THREE_V = rt.camera.position.constructor
  rt.rig.frame(rt.camera, new THREE_V(...r.c), r.r * 1.1)
}, info)
await sleep(9000)
await page.screenshot({ path: `${out}/s2-region.png` })

// 행성계
await page.evaluate((k) => window.__gg.showSystem(window.__gg.world, k, 'system'), info.sys)
await phase('survey')
await sleep(1200)
await page.screenshot({ path: `${out}/s3-system.png` })

// 행성 도착
await page.evaluate((i) => window.__gg.goToPlanet(window.__gg.world, i, 'search'), info.i)
await phase('orbit')
await sleep(1500)
await page.screenshot({ path: `${out}/s4-arrival.png` })
await browser.close()
