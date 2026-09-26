import { useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { loadWorld } from './data'
import { goToPlanet, showSystem } from './nav'
import { getState, setState, useStore } from './store'
import { GalleryLabels, galleryPlanets, PlanetGrid, type Grid } from './ui/Gallery'
import { Info } from './ui/Info'
import { OatmealScene, OatmealUI } from './ui/Oatmeal'
import { Plate, SystemPlate } from './ui/Plate'
import { Search } from './ui/Search'
import { Overlay } from './world/Overlay'
import { rt } from './world/runtime'
import { Scene } from './world/Scene'

const params = new URLSearchParams(location.search)
const view = params.get('view')
const GALLERY: Grid = { cols: 4, rows: 3 }
const PROBE: Grid = { cols: 8, rows: 5 }
const markProbeReady = () => Object.assign(window, { __probeReady: true })

export default function App() {
  const world = useStore((s) => s.world)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadWorld()
      .then((w) => {
        setState({ world: w })
        if (import.meta.env.DEV) Object.assign(window, { __gg: { world: w, rt, getState, goToPlanet, showSystem } })
      })
      .catch((e) => setError(String(e)))
  }, [])

  const grid = view === 'probe' ? PROBE : GALLERY
  const indices = useMemo(
    () => (world && (view === 'gallery' || view === 'probe') ? galleryPlanets(world, grid.cols * grid.rows) : []),
    [world, grid],
  )

  let scene = null
  if (world) {
    if (view === 'gallery') scene = <PlanetGrid world={world} indices={indices} grid={grid} pad={0.8} />
    else if (view === 'oatmeal') scene = <OatmealScene world={world} />
    else if (view === 'probe')
      scene = (
        <PlanetGrid
          world={world}
          indices={indices}
          grid={grid}
          detail={96}
          turn={Number(params.get('turn') ?? 0)}
          onReady={markProbeReady}
        />
      )
    else scene = <Scene world={world} />
  }

  return (
    <div className="app">
      <Canvas
        className="canvas"
        flat
        dpr={view === 'probe' ? 1 : [1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: view === 'probe' }}
        camera={{ fov: 45, near: 0.02, far: 16000, position: [0, 1400, 2200] }}
      >
        <color attach="background" args={['#0A1114']} />
        {scene}
      </Canvas>
      {world && !view && (
        <>
          <Overlay world={world} />
          <Search world={world} />
          <Plate world={world} />
          <SystemPlate world={world} />
          <Info world={world} />
        </>
      )}
      {world && view === 'gallery' && <GalleryLabels world={world} indices={indices} grid={grid} pad={0.8} />}
      {world && view === 'oatmeal' && <OatmealUI world={world} />}
      {!world && <div className="loading">{error ? `관측 자료를 불러오지 못했습니다 — ${error}` : '관측 자료를 불러오는 중'}</div>}
    </div>
  )
}
