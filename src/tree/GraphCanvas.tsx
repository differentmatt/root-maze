import { useMemo } from 'react'
import type { PersonNode, Edge } from '../api'
import { computeLayout } from './layout'

const WIDTH = 600
const HEIGHT = 460

// Renders the family graph as an SVG network: parent→child edges are directed
// (blue, arrowhead points at the child); partner edges are undirected (rose,
// dashed once the relationship has ended). Tap a person to select them.
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
  // Recompute only when the graph's shape changes, not on selection.
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
    // layoutKey captures the shape; nodes/edges identity may change without it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  )

  if (nodes.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-sm text-zinc-500">
        No people yet. Add someone below to start the tree.
      </div>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full touch-none rounded-lg border border-zinc-800 bg-zinc-900"
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
            onClick={() => onSelect(n.nodeId)}
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
    </svg>
  )
}
