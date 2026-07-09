import { listNodes } from './nodes.js'
import { listEdges } from './edges.js'

// The whole graph for a group in one round trip: every live person and every
// live relationship. Small family graphs, so returning it wholesale keeps the
// client simple (no pagination, one fetch feeds the layout).
export async function getGraph(groupId) {
  const [nodes, edges] = await Promise.all([
    listNodes(groupId),
    listEdges(groupId),
  ])
  return { nodes, edges }
}
