import type { CostMatrix } from './costMatrix.js'

export interface AllPairsSP {
  // spCost.get(srcIdx)[dstIdx] = shortest-path cost (Infinity if unreachable)
  spCost: Map<number, Float64Array>

  // spPath.get(srcIdx)[dstIdx] = dense-index path from src to dst, null if unreachable
  spPath: Map<number, (number[] | null)[]>
}

/**
 * Computes shortest paths only from the requested key sources.
 *
 * This is faster than Floyd-Warshall for these challenge shapes because the
 * graph has ~194 planets but each challenge usually needs paths from only
 * start + mandatory + bonus key nodes.
 *
 * The graph is dense, so this uses O(k * n^2) Dijkstra with linear min
 * selection instead of a heap. For n ≈ 194 this is fast and avoids heap
 * allocation overhead.
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

  const spCost = new Map<number, Float64Array>()
  const spPath = new Map<number, (number[] | null)[]>()

  /**
   * Avoid recomputing duplicate sources.
   */
  const uniqueSources = [...new Set(sourceDenseIndices)]

  for (const src of uniqueSources) {
    const dist = new Float64Array(n)
    dist.fill(Infinity)

    const prev = new Int32Array(n)
    prev.fill(-1)

    const used = new Uint8Array(n)

    const paths: (number[] | null)[] = new Array(n).fill(null)

    if (src < 0 || src >= n || forbidden[src]) {
      spCost.set(src, dist)
      spPath.set(src, paths)
      continue
    }

    dist[src] = 0

    /**
     * Dense Dijkstra:
     *
     * Repeatedly select the unused non-forbidden node with smallest distance.
     */
    for (let iter = 0; iter < n; iter++) {
      let u = -1
      let best = Infinity

      for (let i = 0; i < n; i++) {
        if (used[i]) continue
        if (forbidden[i]) continue

        const d = dist[i]

        if (d < best) {
          best = d
          u = i
        }
      }

      if (u === -1) break
      if (!Number.isFinite(best)) break

      used[u] = 1

      const base = u * n

      for (let v = 0; v < n; v++) {
        if (used[v]) continue
        if (forbidden[v]) continue
        if (v === u) continue

        const edge = data[base + v]
        if (!Number.isFinite(edge)) continue

        const nd = best + edge

        if (nd < dist[v]) {
          dist[v] = nd
          prev[v] = u
        }
      }
    }

    /**
     * Reconstruct paths from prev[].
     */
    for (let dst = 0; dst < n; dst++) {
      if (forbidden[dst]) continue

      if (dst === src) {
        paths[dst] = [src]
        continue
      }

      if (!Number.isFinite(dist[dst])) continue

      const reversePath: number[] = []
      let cur = dst

      let guard = 0

      while (cur !== -1) {
        reversePath.push(cur)

        if (cur === src) break

        cur = prev[cur]

        guard++

        if (guard > n + 5) {
          reversePath.length = 0
          break
        }
      }

      if (reversePath.length === 0) {
        paths[dst] = null
        continue
      }

      if (reversePath[reversePath.length - 1] !== src) {
        paths[dst] = null
        continue
      }

      reversePath.reverse()
      paths[dst] = reversePath
    }

    spCost.set(src, dist)
    spPath.set(src, paths)
  }

  return {
    spCost,
    spPath,
  }
}