/**
 * Generates complete round-trip orderings:
 *
 *   [0, ...permutation of 1..n-1, 0]
 *
 * in non-decreasing metric-closure lower-bound cost.
 *
 * Important:
 * This generator intentionally does NOT do classical Held-Karp DP pruning by
 * (mask,last), because the cheapest metric prefix is not always the best after
 * physical path realization.
 *
 * maxCost:
 * A gross-cost upper bound. Prefixes already >= maxCost are not expanded.
 */
export function* heldKarpGen(
  n: number,
  costs: Float64Array,
  maxCost = Infinity,
): Generator<{ ordering: number[]; cost: number }, void, void> {
  if (n === 1) {
    if (0 < maxCost) {
      yield {
        ordering: [0, 0],
        cost: 0,
      }
    }

    return
  }

  if (n > 30) {
    throw new Error(`heldKarpGen requires n <= 30 because it uses bitmasks. Got ${n}`)
  }

  /**
   * Backtracking linked list.
   *
   * btNode[i] = forced-stop index visited at this step.
   * btParent[i] = previous linked-list node index.
   */
  const btNode: number[] = [0]
  const btParent: number[] = [-1]

  /**
   * Specialized heap using parallel arrays.
   *
   * priority is also the current lower-bound cost, so we do not store cost
   * separately.
   */
  const hPri: number[] = []
  const hMask: number[] = []
  const hLast: number[] = []
  const hNodeIdx: number[] = []

  let hSize = 0

  const hpush = (
    priority: number,
    mask: number,
    last: number,
    nodeIdx: number,
  ): void => {
    let i = hSize++

    hPri[i] = priority
    hMask[i] = mask
    hLast[i] = last
    hNodeIdx[i] = nodeIdx

    while (i > 0) {
      const parent = (i - 1) >> 1

      if (hPri[parent] <= hPri[i]) break

      let tp = hPri[parent]
      hPri[parent] = hPri[i]
      hPri[i] = tp

      let ti = hMask[parent]
      hMask[parent] = hMask[i]
      hMask[i] = ti

      ti = hLast[parent]
      hLast[parent] = hLast[i]
      hLast[i] = ti

      ti = hNodeIdx[parent]
      hNodeIdx[parent] = hNodeIdx[i]
      hNodeIdx[i] = ti

      i = parent
    }
  }

  const hpopRoot = (): void => {
    const last = --hSize

    if (last <= 0) {
      hPri.pop()
      hMask.pop()
      hLast.pop()
      hNodeIdx.pop()
      return
    }

    hPri[0] = hPri[last]
    hMask[0] = hMask[last]
    hLast[0] = hLast[last]
    hNodeIdx[0] = hNodeIdx[last]

    hPri.pop()
    hMask.pop()
    hLast.pop()
    hNodeIdx.pop()

    let i = 0

    while (true) {
      let smallest = i
      const left = 2 * i + 1
      const right = 2 * i + 2

      if (left < hSize && hPri[left] < hPri[smallest]) {
        smallest = left
      }

      if (right < hSize && hPri[right] < hPri[smallest]) {
        smallest = right
      }

      if (smallest === i) break

      let tp = hPri[smallest]
      hPri[smallest] = hPri[i]
      hPri[i] = tp

      let ti = hMask[smallest]
      hMask[smallest] = hMask[i]
      hMask[i] = ti

      ti = hLast[smallest]
      hLast[smallest] = hLast[i]
      hLast[i] = ti

      ti = hNodeIdx[smallest]
      hNodeIdx[smallest] = hNodeIdx[i]
      hNodeIdx[i] = ti

      i = smallest
    }
  }

  const buildPath = (nodeIdx: number): number[] => {
    const path: number[] = []

    let i = nodeIdx

    while (i >= 0) {
      path.push(btNode[i])
      i = btParent[i]
    }

    path.reverse()
    return path
  }

  const fullMask = (1 << n) - 1

  hpush(0, 1, 0, 0)

  while (hSize > 0) {
    const cost = hPri[0]
    const mask = hMask[0]
    const last = hLast[0]
    const nodeIdx = hNodeIdx[0]

    hpopRoot()

    if (cost >= maxCost) continue

    if (mask === fullMask) {
      const ordering = buildPath(nodeIdx)
      ordering.push(0)

      yield {
        ordering,
        cost,
      }

      continue
    }

    const rowBase = last * n

    for (let v = 1; v < n; v++) {
      const bit = 1 << v

      if (mask & bit) continue

      const edge = costs[rowBase + v]

      if (!Number.isFinite(edge)) continue

      const newCost = cost + edge

      if (newCost >= maxCost) continue

      const newMask = mask | bit
      const newNodeIdx = btNode.length

      btNode.push(v)
      btParent.push(nodeIdx)

      if (newMask === fullMask) {
        const returnEdge = costs[v * n]

        if (!Number.isFinite(returnEdge)) continue

        const totalCost = newCost + returnEdge

        if (totalCost >= maxCost) continue

        hpush(
          totalCost,
          newMask,
          v,
          newNodeIdx,
        )
      } else {
        hpush(
          newCost,
          newMask,
          v,
          newNodeIdx,
        )
      }
    }
  }
}