import type { SolveInput, SolveResult } from './types.js'
import { heldKarpSolve } from './heldKarpSolve.js'

export function solve(input: SolveInput): SolveResult {
  return heldKarpSolve(input)
}
