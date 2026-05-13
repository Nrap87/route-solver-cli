import { solve } from './solve'
import type { SolveInput } from './types'

self.onmessage = (e: MessageEvent<SolveInput>) => {
  try {
    const result = solve(e.data)
    self.postMessage({ ok: true, result })
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
