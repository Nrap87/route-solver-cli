import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  apiCalculateCoaxium,
  apiConnection,
  apiSubmitChallengeSolution,
  fetchGetActiveLevelDailyChallenge,
  fetchGetDailyChallengeList,
  fetchGetPlanetsAndRoutesRoot,
  prewarmApiConnection,
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
      "  Local:        node dist/cli.js --map data.json --challenge mission.json [...]\n" +
      "  API map:      node dist/cli.js --api-map --challenge mission.json\n" +
      "  API all:      node dist/cli.js --daily-api  (API map + GetDailyChallenge)\n" +
      "  Hybrid:       node dist/cli.js --map data.json --daily-api  (local map + GetDailyChallenge)\n" +
      "  Active daily: node dist/cli.js --map data.json --active-daily-api  (local map + GetActiveLevelDailyChallenge)\n" +
      "  Status:       node dist/cli.js --active-level-daily  (GET GetActiveLevelDailyChallenge, JSON to stdout)\n" +
      "  Timing:       --wait-until-next-minute --prewarm-api  (start early, warm TLS, fetch daily at :00)\n" +
      "  POST:         add --calculate-coaxium (oracle) or --submit (persist); not both.\n" +
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
  activeDailyApi: boolean;
  activeLevelDaily: boolean;
  submit: boolean;
  calculateCoaxium: boolean;
  waitUntilNextMinute: boolean;
  prewarmApi: boolean;
  challengePaths: string[];
}

function parseArgv(argv: string[]): ParsedFlags {
  let baseUrl = "";
  let playerGuid = "";
  let playerEmail = "";
  let mapPath = "";
  let useApiMap = false;
  let dailyApi = false;
  let activeDailyApi = false;
  let activeLevelDaily = false;
  let submit = false;
  let calculateCoaxium = false;
  let waitUntilNextMinute = false;
  let prewarmApi = false;
  const challengePaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;

    if (a === "--api-map") useApiMap = true;
    else if (a === "--daily-api") dailyApi = true;
    else if (a === "--active-daily-api") activeDailyApi = true;
    else if (a === "--active-level-daily") activeLevelDaily = true;
    else if (a === "--submit") submit = true;
    else if (a === "--calculate-coaxium") calculateCoaxium = true;
    else if (a === "--wait-until-next-minute") waitUntilNextMinute = true;
    else if (a === "--prewarm-api") prewarmApi = true;
    else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i]!;
    else if (a.startsWith("--base-url=")) baseUrl = a.slice("--base-url=".length);
    else if (a === "--player-guid" && argv[i + 1]) playerGuid = argv[++i]!;
    else if (a.startsWith("--player-guid=")) playerGuid = a.slice("--player-guid=".length);
    else if (a === "--player-email" && argv[i + 1]) playerEmail = argv[++i]!;
    else if (a.startsWith("--player-email=")) playerEmail = a.slice("--player-email=".length);
    else if (a === "--map" && argv[i + 1]) mapPath = resolvePath(argv[++i]!);
    else if (a.startsWith("--map=")) mapPath = resolvePath(a.slice("--map=".length));
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
    activeDailyApi,
    activeLevelDaily,
    submit,
    calculateCoaxium,
    waitUntilNextMinute,
    prewarmApi,
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

function activeChallengeRecordsFromPayload(payload: unknown): Record<string, unknown>[] {
  const asRecord = (v: unknown): Record<string, unknown> | null => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  };

  if (Array.isArray(payload)) {
    return payload
      .map(asRecord)
      .filter((v): v is Record<string, unknown> => v != null);
  }

  const root = asRecord(payload);
  if (!root) return [];

  const listCandidate = pick(root, "items", "Items", "challenges", "Challenges");

  if (Array.isArray(listCandidate)) {
    return listCandidate
      .map(asRecord)
      .filter((v): v is Record<string, unknown> => v != null);
  }

  const nestedCandidate = pick(
    root,
    "challenge",
    "Challenge",
    "activeChallenge",
    "ActiveChallenge",
    "data",
    "Data"
  );

  const nestedRecord = asRecord(nestedCandidate);

  if (nestedRecord) {
    return [nestedRecord];
  }

  return [root];
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

function msToNextFullMinute(): number {
  const d = new Date();
  const next = new Date(d);
  next.setMinutes(next.getMinutes() + 1, 0, 0);
  return Math.max(1, next.getTime() - d.getTime());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilNextFullMinute(label = "target minute"): Promise<void> {
  const now = new Date();
  const waitMs = msToNextFullMinute();
  const target = new Date(now.getTime() + waitMs);

  console.log(`[wait] waiting ${(waitMs / 1000).toFixed(3)}s until ${label}: ${target.toISOString()}`);

  await sleep(waitMs);

  console.log(`[wait] reached ${label}: ${new Date().toISOString()}`);
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

  if (f.mapPath && f.useApiMap) {
    console.error("Use only one of --map or --api-map.");
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

  if (f.activeLevelDaily && (f.dailyApi || f.activeDailyApi)) {
    console.error("Use only one of --daily-api, --active-daily-api, or --active-level-daily.");
    return 1;
  }

  if (f.dailyApi && f.activeDailyApi) {
    console.error("Use only one of --daily-api or --active-daily-api.");
    return 1;
  }

  if (f.activeDailyApi && f.challengePaths.length > 0) {
    console.error("Do not pass --challenge with --active-daily-api.");
    return 1;
  }

  if (f.waitUntilNextMinute && !f.dailyApi) {
    console.error("--wait-until-next-minute is currently intended for --daily-api runs.");
    return 1;
  }

  if (f.prewarmApi && !f.waitUntilNextMinute) {
    console.error("--prewarm-api should be used together with --wait-until-next-minute.");
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

  if (f.activeDailyApi) {
    const apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const loadStart = performance.now();

    const mapPromise: Promise<ReturnType<typeof mapBlobToPlanetsRoutes>> = f.mapPath
      ? loadMapFromLocal(f.mapPath)
      : fetchGetPlanetsAndRoutesRoot(apiConn.baseUrl, apiConn.headers).then((root) =>
          mapBlobToPlanetsRoutes(root)
        );

    const [planetsAndRoutes, activeRaw] = await Promise.all([
      mapPromise,
      fetchGetActiveLevelDailyChallenge(apiConn.baseUrl, apiConn.headers),
    ]);

    console.log(`[load] map + GetActiveLevelDailyChallenge ${(performance.now() - loadStart).toFixed(0)}ms`);

    const activeRecords = activeChallengeRecordsFromPayload(activeRaw);
    const challenges = sortChallengeRows(activeRecords);

    if (challenges.length === 0) {
      console.error("GetActiveLevelDailyChallenge returned no usable challenge row.");
      console.error(JSON.stringify(activeRaw, null, 2));
      return 1;
    }

    await runBatch({
      challenges,
      planetsAndRoutes,
      api: f.submit || f.calculateCoaxium ? apiConn : null,
      submit: f.submit,
      calculateCoaxium: f.calculateCoaxium,
      printFooter: f.submit || f.calculateCoaxium,
    });

    return 0;
  }

  if (f.dailyApi && f.challengePaths.length > 0) {
    console.error("Do not pass --challenge with --daily-api.");
    return 1;
  }

  if ((f.submit || f.calculateCoaxium) && f.dailyApi === false && f.useApiMap === false && f.challengePaths.length === 0) {
    console.error("--submit / --calculate-coaxium require --daily-api, --active-daily-api, or --map/--api-map with --challenge.");
    return 1;
  }

  let planetsAndRoutes: ReturnType<typeof mapBlobToPlanetsRoutes>;
  let apiConn: { baseUrl: string; headers: ApiHeaders } | null = null;
  let dailyChallengeList: unknown[] | null = null;

  if (f.dailyApi && f.mapPath) {
    apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const loadStart = performance.now();

    if (f.waitUntilNextMinute) {
      console.log("[timing] early-start mode enabled for --daily-api + --map");

      const localMapPromise = loadMapFromLocal(f.mapPath);

      if (f.prewarmApi) {
        const prewarmStart = performance.now();
        console.log("[timing] prewarming API connection before target minute...");
        await prewarmApiConnection(apiConn.baseUrl, apiConn.headers);
        console.log(`[timing] API prewarm complete ${(performance.now() - prewarmStart).toFixed(0)}ms`);
      }

      planetsAndRoutes = await localMapPromise;

      console.log(`[load] local map preloaded ${(performance.now() - loadStart).toFixed(0)}ms`);

      await waitUntilNextFullMinute("daily fetch boundary");

      const dailyStart = performance.now();
      dailyChallengeList = await fetchGetDailyChallengeList(apiConn.baseUrl, apiConn.headers);
      console.log(`[load] GetDailyChallenge after boundary ${(performance.now() - dailyStart).toFixed(0)}ms`);
    } else {
      const [localMap, list] = await Promise.all([
        loadMapFromLocal(f.mapPath),
        fetchGetDailyChallengeList(apiConn.baseUrl, apiConn.headers),
      ]);

      planetsAndRoutes = localMap;
      dailyChallengeList = list;

      console.log(`[load] local map + GetDailyChallenge ${(performance.now() - loadStart).toFixed(0)}ms`);
    }
  } else if (f.dailyApi) {
    apiConn = apiConnection({
      baseUrl: f.baseUrl,
      playerGuid: f.playerGuid,
      playerEmail: f.playerEmail,
    });

    warmupApiDispatcher();

    const loadStart = performance.now();

    if (f.waitUntilNextMinute) {
      console.log("[timing] early-start mode enabled for --daily-api + API map");

      const mapPromise = fetchGetPlanetsAndRoutesRoot(apiConn.baseUrl, apiConn.headers);

      if (f.prewarmApi) {
        const prewarmStart = performance.now();
        console.log("[timing] prewarming API connection before target minute...");
        await prewarmApiConnection(apiConn.baseUrl, apiConn.headers);
        console.log(`[timing] API prewarm complete ${(performance.now() - prewarmStart).toFixed(0)}ms`);
      }

      const mapRoot = await mapPromise;
      planetsAndRoutes = mapBlobToPlanetsRoutes(mapRoot);

      console.log(`[load] API map preloaded ${(performance.now() - loadStart).toFixed(0)}ms`);

      await waitUntilNextFullMinute("daily fetch boundary");

      const dailyStart = performance.now();
      dailyChallengeList = await fetchGetDailyChallengeList(apiConn.baseUrl, apiConn.headers);
      console.log(`[load] GetDailyChallenge after boundary ${(performance.now() - dailyStart).toFixed(0)}ms`);
    } else {
      const [mapRoot, list] = await Promise.all([
        fetchGetPlanetsAndRoutesRoot(apiConn.baseUrl, apiConn.headers),
        fetchGetDailyChallengeList(apiConn.baseUrl, apiConn.headers),
      ]);

      planetsAndRoutes = mapBlobToPlanetsRoutes(mapRoot);
      dailyChallengeList = list;

      console.log(`[load] API map + GetDailyChallenge ${(performance.now() - loadStart).toFixed(0)}ms`);
    }
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
    if (dailyChallengeList == null) {
      console.error("Internal error: daily challenge list not loaded.");
      return 1;
    }

    const entries: Record<string, unknown>[] = [];

    for (const raw of dailyChallengeList) {
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
    console.error("Provide at least one --challenge file, or use --daily-api / --active-daily-api.");
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