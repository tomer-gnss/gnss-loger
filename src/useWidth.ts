import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { ForcedWidth } from './forcedWidth'

const measure = (el: HTMLElement) => Math.max(200, Math.floor(el.getBoundingClientRect().width))

/** Width of an element, tracked so SVG text stays at real pixel size instead of scaling with a viewBox. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(320)
  // Layout effect: the first measurement lands before the browser paints, so a chart never shows
  // for a frame at the 320 px default (wider than its box on an iPhone SE, which made the page scroll).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(measure(el))
    const ro = new ResizeObserver(() => setWidth(measure(el)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const forced = useContext(ForcedWidth)
  return [ref, forced ?? width] as const
}
