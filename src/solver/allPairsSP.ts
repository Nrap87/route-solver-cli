import { MinHeap } from './heap.js'
import type { CostMatrix } from './costMatrix.js'

export interface AllPairsSP {
  // spCost.get(srcIdx)[dstIdx] = shortest-path cost (Infinity if unreachable)
  spCost: Map<number, Float64Array>
  // spPath.get(srcIdx)[dstIdx] = dense-index path from src to dst, null if unreachable
  spPath: Map<number, (number[] | null)[]>
}

export function computeAllPairsSP(
  matrix: CostMatrix,
  sourceDenseIndices: ReadonlyArray<number>,
  forbiddenDenseIndices: ReadonlySet<number>,
): AllPairsSP {
  const { n, data } = matrix
  const spCost = new Map<number, Float64Array>()
  const spPath = new Map<number, (number[] | null)[]>()

  for (const src of sourceDenseIndices) {
    const dist = new Float64Array(n).fill(Infinity)
    const prev = new Int32Array(n).fill(-1)
    dist[src] = 0

    const pq = new MinHeap<number>()
    pq.push(0, src)

    while (pq.size > 0) {
      const [d, u] = pq.pop()!
      if (d > dist[u]) continue

      const base = u * n
      for (let v = 0; v < n; v++) {
        if (v === u || forbiddenDenseIndices.has(v)) continue
        const nd = d + data[base + v]
        if (nd < dist[v]) {
          dist[v] = nd
          prev[v] = u
          pq.push(nd, v)
        }
      }
    }

    const paths: (number[] | null)[] = new Array(n).fill(null)
    for (let dst = 0; dst < n; dst++) {
      if (dst === src) { paths[dst] = [src]; continue }
      if (dist[dst] === Infinity) continue
      const path: number[] = []
      let cur = dst
      while (cur !== -1) {
        path.unshift(cur)
        cur = prev[cur]
      }
      paths[dst] = path
    }

    spCost.set(src, dist)
    spPath.set(src, paths)
  }

  return { spCost, spPath }
}
