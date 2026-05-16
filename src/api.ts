import { Agent, type Dispatcher } from "undici";
import { pick } from "./adapt.js";
import type { Planet } from "./solver/types.js";

const DEFAULT_BASE = "https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices";

/**
 * Star Delivery REST paths.
 * All calls send ApiHeaders: PlayerGuid, PlayerEmail, Accept.
 */
export const StarDeliveryApiPaths = {
  getPlanetsAndRoutes: "GetPlanetsAndRoutes",
  getDailyChallenge: "GetDailyChallenge",
  getActiveLevelDailyChallenge: "GetActiveLevelDailyChallenge",
  calculateCoaxium: "CalculateCoaxium",
  submitChallengeSolution: "SubmitChallengeSolution",
} as const;

export interface ApiHeaders {
  Accept: string;
  PlayerGuid: string;
  PlayerEmail: string;
}

export interface SubmissionResult {
  is_success: boolean;
  feedback_message: string;
  coaxium: number;
  time_elapsed_in_seconds: number | null;
  time_elapsed: number | null;
}

export interface PostJsonResult {
  httpStatus: number;
  rawBody: string;
  parsed: SubmissionResult;
}

export function apiConnection(opts: { baseUrl: string; playerGuid: string; playerEmail: string }): {
  baseUrl: string;
  headers: ApiHeaders;
} {
  const baseUrl = (
    opts.baseUrl ||
    process.env.STAR_DELIVERY_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    DEFAULT_BASE
  ).replace(/\/+$/, "");

  const playerGuid = opts.playerGuid || process.env.PLAYER_GUID || "";
  const playerEmail = opts.playerEmail || process.env.PLAYER_EMAIL || "";

  if (!playerGuid || !playerEmail) {
    throw new Error("API requires PlayerGuid and PlayerEmail (--player-guid / --player-email or env vars).");
  }

  return {
    baseUrl,
    headers: {
      Accept: "application/json",
      PlayerGuid: playerGuid,
      PlayerEmail: playerEmail,
    },
  };
}

let pooledStarDeliveryDispatcher: Dispatcher | undefined;

function runningOnNode(): boolean {
  return typeof globalThis.process !== "undefined" && globalThis.process.versions?.node != null;
}

function starDeliveryFetchDispatcher(): Dispatcher | undefined {
  if (!runningOnNode()) return undefined;

  if (!pooledStarDeliveryDispatcher) {
    pooledStarDeliveryDispatcher = new Agent({
      connections: 16,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  }

  return pooledStarDeliveryDispatcher;
}

/**
 * Creates/reuses the local undici Agent.
 *
 * Important:
 * This does NOT open a network/TLS connection by itself.
 */
export function warmupApiDispatcher(): void {
  starDeliveryFetchDispatcher();
}

/**
 * Performs a real lightweight API request before the timing-critical request.
 *
 * This can open DNS/TCP/TLS/HTTP connection state inside the current Node process.
 * The connection can then be reused by the later GetDailyChallenge request.
 */
export async function prewarmApiConnection(baseUrl: string, headers: ApiHeaders): Promise<void> {
  try {
    await fetchJsonGet(baseUrl, StarDeliveryApiPaths.getActiveLevelDailyChallenge, headers);
  } catch {
    // Ignore warmup errors. The real request can still run and report its own error.
  }
}

async function withApiTiming<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`  [api] ${operation} ${(performance.now() - t0).toFixed(0)}ms`);
  }
}

function pickBool(o: Record<string, unknown>, ...keys: string[]): boolean {
  const v = pick(o, ...keys);

  if (v === true) return true;
  if (v === false) return false;

  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }

  return false;
}

function normalizeSubmissionResult(raw: unknown): SubmissionResult {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const coaxRaw = pick(o, "Coaxium", "coaxium");
  let coaxium = 0;

  if (coaxRaw != null) {
    const n = parseFloat(String(coaxRaw));
    if (Number.isFinite(n)) coaxium = Math.trunc(n);
  }

  const teSec = pick(o, "TimeElapsedInSeconds", "timeElapsedInSeconds");
  const te = pick(o, "TimeElapsed", "timeElapsed");

  return {
    is_success: pickBool(o, "IsSuccess", "isSuccess"),
    feedback_message: String(pick(o, "FeedbackMessage", "feedbackMessage") ?? ""),
    coaxium,
    time_elapsed_in_seconds: typeof teSec === "number" && Number.isFinite(teSec) ? teSec : null,
    time_elapsed: typeof te === "number" && Number.isFinite(te) ? te : null,
  };
}

export async function fetchJsonGet(baseUrl: string, path: string, headers: ApiHeaders): Promise<unknown> {
  const url = `${baseUrl}/${path.replace(/^\//, "")}`;

  const t0 = performance.now();
  const dispatcher = starDeliveryFetchDispatcher();
  const t1 = performance.now();

  const init: RequestInit & { dispatcher?: Dispatcher } = {
    method: "GET",
    headers: { ...headers },
    signal: AbortSignal.timeout(120_000),
  };

  if (dispatcher) init.dispatcher = dispatcher;

  const res = await fetch(url, init);
  const t2 = performance.now();

  const text = await res.text();
  const t3 = performance.now();

  if (!res.ok) {
    throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  if (!text.trim()) {
    throw new Error(`${path} returned empty body`);
  }

  const parsed = JSON.parse(text) as unknown;
  const t4 = performance.now();

  console.log(
    `  [api-detail] ${path} ` +
      `dispatcher=${(t1 - t0).toFixed(0)}ms ` +
      `headers=${(t2 - t1).toFixed(0)}ms ` +
      `body=${(t3 - t2).toFixed(0)}ms ` +
      `json=${(t4 - t3).toFixed(0)}ms ` +
      `bytes=${text.length}`
  );

  return parsed;
}

export function parseDailyChallengeListPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  if (
    payload &&
    typeof payload === "object" &&
    "items" in payload &&
    Array.isArray((payload as { items: unknown }).items)
  ) {
    return (payload as { items: unknown[] }).items;
  }

  return [];
}

export async function fetchGetDailyChallengeList(baseUrl: string, headers: ApiHeaders): Promise<unknown[]> {
  return withApiTiming("GetDailyChallenge", async () => {
    const payload = await fetchJsonGet(baseUrl, StarDeliveryApiPaths.getDailyChallenge, headers);
    return parseDailyChallengeListPayload(payload);
  });
}

export async function fetchGetActiveLevelDailyChallenge(baseUrl: string, headers: ApiHeaders): Promise<unknown> {
  return withApiTiming("GetActiveLevelDailyChallenge", () =>
    fetchJsonGet(baseUrl, StarDeliveryApiPaths.getActiveLevelDailyChallenge, headers)
  );
}

export async function fetchGetPlanetsAndRoutesRoot(
  baseUrl: string,
  headers: ApiHeaders
): Promise<Record<string, unknown>> {
  return withApiTiming("GetPlanetsAndRoutes", async () => {
    const mapPayload = await fetchJsonGet(baseUrl, StarDeliveryApiPaths.getPlanetsAndRoutes, headers);

    if (!mapPayload || typeof mapPayload !== "object" || Array.isArray(mapPayload)) {
      throw new Error("GetPlanetsAndRoutes returned an unexpected payload");
    }

    return mapPayload as Record<string, unknown>;
  });
}

export function buildSubmissionRoute(
  fullPath: number[],
  planetsById: Map<number, Planet>
): { PlanetId: number; Name: string }[] {
  return fullPath.map((pid) => ({
    PlanetId: pid,
    Name: planetsById.get(pid)?.name?.trim() || String(pid),
  }));
}

export async function postStarDeliveryJson(
  baseUrl: string,
  relativePathWithQuery: string,
  bodyObj: unknown,
  headers: ApiHeaders
): Promise<PostJsonResult> {
  const url = `${baseUrl}/${relativePathWithQuery.replace(/^\//, "")}`;

  const t0 = performance.now();
  const dispatcher = starDeliveryFetchDispatcher();
  const t1 = performance.now();

  const init: RequestInit & { dispatcher?: Dispatcher } = {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(120_000),
  };

  if (dispatcher) init.dispatcher = dispatcher;

  const res = await fetch(url, init);
  const t2 = performance.now();

  const text = await res.text();
  const t3 = performance.now();

  console.log(
    `  [api-detail] ${relativePathWithQuery.split("?", 1)[0] ?? relativePathWithQuery} ` +
      `dispatcher=${(t1 - t0).toFixed(0)}ms ` +
      `headers=${(t2 - t1).toFixed(0)}ms ` +
      `body=${(t3 - t2).toFixed(0)}ms ` +
      `bytes=${text.length}`
  );

  if (!res.ok) {
    const endpoint = relativePathWithQuery.split("?", 1)[0] ?? relativePathWithQuery;
    throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  if (!text.trim()) {
    return {
      httpStatus: res.status,
      rawBody: "",
      parsed: {
        is_success: false,
        feedback_message: "Empty response body.",
        coaxium: 0,
        time_elapsed_in_seconds: null,
        time_elapsed: null,
      },
    };
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Response is not valid JSON");
  }

  return {
    httpStatus: res.status,
    rawBody: text,
    parsed: normalizeSubmissionResult(parsedJson),
  };
}

export async function apiCalculateCoaxium(
  baseUrl: string,
  headers: ApiHeaders,
  challengeId: number,
  routePlanetIds: number[],
  planetsById: Map<number, Planet>
): Promise<PostJsonResult> {
  const submission = buildSubmissionRoute(routePlanetIds, planetsById);
  const q = new URLSearchParams({ ChallengeId: String(challengeId) }).toString();
  const path = `${StarDeliveryApiPaths.calculateCoaxium}?${q}`;

  return withApiTiming(`CalculateCoaxium (challenge ${challengeId})`, () =>
    postStarDeliveryJson(baseUrl, path, submission, headers)
  );
}

export async function apiSubmitChallengeSolution(
  baseUrl: string,
  headers: ApiHeaders,
  challengeId: number,
  routePlanetIds: number[],
  planetsById: Map<number, Planet>
): Promise<PostJsonResult> {
  const submission = buildSubmissionRoute(routePlanetIds, planetsById);
  const q = new URLSearchParams({ ChallengeId: String(challengeId) }).toString();
  const path = `${StarDeliveryApiPaths.submitChallengeSolution}?${q}`;

  return withApiTiming(`SubmitChallengeSolution (challenge ${challengeId})`, () =>
    postStarDeliveryJson(baseUrl, path, submission, headers)
  );
}
