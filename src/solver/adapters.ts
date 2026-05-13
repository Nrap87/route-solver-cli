import type { components } from '../api/schema.js'
import type { Planet, Route, Bonus, SolveInput } from './types.js'

type PlanetOut = components['schemas']['PlanetOut']
type RouteOut = components['schemas']['RouteOut']
type ChallengeOut = components['schemas']['ChallengeOut']
type PlanetSimple = components['schemas']['PlanetSimple']

export function adaptPlanet(p: Partial<PlanetOut>): Planet {
  return {
    id: p.Id ?? 0,
    name: p.Name ?? '',
    x: p.Coordinate_X ?? 0,
    y: p.Coordinate_Y ?? 0,
  }
}

export function adaptRoute(r: RouteOut): Route {
  return {
    from: r.From_Planet ?? 0,
    to: r.To_PlanetId ?? 0,
    type: r.RouteType === 'Main Route' ? 'main' : 'other',
  }
}

export function adaptChallenge(
  c: ChallengeOut,
  planets: Planet[],
  routes: Route[],
): SolveInput {
  // StartPlanetId is typed as string in the API despite all other planet IDs being int64 numbers.
  // Number() is safe here: the game's IDs fit within MAX_SAFE_INTEGER per observed values (~10^15),
  // but would silently lose precision above 2^53 if the server ever generates denser IDs.
  const startPlanetId = Number(c.StartPlanetId ?? '0')

  const mandatoryIds = (c.MandatoryPlanets ?? []).map((p) => p.PlanetId ?? 0)
  const forbiddenIds = (c.ForbiddenPlanets ?? []).map((p) => p.PlanetId ?? 0)
  const bonuses: Bonus[] = (c.BonusPlanets ?? [])
    .filter((p) => (p.Bonus ?? 0) > 0)
    .map((p) => ({ planetId: p.PlanetId ?? 0, value: p.Bonus! }))

  return { planets, routes, startPlanetId, mandatoryIds, forbiddenIds, bonuses }
}

export function toPlanetSimple(planets: Planet[]): PlanetSimple[] {
  return planets.map((p) => ({ PlanetId: p.id, Name: p.name }))
}
