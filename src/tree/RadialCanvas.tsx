import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PersonNode, Edge } from '../api'
import {
  computeRadialLayout,
  type Wedge,
  type RadialInputEdge,
} from './radial'
import { usePanZoom, type View } from './panzoom'
import { shortName } from './names'

// A square viewport — a circle fills a portrait phone screen far better than the
// wide layered layout, so the radial view gets its own 1:1 canvas.
const SIZE = 600
const MIN_K = 0.1
const MAX_K = 4
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

const LABEL_BASE = 11 // preferred font size
const LABEL_MIN = 6.5 // smallest we shrink to before truncating
const CHAR_W = 0.56 // approx glyph width as a fraction of font size
const LABEL_PAD = 5

// Place and size a wedge's label so it always reads upright and fits.
//   - A fat wedge (or a thin spouse band) gets *curved* text following the ring,
//     via a mid-radius arc path — so a label never reads as a straight chord
//     across a curved band. The arc is drawn left-to-right and flipped on the
//     lower half so text is never upside down.
//   - A thin sliver (arc narrower than the wedge is deep) gets straight *radial*
//     text reading outward, flipped on the left half so it's never upside down —
//     which fits a name a cramped arc never could.
// The font shrinks to fit the available length (down to LABEL_MIN) before the
// name is truncated with an ellipsis, and is capped by the wedge's thickness so
// text never spills across the band.
type LabelLayout =
  | { curved: false; x: number; y: number; rot: number; fontSize: number; text: string }
  | { curved: true; path: string; fontSize: number; text: string }

// Fraction of a wedge's thickness the text may occupy — the rest is margin so a
// label never touches the band's edges (or a neighboring slice's divider).
const LABEL_FILL = 0.62

function labelLayout(w: Wedge, name: string): LabelLayout {
  const mid = (w.a0 + w.a1) / 2
  const band = w.r1 - w.r0
  const arcMid = (w.a1 - w.a0) * ((w.r0 + w.r1) / 2)
  const radial = arcMid < band

  // Radial (sliver / channel-slice) labels sit a little outward, where the arc
  // is wider, giving the text more room across its baseline before it touches
  // the slice's radial edges.
  const rc = radial ? w.r0 + band * 0.6 : (w.r0 + w.r1) / 2
  const length = radial ? band : (w.a1 - w.a0) * rc // along the baseline
  const thickness = radial ? (w.a1 - w.a0) * rc : band // across it

  let fontSize = Math.min(LABEL_BASE, thickness * LABEL_FILL)
  const avail = Math.max(0, length - LABEL_PAD)
  if (name.length * fontSize * CHAR_W > avail) {
    fontSize = Math.max(LABEL_MIN, avail / (name.length * CHAR_W))
  }
  const fitChars = Math.max(1, Math.floor(avail / (fontSize * CHAR_W)))
  const text = name.length > fitChars ? `${name.slice(0, fitChars - 1)}…` : name

  if (radial) {
    let rot = -(mid * 180) / Math.PI
    if (Math.cos(mid) < 0) rot += 180 // keep upright on the left half
    return { curved: false, x: rc * Math.cos(mid), y: -rc * Math.sin(mid), rot, fontSize, text }
  }

  // Curved: an arc spanning the wedge. On the upper half draw it right-to-left
  // (sweep 1) so the text runs left-to-right upright; on the lower half draw
  // left-to-right (sweep 0) so it isn't upside down.
  //
  // The text hangs off its *alphabetic* baseline, and WebKit/iOS Safari ignore
  // dominant-baseline on a textPath — so rather than rely on it, we offset the
  // path radius by ~⅓ of the font toward the text's descent side. That lands the
  // glyph body centered across the band on every browser. (Glyphs ascend outward
  // on the upper half, inward on the lower half.)
  const rMid = (w.r0 + w.r1) / 2
  const rPath = rMid + (upperHalf(mid) ? -1 : 1) * fontSize * 0.34
  const pt = (a: number) =>
    `${(rPath * Math.cos(a)).toFixed(2)} ${(-rPath * Math.sin(a)).toFixed(2)}`
  const path = upperHalf(mid)
    ? `M ${pt(w.a1)} A ${rPath} ${rPath} 0 0 1 ${pt(w.a0)}`
    : `M ${pt(w.a0)} A ${rPath} ${rPath} 0 0 0 ${pt(w.a1)}`
  return { curved: true, path, fontSize, text }
}

function upperHalf(mid: number): boolean {
  return Math.sin(mid) > 0
}

// A DOM-id-safe suffix for a wedge's label path.
function labelPathId(id: string): string {
  return `lp-${id.replace(/[^\w-]/g, '')}`
}

// The ego-centric radial chart: the focus person as a disc at the center, with
// two nested wedge fans — ancestors above, descendants below — each colored by
// branch. A married-in co-parent (who isn't a blood relative and so has no
// wedge) is drawn as a thin rose "spouse band" at the base of that union's
// children. Adoptive/step/foster parentage is drawn exactly like biological (no
// othering); only remarriage (ended = dashed) and half-siblings stay marked. The
// focus's
// siblings and childless partners — who belong to neither fan — fill the clear
// horizontal channel between them as ring-1 slices. Everyone but the focus is a
// wedge. Tap anyone to re-root the chart on them. It shares the pan/zoom +
// fullscreen chrome with GraphCanvas (which hosts it), so this component owns
// only the SVG body and its own control column.
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
          {/* Everyone but the focus is a wedge: the two branch-colored fans
              (ancestors above, descendants below), neutral sibling slices in the
              horizontal channels, and rose spouse bands / childless-partner
              slices for married-in people a fan can't nest. */}
          {layout.wedges.map((w) => {
            const n = nodeById.get(w.id)
            if (!n) return null
            const spouse = w.kind === 'spouse'
            const sibling = w.kind === 'sibling'
            const halfSib = sibling && Boolean(w.half)
            const selected = w.id === selectedId
            const isMe = meNodeId != null && w.id === meNodeId
            const color = spouse
              ? '#fb7185'
              : sibling
                ? '#a1a1aa'
                : LINEAGE_COLORS[
                    (((w.lineage ?? 0) % LINEAGE_COLORS.length) +
                      LINEAGE_COLORS.length) %
                      LINEAGE_COLORS.length
                  ]
            // A thin band (spouse-at-base) is drawn fainter than a full slice.
            const thin = spouse && w.r1 - w.r0 < 20
            const short = shortName(n)
            const lbl = labelLayout(w, short)
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
                    thin ? (w.ended ? 0.18 : 0.34) : selected ? 0.55 : 0.28
                  }
                  // Adoptive/step/foster parentage looks exactly like biological
                  // — no othering. Dashed rose = ended marriage; dashed neutral =
                  // half-sibling.
                  stroke={isMe ? '#34d399' : color}
                  strokeOpacity={isMe ? 0.9 : 0.6}
                  strokeWidth={isMe ? 2 : 1}
                  strokeDasharray={
                    (spouse && w.ended) || halfSib ? '4 3' : undefined
                  }
                />
                {lbl.curved ? (
                  <>
                    <path id={labelPathId(w.id)} d={lbl.path} fill="none" />
                    {/* No dominant-baseline: the path radius is offset so the
                        alphabetic baseline centers the text across the band on
                        every browser (WebKit ignores dominant-baseline here). */}
                    <text fontSize={lbl.fontSize} fill={spouse ? '#fecdd3' : '#f4f4f5'}>
                      <textPath
                        href={`#${labelPathId(w.id)}`}
                        startOffset="50%"
                        textAnchor="middle"
                      >
                        {lbl.text}
                      </textPath>
                    </text>
                  </>
                ) : (
                  <text
                    x={lbl.x}
                    y={lbl.y}
                    transform={`rotate(${lbl.rot} ${lbl.x} ${lbl.y})`}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={lbl.fontSize}
                    fill={spouse ? '#fecdd3' : '#f4f4f5'}
                  >
                    {lbl.text}
                  </text>
                )}
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
