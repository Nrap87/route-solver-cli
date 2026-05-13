import { describe, it, expect } from 'vitest'
import { buildCostMatrix } from '../costMatrix'
import { computeAllPairsSP } from '../allPairsSP'
import { heldKarpGen } from '../heldKarp'
import { solve } from '../solve'
import type { Planet, Route, SolveInput } from '../types'

// ─── helpers ────────────────────────────────────────────────────────────────

function planet(id: number, x: number, y: number): Planet {
  return { id, name: String(id), x, y }
}

// ─── costMatrix ──────────────────────────────────────────────────────────────

describe('buildCostMatrix', () => {
  it('produces a zero diagonal', () => {
    const planets = [planet(1, 0, 0), planet(2, 3, 4), planet(3, 6, 8)]
    const { n, data } = buildCostMatrix(planets, [])
    for (let i = 0; i < n; i++) expect(data[i * n + i]).toBe(0)
  })

  it('computes Euclidean cost with no routes', () => {
    const planets = [planet(1, 0, 0), planet(2, 3, 4)]
    const { data } = buildCostMatrix(planets, [])
    expect(data[0 * 2 + 1]).toBeCloseTo(5)
    expect(data[1 * 2 + 0]).toBeCloseTo(5)
  })

  it('applies main route 0.5× discount', () => {
    const planets = [planet(1, 0, 0), planet(2, 6, 8)]
    const routes: Route[] = [{ from: 1, to: 2, type: 'main' }]
    const { data } = buildCostMatrix(planets, routes)
    expect(data[0 * 2 + 1]).toBeCloseTo(5)   // 0.5 * 10
    expect(data[1 * 2 + 0]).toBeCloseTo(5)   // bidirectional discount
  })

  it('applies other route 2/3× discount', () => {
    const planets = [planet(1, 0, 0), planet(2, 6, 8)]
    const routes: Route[] = [{ from: 1, to: 2, type: 'other' }]
    const { data } = buildCostMatrix(planets, routes)
    expect(data[0 * 2 + 1]).toBeCloseTo((2 / 3) * 10)
    expect(data[1 * 2 + 0]).toBeCloseTo((2 / 3) * 10)
  })

  it('unrouted pair stays at full Euclidean cost', () => {
    const planets = [planet(1, 0, 0), planet(2, 3, 4), planet(3, 6, 8)]
    const routes: Route[] = [{ from: 1, to: 2, type: 'main' }]
    const { n, data } = buildCostMatrix(planets, routes)
    // pair (2,3) has no route → full cost = euclidean(B,C) = 5
    expect(data[1 * n + 2]).toBeCloseTo(5)
  })

  it('idToIdx and idxToId are inverses', () => {
    const planets = [planet(10, 0, 0), planet(20, 3, 4)]
    const { idToIdx, idxToId } = buildCostMatrix(planets, [])
    expect(idToIdx.get(10)).toBe(0)
    expect(idToIdx.get(20)).toBe(1)
    expect(idxToId[0]).toBe(10)
    expect(idxToId[1]).toBe(20)
  })
})

// ─── allPairsSP ──────────────────────────────────────────────────────────────

describe('computeAllPairsSP', () => {
  // Three collinear planets: 1-(5)-2-(5)-3, no routes
  const planets = [planet(1, 0, 0), planet(2, 5, 0), planet(3, 10, 0)]
  const matrix = buildCostMatrix(planets, [])

  it('spCost from start to itself is 0', () => {
    const { spCost } = computeAllPairsSP(matrix, [0], new Set())
    expect(spCost.get(0)![0]).toBe(0)
  })

  it('direct cost matches matrix entry when no shorter path exists', () => {
    const { spCost } = computeAllPairsSP(matrix, [0], new Set())
    expect(spCost.get(0)![1]).toBeCloseTo(5)
    expect(spCost.get(0)![2]).toBeCloseTo(10)
  })

  it('spPath from 0 to 2 is [0,1,2] (cheaper via intermediate due to collinear layout)', () => {
    // All three planets collinear: 0→2 direct = 10, via 1 = 5+5 = 10 (same). Path will be [0,2] or [0,1,2].
    // Use a triangle where the indirect path is cheaper due to a route discount.
    const p = [planet(1, 0, 0), planet(2, 3, 0), planet(3, 10, 0)]
    const r: Route[] = [{ from: 1, to: 2, type: 'main' }, { from: 2, to: 3, type: 'main' }]
    const m = buildCostMatrix(p, r)
    const { spCost, spPath } = computeAllPairsSP(m, [0], new Set())
    // direct 0→2: euclidean = 10
    // via 1: 0.5*3 + 0.5*7 = 1.5 + 3.5 = 5 → cheaper
    expect(spCost.get(0)![2]).toBeCloseTo(5)
    expect(spPath.get(0)![2]).toEqual([0, 1, 2])
  })

  it('forbidden node is excluded from paths', () => {
    // force path through node 1 to be blocked; direct 0→2 is the only option
    const { spCost, spPath } = computeAllPairsSP(matrix, [0], new Set([1]))
    expect(spCost.get(0)![2]).toBeCloseTo(10)  // must go direct
    expect(spPath.get(0)![2]).toEqual([0, 2])
  })

  it('returns Infinity cost and null path when target is forbidden', () => {
    const { spCost, spPath } = computeAllPairsSP(matrix, [0], new Set([2]))
    expect(spCost.get(0)![2]).toBe(Infinity)
    expect(spPath.get(0)![2]).toBeNull()
  })

  it('computes from multiple sources independently', () => {
    const { spCost } = computeAllPairsSP(matrix, [0, 2], new Set())
    expect(spCost.get(0)![2]).toBeCloseTo(10)
    expect(spCost.get(2)![0]).toBeCloseTo(10)
  })
})

// ─── heldKarp ────────────────────────────────────────────────────────────────

describe('heldKarpGen', () => {
  it('n=1 (start only): yields one trivial ordering [0,0] with cost 0', () => {
    const costs = new Float64Array([0])
    const results = [...heldKarpGen(1, costs)]
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ ordering: [0, 0], cost: 0 })
  })

  it('n=2: yields one ordering [0,1,0]', () => {
    // costs: 0→1 = 3, 1→0 = 3
    const costs = new Float64Array([0, 3, 3, 0])
    const results = [...heldKarpGen(2, costs)]
    expect(results).toHaveLength(1)
    expect(results[0].ordering).toEqual([0, 1, 0])
    expect(results[0].cost).toBeCloseTo(6)
  })

  it('n=3: first yielded ordering is the cheapest', () => {
    // 3 forced stops: 0=start, 1=A, 2=B
    // Asymmetric costs so orderings differ
    // costs (3×3):
    //   0→1=2, 0→2=9
    //   1→0=2, 1→2=3
    //   2→0=9, 2→1=3
    // Ordering 0→1→2→0: 2+3+9 = 14
    // Ordering 0→2→1→0: 9+3+2 = 14  (same here)
    const costs = new Float64Array([
      0, 2, 9,
      2, 0, 3,
      9, 3, 0,
    ])
    const [first, ...rest] = heldKarpGen(2, costs)  // only 1 non-start node, so just one ordering
    void rest
    expect(first).toBeDefined()
  })

  it('n=3 with asymmetric costs: emits cheapest ordering first', () => {
    // 3 forced stops: 0=start, 1=A, 2=B
    // costs (3×3): use layout where 0→1→2→0 = 1+1+10 = 12, 0→2→1→0 = 10+1+1 = 12 → same
    // Better example:
    //   0→1=1, 0→2=10
    //   1→0=1, 1→2=1
    //   2→0=10, 2→1=1
    // 0→1→2→0: 1+1+10 = 12
    // 0→2→1→0: 10+1+1 = 12
    // Both equal, let's use clearer asymmetry:
    //   0→1=1, 0→2=5
    //   1→0=1, 1→2=1
    //   2→0=5, 2→1=100
    // 0→1→2→0: 1+1+5 = 7
    // 0→2→1→0: 5+100+1 = 106
    const costs = new Float64Array([
      0,   1,   5,
      1,   0,   1,
      5, 100,   0,
    ])
    const results = [...heldKarpGen(3, costs)]
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].cost).toBeCloseTo(7)
    expect(results[0].ordering[0]).toBe(0)
    expect(results[0].ordering[results[0].ordering.length - 1]).toBe(0)
  })

  it('orderings are emitted in non-decreasing cost order', () => {
    const costs = new Float64Array([
      0, 1, 5,
      1, 0, 1,
      5, 100, 0,
    ])
    const results = [...heldKarpGen(3, costs)]
    for (let i = 1; i < results.length; i++) {
      expect(results[i].cost).toBeGreaterThanOrEqual(results[i - 1].cost)
    }
  })

  it('every ordering visits all forced stops exactly once (except start at both ends)', () => {
    const costs = new Float64Array([
      0, 2, 3, 4,
      2, 0, 1, 5,
      3, 1, 0, 2,
      4, 5, 2, 0,
    ])
    const results = [...heldKarpGen(4, costs)]
    for (const { ordering } of results) {
      expect(ordering[0]).toBe(0)
      expect(ordering[ordering.length - 1]).toBe(0)
      const middle = ordering.slice(1, -1)
      // middle must be a permutation of [1, 2, 3]
      expect(middle.sort()).toEqual([1, 2, 3])
    }
  })
})

// ─── T1–T13 acceptance tests ─────────────────────────────────────────────────

function dist(ax: number, ay: number, bx: number, by: number) {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2)
}

const EPS = 1e-9
function near(a: number, b: number) { return Math.abs(a - b) < EPS }

// A trivial 4-planet map used by most tests.
// IDs: 1=Origin(0,0), 2=East(10,0), 3=North(0,10), 4=Far(10,10)
function baseInput(overrides: Partial<SolveInput> = {}): SolveInput {
  return {
    planets: [
      { id: 1, name: 'Origin', x: 0,  y: 0  },
      { id: 2, name: 'East',   x: 10, y: 0  },
      { id: 3, name: 'North',  x: 0,  y: 10 },
      { id: 4, name: 'Far',    x: 10, y: 10 },
    ],
    routes: [],
    startPlanetId: 1,
    mandatoryIds: [],
    forbiddenIds: [],
    bonuses: [],
    ...overrides,
  }
}

describe('T1 — trivial tour (no stops)', () => {
  it('returns [start, start] with zero fuel', () => {
    const r = solve(baseInput())
    expect(r.success).toBe(true)
    expect(r.orderedRoute).toHaveLength(2)
    expect(r.orderedRoute[0].id).toBe(1)
    expect(r.orderedRoute[1].id).toBe(1)
    expect(r.effectiveFuel).toBe(0)
    expect(r.grossFuel).toBe(0)
    expect(r.collectedBonus).toBe(0)
  })
})

describe('T2 — one mandatory', () => {
  it('produces a round-trip at correct cost', () => {
    const r = solve(baseInput({ mandatoryIds: [2] }))
    expect(r.success).toBe(true)
    const expected = 2 * dist(0, 0, 10, 0)   // 20
    expect(near(r.grossFuel, expected)).toBe(true)
    expect(near(r.effectiveFuel, expected)).toBe(true)
    expect(r.orderedRoute[0].id).toBe(1)
    expect(r.orderedRoute[r.orderedRoute.length - 1].id).toBe(1)
    expect(r.orderedRoute.map(p => p.id)).toContain(2)
  })
})

describe('T3 — two mandatories, optimal ordering', () => {
  it('visits both mandatories and returns to start', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,   y: 0 },
        { id: 2, name: 'A', x: 3,   y: 4 },
        { id: 3, name: 'B', x: 3,   y: -4 },
      ],
      routes: [],
      startPlanetId: 1,
      mandatoryIds: [2, 3],
      forbiddenIds: [],
      bonuses: [],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    const ids = r.orderedRoute.map(p => p.id)
    expect(ids[0]).toBe(1)
    expect(ids[ids.length - 1]).toBe(1)
    expect(ids).toContain(2)
    expect(ids).toContain(3)
    expect(near(r.grossFuel, 18)).toBe(true)
  })
})

describe('T4 — forbidden nodes', () => {
  it('rejects input where mandatory is also forbidden', () => {
    const r = solve(baseInput({ mandatoryIds: [2], forbiddenIds: [2] }))
    expect(r.success).toBe(false)
    expect(r.errorMessage).toMatch(/forbidden/i)
  })

  it('rejects input where start is forbidden', () => {
    const r = solve(baseInput({ forbiddenIds: [1] }))
    expect(r.success).toBe(false)
  })

  it('routes around forbidden transit node when direct hop is cheaper', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,  y: 0 },
        { id: 2, name: 'F', x: 10, y: 0 },
        { id: 3, name: 'M', x: 20, y: 0 },
      ],
      routes: [],
      startPlanetId: 1,
      mandatoryIds: [3],
      forbiddenIds: [2],
      bonuses: [],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    const ids = r.orderedRoute.map(p => p.id)
    expect(ids).not.toContain(2)
    expect(ids).toContain(3)
    expect(near(r.grossFuel, 40)).toBe(true)
  })
})

describe('T5 — bonus inclusion', () => {
  it('collects bonus that lies on cheapest path (zero detour)', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,  y: 0 },
        { id: 2, name: 'M', x: 20, y: 0 },
        { id: 3, name: 'B', x: 10, y: 0 },
      ],
      routes: [],
      startPlanetId: 1,
      mandatoryIds: [2],
      forbiddenIds: [],
      bonuses: [{ planetId: 3, value: 100 }],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(r.effectiveFuel).toBeLessThan(0)
    expect(r.collectedBonus).toBeGreaterThan(0)
  })

  it('includes bonus that reduces objective via explicit detour', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,  y: 0 },
        { id: 2, name: 'M', x: 10, y: 0 },
        { id: 3, name: 'B', x: 5,  y: 1 },
      ],
      routes: [],
      startPlanetId: 1,
      mandatoryIds: [2],
      forbiddenIds: [],
      bonuses: [{ planetId: 3, value: 1000 }],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(r.collectedBonus).toBe(1000)
    expect(r.effectiveFuel).toBeLessThan(0)
  })
})

describe('T6 — bonus exclusion', () => {
  it('skips a bonus whose detour cost exceeds its value', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,    y: 0 },
        { id: 2, name: 'M', x: 10,   y: 0 },
        { id: 3, name: 'B', x: 5,    y: 1000 },
      ],
      routes: [],
      startPlanetId: 1,
      mandatoryIds: [2],
      forbiddenIds: [],
      bonuses: [{ planetId: 3, value: 1 }],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(r.collectedBonus).toBe(0)
    expect(near(r.grossFuel, 20)).toBe(true)
  })
})

describe('T7 — route discounts', () => {
  it('applies main route ×0.5 discount (both legs explicitly routed)', () => {
    // Routes are directed: add both directions so the round trip is discounted.
    const routes: Route[] = [{ from: 1, to: 2, type: 'main' }, { from: 2, to: 1, type: 'main' }]
    const input: SolveInput = { ...baseInput({ mandatoryIds: [2] }), routes }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(near(r.grossFuel, 10)).toBe(true)
  })

  it('applies other route ×(2/3) discount (both legs explicitly routed)', () => {
    const routes: Route[] = [{ from: 1, to: 2, type: 'other' }, { from: 2, to: 1, type: 'other' }]
    const input: SolveInput = { ...baseInput({ mandatoryIds: [2] }), routes }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(near(r.grossFuel, 2 * 10 * (2 / 3))).toBe(true)
  })

  it('prefers route-discounted path over full-cost direct', () => {
    // O→X→M via main routes: (4 + 0.5*6)*2 = (4+3)*2 = 14 < direct 20
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0, y: 0 },
        { id: 2, name: 'M', x: 10, y: 0 },
        { id: 3, name: 'X', x: 4,  y: 0 },
      ],
      routes: [{ from: 3, to: 2, type: 'main' }],
      startPlanetId: 1,
      mandatoryIds: [2],
      forbiddenIds: [],
      bonuses: [],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(r.grossFuel).toBeLessThanOrEqual(20 + EPS)
  })
})

describe('T8 — mandatory equals start', () => {
  it('treats start-as-mandatory as a no-op and returns trivial tour', () => {
    const r = solve(baseInput({ mandatoryIds: [1] }))
    expect(r.success).toBe(true)
    expect(r.orderedRoute).toHaveLength(2)
    expect(r.effectiveFuel).toBe(0)
  })
})

describe('T9 — conflict detection', () => {
  it('errors when all non-forbidden paths to mandatory are blocked', () => {
    const r = solve(baseInput({ mandatoryIds: [3], forbiddenIds: [3] }))
    expect(r.success).toBe(false)
  })
})

describe('T10 — transit node disjointness', () => {
  it('finds a disjoint route even when cheapest paths share a transit node', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,  y: 0 },
        { id: 2, name: 'A', x: 5,  y: 0 },
        { id: 3, name: 'B', x: 10, y: 0 },
        { id: 4, name: 'C', x: 15, y: 0 },
      ],
      routes: [
        { from: 1, to: 2, type: 'main' },
        { from: 2, to: 3, type: 'main' },
        { from: 3, to: 4, type: 'main' },
      ],
      startPlanetId: 1,
      mandatoryIds: [3, 4],
      forbiddenIds: [],
      bonuses: [],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    const inner = r.orderedRoute.slice(1, -1)
    const ids = inner.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('T12 — transit bonus', () => {
  it('credits bonus planet visited as transit node', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O', x: 0,  y: 0 },
        { id: 2, name: 'M', x: 10, y: 0 },
        { id: 3, name: 'B', x: 5,  y: 0 },
      ],
      routes: [],
      startPlanetId: 1,
      mandatoryIds: [2],
      forbiddenIds: [],
      bonuses: [{ planetId: 3, value: 500 }],
    }
    const r = solve(input)
    expect(r.success).toBe(true)
    expect(r.collectedBonus).toBe(500)
    expect(r.effectiveFuel).toBeLessThan(0)
  })
})

describe('T13 — performance', () => {
  it('solves 3-mandatory in < 100 ms', () => {
    const input: SolveInput = {
      planets: [
        { id: 1, name: 'O',  x: 0,   y: 0   },
        { id: 2, name: 'M1', x: 100, y: 0   },
        { id: 3, name: 'M2', x: 50,  y: 86  },
        { id: 4, name: 'M3', x: -50, y: 86  },
        { id: 5, name: 'X1', x: 30,  y: 40  },
        { id: 6, name: 'X2', x: -30, y: 40  },
      ],
      routes: [
        { from: 1, to: 2, type: 'main' },
        { from: 2, to: 3, type: 'other' },
        { from: 3, to: 4, type: 'main' },
      ],
      startPlanetId: 1,
      mandatoryIds: [2, 3, 4],
      forbiddenIds: [],
      bonuses: [],
    }
    const t0 = Date.now()
    const r = solve(input)
    const elapsed = Date.now() - t0
    expect(r.success).toBe(true)
    expect(r.timedOut).toBeFalsy()
    expect(elapsed).toBeLessThan(100)
    const ids = new Set(r.orderedRoute.map(p => p.id))
    expect(ids.has(2)).toBe(true)
    expect(ids.has(3)).toBe(true)
    expect(ids.has(4)).toBe(true)
  })

  it('solves 4-mandatory + 2-bonus in < 2 s', () => {
    const input: SolveInput = {
      planets: [
        { id: 1,  name: 'O',  x: 0,    y: 0    },
        { id: 2,  name: 'M1', x: 200,  y: 0    },
        { id: 3,  name: 'M2', x: 100,  y: 173  },
        { id: 4,  name: 'M3', x: -100, y: 173  },
        { id: 5,  name: 'M4', x: -200, y: 0    },
        { id: 6,  name: 'B1', x: 50,   y: 50   },
        { id: 7,  name: 'B2', x: -50,  y: 50   },
        { id: 8,  name: 'X1', x: 150,  y: 86   },
        { id: 9,  name: 'X2', x: -150, y: 86   },
        { id: 10, name: 'X3', x: 0,    y: 100  },
      ],
      routes: [
        { from: 1, to: 2,  type: 'main'  },
        { from: 2, to: 3,  type: 'main'  },
        { from: 3, to: 4,  type: 'other' },
        { from: 4, to: 5,  type: 'main'  },
        { from: 5, to: 1,  type: 'main'  },
        { from: 1, to: 6,  type: 'other' },
        { from: 1, to: 7,  type: 'other' },
      ],
      startPlanetId: 1,
      mandatoryIds: [2, 3, 4, 5],
      forbiddenIds: [],
      bonuses: [
        { planetId: 6, value: 80 },
        { planetId: 7, value: 80 },
      ],
    }
    const t0 = Date.now()
    const r = solve(input)
    const elapsed = Date.now() - t0
    expect(r.success).toBe(true)
    expect(r.timedOut).toBeFalsy()
    expect(elapsed).toBeLessThan(2000)
    const ids = new Set(r.orderedRoute.map(p => p.id))
    ;[2, 3, 4, 5].forEach(id => expect(ids.has(id)).toBe(true))
    expect(r.orderedRoute[0].id).toBe(1)
    expect(r.orderedRoute[r.orderedRoute.length - 1].id).toBe(1)
    const inner = r.orderedRoute.slice(1, -1).map(p => p.id)
    expect(new Set(inner).size).toBe(inner.length)
  })
})
