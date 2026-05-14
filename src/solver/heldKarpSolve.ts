import type { SolveInput, SolveResult } from './types.js'
import type { CostMatrix } from './costMatrix.js'
import type { AllPairsSP } from './allPairsSP.js'
import { buildCostMatrix } from './costMatrix.js'
import { computeAllPairsSP } from './allPairsSP.js'
import { heldKarpGen } from './heldKarp.js'

const TIMEOUT_MS = 15 * 60 * 1000

/**
 * Target state count per physical realization Dijkstra call:
 *
 *   (segCount + 1) × n × 2^K
 *
 * K is the number of tracked bottleneck transit nodes.
 */
const MAX_DP_STATES = 120_000

/**
 * Fixed typed-heap capacity per realization call.
 *
 * This avoids per-push object allocation and tuple boxing.
 */
const HEAP_CAP = 1_000_000

/**
 * Maria-style exact ordering threshold.
 *
 * With the optimized typed-array realization engine, fLen <= 11 is usually
 * practical and gives better search coverage than the older fLen <= 8 heuristic.
 */
const MAX_HK_N = 11

type NormalizedBonus = {
  planetId: number
  value: number
}

interface DpWork {
  dist: Float64Array
  parent: Int32Array
  stopOf: Int32Array
  keyBit: Int32Array
  forbArr: Uint8Array
  hPri: Float64Array
  hVal: Int32Array
  hSz: number
}

function normalizeBonuses(
  bonuses: SolveInput['bonuses'],
  byId: ReadonlyMap<number, unknown>,
  forbiddenSet: ReadonlySet<number>,
  startPlanetId: number,
): NormalizedBonus[] {
  const merged = new Map<number, number>()

  for (const b of bonuses) {
    if (!byId.has(b.planetId)) continue
    if (b.value <= 0) continue
    if (forbiddenSet.has(b.planetId)) continue
    if (b.planetId === startPlanetId) continue

    merged.set(b.planetId, (merged.get(b.planetId) ?? 0) + b.value)
  }

  return [...merged.entries()].map(([planetId, value]) => ({
    planetId,
    value,
  }))
}

function identifyKeyNodes(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  forcedSet: ReadonlySet<number>,
  n: number,
  segCount: number,
): number[] {
  const freq = new Map<number, number>()

  for (let i = 0; i < ordering.length - 1; i++) {
    const src = forcedIdxs[ordering[i]]
    const dst = forcedIdxs[ordering[i + 1]]
    const path = sp.spPath.get(src)?.[dst]

    if (!path) continue

    for (let k = 1; k < path.length - 1; k++) {
      const node = path[k]

      if (forcedSet.has(node)) continue

      freq.set(node, (freq.get(node) ?? 0) + 1)
    }
  }

  const maxK = Math.max(
    0,
    Math.floor(Math.log2(MAX_DP_STATES / ((segCount + 1) * n))),
  )

  return [...freq.entries()]
    .filter(([, f]) => f >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxK)
    .map(([node]) => node)
}

function hpush(dpw: DpWork, p: number, v: number): void {
  if (dpw.hSz >= HEAP_CAP) return

  let i = dpw.hSz++

  dpw.hPri[i] = p
  dpw.hVal[i] = v

  while (i > 0) {
    const par = (i - 1) >> 1

    if (dpw.hPri[par] <= dpw.hPri[i]) break

    const tp = dpw.hPri[par]
    dpw.hPri[par] = dpw.hPri[i]
    dpw.hPri[i] = tp

    const tv = dpw.hVal[par]
    dpw.hVal[par] = dpw.hVal[i]
    dpw.hVal[i] = tv

    i = par
  }
}

function hpop(dpw: DpWork): number {
  const rv = dpw.hVal[0]
  const last = --dpw.hSz

  if (last > 0) {
    dpw.hPri[0] = dpw.hPri[last]
    dpw.hVal[0] = dpw.hVal[last]

    let i = 0

    while (true) {
      let sm = i
      const l = 2 * i + 1
      const r = 2 * i + 2

      if (l < dpw.hSz && dpw.hPri[l] < dpw.hPri[sm]) sm = l
      if (r < dpw.hSz && dpw.hPri[r] < dpw.hPri[sm]) sm = r

      if (sm === i) break

      const tp = dpw.hPri[sm]
      dpw.hPri[sm] = dpw.hPri[i]
      dpw.hPri[i] = tp

      const tv = dpw.hVal[sm]
      dpw.hVal[sm] = dpw.hVal[i]
      dpw.hVal[i] = tv

      i = sm
    }
  }

  return rv
}

function realizeOrderingDP(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  matrix: CostMatrix,
  bonusValueArr: Float64Array,
  dpw: DpWork,
  grossCutoff: number,
): { route: number[]; gross: number; collected: number } | null {
  const { n, data } = matrix
  const segCount = ordering.length - 1
  const stops = ordering.map(i => forcedIdxs[i])
  const startDense = stops[0]

  const forcedSet = new Set(forcedIdxs)
  const keyNodes = identifyKeyNodes(
    ordering,
    forcedIdxs,
    sp,
    forcedSet,
    n,
    segCount,
  )

  const K = keyNodes.length
  const maskCount = 1 << K

  const keyBit = dpw.keyBit

  for (let k = 0; k < K; k++) {
    keyBit[keyNodes[k]] = 1 << k
  }

  const stopOf = dpw.stopOf

  /**
   * stopOf[v] = i means v is stops[i].
   *
   * Start appears at stops[0] and stops[segCount]. We store it as segCount so
   * it behaves like a future forced stop until the final return segment.
   */
  for (let i = 1; i < segCount; i++) {
    stopOf[stops[i]] = i
  }

  stopOf[startDense] = segCount

  /**
   * Lower-bound rows and suffix costs for internal B&B pruning.
   *
   * hRemain = shortest path from current planet to next forced stop
   *           + lower bound through remaining forced stops.
   */
  const spRows: (Float64Array | undefined)[] = new Array(segCount)
  const suffix = new Float64Array(segCount + 1)

  for (let s = 0; s < segCount; s++) {
    spRows[s] = sp.spCost.get(stops[s + 1])
  }

  for (let s = segCount - 1; s >= 1; s--) {
    suffix[s] =
      (sp.spCost.get(stops[s])?.[stops[s + 1]] ?? 0) +
      suffix[s + 1]
  }

  const encode = (seg: number, planet: number, mask: number): number =>
    (seg * n + planet) * maskCount + mask

  const totalStates = (segCount + 1) * n * maskCount

  if (totalStates > dpw.dist.length) {
    for (let i = 1; i < segCount; i++) stopOf[stops[i]] = -1
    stopOf[startDense] = -1
    for (let k = 0; k < K; k++) keyBit[keyNodes[k]] = 0
    return null
  }

  const dist = dpw.dist
  const parent = dpw.parent

  dist.fill(Infinity, 0, totalStates)
  parent.fill(-2, 0, totalStates)

  dpw.hSz = 0

  const startState = encode(0, startDense, 0)

  dist[startState] = 0
  parent[startState] = -1

  hpush(dpw, 0, startState)

  let bestState = -1

  while (dpw.hSz > 0) {
    const d = dpw.hPri[0]
    const state = hpop(dpw)

    if (d > dist[state]) continue

    const mask = state % maskCount
    const rem = (state / maskCount) | 0
    const planet = rem % n
    const seg = (rem / n) | 0

    if (seg === segCount) {
      bestState = state
      break
    }

    /**
     * Internal B&B pruning.
     *
     * If current gross plus optimistic remaining gross cannot beat the current
     * gross cutoff, skip expanding this state.
     */
    const hRemain =
      (spRows[seg]?.[planet] ?? Infinity) +
      suffix[seg + 1]

    if (d + hRemain >= grossCutoff) continue

    const nextStop = stops[seg + 1]
    const base = planet * n

    for (let w = 0; w < n; w++) {
      if (w === planet) continue
      if (dpw.forbArr[w]) continue

      const wBit = keyBit[w]

      if (wBit && (mask & wBit)) continue

      const ws = stopOf[w]

      if (ws !== -1) {
        if (ws <= seg) continue
        if (ws > seg + 1) continue
      }

      const newMask = mask | wBit
      const newSeg = w === nextStop ? seg + 1 : seg

      const nd = d + data[base + w]
      const ns = encode(newSeg, w, newMask)

      if (nd < dist[ns]) {
        dist[ns] = nd
        parent[ns] = state
        hpush(dpw, nd, ns)
      }
    }
  }

  for (let i = 1; i < segCount; i++) {
    stopOf[stops[i]] = -1
  }

  stopOf[startDense] = -1

  for (let k = 0; k < K; k++) {
    keyBit[keyNodes[k]] = 0
  }

  if (bestState === -1) return null

  const routeDense: number[] = []

  let cur = bestState

  while (cur !== -1) {
    routeDense.unshift(((cur / maskCount) | 0) % n)
    cur = parent[cur]
  }

  /**
   * Verify simple physical route.
   *
   * Only allowed duplicate is the final return to start.
   */
  const seen = new Set<number>()

  for (let k = 0; k < routeDense.length; k++) {
    const v = routeDense[k]
    const isEnd = k === 0 || k === routeDense.length - 1

    if (seen.has(v) && !(isEnd && v === startDense)) {
      return null
    }

    seen.add(v)
  }

  let gross = 0

  for (let k = 0; k < routeDense.length - 1; k++) {
    gross += data[routeDense[k] * n + routeDense[k + 1]]
  }

  /**
   * Duplicate bonus entries have already been merged into bonusValueArr.
   *
   * Since the physical route is simple except for the final return to start,
   * this direct sum is safe. Start bonuses are filtered out.
   */
  let collected = 0

  for (const idx of routeDense) {
    collected += bonusValueArr[idx]
  }

  return {
    route: routeDense,
    gross,
    collected,
  }
}

function orienteeringDPCandidates(
  allKeyDense: number[],
  mandatoryCount: number,
  sp: AllPairsSP,
  bonusValueArr: Float64Array,
): { bonusMask: number; lbCost: number; dpKeySeq: number[] }[] {
  const nk = allKeyDense.length

  if (nk > 30) {
    throw new Error(`Too many key nodes for bitmask DP: ${nk}. Maximum supported is 30.`)
  }

  const stateCount = (1 << nk) * nk
  const dp = new Float64Array(stateCount).fill(Infinity)
  const par = new Int32Array(stateCount).fill(-1)

  const mandatoryBits = (2 << mandatoryCount) - 2
  const bonusBitOffset = 1 + mandatoryCount

  /**
   * mask = 1 means start visited.
   * v = 0 means currently at start.
   */
  dp[nk] = 0

  for (let mask = 1; mask < (1 << nk); mask++) {
    if (!(mask & 1)) continue

    for (let v = 0; v < nk; v++) {
      if (!(mask & (1 << v))) continue

      const cur = dp[mask * nk + v]

      if (!Number.isFinite(cur)) continue

      for (let u = 1; u < nk; u++) {
        if (mask & (1 << u)) continue

        const cost = sp.spCost.get(allKeyDense[v])?.[allKeyDense[u]]

        if (cost === undefined || !Number.isFinite(cost)) continue

        /**
         * bonusValueArr includes mandatory bonus values too.
         *
         * Therefore lbCost is already effective-fuel-like:
         *
         *   metric gross - selected/mandatory bonus credits
         */
        const bonus = bonusValueArr[allKeyDense[u]]
        const nd = cur + cost - bonus
        const ns = (mask | (1 << u)) * nk + u

        if (nd < dp[ns]) {
          dp[ns] = nd
          par[ns] = mask * nk + v
        }
      }
    }
  }

  const bonusMaskBest = new Map<number, { lbCost: number; state: number }>()

  for (let mask = 1; mask < (1 << nk); mask++) {
    if ((mask & mandatoryBits) !== mandatoryBits) continue

    for (let v = 0; v < nk; v++) {
      if (!(mask & (1 << v))) continue

      const cur = dp[mask * nk + v]

      if (!Number.isFinite(cur)) continue

      const ret =
        v === 0
          ? 0
          : sp.spCost.get(allKeyDense[v])?.[allKeyDense[0]] ?? Infinity

      if (!Number.isFinite(ret)) continue

      const total = cur + ret
      const bonusMask = mask >> bonusBitOffset
      const existing = bonusMaskBest.get(bonusMask)

      if (!existing || total < existing.lbCost) {
        bonusMaskBest.set(bonusMask, {
          lbCost: total,
          state: mask * nk + v,
        })
      }
    }
  }

  const results: { bonusMask: number; lbCost: number; dpKeySeq: number[] }[] = []

  for (const [bonusMask, { lbCost, state }] of bonusMaskBest) {
    const seq: number[] = []
    let cur = state

    while (cur !== -1) {
      seq.unshift(cur % nk)
      cur = par[cur]
    }

    seq.push(0)

    results.push({
      bonusMask,
      lbCost,
      dpKeySeq: seq,
    })
  }

  results.sort((a, b) => {
    if (a.bonusMask === 0 && b.bonusMask !== 0) return -1
    if (b.bonusMask === 0 && a.bonusMask !== 0) return 1

    return a.lbCost - b.lbCost
  })

  return results
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

  const byId = new Map(planets.map(p => [p.id, p]))

  if (!byId.has(startPlanetId)) {
    return fail(`Start planet ${startPlanetId} not found`)
  }

  const forbiddenSet = new Set(forbiddenIds)

  if (forbiddenSet.has(startPlanetId)) {
    return fail('Start planet is forbidden')
  }

  const mandatoryUnique = [
    ...new Set(mandatoryIds.filter(id => id !== startPlanetId)),
  ]

  for (const id of mandatoryUnique) {
    if (!byId.has(id)) {
      return fail(`Mandatory planet ${id} not found in planet list`)
    }

    if (forbiddenSet.has(id)) {
      return fail(`Mandatory planet ${byId.get(id)!.name} is also forbidden`)
    }
  }

  const validBonuses = normalizeBonuses(
    bonuses,
    byId,
    forbiddenSet,
    startPlanetId,
  )

  if (mandatoryUnique.length === 0 && validBonuses.length === 0) {
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

  const startIdx = idToIdx.get(startPlanetId)!

  const forbiddenDenseSet = new Set(
    [...forbiddenSet].flatMap(id => {
      const i = idToIdx.get(id)
      return i !== undefined ? [i] : []
    }),
  )

  const mandatoryIdxs = mandatoryUnique.map(id => idToIdx.get(id)!)
  const mandatoryDenseSet = new Set(mandatoryIdxs)

  /**
   * Dense bonus maps.
   *
   * bonusValueByDense is useful for debugging/readability.
   * bonusValueArr is used in hot paths to avoid Map.get().
   */
  const bonusValueByDense = new Map<number, number>()

  for (const b of validBonuses) {
    const idx = idToIdx.get(b.planetId)

    if (idx === undefined) continue

    bonusValueByDense.set(idx, (bonusValueByDense.get(idx) ?? 0) + b.value)
  }

  const bonusValueArr = new Float64Array(n)

  for (const [idx, value] of bonusValueByDense) {
    bonusValueArr[idx] = value
  }

  /**
   * Optional bonuses exclude mandatory planets.
   *
   * Bonuses on mandatory planets are guaranteed and credited in route scoring,
   * but they should not become optional bitmask decision keys.
   */
  const optionalBonusDenseIdxs: number[] = []
  const optionalBonusValues: number[] = []

  for (const [idx, value] of bonusValueByDense) {
    if (idx === startIdx) continue
    if (mandatoryDenseSet.has(idx)) continue

    optionalBonusDenseIdxs.push(idx)
    optionalBonusValues.push(value)
  }

  let guaranteedBonusCredit = 0

  for (const idx of mandatoryIdxs) {
    guaranteedBonusCredit += bonusValueArr[idx]
  }

  /**
   * Key layout:
   *
   *   0 = start
   *   1..M = mandatory stops
   *   M+1.. = optional bonus stops
   */
  const allKeyDense = [
    startIdx,
    ...mandatoryIdxs,
    ...optionalBonusDenseIdxs,
  ]

  const sp = computeAllPairsSP(matrix, allKeyDense, forbiddenDenseSet)

  for (const a of [startIdx, ...mandatoryIdxs]) {
    for (const b of [startIdx, ...mandatoryIdxs]) {
      if (a === b) continue

      if ((sp.spCost.get(a)?.[b] ?? Infinity) === Infinity) {
        return fail(`No reachable path between planets ${idxToId[a]} and ${idxToId[b]}`)
      }
    }
  }

  const dpw: DpWork = {
    dist: new Float64Array(MAX_DP_STATES),
    parent: new Int32Array(MAX_DP_STATES),
    stopOf: new Int32Array(n).fill(-1),
    keyBit: new Int32Array(n),
    forbArr: new Uint8Array(n),
    hPri: new Float64Array(HEAP_CAP),
    hVal: new Int32Array(HEAP_CAP),
    hSz: 0,
  }

  for (const idx of forbiddenDenseSet) {
    dpw.forbArr[idx] = 1
  }

  const deadline = Date.now() + TIMEOUT_MS

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

  const bonusCandidates = orienteeringDPCandidates(
    allKeyDense,
    mandatoryIdxs.length,
    sp,
    bonusValueArr,
  )

  for (const { bonusMask, lbCost, dpKeySeq } of bonusCandidates) {
    if (Date.now() >= deadline) {
      best.timedOut = true
      break
    }

    /**
     * lbCost already includes:
     *
     * - mandatory bonus credit,
     * - selected optional bonus credit.
     */
    if (lbCost >= best.effectiveFuel) break

    const selectedBonusIdxs: number[] = []
    let selectedOptionalBonusCredit = 0

    for (let k = 0; k < optionalBonusDenseIdxs.length; k++) {
      if (bonusMask & (1 << k)) {
        const idx = optionalBonusDenseIdxs[k]
        selectedBonusIdxs.push(idx)
        selectedOptionalBonusCredit += optionalBonusValues[k]
      }
    }

    const totalSelectedCredit =
      guaranteedBonusCredit +
      selectedOptionalBonusCredit

    const forcedIdxs = [
      startIdx,
      ...mandatoryIdxs,
      ...selectedBonusIdxs,
    ]

    const fLen = forcedIdxs.length

    const grossCutoff =
      Number.isFinite(best.effectiveFuel)
        ? best.effectiveFuel + totalSelectedCredit
        : Infinity

    if (fLen <= MAX_HK_N) {
      const hkCosts = new Float64Array(fLen * fLen)

      for (let i = 0; i < fLen; i++) {
        const row = sp.spCost.get(forcedIdxs[i])

        if (!row) continue

        for (let j = 0; j < fLen; j++) {
          hkCosts[i * fLen + j] = row[forcedIdxs[j]]
        }
      }

      /**
       * Warm start:
       *
       * Realize the orienteering-DP ordering first to establish a strong upper
       * bound before enumerating many orderings.
       */
      {
        const M = mandatoryIdxs.length
        const kiToPos: number[] = new Array(allKeyDense.length)

        for (let i = 0; i <= M; i++) {
          kiToPos[i] = i
        }

        let bRank = 0

        for (let b = 0; b < optionalBonusDenseIdxs.length; b++) {
          if (bonusMask & (1 << b)) {
            kiToPos[M + 1 + b] = M + 1 + bRank++
          }
        }

        const dpOrdering = dpKeySeq.map(ki => kiToPos[ki])

        const dpWarm = realizeOrderingDP(
          dpOrdering,
          forcedIdxs,
          sp,
          matrix,
          bonusValueArr,
          dpw,
          grossCutoff,
        )

        if (dpWarm !== null) {
          const dpEff = dpWarm.gross - dpWarm.collected

          if (dpEff < best.effectiveFuel) {
            best.effectiveFuel = dpEff
            best.route = dpWarm.route
            best.gross = dpWarm.gross
            best.collected = dpWarm.collected
          }
        }
      }

      const updatedGrossCutoff = (): number =>
        Number.isFinite(best.effectiveFuel)
          ? best.effectiveFuel + totalSelectedCredit
          : Infinity

      for (const { ordering, cost: lbOrd } of heldKarpGen(
        fLen,
        hkCosts,
        updatedGrossCutoff(),
      )) {
        if (Date.now() >= deadline) {
          best.timedOut = true
          break
        }

        if (lbOrd - totalSelectedCredit >= best.effectiveFuel) {
          break
        }

        const result = realizeOrderingDP(
          ordering,
          forcedIdxs,
          sp,
          matrix,
          bonusValueArr,
          dpw,
          updatedGrossCutoff(),
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
    } else {
      /**
       * Large subset fallback:
       *
       * Use the DP-backtracked metric ordering for this bonus mask.
       */
      const forcedSeq = dpKeySeq.slice(0, -1)
      const forcedDpIdxs = forcedSeq.map(ki => allKeyDense[ki])
      const ordering = forcedSeq.map((_, i) => i).concat([0])

      const result = realizeOrderingDP(
        ordering,
        forcedDpIdxs,
        sp,
        matrix,
        bonusValueArr,
        dpw,
        grossCutoff,
      )

      if (result !== null) {
        const effective = result.gross - result.collected

        if (effective < best.effectiveFuel) {
          best.effectiveFuel = effective
          best.route = result.route
          best.gross = result.gross
          best.collected = result.collected
        }
      }
    }

    if (best.timedOut) break
  }

  if (best.route === null) {
    return best.timedOut
      ? { ...fail('Timed out before finding any valid route'), timedOut: true }
      : fail('No valid route found')
  }

  const orderedRoute = best.route.map(
    denseIdx => byId.get(idxToId[denseIdx])!,
  )

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