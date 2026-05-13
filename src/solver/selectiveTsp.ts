export interface SelectiveTspCandidate {
    /**
     * Ordering uses key-node indices.
     *
     * Example:
     *   [0, 4, 2, 9, 1, 0]
     *
     * key index 0 is always the start.
     */
    ordering: number[]
  
    /**
     * Lower-bound effective cost in the metric closure:
     *
     *   shortest-path gross cost - explicitly collected key-node bonuses
     *
     * This is not necessarily the final physical route cost because the final
     * route is later realized through realizeOrderingDP().
     */
    lbEffective: number
  
    /**
     * Bitmask of visited key nodes.
     */
    mask: number
  }
  
  interface Label {
    /**
     * Encoded state:
     *
     *   state = mask * keyCount + last
     */
    state: number
  
    /**
     * Effective cost so far:
     *
     *   gross shortest-path cost - collected bonuses
     */
    cost: number
  
    /**
     * Previous label id for path reconstruction.
     */
    prevLabelId: number
  }
  
  interface FinalLabel {
    labelId: number
    finalCost: number
    mask: number
  }
  
  export interface SelectiveTspOptions {
    /**
     * Number of key nodes.
     *
     * key 0 = start.
     * Other keys = mandatory + bonus nodes.
     */
    keyCount: number
  
    /**
     * Flat keyCount × keyCount matrix.
     *
     * costs[i * keyCount + j] = shortest-path cost from key i to key j.
     */
    costs: Float64Array
  
    /**
     * bonusValueByKey[i] = bonus gained when key i is explicitly visited.
     *
     * Usually:
     *   bonusValueByKey[0] = 0
     *   mandatory-only nodes = 0
     *   bonus nodes = positive value
     */
    bonusValueByKey: Float64Array
  
    /**
     * Mask of key nodes that must be included in a valid solution.
     *
     * Should include start bit:
     *   mandatoryMask |= 1
     */
    mandatoryMask: number
  
    /**
     * Keep the best N labels per DP state.
     *
     * Top-1 is fastest but can fail if the best metric-closure ordering cannot
     * be physically realized as a simple path. Keeping multiple labels gives
     * alternative orderings.
     */
    maxLabelsPerState?: number
  
    /**
     * Number of final candidate orderings to return.
     */
    maxCandidates?: number
  }
  
  /**
   * Selective TSP / Orienteering-style DP.
   *
   * This collapses:
   *
   *   - choosing which bonuses to visit
   *   - choosing the order of mandatory + selected bonus nodes
   *
   * into one DP.
   *
   * State:
   *
   *   dp[mask][last] = minimum effective cost to:
   *     - start at key 0
   *     - visit exactly key nodes in mask
   *     - currently be at key node last
   *
   * Transition:
   *
   *   dp[mask | bit(next)][next] =
   *     dp[mask][last] + costs[last,next] - bonusValueByKey[next]
   *
   * Termination:
   *
   *   answer candidates are all masks containing mandatoryMask,
   *   plus return cost to start.
   *
   * This generates metric-closure candidate orderings. The caller should still
   * run path-level realization afterwards.
   */
  export function selectiveTspCandidates(options: SelectiveTspOptions): SelectiveTspCandidate[] {
    const {
      keyCount,
      costs,
      bonusValueByKey,
      mandatoryMask,
      maxLabelsPerState = 12,
      maxCandidates = 3000,
    } = options
  
    if (keyCount <= 0) return []
  
    // This implementation uses JS bitwise masks, so keep keyCount <= 30.
    if (keyCount > 30) {
      throw new Error(`selectiveTspCandidates requires keyCount <= 30, got ${keyCount}`)
    }
  
    const maskCount = 1 << keyCount
    const stateCount = maskCount * keyCount
  
    const stateOf = (mask: number, last: number): number => mask * keyCount + last
  
    const labels: Label[] = []
    const labelsByState: number[][] = Array.from({ length: stateCount }, () => [])
  
    function insertLabel(state: number, cost: number, prevLabelId: number): number | null {
      const bucket = labelsByState[state]
  
      // Bucket is maintained sorted by ascending label cost.
      if (bucket.length >= maxLabelsPerState) {
        const worstId = bucket[bucket.length - 1]
        if (cost >= labels[worstId].cost) return null
      }
  
      const labelId = labels.length
      labels.push({ state, cost, prevLabelId })
  
      let pos = 0
      while (pos < bucket.length && labels[bucket[pos]].cost <= cost) pos++
  
      bucket.splice(pos, 0, labelId)
  
      if (bucket.length > maxLabelsPerState) {
        bucket.pop()
      }
  
      return labelId
    }
  
    const startMask = 1
    insertLabel(stateOf(startMask, 0), 0, -1)
  
    for (let mask = 0; mask < maskCount; mask++) {
      if ((mask & startMask) === 0) continue
  
      for (let last = 0; last < keyCount; last++) {
        const lastBit = 1 << last
        if ((mask & lastBit) === 0) continue
  
        const state = stateOf(mask, last)
        const bucket = labelsByState[state]
        if (bucket.length === 0) continue
  
        for (let bi = 0; bi < bucket.length; bi++) {
          const labelId = bucket[bi]
          const label = labels[labelId]
  
          for (let next = 1; next < keyCount; next++) {
            const nextBit = 1 << next
            if (mask & nextBit) continue
  
            const edgeCost = costs[last * keyCount + next]
            if (!Number.isFinite(edgeCost)) continue
  
            const newMask = mask | nextBit
            const newState = stateOf(newMask, next)
            const newCost = label.cost + edgeCost - bonusValueByKey[next]
  
            insertLabel(newState, newCost, labelId)
          }
        }
      }
    }
  
    const finals: FinalLabel[] = []
  
    for (let mask = 0; mask < maskCount; mask++) {
      if ((mask & mandatoryMask) !== mandatoryMask) continue
  
      for (let last = 0; last < keyCount; last++) {
        const lastBit = 1 << last
        if ((mask & lastBit) === 0) continue
  
        const returnCost = costs[last * keyCount + 0]
        if (!Number.isFinite(returnCost)) continue
  
        const state = stateOf(mask, last)
        const bucket = labelsByState[state]
        if (bucket.length === 0) continue
  
        for (let bi = 0; bi < bucket.length; bi++) {
          const labelId = bucket[bi]
          const label = labels[labelId]
  
          finals.push({
            labelId,
            finalCost: label.cost + returnCost,
            mask,
          })
        }
      }
    }
  
    finals.sort((a, b) => a.finalCost - b.finalCost)
  
    const result: SelectiveTspCandidate[] = []
    const seenOrderings = new Set<string>()
  
    for (const f of finals) {
      if (result.length >= maxCandidates) break
  
      const ordering = reconstructOrdering(f.labelId, labels, keyCount)
      ordering.push(0)
  
      const key = ordering.join(',')
      if (seenOrderings.has(key)) continue
      seenOrderings.add(key)
  
      result.push({
        ordering,
        lbEffective: f.finalCost,
        mask: f.mask,
      })
    }
  
    return result
  }
  
  function reconstructOrdering(labelId: number, labels: Label[], keyCount: number): number[] {
    const reversed: number[] = []
  
    let cur = labelId
    while (cur !== -1) {
      const label = labels[cur]
      const last = label.state % keyCount
      reversed.push(last)
      cur = label.prevLabelId
    }
  
    reversed.reverse()
    return reversed
  }