import type { SolveInput, SolveResult } from './types.js'
import { heldKarpSolve } from './heldKarpSolve.js'
import { trySolveSmallMandatoryOnly } from './mandatoryOnlySolve.js'

const SMALL_MANDATORY_ONLY_LIMIT = 3

export function solve(input: SolveInput): SolveResult {
  const mandatoryCount =
    new Set(input.mandatoryIds.filter(id => id !== input.startPlanetId)).size

  const isSmallMandatoryOnly =
    mandatoryCount <= SMALL_MANDATORY_ONLY_LIMIT &&
    input.bonuses.length === 0

  if (isSmallMandatoryOnly) {
    const mandatoryOnlyResult = trySolveSmallMandatoryOnly(input)

    if (mandatoryOnlyResult !== null) {
      //console.log('mandatory-only fast path used')
      return mandatoryOnlyResult
    }
  }

  //console.log('falling back to heldKarpSolve')
  return heldKarpSolve(input)
}