export interface Planet {
  id: number
  name: string
  x: number
  y: number
}

export interface Route {
  from: number
  to: number
  type: 'main' | 'other'
}

export interface Bonus {
  planetId: number
  value: number
}

export interface SolveInput {
  planets: Planet[]
  routes: Route[]
  startPlanetId: number
  mandatoryIds: number[]
  forbiddenIds: number[]
  bonuses: Bonus[]
}

export interface SolveResult {
  success: boolean
  errorMessage?: string
  orderedRoute: Planet[]
  effectiveFuel: number
  grossFuel: number
  collectedBonus: number
  timedOut?: boolean
}
