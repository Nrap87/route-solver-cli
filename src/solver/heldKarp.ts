import { MinHeap } from './heap.js'

interface HkEntry {
  cost: number
  mask: number
  last: number
  nodeIdx: number
}

function buildPath(nodeIdx: number, btNode: number[], btParent: number[]): number[] {
  const path: number[] = []

  let i = nodeIdx
  while (i >= 0) {
    path.unshift(btNode[i])
    i = btParent[i]
  }

  return path
}

/**
 * Generates complete round-trip orderings:
 *
 *   [0, ...permutation of 1..n-1, 0]
 *
 * in non-decreasing metric-closure lower-bound cost.
 *
 * Important:
 * This generator intentionally does NOT do classical Held-Karp DP pruning by
 * (mask,last), because the cheapest metric prefix is not always the best after
 * physical path realization.
 *
 * maxCost:
 * A gross-cost upper bound. Prefixes already >= maxCost are not expanded.
 * This is critical to avoid heap explosion.
 */
export function* heldKarpGen(
  n: number,
  costs: Float64Array,
  maxCost = Infinity,
): Generator<{ ordering: number[]; cost: number }, void, void> {
  if (n === 1) {
    if (0 < maxCost) {
      yield { ordering: [0, 0], cost: 0 }
    }
    return
  }

  if (n > 30) {
    throw new Error(`heldKarpGen requires n <= 30 because it uses bitmasks. Got ${n}`)
  }

  const btNode: number[] = [0]
  const btParent: number[] = [-1]

  const pq = new MinHeap<HkEntry>()
  pq.push(0, {
    cost: 0,
    mask: 1,
    last: 0,
    nodeIdx: 0,
  })

  const fullMask = (1 << n) - 1

  while (pq.size > 0) {
    const [, entry] = pq.pop()!
    const { cost, mask, last, nodeIdx } = entry

    if (cost >= maxCost) continue

    if (mask === fullMask) {
      const path = buildPath(nodeIdx, btNode, btParent)
      path.push(0)

      yield {
        ordering: path,
        cost,
      }

      continue
    }

    for (let v = 1; v < n; v++) {
      const bit = 1 << v
      if (mask & bit) continue

      const edge = costs[last * n + v]
      if (!Number.isFinite(edge)) continue

      const newMask = mask | bit
      const newCost = cost + edge

      if (newMask === fullMask) {
        const returnEdge = costs[v * n + 0]
        if (!Number.isFinite(returnEdge)) continue

        const totalCost = newCost + returnEdge
        if (totalCost >= maxCost) continue

        const newNodeIdx = btNode.length
        btNode.push(v)
        btParent.push(nodeIdx)

        pq.push(totalCost, {
          cost: totalCost,
          mask: newMask,
          last: v,
          nodeIdx: newNodeIdx,
        })
      } else {
        if (newCost >= maxCost) continue

        const newNodeIdx = btNode.length
        btNode.push(v)
        btParent.push(nodeIdx)

        pq.push(newCost, {
          cost: newCost,
          mask: newMask,
          last: v,
          nodeIdx: newNodeIdx,
        })
      }
    }
  }
}