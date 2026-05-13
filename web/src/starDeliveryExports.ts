import { pick } from "@cli/adapt";
import type { ChallengeFields } from "@cli/adapt";
import type { Planet, Route } from "@cli/solver/types";

export function pickBool(obj: Record<string, unknown>, ...keys: string[]): boolean {
  const v = pick(obj, ...keys);
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return false;
}

export function rawChallengeSortKey(raw: Record<string, unknown>): number {
  const v = pick(raw, "challengeId", "ChallengeId");
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim()) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function buildMapExport(planets: Planet[], routes: Route[]): { planets: unknown[]; routes: unknown[] } {
  return {
    planets: planets.map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y })),
    routes: routes.map((r) => ({
      from_planet: r.from,
      to_planet_id: r.to,
      route_type: r.type === "main" ? "Main Route" : "Other Route",
    })),
  };
}

/** Same shape as `planet-tsp-solver-ts` dashboard `challengeToChallengeJsonShape`. */
export function buildChallengeExportRow(ch: ChallengeFields, raw?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    startPlanetId: ch.startPlanetId,
    mandatoryPlanetIds: ch.mandatoryPlanetIds,
    forbiddenPlanetIds: ch.forbiddenPlanetIds,
    bonusStops: ch.bonusStops.map((b) => ({ planetId: b.planetId, value: b.value })),
  };
  if (ch.challengeId != null) out.challengeId = ch.challengeId;
  if (ch.title?.trim()) out.challengeName = ch.title.trim();
  if (raw != null && pickBool(raw, "IsFinished", "isFinished")) out.isFinished = true;
  return out;
}

export function buildChallengesExport(
  challenges: ChallengeFields[],
  sortedRaw: Record<string, unknown>[],
): Record<string, unknown>[] {
  return challenges.map((ch, i) => buildChallengeExportRow(ch, sortedRaw[i]));
}

export function buildBundleExport(
  planets: Planet[],
  routes: Route[],
  challengesExport: Record<string, unknown>[],
): { exportedAt: string; planets: unknown[]; routes: unknown[]; challenges: Record<string, unknown>[] } {
  const map = buildMapExport(planets, routes);
  return {
    exportedAt: new Date().toISOString(),
    planets: map.planets,
    routes: map.routes,
    challenges: challengesExport,
  };
}

export function downloadJson(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
