import { euclidean, routeKey } from './edgeCost.js'
import type { Planet, Route } from './types.js'

export interface CostMatrix {
  n: number
  idToIdx: Map<number, number>
  idxToId: number[]
  data: Float64Array  // row-major: data[i * n + j] = direct edge cost from planet i to planet j
}

export function buildCostMatrix(planets: Planet[], routes: Route[]): CostMatrix {
  const n = planets.length
  const idToIdx = new Map<number, number>()
  const idxToId: number[] = new Array(n)

  for (let i = 0; i < n; i++) {
    idToIdx.set(planets[i].id, i)
    idxToId[i] = planets[i].id
  }

  const mainSet = new Set<string>()
  const otherSet = new Set<string>()
  for (const r of routes) {
    const key = routeKey(r.from, r.to)
    if (r.type === 'main') mainSet.add(key)
    else otherSet.add(key)
  }

  const data = new Float64Array(n * n)  // diagonal stays 0
  for (let i = 0; i < n; i++) {
    const pi = planets[i]
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const pj = planets[j]
      const d = euclidean(pi, pj)
      const key = routeKey(pi.id, pj.id)
      if (mainSet.has(key)) data[i * n + j] = 0.5 * d
      else if (otherSet.has(key)) data[i * n + j] = (2 / 3) * d
      else data[i * n + j] = d
    }
  }

  return { n, idToIdx, idxToId, data }
}
