/** Bundled JSON from `route-solver-cli/challenges/*.json` (Vite glob). */

function globBasename(key: string): string {
  const n = key.replace(/\\/g, "/").replace(/^.*\//, "");
  return n || key;
}

const bundled = import.meta.glob("../../challenges/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

const BASENAMES = Object.keys(bundled)
  .map(globBasename)
  .filter((n) => n.endsWith(".json"))
  .sort((a, b) => a.localeCompare(b));

/** Default bundled challenge set for the web UI. */
export const DEFAULT_CHALLENGE_FILE = "challenges_1405.json";

/** e.g. challenges_1405.json, challenges_0805.json */
const CHALLENGE_DATE_FILE_RE = /^challenges_\d{4}\.json$/i;

export function isDateStampedChallengeFile(basename: string): boolean {
  return CHALLENGE_DATE_FILE_RE.test(basename);
}

export function listBundledChallengeFilenames(): string[] {
  return BASENAMES.filter(isDateStampedChallengeFile);
}

export function getBundledChallengeJson(basename: string): unknown {
  const key = Object.keys(bundled).find((k) => globBasename(k) === basename);
  if (key === undefined) throw new Error(`Unknown challenge file: ${basename}`);
  return bundled[key];
}

export { entriesFromChallengeDocument } from "@cli/challengeDocument";
