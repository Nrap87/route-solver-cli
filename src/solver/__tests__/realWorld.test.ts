import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { challengeToSolveInput, recordToChallenge } from '../../adapt.js'
import { adaptPlanet, adaptRoute } from '../adapters'
import { solve } from '../solve'
import { PLANETS_RAW, ROUTES_RAW } from './realWorld.fixture'

const PLANETS = PLANETS_RAW.map(adaptPlanet)
const ROUTES = ROUTES_RAW.map(adaptRoute)

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Source of truth: bundled challenge rows with `realFuel` (exact filename on disk includes a space). */
const CHALLENGES_ALL_WITH_FUEL_JSON = join(
  __dirname,
  '../../../challenges/challenges_all with_fuel.json',
)

const SOLVER_TEST_MS = 16 * 60 * 1000

function loadFuelChallengesFromJson(): Array<{
  id: number
  name: string
  realFuel: number
  row: Record<string, unknown>
}> {
  const rows = JSON.parse(
    readFileSync(CHALLENGES_ALL_WITH_FUEL_JSON, 'utf8'),
  ) as Record<string, unknown>[]
  const out: Array<{
    id: number
    name: string
    realFuel: number
    row: Record<string, unknown>
  }> = []

  for (const row of rows) {
    if (typeof row.realFuel !== 'number') continue
    const fields = recordToChallenge(row)
    const id = fields.challengeId
    if (id == null) continue
    const title = fields.title
    out.push({
      id,
      name: title != null && title !== '' ? title : `Challenge ${id}`,
      realFuel: row.realFuel,
      row,
    })
  }

  return out.sort((a, b) => a.id - b.id)
}

const FUEL_CHALLENGES = loadFuelChallengesFromJson()

describe('challenges_all with_fuel.json', () => {
  it.each(FUEL_CHALLENGES)(
    '$id: $name — realFuel $realFuel CX',
    ({ row, realFuel }) => {
      const input = challengeToSolveInput(
        PLANETS,
        ROUTES,
        recordToChallenge(row),
      )
      const result = solve(input)
      expect(result.success).toBe(true)
      expect(result.timedOut).toBeFalsy()
      expect(Math.round(result.effectiveFuel)).toBe(Math.round(realFuel))
    },
    SOLVER_TEST_MS,
  )
})
