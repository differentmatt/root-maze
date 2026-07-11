import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PersonNode, Edge } from '../api'
import {
  computeRadialLayout,
  type Wedge,
  type RadialInputEdge,
} from './radial'
import { usePanZoom, type View } from './panzoom'
import { labelFor, shortName } from './names'

// A square viewport — a circle fills a portrait phone screen far better than the
// wide layered layout, so the radial view gets its own 1:1 canvas.
const SIZE = 600
const MIN_K = 0.1
const MAX_K = 4
const NODE_R = 14
const FIT_PAD = 40

// One soft hue per ancestral branch, echoing the familiar four-color fan chart
// (green / red / blue / gold …); indexed by a wedge's lineage, wrapping for
// deep or unusually branchy trees.
const LINEAGE_COLORS = [
  '#8bb04f', '#cf6b5c', '#5b9bd5', '#e3b34a',
  '#9b7fc7', '#4bb0a0', '#d98c50', '#c77fb0',
]

// SVG path for an annular sector (a fan wedge) between radii r0..r1 over angles
// a0..a1. Angles are math-convention; y is flipped so the fan sweeps the upper
// half. As θ increases the point moves counter-clockwise on screen, so the outer
// arc uses sweep-flag 0 and the inner (returning) arc sweep-flag 1.
function wedgePath(w: Wedge): string {
  const pt = (r: number, a: number) =>
    `${(r * Math.cos(a)).toFixed(2)} ${(-r * Math.sin(a)).toFixed(2)}`
  const large = w.a1 - w.a0 > Math.PI ? 1 : 0
  return (
    `M ${pt(w.r1, w.a0)} A ${w.r1} ${w.r1} 0 ${large} 0 ${pt(w.r1, w.a1)}` +
    ` L ${pt(w.r0, w.a1)} A ${w.r0} ${w.r0} 0 ${large} 1 ${pt(w.r0, w.a0)} Z`
  )
}

// Where and how to draw a wedge's label: centered in the wedge and rotated
// tangent to its ring, which keeps every label upright across the upper fan
// (horizontal at the top, vertical at the sides).
function wedgeLabel(w: Wedge) {
  const mid = (w.a0 + w.a1) / 2
  const rMid = (w.r0 + w.r1) / 2
  return {
    x: rMid * Math.cos(mid),
    y: -rMid * Math.sin(mid),
    rot: 90 - (mid * 180) / Math.PI,
    // Arc length available for the label, so a cramped inner wedge can shrink.
    arc: (w.a1 - w.a0) * rMid,
  }
}

// The ego-centric radial chart: the focus person as a disc at the center, with
// two nested wedge fans — ancestors above, descendants below — each colored by
// branch. A married-in co-parent (who isn't a blood relative and so has no
// wedge) is drawn as a thin rose "spouse band" at the base of that union's
// children, and step/adoptive links are dashed, so remarriage/adoption/multiple
// parents stay legible where a plain fan chart can't show them. The focus's
// siblings and childless partners sit as nodes in the clear horizontal channel
// between the fans. Tap anyone to re-root the chart on them. It shares the
// pan/zoom + fullscreen chrome with GraphCanvas (which hosts it), so this
// component owns only the SVG body and its own control column.
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
          {/* Both fans: ancestors above, descendants below, colored by branch;
              plus thin rose spouse bands naming a married-in co-parent. */}
          {layout.wedges.map((w) => {
            const n = nodeById.get(w.id)
            if (!n) return null
            const spouse = w.kind === 'spouse'
            const nonBio = Boolean(w.subtype && w.subtype !== 'biological')
            const selected = w.id === selectedId
            const isMe = meNodeId != null && w.id === meNodeId
            const color = spouse
              ? '#fb7185'
              : LINEAGE_COLORS[
                  (((w.lineage ?? 0) % LINEAGE_COLORS.length) +
                    LINEAGE_COLORS.length) %
                    LINEAGE_COLORS.length
                ]
            const lbl = wedgeLabel(w)
            const short = shortName(n)
            const maxChars = Math.max(2, Math.floor(lbl.arc / (spouse ? 5 : 6.5)))
            const text =
              short.length > maxChars ? `${short.slice(0, maxChars - 1)}…` : short
            const ariaName = n.name || short
            return (
              <g
                key={w.id}
                onClick={() => activate(w.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    activate(w.id)
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={isMe ? `${ariaName} (you)` : ariaName}
                aria-pressed={selected}
                className="cursor-pointer"
              >
                <path
                  d={wedgePath(w)}
                  fill={color}
                  fillOpacity={
                    spouse ? (w.ended ? 0.18 : 0.34) : selected ? 0.55 : 0.28
                  }
                  // A dashed amber border marks a step/adoptive/foster link; a
                  // dashed rose band marks a marriage that has ended.
                  stroke={isMe ? '#34d399' : nonBio ? '#fbbf24' : color}
                  strokeOpacity={isMe || nonBio ? 0.9 : 0.6}
                  strokeWidth={isMe ? 2 : 1}
                  strokeDasharray={nonBio || (spouse && w.ended) ? '4 3' : undefined}
                />
                <text
                  x={lbl.x}
                  y={lbl.y}
                  transform={`rotate(${lbl.rot} ${lbl.x} ${lbl.y})`}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={spouse ? 8 : 11}
                  fill={spouse ? '#fecdd3' : '#f4f4f5'}
                >
                  {text}
                </text>
              </g>
            )
          })}

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


          {layout.nodes.map((rn) => {
            // The focus is drawn as a labelled center disc below, not here.
            if (rn.role === 'focus') return null
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
                {/* Flankers sit in the horizontal channel, so their labels read
                    outward to the side rather than dipping into a fan below. */}
                <text
                  x={rn.x < 0 ? -(NODE_R + 5) : NODE_R + 5}
                  textAnchor={rn.x < 0 ? 'end' : 'start'}
                  dominantBaseline="middle"
                  fontSize={12}
                  fill={selected ? '#f4f4f5' : '#d4d4d8'}
                >
                  {label}
                </text>
              </g>
            )
          })}

          {/* The focus: a labelled disc at the center of the fan. */}
          {(() => {
            const f = nodeById.get(focusId)
            if (!f) return null
            const isMe = meNodeId != null && focusId === meNodeId
            const short = shortName(f)
            const text = short.length > 9 ? `${short.slice(0, 8)}…` : short
            return (
              <g
                onClick={() => activate(focusId)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    activate(focusId)
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={isMe ? `${f.name} (you)` : f.name}
                className="cursor-pointer"
              >
                {isMe && (
                  <circle r={30} fill="none" stroke="#34d399" strokeWidth={2} />
                )}
                <circle r={27} fill="#f4f4f5" stroke="#fbbf24" strokeWidth={2} />
                <text
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill="#18181b"
                >
                  {text}
                </text>
              </g>
            )
          })()}
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
