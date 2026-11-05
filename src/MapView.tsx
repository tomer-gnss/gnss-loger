import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Crosshair, Maximize2, Minimize2 } from 'lucide-react'

export type MapPoint = { lat: number; lon: number }
export type MapCurrent = MapPoint & { acc: number | null }

const MAX_TRACK_POINTS = 4000 // keep the polyline light on phones

/**
 * OpenStreetMap view with the receiver track, the current position and its accuracy circle.
 * mode 'follow' (live): keeps the current position centred until the user pans the map.
 * mode 'fit' (log): fits the whole track once, then just moves the marker.
 */
export function MapView({ track, current, mode, fitKey }: {
  track: MapPoint[]
  current: MapCurrent | null
  mode: 'follow' | 'fit'
  /** Changing this re-fits the map to the track (e.g. when a new log is loaded). */
  fitKey?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layers = useRef<{ line: L.Polyline; acc: L.Circle; dot: L.CircleMarker } | null>(null)
  const [following, setFollowing] = useState(true)
  const [full, setFull] = useState(false)
  const followRef = useRef(true)

  // Create the map once.
  useEffect(() => {
    if (!box.current) return
    const m = L.map(box.current, { zoomControl: true, attributionControl: true })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m)
    const line = L.polyline([], { color: '#23845d', weight: 3, opacity: 0.9 }).addTo(m)
    const acc = L.circle([0, 0], { radius: 0, color: '#d0703f', weight: 1.5, dashArray: '4 3', fillColor: '#d0703f', fillOpacity: 0.12 }).addTo(m)
    const dot = L.circleMarker([0, 0], { radius: 7, color: '#ffffff', weight: 2.5, fillColor: '#d0703f', fillOpacity: 1 }).addTo(m)
    m.setView([31.5, 34.9], 7)
    // The user took over: stop auto-centring until they press "centre".
    m.on('dragstart', () => { followRef.current = false; setFollowing(false) })
    map.current = m
    layers.current = { line, acc, dot }
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(box.current)
    return () => { ro.disconnect(); m.remove(); map.current = null; layers.current = null }
  }, [])

  // Track polyline.
  useEffect(() => {
    if (!layers.current) return
    const step = Math.max(1, Math.ceil(track.length / MAX_TRACK_POINTS))
    const pts: L.LatLngExpression[] = []
    for (let i = 0; i < track.length; i += step) pts.push([track[i].lat, track[i].lon])
    if (track.length) pts.push([track[track.length - 1].lat, track[track.length - 1].lon])
    layers.current.line.setLatLngs(pts)
  }, [track])

  // Fit the whole track (log mode) when a new log arrives.
  useEffect(() => {
    const m = map.current
    if (!m || mode !== 'fit' || !track.length) return
    m.fitBounds(L.latLngBounds(track.map((p) => [p.lat, p.lon] as [number, number])), { padding: [24, 24], maxZoom: 18 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, mode])

  // Current position + accuracy circle; follow in live mode.
  useEffect(() => {
    const m = map.current
    const l = layers.current
    if (!m || !l) return
    if (!current) { l.dot.setStyle({ opacity: 0, fillOpacity: 0 }); l.acc.setRadius(0); return }
    const ll: L.LatLngExpression = [current.lat, current.lon]
    l.dot.setLatLng(ll).setStyle({ opacity: 1, fillOpacity: 1 })
    l.acc.setLatLng(ll).setRadius(current.acc ?? 0)
    if (mode === 'follow' && followRef.current) {
      const first = m.getZoom() < 12
      if (first) m.setView(ll, 18)
      else m.panTo(ll, { animate: true, duration: 0.4 })
    }
  }, [current, mode])

  const recentre = () => {
    followRef.current = true
    setFollowing(true)
    if (current && map.current) map.current.setView([current.lat, current.lon], Math.max(map.current.getZoom(), 17))
  }

  return (
    <div className={`map-wrap ${full ? 'is-full' : ''}`}>
      <div ref={box} className="map-box" dir="ltr" role="region" aria-label="מפה" />
      <div className="map-buttons">
        <button className="map-btn" onClick={() => setFull(!full)} aria-label={full ? 'צמצם מפה' : 'מפה במסך מלא'}>{full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        {mode === 'follow' && !following && current && <button className="map-btn label" onClick={recentre}><Crosshair size={17} /> מרכז</button>}
      </div>
    </div>
  )
}
