import type { CostMatrix } from './costMatrix.js'

export interface AllPairsSP {
  // spCost.get(srcIdx)[dstIdx] = shortest-path cost (Infinity if unreachable)
  spCost: Map<number, Float64Array>

  // spPath.get(srcIdx)[dstIdx] = dense-index path from src to dst, null if unreachable
  spPath: Map<number, (number[] | null)[]>
}

/**
 * Computes shortest paths using Floyd-Warshall over the dense cost matrix.
 *
 * Why Floyd-Warshall here?
 *
 * The graph is complete:
 *
 *   n = 194
 *   edges ≈ n² = 37,636
 *
 * Heap-Dijkstra from each key source repeatedly scans all n neighbors and can
 * create many heap entries when discounted chains cause repeated improvements.
 *
 * Floyd-Warshall is:
 *
 *   O(n³) = 194³ ≈ 7.3 million relaxations
 *
 * which is very predictable and fast with flat typed arrays.
 *
 * Forbidden planets are removed as usable nodes:
 *
 *   - they cannot be destinations
 *   - they cannot be sources
 *   - they cannot be intermediates
 */
export function computeAllPairsSP(
  matrix: CostMatrix,
  sourceDenseIndices: ReadonlyArray<number>,
  forbiddenDenseIndices: ReadonlySet<number>,
): AllPairsSP {
  const { n, data } = matrix

  const forbidden = new Uint8Array(n)

  for (const idx of forbiddenDenseIndices) {
    if (idx >= 0 && idx < n) {
      forbidden[idx] = 1
    }
  }

  /**
   * dist[i * n + j] = current shortest distance i -> j
   */
  const dist = new Float64Array(data)

  /**
   * next[i * n + j] = next node after i on shortest path to j.
   *
   * -1 means unreachable / invalid.
   */
  const next = new Int32Array(n * n)
  next.fill(-1)

  /**
   * Initialize forbidden rows/columns and path successors.
   */
  for (let i = 0; i < n; i++) {
    const rowBase = i * n

    if (forbidden[i]) {
      for (let j = 0; j < n; j++) {
        dist[rowBase + j] = Infinity
      }

      continue
    }

    for (let j = 0; j < n; j++) {
      const idx = rowBase + j

      if (forbidden[j]) {
        dist[idx] = Infinity
        continue
      }

      if (i === j) {
        dist[idx] = 0
        next[idx] = j
        continue
      }

      if (Number.isFinite(dist[idx])) {
        next[idx] = j
      }
    }
  }

  /**
   * Floyd-Warshall.
   *
   * Important:
   * We skip forbidden k and i.
   * Forbidden j already has dist[k,j] = Infinity, so no special inner check is needed.
   */
  for (let k = 0; k < n; k++) {
    if (forbidden[k]) continue

    const kBase = k * n

    for (let i = 0; i < n; i++) {
      if (forbidden[i]) continue

      const iBase = i * n
      const dik = dist[iBase + k]

      if (!Number.isFinite(dik)) continue

      const nextIK = next[iBase + k]
      if (nextIK < 0) continue

      for (let j = 0; j < n; j++) {
        const dkj = dist[kBase + j]
        const nd = dik + dkj
        const ij = iBase + j

        if (nd < dist[ij]) {
          dist[ij] = nd
          next[ij] = nextIK
        }
      }
    }
  }

  const spCost = new Map<number, Float64Array>()
  const spPath = new Map<number, (number[] | null)[]>()

  for (const src of sourceDenseIndices) {
    const costs = new Float64Array(n)
    const paths: (number[] | null)[] = new Array(n).fill(null)

    if (src < 0 || src >= n || forbidden[src]) {
      costs.fill(Infinity)
      spCost.set(src, costs)
      spPath.set(src, paths)
      continue
    }

    const srcBase = src * n

    for (let dst = 0; dst < n; dst++) {
      costs[dst] = dist[srcBase + dst]

      if (forbidden[dst]) continue

      if (src === dst) {
        paths[dst] = [src]
        continue
      }

      if (!Number.isFinite(dist[srcBase + dst])) continue
      if (next[srcBase + dst] < 0) continue

      const path: number[] = [src]
      let cur = src

      /**
       * Positive edge weights imply no shortest-path cycle is needed.
       * This guard prevents infinite loops if something unexpected happens.
       */
      let guard = 0

      while (cur !== dst) {
        cur = next[cur * n + dst]

        if (cur < 0) {
          path.length = 0
          break
        }

        path.push(cur)

        guard++

        if (guard > n + 5) {
          path.length = 0
          break
        }
      }

      paths[dst] = path.length > 0 ? path : null
    }

    spCost.set(src, costs)
    spPath.set(src, paths)
  }

  return { spCost, spPath }
}