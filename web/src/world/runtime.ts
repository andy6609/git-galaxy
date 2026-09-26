// 프레임 루프와 UI가 함께 쓰는 가변 상태. React state가 아니다.
import type * as THREE from 'three'
import { CameraRig } from './rig'

export const rt = {
  rig: new CameraRig(),
  camera: null as THREE.PerspectiveCamera | null,
  /** 캔버스 기준 포인터 위치(px). 캔버스 밖이면 null */
  pointer: null as { x: number; y: number } | null,
  dragging: false,
  hover: -1,
  /** 가리킨 중심별 (행성계 번호) */
  hoverStar: -1,
  /** 이번 프레임에 구체로 그려지는 행성 (가까운 순) */
  visibleSpheres: [] as number[],
  /** 화면 높이 기준 투영 배율: 거리 d에서 크기 s인 물체의 화면 크기 = s * scale / d */
  pxScale: 1,
  /** 라벨·링을 그리는 DOM 레이어. Overlay가 등록한다 */
  drawOverlay: null as null | (() => void),
}

export type NavVia = 'search' | 'suggest' | 'click' | 'route' | 'url' | 'owner' | 'system'

/** E5 관찰 테스트용 이동 기록 (검색 없이 두 번째 행성으로 갔는가) */
export function logNav(via: NavVia, name: string) {
  const entry = { t: new Date().toISOString(), via, to: name }
  try {
    const log = JSON.parse(localStorage.getItem('gg-navlog') ?? '[]')
    log.push(entry)
    localStorage.setItem('gg-navlog', JSON.stringify(log.slice(-500)))
  } catch {
    // 저장소를 못 쓰면 기록만 건너뛴다
  }
}
