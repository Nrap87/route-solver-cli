import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  apiCalculateCoaxium,
  apiConnection,
  apiSubmitChallengeSolution,
  fetchGetActiveLevelDailyChallenge,
  fetchGetDailyChallengeList,
  fetchGetPlanetsAndRoutesRoot,
  warmupApiDispatcher,
} from "./api.js";
import type { ApiHeaders } from "./api.js";
import {
  challengeToSolveInput,
  mapBlobToPlanetsRoutes,
  pick,
  recordToChallenge,
} from "./adapt.js";
import type { ChallengeFields } from "./adapt.js";
import type { Planet } from "./solver/types.js";
import { solve } from "./solver/solve.js";
import { entriesFromChallengeDocument } from "./challengeDocument.js";

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

function parseJsonRoot(text: string): unknown {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(t) as unknown;
}

function planetLabel(p: Planet): string {
  const n = p.name?.trim();
  return n ? `${n} (${p.id})` : `#${p.id}`;
}

function printUsage(): void {
  console.error(
    "Usage:\n" +
      "  Local:   node dist/cli.js --map data.json --challenge mission.json [...]\n" +
      "  API map: node dist/cli.js --api-map --challenge mission.json\n" +
      "  API all: node dist/cli.js --daily-api  (API map + GetDailyChallenge)\n" +
      "  Hybrid:  node dist/cli.js --map data.json --daily-api  (local map + GetDailyChallenge)\n" +
      "  Status:  node dist/cli.js --active-level-daily  (GET GetActiveLevelDailyChallenge, JSON to stdout)\n" +
      "  POST:    add --calculate-coaxium (oracle) or --submit (persist); not both.\n" +
      "\n" +
      "Cache flags:\n" +
      "  --no-cache        Disable local GetDailyChallenge cache.\n" +
      "  --refresh-cache   Force refresh of local GetDailyChallenge cache.\n" +
      "\n" +
      "Env: STAR_DELIVERY_BASE_URL or VITE_API_BASE_URL, PLAYER_GUID, PLAYER_EMAIL"
  );
}

interface ParsedFlags {
  baseUrl: string;
  playerGuid: string;
  playerEmail: string;
  mapPath: string;
  useApiMap: boolean;
  dailyApi: boolean;
  /** GET GetActiveLevelDailyChallenge only; print JSON and exit. */
  activeLevelDaily: boolean;
  submit: boolean;
  calculateCoaxium: boolean;
  noCache: boolean;
  refreshCache: boolean;
  challengePaths: string[];
}

function parseArgv(argv: string[]): ParsedFlags {
  let baseUrl = "";
  let playerGuid = "";
  let playerEmail = "";
  let mapPath = "";
  let useApiMap = false;
  let dailyApi = false;
  let activeLevelDaily = false;
  let submit = false;
  let calculateCoaxium = false;
  let noCache = false;
  let refreshCache = false;
  const challengePaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;

    if (a === "--api-map") useApiMap = true;
    else if (a === "--daily-api") dailyApi = true;
    else if (a === "--active-level-daily") activeLevelDaily = true;
    else if (a === "--submit") submit = true;
    else if (a === "--calculate-coaxium") calculateCoaxium = true;
    else if (a === "--no-cache") noCache = true;
    else if (a === "--refresh-cache") refreshCache = true;
    else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i]!;
    else if (a.startsWith("--base-url=")) baseUrl = a.slice("--base-url=".length);
    else if (a === "--player-guid" && argv[i + 1]) playerGuid = argv[++i]!;
    else if (a.startsWith("--player-guid=")) playerGuid = a.slice("--player-guid=".length);
    else if (a === "--player-email" && argv[i + 1]) playerEmail = argv[++i]!;
    else if (a.startsWith("--player-email=")) playerEmail = a.slice("--player-email=".length);
    else if (a === "--map" && argv[i + 1]) mapPath = argv[++i]!;
    else if (a === "--challenge" && argv[i + 1]) challengePaths.push(resolvePath(argv[++i]!));
    else if (!a.startsWith("-")) {
      if (!mapPath) mapPath = resolvePath(a);
      else challengePaths.push(resolvePath(a));
    }
  }

  return {
    baseUrl,
    playerGuid,
    playerEmail,
    mapPath,
    useApiMap,
    dailyApi,
    activeLevelDaily,
    submit,
    calculateCoaxium,
    noCache,
    refreshCache,
    challengePaths,
  };
}

function sortChallengeRows(entries: Record<string, unknown>[]): ChallengeFields[] {
  const rows = entries
    .filter((e) => e && typeof e === "object" && !Array.isArray(e))
    .map((raw) => recordToChallenge(raw));

  rows.sort((a, b) => (a.challengeId ?? 0) - (b.challengeId ?? 0));
  return rows;
}

async function loadMapFromLocal(mapPath: string): Promise<ReturnType<typeof mapBlobToPlanetsRoutes>> {
  const text = await readFile(mapPath, "utf8");
  const root = parseJsonRoot(text) as Record<string, unknown>;

  if (pick(root, "Planets", "planets") == null && pick(root, "Routes", "routes") == null) {
    throw new Error("Map file must contain Planets/planets and Routes/routes.");
  }

  return mapBlobToPlanetsRoutes(root);
}

function formatElapsedSeconds(startMs: number, endMs: number): string {
  return ((endMs - startMs) / 1000).toFixed(3);
}

function sanitizeCachePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140);
}

function dailyChallengeCachePath(baseUrl: string, headers: ApiHeaders): string {
  const today = new Date().toISOString().slice(0, 10);

  let basePart = "default-base";
  try {
    const u = new URL(baseUrl);
    basePart = `${u.host}${u.pathname}`;
  } catch {
    basePart = baseUrl;
  }

  const safeBase = sanitizeCachePart(basePart);
  const safeGuid = sanitizeCachePart(headers.PlayerGuid);

  return join(process.cwd(), ".cache", `GetDailyChallenge-${today}-${safeBase}-${safeGuid}.json`);
}

async function fetchDailyChallengeListMaybeCached(
  baseUrl: string,
  headers: ApiHeaders,
  opts: { noCache: boolean; refreshCache: boolean }
): Promise<unknown[]> {
  if (opts.noCache) {
    return fetchGetDailyChallengeList(baseUrl, headers);
  }

  const cachePath = dailyChallengeCachePath(baseUrl, headers);

  if (!opts.refreshCache) {
    try {
      const text = await readFile(cachePath, "utf8");
      const parsed = JSON.parse(text) as unknown;

      if (Array.isArray(parsed)) {
        console.log(`  [cache] GetDailyChallenge hit ${cachePath}`);
        return parsed;
      }

      console.log(`  [cache] GetDailyChallenge ignored invalid cache shape ${cachePath}`);
    } catch {
      // Cache miss.
    }
  }

  const list = await fetchGetDailyChallengeList(baseUrl, headers);

  await mkdir(join(process.cwd(), ".cache"), { recursive: true });
  await writeFile(cachePath, JSON.stringify(list, null, 2), "utf8");

  console.log(`  [cache] GetDailyChallenge saved ${cachePath}`);

  return list;
}

async function runBatch(args: {
  challenges: ChallengeFields[];
  planetsAndRoutes: ReturnType<typeof mapBlobToPlanetsRoutes>;
  api: { baseUrl: string; headers: ApiHeaders } | null;
  submit: boolean;
  calculateCoaxium: boolean;
  printFooter: boolean;
}): Promise<void> {
  const { challenges, planetsAndRoutes, api, submit, calculateCoaxium, printFooter } = args;
  const sorted = [...challenges].sort((a, b) => (a.challengeId ?? 0) - (b.challengeId ?? 0));
  const planetsById = new Map(planetsAndRoutes.planets.map((p) => [p.id, p]));

  let rank = 0;

  for (const ch of sorted) {
    rank += 1;

    const level = ch.level ?? rank;
    const cid = ch.challengeId;
    const title = ch.title?.trim();
    const idPart = cid !== undefined ? String(cid) : String(rank);
    const titleBit = title ? ` ${JSON.stringify(title)}` : "";

    const challengeStartMs = Date.now();

    console.log(`  [challenge] start ${new Date(challengeStartMs).toISOString()}`);

    const logChallengeComplete = () => {
      const endMs = Date.now();
      console.log(`  [challenge] end ${new Date(endMs).toISOString()}`);
      console.log(`  [challenge] elapsed ${formatElapsedSeconds(challengeStartMs, endMs)}s`);
    };

    console.log(`Solving [#${idPart} Level ${level}]${titleBit}...`);

    const input = challengeToSolveInput(planetsAndRoutes.planets, planetsAndRoutes.routes, ch);

    const t0 = performance.now();
    const result = solve(input);
    const ms = performance.now() - t0;

    if (!result.success) {
      console.log(`  → ERROR: ${result.errorMessage ?? "unknown"} (${ms.toFixed(0)}ms)`);
      logChallengeComplete();
      console.log("");
      continue;
    }

    console.log(`  → effectiveFuel=${result.effectiveFuel} (${ms.toFixed(0)}ms)`);
    console.log(`  Gross fuel     : ${result.grossFuel}`);
    console.log(`  Bonus collected: ${result.collectedBonus}`);

    const routeStr = result.orderedRoute.map(planetLabel).join(" → ");
    console.log(`  Route (${result.orderedRoute.length} planets): ${routeStr}`);

    const needPost = submit || calculateCoaxium;

    if (needPost) {
      if (!api) throw new Error("Internal error: POST requested without API connection.");

      if (cid === undefined) {
        console.log("  → skipped API: challenge has no ChallengeId in payload.");
        logChallengeComplete();
        console.log("");
        continue;
      }

      const routeIds = result.orderedRoute.map((p) => p.id);

      try {
        console.log("  Testing submission endpoint...");

        if (submit) {
          const { httpStatus, rawBody } = await apiSubmitChallengeSolution(
            api.baseUrl,
            api.headers,
            cid,
            routeIds,
            planetsById
          );

          console.log(`  → HTTP ${httpStatus}: ${rawBody}`);
        } else {
          const { httpStatus, rawBody } = await apiCalculateCoaxium(
            api.baseUrl,
            api.headers,
            cid,
            routeIds,
            planetsById
          );

          console.log(`  → HTTP ${httpStatus}: ${rawBody}`);
        }
      } catch (e) {
        console.log(`  → API error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    logChallengeComplete();
    console.log("");
  }

  if (printFooter && calculateCoaxium) {
    console.log("Dry run complete — test submissions fired, no retry logic applied.");
  } else if (printFooter && submit) {
    console.log("Submit pass complete — SubmitChallengeSolution called per challenge; no automatic retry.");
  }
}

async function main(): Promise<number> {
  const f = parseArgv(process.argv.slice(2));

  if (f.submit && f.calculateCoaxium) {
    console.error("Use only one of --submit or --calculate-coaxium.");
    return 1;
  }

  if (f.activeLevelDaily && (f.submit || f.calculateCoaxium)) {
    console.error("--active-level-daily cannot be combined with --submit or --calculate-coaxium.");
    return 1;
  }

  if (f.activeLevelDaily && f.challengePaths.length > 0) {
    console.error("Do not pass --challenge with --active-level-daily.");
    return 1;
  }

  if (f.activeLevelDaily && f.dailyApi) {
    console.error("Use only one of --daily-api or --active-level-daily.");
    return 1;
  }

  if (f.noCache && f.refreshCache) {
    console.error("Use only one of --no-cache or --refresh-cache.");
    return 1;
  }

  if (f.activeLevelDaily) {
    const apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const raw = await fetchGetActiveLevelDailyChallenge(apiConn.baseUrl, apiConn.headers);
    console.log(JSON.stringify(raw, null, 2));
    return 0;
  }

  if (f.dailyApi && f.challengePaths.length > 0) {
    console.error("Do not pass --challenge with --daily-api.");
    return 1;
  }

  if (f.mapPath && f.useApiMap) {
    console.error("Use only one of --map or --api-map.");
    return 1;
  }

  if ((f.submit || f.calculateCoaxium) && f.dailyApi === false && f.useApiMap === false && f.challengePaths.length === 0) {
    console.error("--submit / --calculate-coaxium require --daily-api, or --map/--api-map with --challenge.");
    return 1;
  }

  let planetsAndRoutes: ReturnType<typeof mapBlobToPlanetsRoutes>;
  let apiConn: { baseUrl: string; headers: ApiHeaders } | null = null;
  let dailyChallengeList: unknown[] | null = null;

  /**
   * Main loading strategy:
   *
   * 1. If --daily-api + --map:
   *    - Load local map and GetDailyChallenge in parallel.
   *
   * 2. If --daily-api without --map:
   *    - Fetch GetPlanetsAndRoutes and GetDailyChallenge in parallel.
   *
   * 3. If --api-map only:
   *    - Fetch map from API.
   *
   * 4. Otherwise:
   *    - Load local map.
   */
  if (f.dailyApi && f.mapPath) {
    apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const [localMap, list] = await Promise.all([
      loadMapFromLocal(f.mapPath),
      fetchDailyChallengeListMaybeCached(apiConn.baseUrl, apiConn.headers, {
        noCache: f.noCache,
        refreshCache: f.refreshCache,
      }),
    ]);

    planetsAndRoutes = localMap;
    dailyChallengeList = list;
  } else if (f.dailyApi) {
    apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const [mapRoot, list] = await Promise.all([
      fetchGetPlanetsAndRoutesRoot(apiConn.baseUrl, apiConn.headers),
      fetchDailyChallengeListMaybeCached(apiConn.baseUrl, apiConn.headers, {
        noCache: f.noCache,
        refreshCache: f.refreshCache,
      }),
    ]);

    planetsAndRoutes = mapBlobToPlanetsRoutes(mapRoot);
    dailyChallengeList = list;
  } else if (f.useApiMap) {
    apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const root = await fetchGetPlanetsAndRoutesRoot(apiConn.baseUrl, apiConn.headers);
    planetsAndRoutes = mapBlobToPlanetsRoutes(root);
  } else {
    if (!f.mapPath) {
      printUsage();
      return 1;
    }

    planetsAndRoutes = await loadMapFromLocal(f.mapPath);
  }

  const postFlags = f.submit || f.calculateCoaxium;

  if (postFlags && !apiConn) {
    apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();
  }

  if (f.dailyApi) {
    const list =
      dailyChallengeList ??
      (await fetchDailyChallengeListMaybeCached(apiConn!.baseUrl, apiConn!.headers, {
        noCache: f.noCache,
        refreshCache: f.refreshCache,
      }));

    const entries: Record<string, unknown>[] = [];

    for (const raw of list) {
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
      entries.push(raw as Record<string, unknown>);
    }

    const challenges = sortChallengeRows(entries);

    if (challenges.length === 0) {
      console.error("GetDailyChallenge returned no challenge rows.");
      return 1;
    }

    await runBatch({
      challenges,
      planetsAndRoutes,
      api: postFlags ? apiConn : null,
      submit: f.submit,
      calculateCoaxium: f.calculateCoaxium,
      printFooter: postFlags,
    });
  }

  if (f.challengePaths.length === 0 && !f.dailyApi) {
    console.error("Provide at least one --challenge file (or use --daily-api).");
    return 1;
  }

  for (let fi = 0; fi < f.challengePaths.length; fi++) {
    const cp = f.challengePaths[fi]!;
    const text = await readFile(cp, "utf8");
    const root = parseJsonRoot(text);
    const entries = entriesFromChallengeDocument(root);
    const challenges = sortChallengeRows(entries);

    if (challenges.length === 0) continue;

    const isLastFile = fi === f.challengePaths.length - 1;

    await runBatch({
      challenges,
      planetsAndRoutes,
      api: postFlags ? apiConn : null,
      submit: f.submit,
      calculateCoaxium: f.calculateCoaxium,
      printFooter: postFlags && isLastFile,
    });
  }

  return 0;
}

const cliRunStartMs = Date.now();

console.log(`[cli] start ${new Date(cliRunStartMs).toISOString()}`);

main()
  .then((code) => {
    const endMs = Date.now();
    console.log(`[cli] end ${new Date(endMs).toISOString()}`);
    console.log(`[cli] elapsed ${formatElapsedSeconds(cliRunStartMs, endMs)}s`);
    process.exit(code);
  })
  .catch((e) => {
    console.error(e);
    const endMs = Date.now();
    console.log(`[cli] end ${new Date(endMs).toISOString()}`);
    console.log(`[cli] elapsed ${formatElapsedSeconds(cliRunStartMs, endMs)}s`);
    process.exit(1);
  });