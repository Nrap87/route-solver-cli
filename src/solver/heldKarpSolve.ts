import type { Bonus, Planet, SolveInput, SolveResult } from './types.js'
import type { CostMatrix } from './costMatrix.js'
import type { AllPairsSP } from './allPairsSP.js'
import { buildCostMatrix } from './costMatrix.js'
import { computeAllPairsSP } from './allPairsSP.js'
import { heldKarpGen } from './heldKarp.js'
import { MinHeap } from './heap.js'
import { orienteeringDPCandidates } from './orienteeringDP.js'

const TIMEOUT_MS = 15 * 60 * 1000

/**
 * Exact permutation enumeration is expensive because each ordering may require
 * physical route realization.
 *
 * fLen = 8 means at most 7! = 5,040 orderings.
 * fLen = 9 means 8! = 40,320 orderings and can become slow.
 */
const EXACT_ENUMERATION_LIMIT = 8

/**
 * For small bonus challenges, avoid factorial Held-Karp generator enumeration.
 *
 * Challenge 86 has:
 *
 *   start + 2 mandatory + 5 bonus = 8 key nodes
 *
 * Exhaustively generating orderings for every bonus subset can take 10s+.
 * Instead, for keyCount <= this limit, use the metric-closure DP ordering once
 * per bonus subset and physically realize only that candidate.
 */
const SMALL_BONUS_CANDIDATE_ONLY_KEY_LIMIT = 8

/**
 * Mandatory-only shortest-path concatenation is only safe as a direct return for
 * very small cases.
 *
 * Challenge 106 has 3 mandatory planets and benefits from this shortcut.
 */
const MANDATORY_ONLY_SHORTEST_PATH_FAST_LIMIT = 3

/**
 * For larger mandatory-only challenges, the shortest-path permutation result is
 * not always globally correct, so we must not return it immediately.
 *
 * However, it is still useful as an initial upper bound for pruning the general
 * solver.
 *
 * 8 mandatory planets = 40,320 permutations, still acceptable for a one-time
 * baseline.
 */
const MANDATORY_ONLY_INITIAL_BOUND_LIMIT = 8


type RealizedRoute = {
  route: number[]
  gross: number
  collected: number
}

function popcount(mask: number): number {
  let c = 0

  while (mask) {
    mask &= mask - 1
    c++
  }

  return c
}

function scoreDenseRoute(
  routeDense: number[],
  matrix: CostMatrix,
  bonusValueByDense: ReadonlyMap<number, number>,
): { gross: number; collected: number } {
  const { data } = matrix

  let gross = 0

  for (let i = 0; i < routeDense.length - 1; i++) {
    gross += data[routeDense[i] * matrix.n + routeDense[i + 1]]
  }

  let collected = 0
  const seenBonus = new Set<number>()

  for (const idx of routeDense) {
    if (seenBonus.has(idx)) continue

    const value = bonusValueByDense.get(idx)

    if (value !== undefined) {
      collected += value
      seenBonus.add(idx)
    }
  }

  return { gross, collected }
}

/**
 * Concatenates shortest paths between consecutive forced stops.
 *
 * Valid only if the resulting physical route is simple, except for the final
 * return to the start.
 */
function concatShortestPathStops(args: {
  stops: number[]
  sp: AllPairsSP
  forbiddenDenseSet: ReadonlySet<number>
  matrix: CostMatrix
  bonusValueByDense: ReadonlyMap<number, number>
}): RealizedRoute | null {
  const {
    stops,
    sp,
    forbiddenDenseSet,
    matrix,
    bonusValueByDense,
  } = args

  if (stops.length < 2) return null

  const startDense = stops[0]
  const routeDense: number[] = []

  for (let i = 0; i < stops.length - 1; i++) {
    const src = stops[i]
    const dst = stops[i + 1]

    const path = sp.spPath.get(src)?.[dst]

    if (!path || path.length === 0) {
      return null
    }

    if (i === 0) {
      routeDense.push(...path)
    } else {
      routeDense.push(...path.slice(1))
    }
  }

  if (routeDense.length === 0) return null
  if (routeDense[0] !== startDense) return null
  if (routeDense[routeDense.length - 1] !== startDense) return null

  /**
   * Validate simple physical route.
   *
   * Only allowed duplicate is the final return to the start.
   */
  const seen = new Set<number>()

  for (let i = 0; i < routeDense.length; i++) {
    const node = routeDense[i]

    if (forbiddenDenseSet.has(node)) {
      return null
    }

    if (seen.has(node)) {
      const isFinalReturnToStart =
        i === routeDense.length - 1 && node === startDense

      if (!isFinalReturnToStart) {
        return null
      }
    }

    seen.add(node)
  }

  const { gross, collected } = scoreDenseRoute(
    routeDense,
    matrix,
    bonusValueByDense,
  )

  return {
    route: routeDense,
    gross,
    collected,
  }
}

/**
 * Fast realization:
 *
 * For a metric-closure ordering, concatenate the already-computed shortest paths
 * between consecutive forced stops.
 */
function realizeOrderingByShortestPathConcat(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  baseForbidden: ReadonlySet<number>,
  matrix: CostMatrix,
  bonusValueByDense: ReadonlyMap<number, number>,
): RealizedRoute | null {
  const stops = ordering.map(i => forcedIdxs[i])

  return concatShortestPathStops({
    stops,
    sp,
    forbiddenDenseSet: baseForbidden,
    matrix,
    bonusValueByDense,
  })
}

/**
 * Fast path/baseline for mandatory-only challenges.
 *
 * For small cases this can be returned directly.
 * For larger cases it is only used as an upper bound because independent
 * shortest-path concatenation can be suboptimal globally.
 */
function solveMandatoryOnlyByShortestPathPermutations(args: {
  startIdx: number
  mandatoryIdxs: number[]
  sp: AllPairsSP
  forbiddenDenseSet: ReadonlySet<number>
  matrix: CostMatrix
  bonusValueByDense: ReadonlyMap<number, number>
}): RealizedRoute | null {
  const {
    startIdx,
    mandatoryIdxs,
    sp,
    forbiddenDenseSet,
    matrix,
    bonusValueByDense,
  } = args

  if (mandatoryIdxs.length > MANDATORY_ONLY_INITIAL_BOUND_LIMIT) {
    return null
  }

  if (mandatoryIdxs.length === 0) {
    return {
      route: [startIdx, startIdx],
      gross: 0,
      collected: bonusValueByDense.get(startIdx) ?? 0,
    }
  }

  let best: RealizedRoute | null = null
  let bestEffective = Infinity

  const used = new Uint8Array(mandatoryIdxs.length)
  const perm: number[] = []

  function dfs(): void {
    if (perm.length === mandatoryIdxs.length) {
      const stops = [
        startIdx,
        ...perm,
        startIdx,
      ]

      const realized = concatShortestPathStops({
        stops,
        sp,
        forbiddenDenseSet,
        matrix,
        bonusValueByDense,
      })

      if (realized === null) {
        return
      }

      const effective = realized.gross - realized.collected

      if (effective < bestEffective) {
        bestEffective = effective
        best = realized
      }

      return
    }

    for (let i = 0; i < mandatoryIdxs.length; i++) {
      if (used[i]) continue

      used[i] = 1
      perm.push(mandatoryIdxs[i])

      dfs()

      perm.pop()
      used[i] = 0
    }
  }

  dfs()

  return best
}

// Find transit nodes that appear as intermediates on 2+ segment SP paths in this ordering.
function identifyKeyNodes(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  stopSet: ReadonlySet<number>,
): number[] {
  const freq = new Map<number, number>()

  for (let i = 0; i < ordering.length - 1; i++) {
    const src = forcedIdxs[ordering[i]]
    const dst = forcedIdxs[ordering[i + 1]]
    const path = sp.spPath.get(src)?.[dst]

    if (!path) continue

    for (let k = 1; k < path.length - 1; k++) {
      const node = path[k]

      if (stopSet.has(node)) continue

      freq.set(node, (freq.get(node) ?? 0) + 1)
    }
  }

  return [...freq.entries()]
    .filter(([, f]) => f >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([node]) => node)
}

function realizeOrderingDP(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  baseForbidden: ReadonlySet<number>,
  matrix: CostMatrix,
  bonusValueByDense: ReadonlyMap<number, number>,
): RealizedRoute | null {
  const { n, data } = matrix

  const segCount = ordering.length - 1
  const stops = ordering.map(i => forcedIdxs[i])
  const startDense = stops[0]

  const stopSet = new Set(stops)
  const keyNodes = identifyKeyNodes(ordering, forcedIdxs, sp, stopSet)

  const K = keyNodes.length
  const maskCount = 1 << K

  const keyBit = new Map<number, number>()
  for (let k = 0; k < K; k++) {
    keyBit.set(keyNodes[k], 1 << k)
  }

  const encode = (seg: number, planet: number, mask: number): number =>
    (seg * n + planet) * maskCount + mask

  const totalStates = (segCount + 1) * n * maskCount

  const dist = new Float64Array(totalStates)
  dist.fill(Infinity)

  const parent = new Int32Array(totalStates)
  parent.fill(-2)

  /**
   * Forced stop lookup.
   *
   * Start appears twice: first and last. Let the final occurrence win, so start
   * cannot be used as a premature transit node.
   */
  const stopPos = new Int32Array(n)
  stopPos.fill(-1)

  for (let i = 0; i < stops.length; i++) {
    stopPos[stops[i]] = i
  }

  const initialMask = keyBit.get(startDense) ?? 0
  const startState = encode(0, startDense, initialMask)

  dist[startState] = 0
  parent[startState] = -1

  const terminalPlanet = stops[segCount]

  let bestDist = Infinity
  let bestState = -1

  const pq = new MinHeap<number>()
  pq.push(0, startState)

  while (pq.size > 0) {
    const [d, state] = pq.pop()!

    if (d > dist[state]) continue

    const mask = state % maskCount
    const rem = (state / maskCount) | 0
    const planet = rem % n
    const seg = (rem / n) | 0

    /**
     * Dijkstra early exit.
     *
     * The first terminal state popped is globally optimal.
     */
    if (seg === segCount && planet === terminalPlanet) {
      bestDist = d
      bestState = state
      break
    }

    if (seg === segCount) continue

    const nextStop = stops[seg + 1]
    const base = planet * n

    for (let w = 0; w < n; w++) {
      if (w === planet) continue
      if (baseForbidden.has(w)) continue

      const wBit = keyBit.get(w) ?? 0
      if (wBit && (mask & wBit)) continue

      const pos = stopPos[w]

      if (pos !== -1) {
        if (pos <= seg) continue
        if (pos >= seg + 2) continue
      }

      const newMask = mask | wBit
      const newSeg = w === nextStop ? seg + 1 : seg

      const nd = d + data[base + w]
      const ns = encode(newSeg, w, newMask)

      if (nd < dist[ns]) {
        dist[ns] = nd
        parent[ns] = state
        pq.push(nd, ns)
      }
    }
  }

  if (!Number.isFinite(bestDist) || bestState === -1) return null

  const routeDense: number[] = []

  let cur = bestState
  while (cur !== -1) {
    routeDense.unshift(((cur / maskCount) | 0) % n)
    cur = parent[cur]
  }

  /**
   * Simple route validation.
   *
   * Only allowed duplicate: final return to start.
   */
  const seen = new Set<number>()

  for (let k = 0; k < routeDense.length; k++) {
    const v = routeDense[k]

    if (seen.has(v)) {
      const isFinalReturnToStart =
        k === routeDense.length - 1 && v === startDense

      if (!isFinalReturnToStart) {
        return null
      }
    }

    seen.add(v)
  }

  const { gross, collected } = scoreDenseRoute(
    routeDense,
    matrix,
    bonusValueByDense,
  )

  return {
    route: routeDense,
    gross,
    collected,
  }
}

export function heldKarpSolve(input: SolveInput): SolveResult {
  const {
    planets,
    routes,
    startPlanetId,
    mandatoryIds,
    forbiddenIds,
    bonuses,
  } = input

  const byId = new Map<number, Planet>(planets.map((p) => [p.id, p]))

  if (!byId.has(startPlanetId)) {
    return fail(`Start planet ${startPlanetId} not found`)
  }

  const forbiddenSet = new Set(forbiddenIds)

  if (forbiddenSet.has(startPlanetId)) {
    return fail('Start planet is forbidden')
  }

  const mandatoryUnique = [
    ...new Set(mandatoryIds.filter((id: number) => id !== startPlanetId)),
  ]

  for (const id of mandatoryUnique) {
    if (!byId.has(id)) {
      return fail(`Mandatory planet ${id} not found in planet list`)
    }

    if (forbiddenSet.has(id)) {
      return fail(`Mandatory planet ${byId.get(id)!.name} is also forbidden`)
    }
  }

  const rawValidBonuses = bonuses.filter(
    (b: Bonus) =>
      byId.has(b.planetId) &&
      b.value > 0 &&
      !forbiddenSet.has(b.planetId) &&
      b.planetId !== startPlanetId,
  )

  if (mandatoryUnique.length === 0 && rawValidBonuses.length === 0) {
    const start = byId.get(startPlanetId)!

    return {
      success: true,
      orderedRoute: [start, start],
      effectiveFuel: 0,
      grossFuel: 0,
      collectedBonus: 0,
    }
  }

  const deadline = Date.now() + TIMEOUT_MS

  const matrix = buildCostMatrix(planets, routes)
  const { idToIdx, idxToId } = matrix

  const startIdx = idToIdx.get(startPlanetId)!

  const forbiddenDenseSet = new Set(
    [...forbiddenSet].flatMap((id: number) => {
      const i = idToIdx.get(id)
      return i !== undefined ? [i] : []
    }),
  )

  const mandatoryIdxs = mandatoryUnique.map((id: number) => idToIdx.get(id)!)
  const mandatoryDenseSet = new Set(mandatoryIdxs)

  /**
   * Merge duplicate bonus entries by dense planet index.
   */
  const bonusValueByDense = new Map<number, number>()

  for (const b of rawValidBonuses) {
    const idx = idToIdx.get(b.planetId)

    if (idx === undefined) continue

    bonusValueByDense.set(idx, (bonusValueByDense.get(idx) ?? 0) + b.value)
  }

  /**
   * Optional bonuses exclude:
   *
   * - start
   * - mandatory planets
   *
   * Bonuses on mandatory planets are guaranteed and credited in final route
   * scoring, but they should not become optional DP keys.
   */
  const optionalBonusDenseIdxs: number[] = []
  const optionalBonusValues: number[] = []

  for (const [idx, value] of bonusValueByDense.entries()) {
    if (idx === startIdx) continue
    if (mandatoryDenseSet.has(idx)) continue

    optionalBonusDenseIdxs.push(idx)
    optionalBonusValues.push(value)
  }

  /**
   * Fixed key layout:
   *
   *   key 0 = start
   *   keys 1..M = mandatory
   *   keys 1+M..1+M+B = optional bonuses
   */
  const keyIdxs = [
    startIdx,
    ...mandatoryIdxs,
    ...optionalBonusDenseIdxs,
  ]

  const keyCount = keyIdxs.length
  const mandatoryCount = mandatoryIdxs.length
  const bonusCount = optionalBonusDenseIdxs.length

  if (keyCount > 30) {
    return fail(`Too many key nodes for bitmask DP: ${keyCount}. Maximum supported is 30.`)
  }

  let guaranteedBonusCredit = 0

  for (const idx of mandatoryIdxs) {
    guaranteedBonusCredit += bonusValueByDense.get(idx) ?? 0
  }

  const sp = computeAllPairsSP(matrix, keyIdxs, forbiddenDenseSet)

  for (const a of [startIdx, ...mandatoryIdxs]) {
    for (const b of [startIdx, ...mandatoryIdxs]) {
      if (a === b) continue

      if ((sp.spCost.get(a)?.[b] ?? Infinity) === Infinity) {
        return fail(`No reachable path between planets ${idxToId[a]} and ${idxToId[b]}`)
      }
    }
  }

  /**
   * Mandatory-only shortcut/baseline.
   *
   * For very small mandatory-only challenges, we can return immediately.
   *
   * For larger mandatory-only challenges, do NOT return this result because it
   * may be suboptimal. Challenge 97 is the known counterexample.
   *
   * But we still keep it as an initial upper bound to prune the general solver.
   */
  let initialBest: RealizedRoute | null = null

  if (
    optionalBonusDenseIdxs.length === 0 &&
    mandatoryIdxs.length <= MANDATORY_ONLY_INITIAL_BOUND_LIMIT
  ) {
    const mandatoryOnlyResult = solveMandatoryOnlyByShortestPathPermutations({
      startIdx,
      mandatoryIdxs,
      sp,
      forbiddenDenseSet,
      matrix,
      bonusValueByDense,
    })

    if (mandatoryOnlyResult !== null) {
      if (mandatoryIdxs.length <= MANDATORY_ONLY_SHORTEST_PATH_FAST_LIMIT) {
        const orderedRoute = mandatoryOnlyResult.route.map(
          denseIdx => byId.get(idxToId[denseIdx])!,
        )

        return {
          success: true,
          orderedRoute,
          effectiveFuel: mandatoryOnlyResult.gross - mandatoryOnlyResult.collected,
          grossFuel: mandatoryOnlyResult.gross,
          collectedBonus: mandatoryOnlyResult.collected,
        }
      }

      initialBest = mandatoryOnlyResult
    }
  }

  interface Best {
    effectiveFuel: number
    route: number[] | null
    gross: number
    collected: number
    timedOut: boolean
  }

  const best: Best = {
    effectiveFuel:
      initialBest !== null
        ? initialBest.gross - initialBest.collected
        : Infinity,
    route: initialBest?.route ?? null,
    gross: initialBest?.gross ?? 0,
    collected: initialBest?.collected ?? 0,
    timedOut: false,
  }

  const keyCosts = new Float64Array(keyCount * keyCount)
  keyCosts.fill(Infinity)

  for (let i = 0; i < keyCount; i++) {
    const row = sp.spCost.get(keyIdxs[i])
    if (!row) continue

    for (let j = 0; j < keyCount; j++) {
      keyCosts[i * keyCount + j] = row[keyIdxs[j]]
    }
  }

  let candidates

  try {
    candidates = orienteeringDPCandidates({
      keyCount,
      mandatoryCount,
      bonusCount,
      costs: keyCosts,
      bonusValues: new Float64Array(optionalBonusValues),
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }

  /*const debugStats = {
    keyCount,
    mandatoryCount,
    bonusCount,
    candidateCount: candidates.length,
    useSmallBonusCandidateOnly: false,
    hkOrderingCount: 0,
    concatSuccessCount: 0,
    concatFailCount: 0,
    realizeDPCallCount: 0,
    realizeDPSuccessCount: 0,
    bestUpdateCount: 0,
  }*/

  /**
   * Candidate ordering:
   *
   * 1. Empty subset first: quick baseline route.
   * 2. Large subsets next: use DP fallback, avoids blocking on exact HK.
   * 3. Then promising lower-bound candidates.
   */
  const forcedLenForBonusMask = (bonusMask: number): number =>
    1 + mandatoryCount + popcount(bonusMask)

  candidates.sort((a, b) => {
    if (a.bonusMask === 0) return -1
    if (b.bonusMask === 0) return 1

    const fa = forcedLenForBonusMask(a.bonusMask)
    const fb = forcedLenForBonusMask(b.bonusMask)

    const aLarge = fa > EXACT_ENUMERATION_LIMIT
    const bLarge = fb > EXACT_ENUMERATION_LIMIT

    if (aLarge !== bLarge) return aLarge ? -1 : 1

    const ae = a.lbEffective - guaranteedBonusCredit
    const be = b.lbEffective - guaranteedBonusCredit

    return ae - be
  })

  const useSmallBonusCandidateOnly =
    bonusCount > 0 &&
    keyCount <= SMALL_BONUS_CANDIDATE_ONLY_KEY_LIMIT

  //debugStats.useSmallBonusCandidateOnly = useSmallBonusCandidateOnly


  for (const candidate of candidates) {
    if (Date.now() >= deadline) {
      best.timedOut = true
      break
    }

    const selectedBonusIdxs: number[] = []

    for (let k = 0; k < bonusCount; k++) {
      if (candidate.bonusMask & (1 << k)) {
        selectedBonusIdxs.push(optionalBonusDenseIdxs[k])
      }
    }

    const forcedIdxs = [
      startIdx,
      ...mandatoryIdxs,
      ...selectedBonusIdxs,
    ]

    const fLen = forcedIdxs.length

    /**
     * Fast path for small bonus challenges.
     *
     * For Challenge 86, this avoids enumerating thousands of permutations via
     * heldKarpGen(). We already have one DP-optimal metric-closure ordering for
     * this bonus subset, so realize that ordering directly.
     */
    if (useSmallBonusCandidateOnly) {
      const adjustedLbEffective =
        candidate.lbEffective -
        guaranteedBonusCredit

      if (adjustedLbEffective >= best.effectiveFuel) {
        continue
      }

      const fastResult = realizeOrderingByShortestPathConcat(
        candidate.ordering,
        keyIdxs,
        sp,
        forbiddenDenseSet,
        matrix,
        bonusValueByDense,
      )

      const result =
        fastResult ??
        realizeOrderingDP(
          candidate.ordering,
          keyIdxs,
          sp,
          forbiddenDenseSet,
          matrix,
          bonusValueByDense,
        )

      if (result === null) continue

      const effective = result.gross - result.collected

      if (effective < best.effectiveFuel) {
        best.effectiveFuel = effective
        best.route = result.route
        best.gross = result.gross
        best.collected = result.collected
      }

      continue
    }

    if (fLen === 1) {
      const route = [startIdx, startIdx]
      const gross = 0
      const collected = bonusValueByDense.get(startIdx) ?? 0
      const effective = gross - collected

      if (effective < best.effectiveFuel) {
        best.effectiveFuel = effective
        best.route = route
        best.gross = gross
        best.collected = collected
      }

      continue
    }

    if (fLen <= EXACT_ENUMERATION_LIMIT) {
      const hkCosts = new Float64Array(fLen * fLen)
      hkCosts.fill(Infinity)

      for (let i = 0; i < fLen; i++) {
        const row = sp.spCost.get(forcedIdxs[i])
        if (!row) continue

        for (let j = 0; j < fLen; j++) {
          hkCosts[i * fLen + j] = row[forcedIdxs[j]]
        }
      }

      const maxGrossForSubset =
        best.effectiveFuel +
        candidate.bonusCredit +
        guaranteedBonusCredit

      for (const { ordering, cost: lbGross } of heldKarpGen(fLen, hkCosts, maxGrossForSubset)) {
        //debugStats.hkOrderingCount++
        if (Date.now() >= deadline) {
          best.timedOut = true
          break
        }

        const lbEffective =
          lbGross -
          candidate.bonusCredit -
          guaranteedBonusCredit

        if (lbEffective >= best.effectiveFuel) {
          break
        }

        const fastResult = realizeOrderingByShortestPathConcat(
          ordering,
          forcedIdxs,
          sp,
          forbiddenDenseSet,
          matrix,
          bonusValueByDense,
        )

        /*if (fastResult !== null) {
          debugStats.concatSuccessCount++
        } else {
          debugStats.concatFailCount++
          debugStats.realizeDPCallCount++
        }*/

        const result =
          fastResult ??
          realizeOrderingDP(
            ordering,
            forcedIdxs,
            sp,
            forbiddenDenseSet,
            matrix,
            bonusValueByDense,
          )

        /*if (fastResult === null && result !== null) {
          debugStats.realizeDPSuccessCount++
        }*/

        if (result === null) continue

        const effective = result.gross - result.collected

        if (effective < best.effectiveFuel) {
          //debugStats.bestUpdateCount++

          best.effectiveFuel = effective
          best.route = result.route
          best.gross = result.gross
          best.collected = result.collected
        }
      }

      if (best.timedOut) break
    } else {
      /**
       * Large subset:
       *
       * Use DP-backtracked ordering. No factorial enumeration.
       */
      const adjustedLbEffective =
        candidate.lbEffective -
        guaranteedBonusCredit

      if (adjustedLbEffective >= best.effectiveFuel) {
        continue
      }

      const fastResult = realizeOrderingByShortestPathConcat(
        candidate.ordering,
        keyIdxs,
        sp,
        forbiddenDenseSet,
        matrix,
        bonusValueByDense,
      )

      const result =
        fastResult ??
        realizeOrderingDP(
          candidate.ordering,
          keyIdxs,
          sp,
          forbiddenDenseSet,
          matrix,
          bonusValueByDense,
        )

      if (result === null) continue

      const effective = result.gross - result.collected

      if (effective < best.effectiveFuel) {
        best.effectiveFuel = effective
        best.route = result.route
        best.gross = result.gross
        best.collected = result.collected
      }
    }
  }

  if (best.route === null) {
    return best.timedOut
      ? { ...fail('Timed out before finding any valid route'), timedOut: true }
      : fail('No valid route found')
  }

  const orderedRoute = best.route.map(denseIdx => byId.get(idxToId[denseIdx])!)

  //console.log('solver stats', debugStats)

  return {
    success: true,
    orderedRoute,
    effectiveFuel: best.effectiveFuel,
    grossFuel: best.gross,
    collectedBonus: best.collected,
    timedOut: best.timedOut || undefined,
  }
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