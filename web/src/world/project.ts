// 월드 좌표 → 화면 좌표. 프레임마다 수천 번 부르므로 할당하지 않는다.
import * as THREE from 'three'

const m = new THREE.Matrix4()

export type Projector = {
  /** 성공하면 out에 [x, y, 깊이]를 쓰고 true */
  project(x: number, y: number, z: number, out: Float32Array): boolean
  width: number
  height: number
}

export function projector(cam: THREE.PerspectiveCamera, width: number, height: number): Projector {
  m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  const e = m.elements
  return {
    width,
    height,
    project(x, y, z, out) {
      const w = e[3] * x + e[7] * y + e[11] * z + e[15]
      if (w <= 0.01) return false
      out[0] = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5) * width
      out[1] = (1 - (((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5)) * height
      out[2] = w
      return true
    },
  }
}
