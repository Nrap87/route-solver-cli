import type { Bonus, Planet, Route, SolveInput } from "./solver/types.js";

export function pick(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (key in obj) return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

export function toInt(v: unknown, defaultVal = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : defaultVal;
  }
  return defaultVal;
}

export function toFloat(v: unknown, defaultVal = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : defaultVal;
  }
  return defaultVal;
}

export function stripBomFromKeys(raw: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const k2 = k.charCodeAt(0) === 0xfeff ? k.slice(1) : k;
    if (k2 !== k) changed = true;
    out[k2] = v;
  }
  return changed ? out : raw;
}

function normalizePlanetRaw(raw: Record<string, unknown>): Planet {
  return {
    id: toInt(pick(raw, "id", "Id")),
    name: String(pick(raw, "name", "Name") ?? ""),
    x: toFloat(pick(raw, "x", "X", "coordinateX", "CoordinateX", "Coordinate_X")),
    y: toFloat(pick(raw, "y", "Y", "coordinateY", "CoordinateY", "Coordinate_Y")),
  };
}

function routeTypeToSolver(rt: string): "main" | "other" {
  const s = rt.trim().toLowerCase();
  if (s === "main route" || s === "main") return "main";
  return "other";
}

function normalizeRouteRaw(raw: Record<string, unknown>): { from: number; to: number; type: "main" | "other" } {
  const from = toInt(pick(raw, "from_planet", "fromPlanet", "FromPlanet", "From_Planet", "from"));
  const to = toInt(pick(raw, "to_planet_id", "toPlanetId", "ToPlanetId", "To_PlanetId", "to"));
  const routeType = String(pick(raw, "route_type", "routeType", "RouteType", "type") ?? "");
  return { from, to, type: routeTypeToSolver(routeType) };
}

/** `GetPlanetsAndRoutes` root or same shape as local `data.json`. */
export function mapBlobToPlanetsRoutes(root: Record<string, unknown>): { planets: Planet[]; routes: Route[] } {
  const planetsRaw = (pick(root, "Planets", "planets") as unknown[]) ?? [];
  const routesRaw = (pick(root, "Routes", "routes") as unknown[]) ?? [];
  const planets = planetsRaw.map((p) => normalizePlanetRaw(stripBomFromKeys(p as Record<string, unknown>)));
  const routes = routesRaw.map((r) => normalizeRouteRaw(stripBomFromKeys(r as Record<string, unknown>)));
  planets.sort((a, b) => a.id - b.id);
  return { planets, routes };
}

export interface ChallengeFields {
  startPlanetId: number;
  mandatoryPlanetIds: number[];
  forbiddenPlanetIds: number[];
  bonusStops: Bonus[];
  title?: string;
  challengeId?: number;
  /** From API when present; otherwise CLI assigns order in sorted batch (1, 2, 3). */
  level?: number;
}

export function recordToChallenge(obj: Record<string, unknown>): ChallengeFields {
  const o = stripBomFromKeys(obj);
  const start = toInt(pick(o, "startPlanetId", "StartPlanetId", "start_planet_id", "Start_PlanetId"));
  let mandatoryIds = pick(o, "mandatoryPlanetIds", "MandatoryPlanetIds");
  let forbiddenIds = pick(o, "forbiddenPlanetIds", "ForbiddenPlanetIds");
  let bonusStops = pick(o, "bonusStops", "BonusStops");

  /** Empty id arrays often accompany API-style `MandatoryPlanets` / `ForbiddenPlanets` lists — treat as missing. */
  if (Array.isArray(mandatoryIds) && mandatoryIds.length === 0) {
    mandatoryIds = undefined;
  }
  if (Array.isArray(forbiddenIds) && forbiddenIds.length === 0) {
    forbiddenIds = undefined;
  }

  if (mandatoryIds == null) {
    const mandatoryPlanets = (pick(o, "mandatoryPlanets", "MandatoryPlanets") as unknown[]) ?? [];
    mandatoryIds = mandatoryPlanets.map((p) =>
      toInt(pick(p as Record<string, unknown>, "planetId", "PlanetId"))
    );
  }
  if (forbiddenIds == null) {
    const forbiddenPlanets = (pick(o, "forbiddenPlanets", "ForbiddenPlanets") as unknown[]) ?? [];
    forbiddenIds = forbiddenPlanets.map((p) =>
      toInt(pick(p as Record<string, unknown>, "planetId", "PlanetId"))
    );
  }

  function mapBonusRows(rows: unknown[]): Bonus[] {
    return rows.map((b) => {
      const x = b as Record<string, unknown>;
      return {
        planetId: toInt(pick(x, "planetId", "PlanetId", "planet_id", "Planet_Id")),
        value: toFloat(pick(x, "value", "Value", "bonus", "Bonus")),
      };
    });
  }

  const bonusPlanetsRaw = pick(o, "bonusPlanets", "BonusPlanets");
  const planetsArr = Array.isArray(bonusPlanetsRaw) ? bonusPlanetsRaw : [];
  const stopsArr = Array.isArray(bonusStops) ? (bonusStops as unknown[]) : null;

  /** Prefer non-empty `BonusStops`; if the API sends `BonusStops: []` but fills `BonusPlanets`, use that (list payloads differ from saved JSON). */
  let bonusList: Bonus[];
  if (stopsArr && stopsArr.length > 0) {
    bonusList = mapBonusRows(stopsArr);
  } else if (planetsArr.length > 0) {
    bonusList = mapBonusRows(planetsArr);
  } else if (stopsArr) {
    bonusList = mapBonusRows(stopsArr);
  } else {
    bonusList = [];
  }

  const cidRaw = pick(o, "challengeId", "ChallengeId");
  let challengeId: number | undefined;
  if (cidRaw != null && String(cidRaw).trim() !== "") {
    const n = typeof cidRaw === "number" ? cidRaw : parseInt(String(cidRaw), 10);
    if (Number.isFinite(n)) challengeId = Math.trunc(n);
  }

  const titleRaw = pick(o, "title", "Title", "challengeName", "ChallengeName");
  const title =
    titleRaw != null && String(titleRaw).trim() !== "" ? String(titleRaw).trim() : undefined;

  const levRaw = pick(o, "level", "Level", "challengeLevel", "ChallengeLevel");
  let level: number | undefined;
  if (levRaw != null && String(levRaw).trim() !== "") {
    const n = typeof levRaw === "number" ? levRaw : parseInt(String(levRaw), 10);
    if (Number.isFinite(n) && n > 0) level = Math.trunc(n);
  }

  return {
    startPlanetId: start,
    mandatoryPlanetIds: ((mandatoryIds as number[]) ?? []).map((v) => toInt(v)),
    forbiddenPlanetIds: ((forbiddenIds as number[]) ?? []).map((v) => toInt(v)),
    bonusStops: bonusList,
    ...(challengeId !== undefined ? { challengeId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(level !== undefined ? { level } : {}),
  };
}

export function challengeToSolveInput(planets: Planet[], routes: Route[], ch: ChallengeFields): SolveInput {
  return {
    planets,
    routes,
    startPlanetId: ch.startPlanetId,
    mandatoryIds: ch.mandatoryPlanetIds,
    forbiddenIds: ch.forbiddenPlanetIds,
    bonuses: ch.bonusStops,
  };
}
