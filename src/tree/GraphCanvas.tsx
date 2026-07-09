import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PersonNode, Edge } from '../api'
import { computeLayout } from './layout'

const WIDTH = 600
const HEIGHT = 460
const MIN_K = 0.4
const MAX_K = 4

interface View {
  x: number
  y: number
  k: number
}

// Renders the family graph as a pan/zoom SVG network: parent→child edges are
// directed (blue, arrowhead points at the child); partner edges are undirected
// (rose, dashed once ended). Drag to pan, wheel/pinch to zoom, and a button
// toggles native fullscreen. Tap a person to select them.
export default function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: PersonNode[]
  edges: Edge[]
  selectedId: string | null
  onSelect: (nodeId: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [isFull, setIsFull] = useState(false)

  // Active pointers, so we can tell a one-finger pan from a two-finger pinch.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastPan = useRef<{ x: number; y: number } | null>(null)
  const pinchDist = useRef<number | null>(null)
  const moved = useRef(false)

  // Recompute the layout only when the graph's shape changes, not on select.
  const layoutKey = useMemo(
    () =>
      nodes
        .map((n) => n.nodeId)
        .sort()
        .join(',') +
      '|' +
      edges
        .map((e) => `${e.fromPerson}>${e.toPerson}`)
        .sort()
        .join(','),
    [nodes, edges],
  )

  const pos = useMemo(
    () =>
      computeLayout(
        nodes.map((n) => n.nodeId),
        edges.map((e) => ({ from: e.fromPerson, to: e.toPerson })),
        WIDTH,
        HEIGHT,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  )

  // Map client (screen) coordinates to SVG user space via the <svg>'s own CTM,
  // which is independent of our pan/zoom transform — so deltas stay stable.
  const toUser = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  const zoomAround = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const q = toUser(clientX, clientY)
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
        const f = k / v.k
        return { k, x: q.x - f * (q.x - v.x), y: q.y - f * (q.y - v.y) }
      })
    },
    [toUser],
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
  }, [zoomAround])

  // "Fullscreen" is a CSS overlay rather than the native Fullscreen API, which
  // iOS Safari doesn't support for arbitrary elements. While open, lock body
  // scroll and let Escape close it.
  useEffect(() => {
    if (!isFull) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setIsFull(false)
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [isFull])

  function onPointerDown(e: React.PointerEvent) {
    svgRef.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    if (pointers.current.size === 1) {
      lastPan.current = toUser(e.clientX, e.clientY)
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
      lastPan.current = null
    }
  }

  function onPointerMove(e: React.PointerEvent) {
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
      const q = toUser(e.clientX, e.clientY)
      const dx = q.x - lastPan.current.x
      const dy = q.y - lastPan.current.y
      if (Math.abs(dx) + Math.abs(dy) > 1) moved.current = true
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
      lastPan.current = q
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = null
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()]
      lastPan.current = toUser(p.x, p.y)
    } else if (pointers.current.size === 0) {
      lastPan.current = null
    }
  }

  // A tap only selects if the pointer didn't drag (which would be a pan).
  function selectIfTap(nodeId: string) {
    if (!moved.current) onSelect(nodeId)
  }

  if (nodes.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-sm text-zinc-500">
        No people yet. Add someone below to start the tree.
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      className={
        isFull
          ? 'fixed inset-0 z-50 flex items-center justify-center bg-zinc-950 p-2'
          : 'relative'
      }
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`touch-none rounded-lg border border-zinc-800 bg-zinc-900 ${
          isFull ? 'h-full w-full' : 'h-auto w-full'
        }`}
        role="img"
        aria-label="Family graph"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="#38bdf8" />
          </marker>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((e) => {
            const a = pos[e.fromPerson]
            const b = pos[e.toPerson]
            if (!a || !b) return null
            const partner = e.edgeKind === 'partner'
            const ended = Boolean(e.endDate) || e.subtype === 'ex'
            return (
              <line
                key={e.edgeId}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={partner ? '#fb7185' : '#38bdf8'}
                strokeWidth={2}
                strokeDasharray={ended ? '5 4' : undefined}
                markerEnd={partner ? undefined : 'url(#arrow)'}
              />
            )
          })}

          {nodes.map((n) => {
            const p = pos[n.nodeId]
            if (!p) return null
            const selected = n.nodeId === selectedId
            return (
              <g
                key={n.nodeId}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => selectIfTap(n.nodeId)}
                className="cursor-pointer"
              >
                <circle
                  r={18}
                  fill={selected ? '#f4f4f5' : '#27272a'}
                  stroke={selected ? '#f4f4f5' : '#52525b'}
                  strokeWidth={2}
                />
                <text
                  y={34}
                  textAnchor="middle"
                  fontSize={13}
                  fill={selected ? '#f4f4f5' : '#d4d4d8'}
                >
                  {n.name}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <ControlButton
          label="Reset view"
          onClick={() => setView({ x: 0, y: 0, k: 1 })}
        >
          ⌾
        </ControlButton>
        <ControlButton
          label={isFull ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={() => setIsFull((v) => !v)}
        >
          {isFull ? '×' : '⤢'}
        </ControlButton>
      </div>
    </div>
  )
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900/90 text-lg text-zinc-300 hover:bg-zinc-800"
    >
      {children}
    </button>
  )
}
