import type { Planet, SolveInput, SolveResult } from './types.js'
import type { CostMatrix } from './costMatrix.js'
import { buildCostMatrix } from './costMatrix.js'

const MAX_FAST_MANDATORY_COUNT = 3

interface RealizedRoute {
  route: number[]
  gross: number
  collected: number
}

function fail(msg: string): SolveResult {
  return {
    success: false,
    errorMessage: msg,
    orderedRoute: [],
    effectiveFuel: 0,
    grossFuel: 0,
    collectedBonus: 0,
  }
}

function scoreRoute(
  routeDense: number[],
  matrix: CostMatrix,
): { gross: number; collected: number } {
  const { n, data } = matrix

  let gross = 0

  for (let i = 0; i < routeDense.length - 1; i++) {
    const from = routeDense[i]!
    const to = routeDense[i + 1]!

    gross += data[from * n + to]
  }

  return {
    gross,
    collected: 0,
  }
}

/**
 * Dense-graph Dijkstra with explicit blocked nodes.
 *
 * For n ≈ 194, O(n²) Dijkstra is small and predictable.
 */
function shortestPathAvoiding(
  matrix: CostMatrix,
  src: number,
  dst: number,
  blockedInput: Uint8Array,
): number[] | null {
  const { n, data } = matrix

  const blocked = new Uint8Array(blockedInput)

  // Source and destination are allowed for this segment.
  blocked[src] = 0
  blocked[dst] = 0

  const dist = new Float64Array(n)
  dist.fill(Infinity)

  const prev = new Int32Array(n)
  prev.fill(-1)

  const used = new Uint8Array(n)

  dist[src] = 0

  for (let iter = 0; iter < n; iter++) {
    let u = -1
    let best = Infinity

    for (let i = 0; i < n; i++) {
      if (used[i]) continue
      if (blocked[i]) continue

      const d = dist[i]

      if (d < best) {
        best = d
        u = i
      }
    }

    if (u === -1) break
    if (u === dst) break

    used[u] = 1

    const base = u * n

    for (let v = 0; v < n; v++) {
      if (used[v]) continue
      if (blocked[v]) continue
      if (v === u) continue

      const nd = best + data[base + v]

      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
      }
    }
  }

  if (!Number.isFinite(dist[dst])) {
    return null
  }

  const path: number[] = []
  let cur = dst

  while (cur !== -1) {
    path.unshift(cur)

    if (cur === src) {
      break
    }

    cur = prev[cur]
  }

  if (path.length === 0) return null

  if (path[0] !== src) {
    return null
  }

  return path
}

/**
 * Realizes one mandatory ordering as a simple physical route.
 *
 * Segment-level blockers prevent:
 *
 * - forbidden planets
 * - visiting mandatory planets out of order
 * - returning to start too early
 * - reusing already visited planets
 */
function realizeMandatoryOrderingGreedy(args: {
  matrix: CostMatrix
  startIdx: number
  ordering: number[]
  baseBlocked: Uint8Array
}): RealizedRoute | null {
  const {
    matrix,
    startIdx,
    ordering,
    baseBlocked,
  } = args

  const { n } = matrix

  const stops: number[] = [
    startIdx,
    ...ordering,
    startIdx,
  ]

  const forced = new Uint8Array(n)

  forced[startIdx] = 1

  for (const idx of ordering) {
    forced[idx] = 1
  }

  const seen = new Uint8Array(n)
  const routeDense: number[] = [startIdx]

  seen[startIdx] = 1

  for (let seg = 0; seg < stops.length - 1; seg++) {
    const src = stops[seg]!
    const dst = stops[seg + 1]!
    const isFinalSegment = seg === stops.length - 2

    const blocked = new Uint8Array(baseBlocked)

    /**
     * Block already visited planets.
     *
     * Exceptions:
     * - current source
     * - final destination start on final segment
     */
    for (let i = 0; i < n; i++) {
      if (seen[i]) {
        blocked[i] = 1
      }
    }

    blocked[src] = 0

    if (isFinalSegment && dst === startIdx) {
      blocked[dst] = 0
    }

    /**
     * Block forced stops that are not this segment destination.
     *
     * This prevents:
     * - visiting mandatory planets out of order
     * - returning to start too early
     */
    for (let i = 0; i < n; i++) {
      if (!forced[i]) continue

      if (i === src) continue
      if (i === dst) continue

      blocked[i] = 1
    }

    const segmentPath = shortestPathAvoiding(
      matrix,
      src,
      dst,
      blocked,
    )

    if (segmentPath === null || segmentPath.length < 2) {
      return null
    }

    for (let i = 1; i < segmentPath.length; i++) {
      const node = segmentPath[i]!

      const isFinalReturnToStart =
        isFinalSegment &&
        i === segmentPath.length - 1 &&
        node === startIdx

      if (seen[node] && !isFinalReturnToStart) {
        return null
      }

      routeDense.push(node)

      if (!isFinalReturnToStart) {
        seen[node] = 1
      }
    }
  }

  if (routeDense[0] !== startIdx) {
    return null
  }

  if (routeDense[routeDense.length - 1] !== startIdx) {
    return null
  }

  const { gross, collected } = scoreRoute(routeDense, matrix)

  return {
    route: routeDense,
    gross,
    collected,
  }
}

/**
 * Fast solver for very small mandatory-only challenges.
 *
 * Handles:
 *
 * - no bonuses
 * - up to 3 mandatory planets
 * - optional forbidden planets
 *
 * This covers challenges like 84, 85, 106, 107.
 */
export function trySolveSmallMandatoryOnly(input: SolveInput): SolveResult | null {
  const {
    planets,
    routes,
    startPlanetId,
    mandatoryIds,
    forbiddenIds,
    bonuses,
  } = input

  if (bonuses.length > 0) {
    return null
  }

  const mandatoryUnique: number[] = [
    ...new Set(mandatoryIds.filter((id: number) => id !== startPlanetId)),
  ]

  if (mandatoryUnique.length > MAX_FAST_MANDATORY_COUNT) {
    return null
  }

  const byId = new Map<number, Planet>(
    planets.map((p: Planet) => [p.id, p]),
  )

  if (!byId.has(startPlanetId)) {
    return fail(`Start planet ${startPlanetId} not found`)
  }

  const forbiddenSet = new Set(forbiddenIds)

  if (forbiddenSet.has(startPlanetId)) {
    return fail('Start planet is forbidden')
  }

  for (const id of mandatoryUnique) {
    if (!byId.has(id)) {
      return fail(`Mandatory planet ${id} not found in planet list`)
    }

    if (forbiddenSet.has(id)) {
      return fail(`Mandatory planet ${id} is also forbidden`)
    }
  }

  if (mandatoryUnique.length === 0) {
    const start = byId.get(startPlanetId)!

    return {
      success: true,
      orderedRoute: [start, start],
      effectiveFuel: 0,
      grossFuel: 0,
      collectedBonus: 0,
    }
  }

  const matrix = buildCostMatrix(planets, routes)
  const { idToIdx, idxToId, n } = matrix

  const startIdxMaybe = idToIdx.get(startPlanetId)

  if (startIdxMaybe === undefined) {
    return fail(`Start planet ${startPlanetId} not found in matrix`)
  }

  const startIdx: number = startIdxMaybe

  const mandatoryIdxs: number[] = []

  for (const id of mandatoryUnique) {
    const idxMaybe = idToIdx.get(id)

    if (idxMaybe === undefined) {
      return fail(`Mandatory planet ${id} not found in matrix`)
    }

    mandatoryIdxs.push(idxMaybe)
  }

  const baseBlocked = new Uint8Array(n)

  for (const forbiddenId of forbiddenIds) {
    const idx = idToIdx.get(forbiddenId)

    if (idx !== undefined) {
      baseBlocked[idx] = 1
    }
  }

  const realizedRoutes: RealizedRoute[] = []

  const used = new Uint8Array(mandatoryIdxs.length)
  const perm: number[] = []

  function dfs(): void {
    if (perm.length === mandatoryIdxs.length) {
      const ordering = perm.slice()

      const realized = realizeMandatoryOrderingGreedy({
        matrix,
        startIdx,
        ordering,
        baseBlocked,
      })

      if (realized !== null) {
        realizedRoutes.push(realized)
      }

      return
    }

    for (let i = 0; i < mandatoryIdxs.length; i++) {
      if (used[i]) continue

      used[i] = 1
      perm.push(mandatoryIdxs[i]!)

      dfs()

      perm.pop()
      used[i] = 0
    }
  }

  dfs()

  if (realizedRoutes.length === 0) {
    return null
  }

  let bestResult = realizedRoutes[0]!
  let bestEffective = bestResult.gross - bestResult.collected

  for (let i = 1; i < realizedRoutes.length; i++) {
    const candidate = realizedRoutes[i]!
    const effective = candidate.gross - candidate.collected

    if (effective < bestEffective) {
      bestEffective = effective
      bestResult = candidate
    }
  }

  const orderedRoute: Planet[] = bestResult.route.map((denseIdx: number) => {
    const planetId = idxToId[denseIdx]

    if (planetId === undefined) {
      throw new Error(`Internal error: dense planet ${denseIdx} has no planet id`)
    }

    const planet = byId.get(planetId)

    if (!planet) {
      throw new Error(`Internal error: planet id ${planetId} not found`)
    }

    return planet
  })

  return {
    success: true,
    orderedRoute,
    effectiveFuel: bestResult.gross - bestResult.collected,
    grossFuel: bestResult.gross,
    collectedBonus: bestResult.collected,
  }
}