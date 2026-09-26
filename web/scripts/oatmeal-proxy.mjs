// E2 대리 지표: 흐리게 줄인 이미지만으로 같은 행성을 알아보는가.
//   node scripts/oatmeal-proxy.mjs [출력 json]      (dev 서버가 떠 있어야 한다)
//
// 행성 N개를 도착 구도(A)와 돌린 구도(B)로 렌더링하고 작게 줄인다. 잔무늬는 사라지고 큰 형태와 색만 남는다.
// B의 각 행성에 대해 A 전체에서 가장 비슷한 것이 자기 자신이면 맞힘.
//   easy.*  40°·-15° 돌림, 16×16
//   hard.*  65°·-20° 돌림, 행성 크기를 지우고(원판을 잘라 같은 크기로) 8×8 — 사람의 한 번 기억에 더 가깝게
//   full       색 + 형태
//   structure  밝기만, 칸마다 평균·분산 정규화 (팔레트를 빼고 형태만)
//   color      평균 색만 (팔레트만으로 얼마나 맞히나)
//   same_arch  같은 원형끼리만 후보로 두었을 때 (원형 안에서도 구별되나)
//   hist       (hard 각도) 원판의 색·밝기 분포만. 위치를 보지 않아 회전에 강하다 —
//              "흰 극관에 붉은 나선" 같은 기억에 가깝다. 위치를 보는 지표는 큰 무늬가
//              회전과 함께 움직이면 오히려 불리하다 (E2에서 확인).
// 외형 버전을 비교한다: LOOKS=1,2 (기본). ?look=1은 E1의 v1을 그대로 재현한다.
// 사람 대상 오트밀 테스트(?view=oatmeal)를 대신하지 않는다. 개발 중 비교용이다.
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.URL ?? 'http://localhost:5173'
const OUT = process.argv[2]
const N = Number(process.env.N ?? 160)
const LOOKS = (process.env.LOOKS ?? '1,2').split(',').map(Number)
const PER_PAGE = 40

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1152, height: 720, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto(`${BASE}/?view=probe&seed=1`, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => !!window.__gg)
// 고정된 표본: repo ID 순으로 정렬해 일정 간격으로 뽑는다 (외형 버전이 바뀌어도 같은 repo들)
const sample = await page.evaluate((n) => {
  const { world } = window.__gg
  const ids = world.planets.map((p) => p.id).sort()
  const step = ids.length / n
  return Array.from({ length: n }, (_, k) => ids[Math.floor(k * step)]).map((id) => {
    return { id }
  })
}, N)

async function render(ids, turn, S, crop, look) {
  await page.goto(`${BASE}/?view=probe&look=${look}&turn=${turn}&ids=${ids.join(',')}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.__probeReady === true, { timeout: 20000 })
  return page.evaluate(
    (S, n, crop) => {
      const c = document.querySelector('canvas')
      const cols = 8
      const rows = 5
      const cw = c.width / cols
      const ch = c.height / rows
      const mid = document.createElement('canvas')
      mid.width = mid.height = S * 3
      const small = document.createElement('canvas')
      small.width = small.height = S
      const mctx = mid.getContext('2d')
      const sctx = small.getContext('2d', { willReadFrequently: true })
      mctx.imageSmoothingQuality = sctx.imageSmoothingQuality = 'high'
      const out = []
      const hists = []
      for (let k = 0; k < n; k++) {
        let x = (k % cols) * cw
        let y = Math.floor(k / cols) * ch
        let size = cw
        const m = cw * 0.1
        if (crop) {
          // 행성 원판의 경계 상자를 찾아 그 크기로 자른다 (크기 단서 제거)
          const probe = document.createElement('canvas')
          probe.width = cw
          probe.height = ch
          const pctx = probe.getContext('2d', { willReadFrequently: true })
          pctx.drawImage(c, x, y, cw, ch, 0, 0, cw, ch)
          const d = pctx.getImageData(0, 0, cw, ch).data
          let x0 = cw, y0 = ch, x1 = 0, y1 = 0
          for (let py = 0; py < ch; py++)
            for (let px = 0; px < cw; px++) {
              const o = (py * cw + px) * 4
              if (d[o] + d[o + 1] + d[o + 2] > 70) {
                x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py)
              }
            }
          const side = Math.max(x1 - x0, y1 - y0, 8)
          x += (x0 + x1) / 2 - side / 2
          y += (y0 + y1) / 2 - side / 2
          size = side
          mctx.clearRect(0, 0, S * 3, S * 3)
          mctx.drawImage(c, x, y, size, size, 0, 0, S * 3, S * 3)
          // 원판 안의 색(4×4×4)과 밝기(10) 분포
          const H = 48
          const hc = document.createElement('canvas')
          hc.width = hc.height = H
          const hctx = hc.getContext('2d', { willReadFrequently: true })
          hctx.drawImage(c, x, y, size, size, 0, 0, H, H)
          const hd = hctx.getImageData(0, 0, H, H).data
          const color = new Array(64).fill(0)
          const light = new Array(10).fill(0)
          let cnt = 0
          for (let py = 0; py < H; py++)
            for (let px = 0; px < H; px++) {
              const dx = (px + 0.5) / H - 0.5
              const dy = (py + 0.5) / H - 0.5
              if (dx * dx + dy * dy > 0.2) continue
              const o = (py * H + px) * 4
              const r = hd[o], g = hd[o + 1], b = hd[o + 2]
              if (r + g + b < 40) continue
              color[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++
              light[Math.min(9, Math.floor(((0.3 * r + 0.59 * g + 0.11 * b) / 256) * 10))]++
              cnt++
            }
          hists.push([...color.map((v) => v / (cnt || 1)), ...light.map((v) => v / (cnt || 1))])
        } else {
          mctx.clearRect(0, 0, S * 3, S * 3)
          mctx.drawImage(c, x + m, y + m, cw - 2 * m, ch - 2 * m, 0, 0, S * 3, S * 3)
        }
        sctx.clearRect(0, 0, S, S)
        sctx.drawImage(mid, 0, 0, S * 3, S * 3, 0, 0, S, S)
        out.push(Array.from(sctx.getImageData(0, 0, S, S).data))
      }
      return { out, hists }
    },
    S,
    ids.length,
    crop,
  )
}

async function collect(look) {
  const sets = { easy: { A: [], B: [] }, hard: { A: [], B: [] }, hist: { A: [], B: [] } }
  for (let p = 0; p < N; p += PER_PAGE) {
    const ids = sample.slice(p, p + PER_PAGE).map((s) => s.id)
    sets.easy.A.push(...(await render(ids, 0, 16, false, look)).out)
    sets.easy.B.push(...(await render(ids, 1, 16, false, look)).out)
    const a = await render(ids, 0, 8, true, look)
    const b = await render(ids, 2, 8, true, look)
    sets.hard.A.push(...a.out)
    sets.hard.B.push(...b.out)
    sets.hist.A.push(...a.hists)
    sets.hist.B.push(...b.hists)
  }
  return sets
}
const byLook = {}
for (const look of LOOKS) byLook[look] = await collect(look)
await browser.close()

const rgb = (px) => {
  const v = []
  for (let i = 0; i < px.length; i += 4) v.push(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255)
  return v
}
const lum = (px) => {
  const v = []
  for (let i = 0; i < px.length; i += 4) v.push((0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]) / 255)
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) || 1
  return v.map((x) => (x - mean) / sd)
}
const meanColor = (px) => {
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] + px[i + 1] + px[i + 2] < 60) continue // 배경
    r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : [0, 0, 0]
}
const bhatta = (a, b) => a.reduce((s, x, i) => s + Math.sqrt(x * b[i]), 0)
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  return d / (Math.sqrt(na * nb) || 1)
}
const negDist = (a, b) => -Math.hypot(...a.map((x, i) => x - b[i]))

function accuracy({ A, B }, f, sim, candidates = () => true) {
  const va = A.map(f)
  const vb = B.map(f)
  let hit = 0
  for (let i = 0; i < vb.length; i++) {
    let best = -1
    let bestS = -Infinity
    for (let j = 0; j < va.length; j++) {
      if (!candidates(i, j)) continue
      const s = sim(vb[i], va[j])
      if (s > bestS) {
        bestS = s
        best = j
      }
    }
    if (best === i) hit++
  }
  return +(hit / vb.length).toFixed(3)
}

const score = (set) => ({
  full: accuracy(set, rgb, cos),
  structure: accuracy(set, lum, cos),
  color: accuracy(set, meanColor, negDist),
})
const id = (x) => x
const result = { n: N, chance: +(1 / N).toFixed(4) }
for (const look of LOOKS) {
  const sets = byLook[look]
  result[`v${look}`] = {
    easy: score(sets.easy),
    hard: score(sets.hard),
    hist: accuracy(sets.hist, id, bhatta),
  }
}
console.log(JSON.stringify(result, null, 1))
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1))
