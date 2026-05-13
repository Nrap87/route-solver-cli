import { pick } from "./adapt.js";

/** Known wrapper keys for a list of challenge rows (API / export / hand-authored JSON). */
const ARRAY_WRAP_KEYS = ["items", "challenges", "Challenges", "data", "Data"] as const;

function isRecordRow(x: unknown): x is Record<string, unknown> {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function looksLikeChallengeRow(o: Record<string, unknown>): boolean {
  return (
    pick(o, "challengeId", "ChallengeId") != null ||
    pick(o, "startPlanetId", "StartPlanetId") != null ||
    pick(o, "MandatoryPlanets", "mandatoryPlanets") != null ||
    pick(o, "MandatoryPlanetIds", "mandatoryPlanetIds") != null
  );
}

/**
 * Normalize various on-disk / API challenge list JSON shapes into raw row objects
 * for {@link import("./adapt.js").recordToChallenge}.
 *
 * Supports:
 * - Top-level array of challenge objects (e.g. GetDailyChallenge-style list exports)
 * - `{ "items": [...] }`, `{ "challenges": [...] }`, `{ "Challenges": [...] }`, `{ "data": [...] }`
 * - A single challenge object as the document root
 */
export function entriesFromChallengeDocument(doc: unknown): Record<string, unknown>[] {
  if (doc == null) return [];
  if (Array.isArray(doc)) {
    return doc.filter(isRecordRow);
  }
  if (typeof doc !== "object") return [];
  const o = doc as Record<string, unknown>;
  for (const k of ARRAY_WRAP_KEYS) {
    const arr = o[k];
    if (Array.isArray(arr)) {
      return arr.filter(isRecordRow);
    }
  }
  if (looksLikeChallengeRow(o)) {
    return [o];
  }
  return [];
}
