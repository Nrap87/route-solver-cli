export interface OrienteeringCandidate {
    /**
     * Bonus subset mask over optional bonus nodes only.
     *
     * Bit k corresponds to optional bonus k.
     */
    bonusMask: number
  
    /**
     * Ordering in full key-node indices.
     *
     * Key layout expected by this DP:
     *
     *   key 0 = start
     *   keys 1..M = mandatory
     *   keys 1+M..1+M+B = optional bonuses
     *
     * Example:
     *
     *   [0, 2, 5, 1, 0]
     */
    ordering: number[]
  
    /**
     * Gross metric-closure round-trip cost before subtracting bonuses.
     */
    lbGross: number
  
    /**
     * Optional bonus credit for this bonus subset.
     */
    bonusCredit: number
  
    /**
     * Lower-bound effective cost:
     *
     *   lbGross - bonusCredit
     *
     * This does not include guaranteed bonuses on mandatory planets. The caller
     * can subtract those separately if needed.
     */
    lbEffective: number
  
    /**
     * Full key mask containing:
     *
     *   start + all mandatory + selected optional bonuses
     */
    keyMask: number
  }
  
  export interface OrienteeringDPOptions {
    keyCount: number
    mandatoryCount: number
    bonusCount: number
    costs: Float64Array
  
    /**
     * bonusValues[k] = value of optional bonus k.
     *
     * Optional bonus k corresponds to key:
     *
     *   1 + mandatoryCount + k
     */
    bonusValues: Float64Array
  }
  
  /**
   * Computes one DP-optimal metric-closure ordering for every optional-bonus subset.
   *
   * This collapses:
   *
   *   choose bonus subset + choose best metric ordering
   *
   * into one DP over all key nodes.
   *
   * Complexity:
   *
   *   O(2^K * K^2)
   *
   * where:
   *
   *   K = 1 + mandatoryCount + bonusCount
   */
  export function orienteeringDPCandidates(options: OrienteeringDPOptions): OrienteeringCandidate[] {
    const {
      keyCount,
      mandatoryCount,
      bonusCount,
      costs,
      bonusValues,
    } = options
  
    if (keyCount <= 0) return []
  
    if (keyCount > 30) {
      throw new Error(`orienteeringDPCandidates requires keyCount <= 30, got ${keyCount}`)
    }
  
    const maskCount = 1 << keyCount
    const stateCount = maskCount * keyCount
  
    const stateOf = (mask: number, last: number): number => mask * keyCount + last
  
    const dp = new Float64Array(stateCount)
    dp.fill(Infinity)
  
    const prevLast = new Int16Array(stateCount)
    prevLast.fill(-1)
  
    const prevMask = new Int32Array(stateCount)
    prevMask.fill(-1)
  
    const startMask = 1
    dp[stateOf(startMask, 0)] = 0
  
    for (let mask = 0; mask < maskCount; mask++) {
      if ((mask & startMask) === 0) continue
  
      for (let last = 0; last < keyCount; last++) {
        if ((mask & (1 << last)) === 0) continue
  
        const curState = stateOf(mask, last)
        const curCost = dp[curState]
  
        if (!Number.isFinite(curCost)) continue
  
        const rowBase = last * keyCount
  
        for (let next = 1; next < keyCount; next++) {
          const nextBit = 1 << next
          if (mask & nextBit) continue
  
          const edge = costs[rowBase + next]
          if (!Number.isFinite(edge)) continue
  
          const newMask = mask | nextBit
          const newState = stateOf(newMask, next)
          const newCost = curCost + edge
  
          if (newCost < dp[newState]) {
            dp[newState] = newCost
            prevLast[newState] = last
            prevMask[newState] = mask
          }
        }
      }
    }
  
    const mandatoryMask = buildMandatoryMask(mandatoryCount)
    const bonusSubsetCount = 1 << bonusCount
    const candidates: OrienteeringCandidate[] = []
  
    for (let bonusMask = 0; bonusMask < bonusSubsetCount; bonusMask++) {
      const keyMask =
        mandatoryMask |
        bonusMaskToKeyMask(bonusMask, mandatoryCount, bonusCount)
  
      let bestGross = Infinity
      let bestLast = -1
  
      for (let last = 0; last < keyCount; last++) {
        if ((keyMask & (1 << last)) === 0) continue
  
        const returnCost = costs[last * keyCount + 0]
        if (!Number.isFinite(returnCost)) continue
  
        const state = stateOf(keyMask, last)
        const gross = dp[state] + returnCost
  
        if (gross < bestGross) {
          bestGross = gross
          bestLast = last
        }
      }
  
      if (bestLast === -1 || !Number.isFinite(bestGross)) continue
  
      const bonusCredit = bonusCreditForMask(bonusMask, bonusValues)
  
      const ordering = reconstructOrdering({
        keyMask,
        last: bestLast,
        keyCount,
        prevLast,
        prevMask,
      })
  
      ordering.push(0)
  
      candidates.push({
        bonusMask,
        ordering,
        lbGross: bestGross,
        bonusCredit,
        lbEffective: bestGross - bonusCredit,
        keyMask,
      })
    }
  
    /**
     * Default order:
     *
     *   empty subset first,
     *   then best effective lower bound.
     *
     * heldKarpSolve.ts applies an additional challenge-oriented reorder after this.
     */
    candidates.sort((a, b) => {
      if (a.bonusMask === 0) return -1
      if (b.bonusMask === 0) return 1
      return a.lbEffective - b.lbEffective
    })
  
    return candidates
  }
  
  function buildMandatoryMask(mandatoryCount: number): number {
    let mask = 1 // start
  
    for (let i = 0; i < mandatoryCount; i++) {
      const keyIndex = 1 + i
      mask |= 1 << keyIndex
    }
  
    return mask
  }
  
  function bonusMaskToKeyMask(
    bonusMask: number,
    mandatoryCount: number,
    bonusCount: number,
  ): number {
    let keyMask = 0
  
    for (let k = 0; k < bonusCount; k++) {
      if (bonusMask & (1 << k)) {
        const keyIndex = 1 + mandatoryCount + k
        keyMask |= 1 << keyIndex
      }
    }
  
    return keyMask
  }
  
  function bonusCreditForMask(bonusMask: number, bonusValues: Float64Array): number {
    let credit = 0
  
    for (let k = 0; k < bonusValues.length; k++) {
      if (bonusMask & (1 << k)) {
        credit += bonusValues[k]
      }
    }
  
    return credit
  }
  
  function reconstructOrdering(args: {
    keyMask: number
    last: number
    keyCount: number
    prevLast: Int16Array
    prevMask: Int32Array
  }): number[] {
    const {
      keyMask,
      last,
      keyCount,
      prevLast,
      prevMask,
    } = args
  
    const stateOf = (mask: number, node: number): number => mask * keyCount + node
  
    const reversed: number[] = []
  
    let curMask = keyMask
    let curLast = last
  
    while (curLast !== -1) {
      reversed.push(curLast)
  
      if (curMask === 1 && curLast === 0) break
  
      const state = stateOf(curMask, curLast)
      const pLast = prevLast[state]
      const pMask = prevMask[state]
  
      curLast = pLast
      curMask = pMask
    }
  
    reversed.reverse()
    return reversed
  }