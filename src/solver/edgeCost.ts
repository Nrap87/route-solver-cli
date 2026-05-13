import type { Planet, Route } from './types.js'

export function euclidean(a: Planet, b: Planet): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
}

// Canonical undirected key: smaller ID first. Routes are bidirectional discounts.
export function routeKey(fromId: number, toId: number): string {
  return `${Math.min(fromId, toId)}-${Math.max(fromId, toId)}`
}

export function buildRouteSets(routes: Route[]): {
  mainSet: Set<string>
  otherSet: Set<string>
} {
  const mainSet = new Set<string>()
  const otherSet = new Set<string>()
  for (const r of routes) {
    const key = routeKey(r.from, r.to)
    if (r.type === 'main') mainSet.add(key)
    else otherSet.add(key)
  }
  return { mainSet, otherSet }
}

export function edgeCost(
  a: Planet,
  b: Planet,
  mainSet: Set<string>,
  otherSet: Set<string>,
): number {
  // Every planet pair has an implicit full-cost edge; routes are directed discounts.
  const d = euclidean(a, b)
  const key = routeKey(a.id, b.id)
  if (mainSet.has(key)) return 0.5 * d
  if (otherSet.has(key)) return (2 / 3) * d
  return d
}
