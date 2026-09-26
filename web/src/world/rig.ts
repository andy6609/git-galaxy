// 카메라: 궤도 조작 + 항해. React 밖에서 프레임마다 돈다.
// 상태 (docs/PROTOTYPE_SPEC.md §9): Survey → Resolve → Departure → Transit → Approach → Orbit
import * as THREE from 'three'

const UP = new THREE.Vector3(0, 1, 0)
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// 속도 곡선: v(t) ∝ t^1.5 (1-t)^3.5 → 가속 30%, 감속 70%
const SPEED_LUT = (() => {
  const n = 512
  const lut = new Float32Array(n + 1)
  let acc = 0
  for (let i = 1; i <= n; i++) {
    const t = (i - 0.5) / n
    acc += Math.pow(t, 1.5) * Math.pow(1 - t, 3.5)
    lut[i] = acc
  }
  for (let i = 0; i <= n; i++) lut[i] /= acc
  return lut
})()

function sampleLut(lut: Float32Array, t: number) {
  const x = clamp(t, 0, 1) * (lut.length - 1)
  const i = Math.floor(x)
  if (i >= lut.length - 1) return lut[lut.length - 1]
  return lut[i] + (lut[i + 1] - lut[i]) * (x - i)
}

type Travel = {
  t: number
  duration: number
  speedup: number
  curve: THREE.CubicBezierCurve3
  look0: THREE.Vector3
  dest: THREE.Vector3
  minRadius: number
  onArrive?: () => void
}

export type FlyOptions = {
  /** 도착 후 궤도 중심 */
  dest: THREE.Vector3
  /** 도착했을 때 카메라가 있을 방향 (dest 기준, 단위 벡터) */
  arriveDir: THREE.Vector3
  arriveDistance: number
  minRadius: number
  revisit?: boolean
  onArrive?: () => void
}

export class CameraRig {
  readonly target = new THREE.Vector3()
  readonly spherical = new THREE.Spherical(1750, 1.1, 0.5)
  minRadius = 6
  maxRadius = 3400
  autoRotate = 0.018
  travel: Travel | null = null
  /** 도착 연출 진행도 0..1 (조명이 가장자리를 넘어오는 효과에 쓴다) */
  reveal = 1
  readonly look = new THREE.Vector3()
  readonly reducedMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  private pendingTheta = 0
  private pendingPhi = 0
  private pendingZoom = 0

  get traveling() {
    return this.travel !== null
  }

  rotate(dx: number, dy: number) {
    this.autoRotate = 0
    this.pendingTheta -= dx * 0.0055
    this.pendingPhi -= dy * 0.0055
  }

  zoom(delta: number) {
    this.autoRotate = 0
    this.pendingZoom += delta * 0.0012
  }

  stopAuto() {
    this.autoRotate = 0
  }

  /** 거리에 따른 항해 시간 (PROTOTYPE_SPEC §9) */
  durationFor(distance: number, revisit = false) {
    if (this.reducedMotion) return 0.8
    const base = clamp(2 + 2.6 * Math.log10(1 + distance / 15), 2, 9.5)
    return revisit ? Math.max(1.4, base * 0.6) : base
  }

  flyTo(camera: THREE.Camera, o: FlyOptions) {
    const c0 = camera.position.clone()
    const look0 = this.travel ? this.look.clone() : this.target.clone()
    const c1 = o.dest.clone().addScaledVector(o.arriveDir, o.arriveDistance)
    const dist = c0.distanceTo(c1)
    const back = c0.clone().sub(look0)
    if (back.lengthSq() < 1e-6) back.set(0, 0, 1)
    back.normalize()
    // 떠오르며 물러났다가(Departure) 원반 위로 호를 그리고(Transit) 도착 방향으로 들어온다(Approach)
    const p1 = c0.clone().addScaledVector(back, dist * 0.12).addScaledVector(UP, dist * 0.18)
    const p2 = c1.clone().addScaledVector(o.arriveDir, dist * 0.28).addScaledVector(UP, dist * 0.08)
    this.travel = {
      t: 0,
      duration: this.durationFor(dist, o.revisit),
      speedup: 1,
      curve: new THREE.CubicBezierCurve3(c0, p1, p2, c1),
      look0,
      dest: o.dest.clone(),
      minRadius: o.minRadius,
      onArrive: o.onArrive,
    }
    this.curveLut = null
    this.autoRotate = 0
    this.pendingTheta = this.pendingPhi = this.pendingZoom = 0
    this.reveal = 0
  }

  /** 남은 항해를 0.35초 안에 끝낸다 */
  skip() {
    const tr = this.travel
    if (!tr) return
    const remaining = (1 - tr.t) * tr.duration
    tr.speedup = Math.max(1, remaining / 0.35)
  }

  /** 목적지 없이 중심을 옮긴다 (개인 별자리 전체 보기 등) */
  frame(camera: THREE.Camera, center: THREE.Vector3, radius: number, onArrive?: () => void) {
    const dir = camera.position.clone().sub(center)
    dir.y = Math.max(dir.y, dir.length() * 0.35)
    dir.normalize()
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 45
    const distance = Math.max(radius / Math.sin(THREE.MathUtils.degToRad(fov) * 0.36), 30)
    this.flyTo(camera, { dest: center, arriveDir: dir, arriveDistance: distance, minRadius: 6, onArrive })
  }

  private curveLut: Float32Array | null = null

  /** 곡선 길이 기준으로 u를 구한다 (속도 곡선이 실제 이동 속도가 되게) */
  private arcU(s: number) {
    const tr = this.travel!
    if (!this.curveLut) {
      const n = 256
      const lut = new Float32Array(n + 1)
      const a = new THREE.Vector3()
      const b = new THREE.Vector3()
      tr.curve.getPoint(0, a)
      for (let i = 1; i <= n; i++) {
        tr.curve.getPoint(i / n, b)
        lut[i] = lut[i - 1] + a.distanceTo(b)
        a.copy(b)
      }
      for (let i = 0; i <= n; i++) lut[i] /= lut[n] || 1
      this.curveLut = lut
    }
    const lut = this.curveLut
    let lo = 0
    let hi = lut.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (lut[mid] < s) lo = mid
      else hi = mid
    }
    const span = lut[hi] - lut[lo] || 1
    return (lo + (s - lut[lo]) / span) / (lut.length - 1)
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    const tr = this.travel
    if (tr) {
      // 프레임이 떨어져도 경과 시간으로 진행해 정확히 도착한다
      tr.t = Math.min(1, tr.t + (dt * tr.speedup) / tr.duration)
      const s = sampleLut(SPEED_LUT, tr.t)
      tr.curve.getPoint(this.arcU(s), camera.position)
      this.look.lerpVectors(tr.look0, tr.dest, smoothstep(0, 0.4, tr.t))
      camera.up.copy(UP)
      camera.lookAt(this.look)
      this.reveal = smoothstep(0.72, 1, tr.t)
      if (tr.t >= 1) {
        this.travel = null
        this.target.copy(tr.dest)
        this.spherical.setFromVector3(camera.position.clone().sub(tr.dest))
        this.minRadius = tr.minRadius
        this.reveal = 1
        tr.onArrive?.()
      }
      return
    }

    const k = 1 - Math.exp(-dt * 10)
    const dTheta = this.pendingTheta * k
    const dPhi = this.pendingPhi * k
    const dZoom = this.pendingZoom * k
    this.pendingTheta -= dTheta
    this.pendingPhi -= dPhi
    this.pendingZoom -= dZoom
    const sp = this.spherical
    sp.theta += dTheta + this.autoRotate * dt
    sp.phi = clamp(sp.phi + dPhi, 0.12, Math.PI - 0.12)
    sp.radius = clamp(sp.radius * Math.exp(dZoom), this.minRadius, this.maxRadius)
    camera.position.setFromSpherical(sp).add(this.target)
    camera.up.copy(UP)
    camera.lookAt(this.target)
    this.look.copy(this.target)
  }
}
