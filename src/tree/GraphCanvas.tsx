import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PersonNode, Edge } from '../api'
import { computeLayout, neighborhood, type LayoutEdge } from './layout'
import { labelFor } from './names'

// The graph can be viewed two ways. 'tree' lays out the whole family by
// generation; 'focus' shows just one person's nearby relatives, which keeps a
// large tree legible on a small screen. The layout engine is the same for both
// — 'focus' simply runs it over a bounded neighborhood.
type ViewMode = 'tree' | 'focus'
// How many relationship-hops out the focus view reaches from its center.
const FOCUS_DEPTH = 3

// The SVG's own coordinate viewport. It stays fixed so the on-screen element
// keeps a stable size; the whole tree is fit into it via the pan/zoom
// transform, however big the graph gets.
const WIDTH = 600
const HEIGHT = 460
// Zoom-out floor low enough to fit a hundred-plus-person tree on screen.
const MIN_K = 0.05
const MAX_K = 4
const NODE_R = 18
// Padding (in viewport units) around the tree when fit into view.
const FIT_PAD = 32

interface View {
  x: number
  y: number
  k: number
}

// Renders the family graph as a pan/zoom SVG network: parent→child edges are
// directed (blue, a small arrowhead just off the child); partner edges are
// undirected (rose, dashed once ended). Drag to pan, wheel/pinch to zoom, and a
// button toggles a fullscreen overlay. Tap a person to select them. Fullscreen
// state is owned by the parent so it can layer UI over the fullscreen graph.
export default function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  isFull,
  onFullscreenChange,
  meNodeId,
}: {
  nodes: PersonNode[]
  edges: Edge[]
  selectedId: string | null
  onSelect: (nodeId: string) => void
  isFull: boolean
  onFullscreenChange: (next: boolean) => void
  // The person the signed-in user has claimed as themselves, highlighted so
  // they can find their place in the tree at a glance.
  meNodeId?: string | null
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [mode, setMode] = useState<ViewMode>('tree')
  const [showHelp, setShowHelp] = useState(false)
  // Who the focus view centers on. Null until the user picks someone (or has a
  // claimed "me" node), at which point it defaults sensibly below.
  const [focusId, setFocusId] = useState<string | null>(null)

  // Active pointers, so we can tell a one-finger pan from a two-finger pinch.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  // Track in client (screen) coords so pan deltas are computed independently of
  // view.k — the SVG CTM converts to user space without including the <g> transform.
  const lastPan = useRef<{ x: number; y: number } | null>(null)
  const pinchDist = useRef<number | null>(null)
  const moved = useRef(false)

  const layoutEdges: LayoutEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        from: e.fromPerson,
        to: e.toPerson,
        kind: e.edgeKind,
      })),
    [edges],
  )

  // In focus mode, center on the user's pick, else their claimed node, else the
  // first person — but only if that person is actually present.
  const focusCandidate = focusId ?? meNodeId ?? nodes[0]?.nodeId ?? null
  const effectiveFocus =
    focusCandidate && nodes.some((n) => n.nodeId === focusCandidate)
      ? focusCandidate
      : null

  // The people (and edges between them) this view actually shows.
  const visible = useMemo(() => {
    if (mode !== 'focus' || !effectiveFocus) return null
    return neighborhood(
      nodes.map((n) => n.nodeId),
      layoutEdges,
      effectiveFocus,
      FOCUS_DEPTH,
    )
  }, [mode, effectiveFocus, nodes, layoutEdges])

  const shownNodes = useMemo(
    () => (visible ? nodes.filter((n) => visible.has(n.nodeId)) : nodes),
    [visible, nodes],
  )
  const shownEdges = useMemo(
    () =>
      visible
        ? edges.filter(
            (e) => visible.has(e.fromPerson) && visible.has(e.toPerson),
          )
        : edges,
    [visible, edges],
  )

  // Recompute the layout only when the visible graph's shape changes, not on
  // select. Mode and focus change which people are visible, so they're keyed in.
  const layoutKey = useMemo(
    () =>
      mode +
      '|' +
      (effectiveFocus ?? '') +
      '|' +
      shownNodes
        .map((n) => n.nodeId)
        .sort()
        .join(',') +
      '|' +
      shownEdges
        .map((e) => `${e.fromPerson}>${e.toPerson}`)
        .sort()
        .join(','),
    [mode, effectiveFocus, shownNodes, shownEdges],
  )

  const layout = useMemo(
    () =>
      computeLayout(
        shownNodes.map((n) => n.nodeId),
        shownEdges.map((e) => ({
          from: e.fromPerson,
          to: e.toPerson,
          kind: e.edgeKind,
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  )
  const pos = layout.pos

  // A view (pan/zoom) that fits a content box of size cw×ch, centered on the
  // point (cx, cy), into the viewport — clamped to the zoom range.
  const viewFitting = useCallback(
    (cx: number, cy: number, cw: number, ch: number, maxK: number): View => {
      const k = Math.min(
        maxK,
        Math.max(
          MIN_K,
          Math.min(
            (WIDTH - 2 * FIT_PAD) / Math.max(cw, 1),
            (HEIGHT - 2 * FIT_PAD) / Math.max(ch, 1),
          ),
        ),
      )
      return { k, x: WIDTH / 2 - k * cx, y: HEIGHT / 2 - k * cy }
    },
    [],
  )

  // Fit the whole tree centered in the viewport.
  const fitView = useCallback((): View => {
    const cw = layout.width
    const ch = layout.height
    if (cw <= 0 || ch <= 0) return { x: 0, y: 0, k: 1 }
    return viewFitting(cw / 2, ch / 2, cw, ch, MAX_K)
  }, [layout.width, layout.height, viewFitting])

  // Zoom in on the focus person and their immediate relatives. Unlike fitting
  // the whole neighborhood (which, for a small family, is the entire tree and
  // so looks like nothing happened), this always visibly re-centers on the
  // chosen person — the point of the focus view.
  const focusView = useCallback((): View => {
    const c = effectiveFocus && pos[effectiveFocus]
    if (!c) return fitView()
    const near = new Set<string>([effectiveFocus!])
    for (const e of shownEdges) {
      if (e.fromPerson === effectiveFocus) near.add(e.toPerson)
      if (e.toPerson === effectiveFocus) near.add(e.fromPerson)
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of near) {
      const p = pos[id]
      if (!p) continue
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    // Pad for node radius + labels, and keep a floor so a lone person doesn't
    // zoom in absurdly far.
    const cw = Math.max(maxX - minX + 4 * NODE_R, 260)
    const ch = Math.max(maxY - minY + 4 * NODE_R, 220)
    return viewFitting((minX + maxX) / 2, (minY + maxY) / 2, cw, ch, 1.4)
  }, [effectiveFocus, pos, shownEdges, fitView, viewFitting])

  // Re-frame the view whenever the mode, focus person, or graph shape changes:
  // fit the whole tree in tree mode, zoom to the person in focus mode. Manual
  // pan/zoom is preserved between these changes.
  useEffect(() => {
    setView(mode === 'focus' ? focusView() : fitView())
  }, [mode, focusView, fitView])

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
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && onFullscreenChange(false)
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [isFull, onFullscreenChange])

  function onPointerDown(e: React.PointerEvent) {
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
      const screenDx = e.clientX - lastPan.current.x
      const screenDy = e.clientY - lastPan.current.y
      if (Math.abs(screenDx) + Math.abs(screenDy) > 4) moved.current = true
      const q = toUser(e.clientX, e.clientY)
      const prev = toUser(lastPan.current.x, lastPan.current.y)
      setView((v) => ({ ...v, x: v.x + (q.x - prev.x), y: v.y + (q.y - prev.y) }))
      lastPan.current = { x: e.clientX, y: e.clientY }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = null
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()]
      lastPan.current = { x: p.x, y: p.y }
    } else if (pointers.current.size === 0) {
      lastPan.current = null
    }
  }

  // A tap only selects if the pointer didn't drag (which would be a pan). In
  // focus mode a tap also re-centers the view on that person, so the graph
  // becomes a way to walk the family one relative at a time.
  function selectIfTap(nodeId: string) {
    if (moved.current) return
    if (mode === 'focus') setFocusId(nodeId)
    onSelect(nodeId)
  }

  // Enter focus mode centered on the current selection (or the "me" node).
  function enterFocus() {
    setFocusId(selectedId ?? meNodeId ?? null)
    setMode('focus')
  }

  const focusName =
    (effectiveFocus &&
      nodes.find((n) => n.nodeId === effectiveFocus)?.name) ||
    null

  if (nodes.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-sm text-zinc-500">
        No people yet. Add someone below to start the tree.
      </div>
    )
  }

  return (
    <div
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
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0,1 L9,5 L0,9" fill="none" stroke="#7dd3fc" strokeWidth="2" />
          </marker>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {shownEdges.map((e) => {
            const a = pos[e.fromPerson]
            const b = pos[e.toPerson]
            if (!a || !b) return null
            const partner = e.edgeKind === 'partner'
            const ended = Boolean(e.endDate) || e.subtype === 'ex'
            // Trim the segment to the circles' edges so the line meets the rims,
            // and leave a little gap on the child end so the arrowhead sits just
            // outside the circle instead of hidden under it.
            const dx = b.x - a.x
            const dy = b.y - a.y
            const len = Math.hypot(dx, dy) || 1
            const ux = dx / len
            const uy = dy / len
            const endGap = partner ? NODE_R : NODE_R + 6
            return (
              <line
                key={e.edgeId}
                x1={a.x + ux * NODE_R}
                y1={a.y + uy * NODE_R}
                x2={b.x - ux * endGap}
                y2={b.y - uy * endGap}
                stroke={partner ? '#fb7185' : '#38bdf8'}
                strokeWidth={1.75}
                strokeDasharray={ended ? '5 4' : undefined}
                markerEnd={partner ? undefined : 'url(#arrow)'}
              />
            )
          })}

          {shownNodes.map((n) => {
            const p = pos[n.nodeId]
            if (!p) return null
            const selected = n.nodeId === selectedId
            const isMe = meNodeId != null && n.nodeId === meNodeId
            const isFocus = mode === 'focus' && n.nodeId === effectiveFocus
            const linked = Boolean(n.accountId)
            const label = labelFor(n, shownNodes)
            const ariaName = n.name || label
            return (
              <g
                key={n.nodeId}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => selectIfTap(n.nodeId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(n.nodeId)
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={isMe ? `${ariaName} (you)` : ariaName}
                aria-pressed={selected}
                className="cursor-pointer"
              >
                {/* Emerald ring marks the signed-in user's own node. */}
                {isMe && (
                  <circle
                    r={NODE_R + 4}
                    fill="none"
                    stroke="#34d399"
                    strokeWidth={2}
                  />
                )}
                {/* Amber ring marks the person the focus view is centered on
                    (skipped when it's already the emerald "me" node). */}
                {isFocus && !isMe && (
                  <circle
                    r={NODE_R + 4}
                    fill="none"
                    stroke="#fbbf24"
                    strokeWidth={2}
                  />
                )}
                <circle
                  r={NODE_R}
                  fill={selected ? '#f4f4f5' : '#27272a'}
                  stroke={selected ? '#f4f4f5' : '#52525b'}
                  strokeWidth={2}
                />
                {/* A small dot flags people already claimed by a member. */}
                {linked && !isMe && (
                  <circle cx={NODE_R - 4} cy={-NODE_R + 4} r={3.5} fill="#34d399" />
                )}
                <text
                  y={34}
                  textAnchor="middle"
                  fontSize={13}
                  fill={selected ? '#f4f4f5' : '#d4d4d8'}
                >
                  {label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
        <div className="flex items-center gap-1">
          <div
            role="group"
            aria-label="Graph view"
            className="flex overflow-hidden rounded-md border border-zinc-700 bg-zinc-900/90 text-xs"
          >
            <ModeButton active={mode === 'tree'} onClick={() => setMode('tree')}>
              Whole tree
            </ModeButton>
            <ModeButton active={mode === 'focus'} onClick={enterFocus}>
              Focus
            </ModeButton>
          </div>
          <button
            type="button"
            aria-label="About the views"
            aria-expanded={showHelp}
            onClick={() => setShowHelp((v) => !v)}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/90 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            ?
          </button>
        </div>
        {showHelp ? (
          <div className="max-w-[15rem] space-y-1 rounded-md border border-zinc-700 bg-zinc-900/95 p-2 text-[11px] leading-snug text-zinc-300">
            <p>
              <span className="font-medium text-zinc-100">Whole tree</span> —
              everyone, laid out by generation.
            </p>
            <p>
              <span className="font-medium text-zinc-100">Focus</span> — zoom in
              on one person and their close family. Tap anyone to re-center on
              them.
            </p>
            <p className="text-zinc-500">
              Drag to pan · pinch or scroll to zoom · ⌾ re-fits.
            </p>
          </div>
        ) : (
          mode === 'focus' && (
            <p className="max-w-[12rem] rounded bg-zinc-900/90 px-1.5 py-0.5 text-[11px] text-zinc-400">
              {focusName
                ? `Around ${focusName} · tap a relative to re-center`
                : 'Pick someone to center on'}
            </p>
          )
        )}
      </div>

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <ControlButton label="Fit to view" onClick={() => setView(fitView())}>
          ⌾
        </ControlButton>
        <ControlButton
          label={isFull ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={() => onFullscreenChange(!isFull)}
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

// One segment of the whole-tree / focus toggle.
function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2.5 py-1 ${
        active
          ? 'bg-zinc-200 text-zinc-900'
          : 'text-zinc-300 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}
