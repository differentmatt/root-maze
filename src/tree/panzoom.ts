import { useCallback, useEffect, useRef, useState } from 'react'

// Shared pan/zoom for the graph canvases. Drag (one pointer) to pan, pinch (two
// pointers) or wheel to zoom about the cursor. Extracted from GraphCanvas so the
// radial canvas gets the exact same, already-proven touch behavior. The view is
// an SVG-user-space transform (translate + uniform scale) applied to a <g>.

export interface View {
  x: number
  y: number
  k: number
}

export interface PanZoom {
  view: View
  setView: React.Dispatch<React.SetStateAction<View>>
  // Spread onto the <svg> element.
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerCancel: (e: React.PointerEvent) => void
  }
  // Whether the last gesture moved (so a tap can be told from a drag/pinch).
  moved: React.MutableRefObject<boolean>
  zoomAround: (clientX: number, clientY: number, factor: number) => void
}

export function usePanZoom(
  svgRef: React.RefObject<SVGSVGElement | null>,
  minK: number,
  maxK: number,
  initial: View = { x: 0, y: 0, k: 1 },
): PanZoom {
  const [view, setView] = useState<View>(initial)

  // Active pointers, so we can tell a one-finger pan from a two-finger pinch.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastPan = useRef<{ x: number; y: number } | null>(null)
  const pinchDist = useRef<number | null>(null)
  const moved = useRef(false)

  // Map client (screen) coordinates to SVG user space via the <svg>'s own CTM,
  // which is independent of our pan/zoom transform — so deltas stay stable.
  const toUser = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current
      const ctm = svg?.getScreenCTM()
      if (!svg || !ctm) return { x: 0, y: 0 }
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
      return { x: p.x, y: p.y }
    },
    [svgRef],
  )

  const zoomAround = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const q = toUser(clientX, clientY)
      setView((v) => {
        const k = Math.min(maxK, Math.max(minK, v.k * factor))
        const f = k / v.k
        return { k, x: q.x - f * (q.x - v.x), y: q.y - f * (q.y - v.y) }
      })
    },
    [toUser, minK, maxK],
  )

  // Wheel must be a non-passive native listener so preventDefault() can stop
  // the page from scrolling while zooming.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAround(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [svgRef, zoomAround])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      svgRef.current?.setPointerCapture(e.pointerId)
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      moved.current = false
      if (pointers.current.size === 1) {
        lastPan.current = { x: e.clientX, y: e.clientY }
      } else if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
        lastPan.current = null
      }
    },
    [svgRef],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pointers.current.size >= 2 && pinchDist.current != null) {
        const [a, b] = [...pointers.current.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDist.current > 0) {
          zoomAround((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist.current)
        }
        pinchDist.current = dist
        moved.current = true
      } else if (pointers.current.size === 1 && lastPan.current) {
        const screenDx = e.clientX - lastPan.current.x
        const screenDy = e.clientY - lastPan.current.y
        if (Math.abs(screenDx) + Math.abs(screenDy) > 4) moved.current = true
        const q = toUser(e.clientX, e.clientY)
        const prev = toUser(lastPan.current.x, lastPan.current.y)
        setView((v) => ({ ...v, x: v.x + (q.x - prev.x), y: v.y + (q.y - prev.y) }))
        lastPan.current = { x: e.clientX, y: e.clientY }
      }
    },
    [toUser, zoomAround],
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = null
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()]
      lastPan.current = { x: p.x, y: p.y }
    } else if (pointers.current.size === 0) {
      lastPan.current = null
    }
  }, [])

  return {
    view,
    setView,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
    moved,
    zoomAround,
  }
}
