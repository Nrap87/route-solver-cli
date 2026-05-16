import createClient from 'openapi-fetch'
import type { paths, components } from './schema'
import type { Planet } from '../solver/types'

const playerGuid = import.meta.env.VITE_PLAYER_GUID as string
const playerEmail = import.meta.env.VITE_PLAYER_EMAIL as string
const baseUrl = import.meta.env.VITE_API_BASE_URL as string

const AUTH = { PlayerGuid: playerGuid, PlayerEmail: playerEmail } as const

const apiClient = createClient<paths>({ baseUrl })

export function getPlanetsAndRoutes() {
  return apiClient.GET('/GetPlanetsAndRoutes', { params: { header: AUTH } })
}

export function getActiveLevelDailyChallenge() {
  return apiClient.GET('/GetActiveLevelDailyChallenge', { params: { header: AUTH } })
}

export function getDailyChallenge() {
  return apiClient.GET('/GetDailyChallenge', { params: { header: AUTH } })
}

export type OracleResult = components['schemas']['SubmissionResult']

export async function calculateCoaxium(
  challengeId: number,
  route: Planet[],
): Promise<OracleResult | null> {
  const body = route.map((p) => ({ PlanetId: p.id, Name: p.name }))
  const { data, error } = await apiClient.POST('/CalculateCoaxium', {
    params: {
      header: AUTH,
      query: { ChallengeId: challengeId },
    },
    body,
  })
  if (error || !data) return null
  return data
}

export async function submitChallengeSolution(
  challengeId: number,
  route: Planet[],
): Promise<OracleResult | null> {
  const body = route.map((p) => ({ PlanetId: p.id, Name: p.name }))
  const { data, error } = await apiClient.POST('/SubmitChallengeSolution', {
    params: {
      header: AUTH,
      query: { ChallengeId: challengeId },
    },
    body,
  })
  if (error || !data) return null
  return data
}
