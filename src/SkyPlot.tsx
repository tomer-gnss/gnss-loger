import { satellitesOf, satLabel, type Signal, type Sys } from './logParser'
import { SYS_COLOR } from './colors'

/** A satellite drawn as a dashed outline: where it *should* be according to its orbit. */
export type Ghost = { sys: Sys; svid: number; name?: string; az: number; el: number }

/**
 * Polar sky plot (north up, zenith in the centre).
 * - signals: measured satellites (filled = used in fix, hollow = not used, faded = not tracked)
 * - ghosts: predicted positions from orbital data, drawn as dashed outlines underneath, so a
 *   measured satellite sitting on its ghost confirms the sky is real.
 */
export function SkyPlot({ signals, ghosts = [], emptyText = 'אין מיקומי לוויינים בלוג הזה' }: { signals: Signal[]; ghosts?: Ghost[]; emptyText?: string }) {
  const sats = satellitesOf(signals).filter((s) => s.az !== null && s.el !== null && s.el >= -5)
  const shownGhosts = ghosts.filter((g) => g.el >= 0)
  const c = 180, r = 140
  const pos = (az: number, el: number) => {
    const d = r * (1 - Math.max(0, el) / 90), a = (az * Math.PI) / 180
    return { x: c + d * Math.sin(a), y: c - d * Math.cos(a) }
  }
  return (
    <svg className="sky-plot" viewBox="0 0 360 372" role="img" aria-label={`מפת שמיים: ${sats.length} לוויינים${shownGhosts.length ? `, ${shownGhosts.length} חזויים` : ''}`}>
      <circle cx={c} cy={c} r={r} className="sky-horizon" />
      {[30, 60].map((el) => <circle key={el} cx={c} cy={c} r={r * (1 - el / 90)} className="sky-ring" />)}
      <path d={`M ${c - r} ${c} H ${c + r} M ${c} ${c - r} V ${c + r}`} className="sky-crosshair" />
      <text x={c + 4} y={c - r * (1 - 30 / 90) - 4} className="sky-ring-label">30°</text>
      <text x={c + 4} y={c - r * (1 - 60 / 90) - 4} className="sky-ring-label">60°</text>
      {shownGhosts.map((g) => {
        const p = pos(g.az, g.el)
        return (
          <g key={`ghost-${g.sys}-${g.svid}`} transform={`translate(${p.x} ${p.y})`}>
            <circle r="8" fill="none" stroke={SYS_COLOR[g.sys].dark} strokeWidth="1.5" strokeDasharray="2 2" opacity="0.8" />
            <title>{`${satLabel(g)} · ${g.sys} · חזוי · אזימוט ${Math.round(g.az)}° · גובה ${Math.round(g.el)}°`}</title>
          </g>
        )
      })}
      {sats.map((s) => {
        const p = pos(s.az!, s.el!)
        const color = SYS_COLOR[s.sys].dark
        const tracked = (s.cn0 ?? 0) > 0
        return (
          <g key={`${s.sys}-${s.svid}`} transform={`translate(${p.x} ${p.y})`} opacity={tracked ? 1 : 0.45}>
            {s.used === false ? <circle r="5" fill="#142a22" stroke={color} strokeWidth="2" /> : <circle r="6" fill={color} stroke="#142a22" strokeWidth="2" />}
            <text x="9" y="-7" className="sky-label">{satLabel(s)}</text>
            <title>{`${satLabel(s)} · ${s.sys} · אזימוט ${Math.round(s.az!)}° · גובה ${Math.round(s.el!)}°${s.cn0 && s.cn0 > 1 ? ` · ${s.cn0.toFixed(0)} dB-Hz` : ''}${s.used ? ' · בשימוש' : ''}`}</title>
          </g>
        )
      })}
      <text x={c} y={c - r - 10} className="plot-direction" textAnchor="middle">N</text>
      <text x={c + r + 12} y={c + 4} className="plot-direction" textAnchor="middle">E</text>
      <text x={c} y={c + r + 22} className="plot-direction" textAnchor="middle">S</text>
      <text x={c - r - 12} y={c + 4} className="plot-direction" textAnchor="middle">W</text>
      {!sats.length && !shownGhosts.length && <text x={c} y={c + 5} className="plot-direction" textAnchor="middle">{emptyText}</text>}
    </svg>
  )
}
