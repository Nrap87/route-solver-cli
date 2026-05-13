import { describe, it, expect } from 'vitest'
import { adaptPlanet, adaptRoute, adaptChallenge, toPlanetSimple } from '../adapters'
import type { Planet, Route } from '../types'

describe('adaptPlanet', () => {
  it('maps all fields', () => {
    const result = adaptPlanet({ Id: 7, Name: 'Tatooine', Coordinate_X: 3, Coordinate_Y: 4 })
    expect(result).toEqual({ id: 7, name: 'Tatooine', x: 3, y: 4 })
  })

  it('defaults missing fields to zero/empty', () => {
    const result = adaptPlanet({ Name: 'Void' })
    expect(result).toEqual({ id: 0, name: 'Void', x: 0, y: 0 })
  })
})

describe('adaptRoute', () => {
  it('maps Main Route to main', () => {
    const result = adaptRoute({ From_Planet: 1, To_PlanetId: 2, RouteType: 'Main Route' })
    expect(result).toEqual({ from: 1, to: 2, type: 'main' })
  })

  it('maps Other Route to other', () => {
    const result = adaptRoute({ From_Planet: 1, To_PlanetId: 3, RouteType: 'Other Route' })
    expect(result).toEqual({ from: 1, to: 3, type: 'other' })
  })

  it('defaults unknown RouteType to other', () => {
    const result = adaptRoute({ From_Planet: 1, To_PlanetId: 4, RouteType: 'Unknown' })
    expect(result.type).toBe('other')
  })
})

describe('adaptChallenge', () => {
  const planets: Planet[] = [
    { id: 1, name: 'A', x: 0, y: 0 },
    { id: 2, name: 'B', x: 3, y: 4 },
    { id: 3, name: 'C', x: 6, y: 8 },
    { id: 4, name: 'D', x: 9, y: 12 },
  ]
  const routes: Route[] = [{ from: 1, to: 2, type: 'main' }]

  // T11 — adapter round-trip
  it('produces correct SolveInput from a known ChallengeOut', () => {
    const challenge = {
      ChallengeId: 42,
      ChallengeName: 'Test',
      StartPlanetId: '1',
      MandatoryPlanets: [{ PlanetId: 2, Name: 'B', Bonus: 0 }],
      ForbiddenPlanets: [{ PlanetId: 3, Name: 'C', Bonus: 0 }],
      BonusPlanets: [{ PlanetId: 4, Name: 'D', Bonus: 100 }],
      IsFinished: false,
      Level: 'Level1',
    }

    const input = adaptChallenge(challenge, planets, routes)

    expect(input.startPlanetId).toBe(1)
    expect(input.mandatoryIds).toEqual([2])
    expect(input.forbiddenIds).toEqual([3])
    expect(input.bonuses).toEqual([{ planetId: 4, value: 100 }])
    expect(input.planets).toBe(planets)
    expect(input.routes).toBe(routes)
  })

  it('parses StartPlanetId from string', () => {
    const input = adaptChallenge(
      { StartPlanetId: '99', ChallengeName: '', Level: '', IsFinished: false },
      planets,
      routes,
    )
    expect(input.startPlanetId).toBe(99)
  })

  it('treats missing planet lists as empty arrays', () => {
    const input = adaptChallenge(
      { StartPlanetId: '1', ChallengeName: '', Level: '', IsFinished: false },
      planets,
      routes,
    )
    expect(input.mandatoryIds).toEqual([])
    expect(input.forbiddenIds).toEqual([])
    expect(input.bonuses).toEqual([])
  })

  it('ignores bonus planets with Bonus <= 0', () => {
    const input = adaptChallenge(
      {
        StartPlanetId: '1',
        ChallengeName: '',
        Level: '',
        IsFinished: false,
        BonusPlanets: [
          { PlanetId: 2, Name: 'B', Bonus: 0 },
          { PlanetId: 3, Name: 'C', Bonus: -5 },
          { PlanetId: 4, Name: 'D', Bonus: 50 },
        ],
      },
      planets,
      routes,
    )
    expect(input.bonuses).toEqual([{ planetId: 4, value: 50 }])
  })
})

describe('toPlanetSimple', () => {
  it('converts Planet array to PlanetSimple array', () => {
    const result = toPlanetSimple([
      { id: 1, name: 'A', x: 0, y: 0 },
      { id: 2, name: 'B', x: 1, y: 1 },
    ])
    expect(result).toEqual([
      { PlanetId: 1, Name: 'A' },
      { PlanetId: 2, Name: 'B' },
    ])
  })
})
