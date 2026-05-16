import { useState, useEffect, useCallback } from 'react'
import { getActiveLevelDailyChallenge, getDailyChallenge } from '../api/client'
import type { components } from '../api/schema'

export type ChallengeOut = components['schemas']['ChallengeOut']

export function useChallenges() {
  const [data, setData] = useState<ChallengeOut[] | null>(null)
  const [rawAll, setRawAll] = useState<unknown>(null)
  const [rawActive, setRawActive] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)

    const run = async () => {
      try {
        const [allRes, activeRes] = await Promise.all([
          getDailyChallenge(),
          getActiveLevelDailyChallenge(),
        ])
        if (cancelled) return

        if (allRes.error || !allRes.data) { setError('Failed to load challenges'); return }
        setData(allRes.data)
        setRawAll(allRes.data)
        setRawActive(activeRes.data ?? null)
      } catch {
        if (!cancelled) setError('Failed to load challenges')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => { cancelled = true }
  }, [retryCount])

  const retry = useCallback(() => setRetryCount((c) => c + 1), [])

  return { data, rawAll, rawActive, loading, error, retry }
}
