import type { Bonus, Planet, SolveInput, SolveResult } from './types.js'
import type { CostMatrix } from './costMatrix.js'
import type { AllPairsSP } from './allPairsSP.js'
import { buildCostMatrix } from './costMatrix.js'
import { computeAllPairsSP } from './allPairsSP.js'
import { heldKarpGen } from './heldKarp.js'
import { MinHeap } from './heap.js'
import { orienteeringDPCandidates } from './orienteeringDP.js'

const TIMEOUT_MS = 5 * 60 * 1000

/**
 * IMPORTANT:
 *
 * 11 is too high for Challenge 105 because fLen = 11 means 10! possible
 * orderings and can still block before the useful DP-fallback candidates run.
 *
 * 9 is safer:
 *
 *   fLen = 9 means 8! = 40,320 possible orderings
 *
 * Challenges 103 and 104 have fLen = 4, so they remain exact and fast.
 */
const EXACT_ENUMERATION_LIMIT = 9

function popcount(mask: number): number {
  let c = 0

  while (mask) {
    mask &= mask - 1
    c++
  }

  return c
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
): { route: number[]; gross: number; collected: number } | null {
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

  const pq = new MinHeap<number>()
  pq.push(0, startState)

  while (pq.size > 0) {
    const [d, state] = pq.pop()!

    if (d > dist[state]) continue

    const mask = state % maskCount
    const rem = (state / maskCount) | 0
    const planet = rem % n
    const seg = (rem / n) | 0

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

  const terminalPlanet = stops[segCount]

  let bestDist = Infinity
  let bestState = -1

  for (let mask = 0; mask < maskCount; mask++) {
    const s = encode(segCount, terminalPlanet, mask)

    if (dist[s] < bestDist) {
      bestDist = dist[s]
      bestState = s
    }
  }

  if (!Number.isFinite(bestDist)) return null

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
      const isFinalReturnToStart = k === routeDense.length - 1 && v === startDense

      if (!isFinalReturnToStart) {
        return null
      }
    }

    seen.add(v)
  }

  let gross = 0

  for (let k = 0; k < routeDense.length - 1; k++) {
    gross += data[routeDense[k] * n + routeDense[k + 1]]
  }

  let collected = 0
  const collectedBonusNodes = new Set<number>()

  for (const idx of routeDense) {
    if (collectedBonusNodes.has(idx)) continue

    const val = bonusValueByDense.get(idx)

    if (val !== undefined) {
      collected += val
      collectedBonusNodes.add(idx)
    }
  }

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

  interface Best {
    effectiveFuel: number
    route: number[] | null
    gross: number
    collected: number
    timedOut: boolean
  }

  const best: Best = {
    effectiveFuel: Infinity,
    route: null,
    gross: 0,
    collected: 0,
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

  /**
   * Critical Challenge 105 ordering:
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

        const result = realizeOrderingDP(
          ordering,
          forcedIdxs,
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

      if (best.timedOut) break
    } else {
      /**
       * Large subset:
       *
       * Use DP backtracked ordering. No factorial enumeration.
       */
      const adjustedLbEffective =
        candidate.lbEffective -
        guaranteedBonusCredit

      if (adjustedLbEffective >= best.effectiveFuel) {
        continue
      }

      const result = realizeOrderingDP(
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