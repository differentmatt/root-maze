import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PersonNode, Edge } from '../api'
import { computeRadialLayout, type RadialInputEdge } from './radial'
import { usePanZoom, type View } from './panzoom'
import { labelFor } from './names'

// A square viewport — a circle fills a portrait phone screen far better than the
// wide layered layout, so the radial view gets its own 1:1 canvas.
const SIZE = 600
const MIN_K = 0.1
const MAX_K = 4
const NODE_R = 14
const JUNCTION_R = 3.5
const FIT_PAD = 40

// The ego-centric radial chart: the focus person at the center, ancestors
// fanning up and descendants fanning down, with couples' shared children
// collapsed onto union junctions. Tap anyone to re-root the chart on them. It
// shares the pan/zoom + fullscreen chrome with GraphCanvas (which hosts it), so
// this component owns only the SVG body and its own control column.
export default function RadialCanvas({
  nodes,
  edges,
  focusId,
  onFocus,
  selectedId,
  onSelect,
  meNodeId,
  isFull,
  onFullscreenChange,
}: {
  nodes: PersonNode[]
  edges: Edge[]
  focusId: string
  onFocus: (nodeId: string) => void
  selectedId: string | null
  onSelect: (nodeId: string) => void
  meNodeId?: string | null
  isFull: boolean
  onFullscreenChange: (next: boolean) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const { view, setView, handlers, moved } = usePanZoom(svgRef, MIN_K, MAX_K)

  const layoutEdges: RadialInputEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        from: e.fromPerson,
        to: e.toPerson,
        kind: e.edgeKind,
        subtype: e.subtype,
        ended: Boolean(e.endDate) || e.subtype === 'ex',
      })),
    [edges],
  )

  const layout = useMemo(
    () =>
      computeRadialLayout(
        nodes.map((n) => n.nodeId),
        layoutEdges,
        focusId,
      ),
    [nodes, layoutEdges, focusId],
  )

  const nodeById = useMemo(() => {
    const m = new Map<string, PersonNode>()
    for (const n of nodes) m.set(n.nodeId, n)
    return m
  }, [nodes])

  // Fit the whole chart, centered, into the square viewport.
  const fitView = useCallback((): View => {
    const cw = layout.width || 1
    const ch = layout.height || 1
    const k = Math.min(
      MAX_K,
      Math.max(
        MIN_K,
        Math.min((SIZE - 2 * FIT_PAD) / cw, (SIZE - 2 * FIT_PAD) / ch),
      ),
    )
    const cx = layout.minX + cw / 2
    const cy = layout.minY + ch / 2
    return { k, x: SIZE / 2 - k * cx, y: SIZE / 2 - k * cy }
  }, [layout.width, layout.height, layout.minX, layout.minY])

  // Re-frame whenever the chart re-roots (focus change) or its shape changes.
  useEffect(() => {
    setView(fitView())
  }, [fitView, setView])

  // Also re-frame on entering/leaving fullscreen, so it opens fully in view.
  useEffect(() => {
    setView(fitView())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFull])

  // A tap (not a drag/pinch) re-roots the chart on the tapped person and
  // selects them — the same navigate-by-relative gesture as the focus view.
  function activate(nodeId: string) {
    if (moved.current) return
    onFocus(nodeId)
    onSelect(nodeId)
  }

  if (nodes.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-sm text-zinc-500">
        No people yet. Add someone below to start the tree.
      </div>
    )
  }

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="xMidYMid meet"
        {...handlers}
        className={`touch-none rounded-lg border border-zinc-800 bg-zinc-900 ${
          isFull ? 'h-full w-full' : 'aspect-square w-full'
        }`}
        role="img"
        aria-label="Radial family chart"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.edges.map((e) => {
            const partner = e.relation === 'partner'
            const nonBio =
              e.relation === 'parent_child' && e.subtype && e.subtype !== 'biological'
            const stroke = partner ? '#fb7185' : nonBio ? '#fbbf24' : '#38bdf8'
            const dashed = e.ended || Boolean(nonBio)
            const d =
              e.cx !== undefined
                ? `M ${e.ax} ${e.ay} Q ${e.cx} ${e.cy} ${e.bx} ${e.by}`
                : undefined
            return d ? (
              <path
                key={e.id}
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={1.75}
                strokeDasharray={dashed ? '5 4' : undefined}
                strokeLinecap="round"
              />
            ) : (
              <line
                key={e.id}
                x1={e.ax}
                y1={e.ay}
                x2={e.bx}
                y2={e.by}
                stroke={stroke}
                strokeWidth={1.75}
                strokeDasharray={dashed ? '5 4' : undefined}
              />
            )
          })}

          {layout.junctions.map((j) => (
            <circle key={j.id} cx={j.x} cy={j.y} r={JUNCTION_R} fill="#52525b" />
          ))}

          {layout.nodes.map((rn) => {
            const n = nodeById.get(rn.id)
            if (!n) return null
            const selected = rn.id === selectedId
            const isMe = meNodeId != null && rn.id === meNodeId
            const isFocus = rn.id === focusId
            const linked = Boolean(n.accountId)
            const halfSib = rn.role === 'sibling' && rn.half
            const label = labelFor(n, nodes)
            const ariaName = n.name || label
            return (
              <g
                key={rn.id}
                transform={`translate(${rn.x} ${rn.y})`}
                onClick={() => activate(rn.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    activate(rn.id)
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
                  <circle r={NODE_R + 4} fill="none" stroke="#34d399" strokeWidth={2} />
                )}
                {/* Amber ring marks the person the chart is rooted on. Sits just
                    outside the emerald ring when they're the same node. */}
                {isFocus && (
                  <circle
                    r={isMe ? NODE_R + 7 : NODE_R + 4}
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
                  // Half-siblings get a dashed outline to distinguish them.
                  strokeDasharray={halfSib ? '3 3' : undefined}
                />
                {/* A small dot flags people already claimed by a member. */}
                {linked && !isMe && (
                  <circle cx={NODE_R - 4} cy={-NODE_R + 4} r={3} fill="#34d399" />
                )}
                <text
                  y={NODE_R + 14}
                  textAnchor="middle"
                  fontSize={12}
                  fill={selected ? '#f4f4f5' : '#d4d4d8'}
                >
                  {label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

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
    </>
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
