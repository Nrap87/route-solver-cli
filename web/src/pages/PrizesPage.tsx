import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiCalculateCoaxium,
  apiSubmitChallengeSolution,
  fetchGetDailyChallengeList,
  fetchGetPlanetsAndRoutesRoot,
} from "@cli/api";
import type { ApiHeaders } from "@cli/api";
import {
  challengeToSolveInput,
  mapBlobToPlanetsRoutes,
  recordToChallenge,
} from "@cli/adapt";
import type { ChallengeFields } from "@cli/adapt";
import { solve } from "@cli/solver/solve";
import type { Planet, Route, SolveResult } from "@cli/solver/types";
import { restBaseForRequests } from "../apiBase";
import {
  buildBundleExport,
  buildChallengesExport,
  buildMapExport,
  downloadJson,
  escapeHtml,
  pickBool,
  rawChallengeSortKey,
} from "../starDeliveryExports";
import {
  DEFAULT_STAR_DELIVERY_REST_BASE,
  resolvePlayerEmail,
  resolvePlayerGuid,
} from "../starDeliveryDefaults";
import {
  entriesFromChallengeDocument,
  getBundledChallengeJson,
  listBundledChallengeFilenames,
} from "../challengeFiles";

const STORAGE_GUID = "sd_player_guid";
const STORAGE_EMAIL = "sd_player_email";
const STORAGE_API_BASE = "sd_api_base";

const CREDENTIALS_MISSING_MSG =
  "Player credentials are not configured (set VITE_PLAYER_GUID / VITE_PLAYER_EMAIL or defaults in starDeliveryDefaults).";

function readStored(key: string, fallback: string): string {
  try {
    const v = sessionStorage.getItem(key);
    return v != null && v.trim() !== "" ? v : fallback;
  } catch {
    return fallback;
  }
}

function tabLabel(ch: ChallengeFields, index: number): string {
  if (ch.title?.trim()) return ch.title.trim();
  if (ch.level != null) return `Level ${ch.level}`;
  return `Challenge ${index + 1}`;
}

function descriptionLines(ch: ChallengeFields): string[] {
  const lines = [
    "Your goal is to deliver the merchandise spending the least amount of coaxium, returning to your origin planet.",
    "There are mandatory planets to visit, and you must not visit the same planet twice.",
  ];
  if (ch.forbiddenPlanetIds.length) {
    lines.push("You won't be able to pass through forbidden planets.");
  }
  if (ch.bonusStops.length) {
    lines.push("Some planets refuel your ship and might be worth the detour.");
  }
  return lines;
}

function monthDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 10000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function buildRouteSummaryStrings(result: SolveResult): string[] {
  if (!result.success) return [];
  const names = result.orderedRoute.map((p) => {
    const n = p.name?.trim();
    return n ? `${n} (${p.id})` : `#${p.id}`;
  });
  return [
    `route (${result.orderedRoute.length}): ${names.join(" â†’ ")}`,
    `routeIds: [${result.orderedRoute.map((p) => p.id).join(", ")}]`,
  ];
}

function formatSolveLog(
  result: SolveResult,
  timing?: { solveMs?: number; apiMs?: number; totalMs?: number },
): string {
  const lines: string[] = [];
  if (!result.success) {
    lines.push(`Solver: FAILED`, result.errorMessage ?? "unknown error");
    if (timing?.solveMs != null) lines.push(`solve elapsed: ${formatElapsed(timing.solveMs)}`);
    if (timing?.totalMs != null) lines.push(`total elapsed: ${formatElapsed(timing.totalMs)}`);
    return lines.join("\n");
  }
  lines.push(
    "Solver: OK",
    `effectiveFuel: ${result.effectiveFuel}`,
    `grossFuel: ${result.grossFuel}`,
    `collectedBonus: ${result.collectedBonus}`,
    ...buildRouteSummaryStrings(result),
  );
  if (timing?.solveMs != null) lines.push(`solve elapsed: ${formatElapsed(timing.solveMs)}`);
  if (timing?.apiMs != null) lines.push(`API elapsed: ${formatElapsed(timing.apiMs)}`);
  if (timing?.totalMs != null) lines.push(`total elapsed: ${formatElapsed(timing.totalMs)}`);
  return lines.join("\n");
}

function formatSolveOneLiner(ch: ChallengeFields, result: SolveResult, solveMs?: number): string {
  const id = ch.challengeId != null ? `#${ch.challengeId}` : tabLabel(ch, 0);
  const t = solveMs != null ? `  ${formatElapsed(solveMs)}` : "";
  if (!result.success) return `${id}  FAIL${t}  ${result.errorMessage ?? ""}`;
  return `${id}  ok${t}  fuel=${result.effectiveFuel}  hops=${result.orderedRoute.length}`;
}

export function PrizesPage() {
  const playerGuid = useMemo(() => resolvePlayerGuid(), []);
  const playerEmail = useMemo(() => resolvePlayerEmail(), []);
  const [apiBaseUrl, setApiBaseUrl] = useState(() =>
    readStored(STORAGE_API_BASE, DEFAULT_STAR_DELIVERY_REST_BASE),
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planets, setPlanets] = useState<Planet[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [sortedRawRows, setSortedRawRows] = useState<Record<string, unknown>[]>([]);
  const [challenges, setChallenges] = useState<ChallengeFields[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [busy, setBusy] = useState<"solve" | "coaxium" | "submit" | null>(null);
  const [masterBusy, setMasterBusy] = useState<"solve" | "coaxium" | "submit" | null>(null);
  const [logText, setLogText] = useState("");
  const [logError, setLogError] = useState(false);
  const [masterLog, setMasterLog] = useState("");
  /** `"daily"` = GetDailyChallenge list; otherwise bundled `challenges/*.json` basename. */
  const [challengeSource, setChallengeSource] = useState<"daily" | string>("daily");

  const bundledChallengeNames = useMemo(() => listBundledChallengeFilenames(), []);

  const headers: ApiHeaders | null = useMemo(() => {
    const g = playerGuid.trim();
    const e = playerEmail.trim();
    if (!g || !e) return null;
    return { Accept: "application/json", PlayerGuid: g, PlayerEmail: e };
  }, [playerGuid, playerEmail]);

  const planetsById = useMemo(
    () => new Map(planets.map((p) => [p.id, p])),
    [planets],
  );

  const challengesExport = useMemo(
    () => (challenges.length ? buildChallengesExport(challenges, sortedRawRows) : []),
    [challenges, sortedRawRows],
  );

  const persistCreds = useCallback(() => {
    try {
      sessionStorage.setItem(STORAGE_GUID, playerGuid.trim());
      sessionStorage.setItem(STORAGE_EMAIL, playerEmail.trim());
      sessionStorage.setItem(STORAGE_API_BASE, apiBaseUrl.trim());
    } catch {
      /* ignore */
    }
  }, [playerGuid, playerEmail, apiBaseUrl]);

  const loadDaily = useCallback(async () => {
    setLoadError(null);
    if (!headers) {
      setLoadError(CREDENTIALS_MISSING_MSG);
      return;
    }
    persistCreds();
    setLoading(true);
    try {
      const rootUrl = restBaseForRequests(apiBaseUrl);
      const mapRoot = await fetchGetPlanetsAndRoutesRoot(rootUrl, headers);
      const pr = mapBlobToPlanetsRoutes(mapRoot);
      setPlanets(pr.planets);
      setRoutes(pr.routes);

      const list = await fetchGetDailyChallengeList(rootUrl, headers);
      const entries: Record<string, unknown>[] = [];
      for (const raw of list) {
        if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
          entries.push(raw as Record<string, unknown>);
        }
      }
      entries.sort((a, b) => rawChallengeSortKey(a) - rawChallengeSortKey(b));
      if (entries.length === 0) {
        setChallenges([]);
        setSortedRawRows([]);
        setLoadError("GetDailyChallenge returned no usable challenge rows.");
        return;
      }
      setSortedRawRows(entries);
      setChallenges(entries.map((raw) => recordToChallenge(raw)));
      setActiveTab(0);
      setLogText("");
      setMasterLog(
        `Loaded ${entries.length} daily challenge(s); map ${pr.planets.length} planets, ${pr.routes.length} routes.`,
      );
      setLogError(false);
    } catch (e) {
      setChallenges([]);
      setSortedRawRows([]);
      setPlanets([]);
      setRoutes([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, headers, persistCreds]);

  const loadChallengesFromFile = useCallback(
    async (basename: string) => {
      setLoadError(null);
      if (!headers) {
        setLoadError(CREDENTIALS_MISSING_MSG);
        return;
      }
      persistCreds();
      setLoading(true);
      try {
        const rootUrl = restBaseForRequests(apiBaseUrl);
        const mapRoot = await fetchGetPlanetsAndRoutesRoot(rootUrl, headers);
        const pr = mapBlobToPlanetsRoutes(mapRoot);
        setPlanets(pr.planets);
        setRoutes(pr.routes);

        const doc = getBundledChallengeJson(basename);
        const rows = entriesFromChallengeDocument(doc);
        const entries: Record<string, unknown>[] = [];
        for (const raw of rows) {
          if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
            entries.push(raw);
          }
        }
        entries.sort((a, b) => rawChallengeSortKey(a) - rawChallengeSortKey(b));
        if (entries.length === 0) {
          setChallenges([]);
          setSortedRawRows([]);
          setLoadError(`Challenge file "${basename}" contains no usable challenge rows.`);
          return;
        }
        setSortedRawRows(entries);
        setChallenges(entries.map((raw) => recordToChallenge(raw)));
        setActiveTab(0);
        setLogText("");
        setMasterLog(
          `Loaded ${entries.length} challenge(s) from file "${basename}"; map ${pr.planets.length} planets, ${pr.routes.length} routes (API).`,
        );
        setLogError(false);
      } catch (e) {
        setChallenges([]);
        setSortedRawRows([]);
        setPlanets([]);
        setRoutes([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [apiBaseUrl, headers, persistCreds],
  );

  const reloadCurrentSource = useCallback(() => {
    if (challengeSource === "daily") return void loadDaily();
    return void loadChallengesFromFile(challengeSource);
  }, [challengeSource, loadDaily, loadChallengesFromFile]);

  const autoLoadOnce = useRef(false);
  useEffect(() => {
    if (autoLoadOnce.current) return;
    if (!headers) return;
    autoLoadOnce.current = true;
    void loadDaily();
  }, [loadDaily, headers]);

  const current = challenges[activeTab];
  const currentRaw = sortedRawRows[activeTab];
  const currentFinished = currentRaw != null && pickBool(currentRaw, "IsFinished", "isFinished");

  const runSolveCore = useCallback(
    (ch: ChallengeFields) => {
      if (planets.length === 0) {
        throw new Error("Load daily data first.");
      }
      const input = challengeToSolveInput(planets, routes, ch);
      return solve(input);
    },
    [planets, routes],
  );

  const onSolve = async () => {
    if (!current) return;
    setBusy("solve");
    setLogError(false);
    const t0 = performance.now();
    try {
      const result = runSolveCore(current);
      const solveMs = performance.now() - t0;
      setLogText(formatSolveLog(result, { solveMs, totalMs: solveMs }));
      setLogError(!result.success);
    } catch (e) {
      const totalMs = performance.now() - t0;
      setLogText([e instanceof Error ? e.message : String(e), `total elapsed: ${formatElapsed(totalMs)}`].join("\n"));
      setLogError(true);
    } finally {
      setBusy(null);
    }
  };

  const onCoaxium = async () => {
    if (!current || !headers) return;
    const cid = current.challengeId;
    if (cid === undefined) {
      setLogText("This row has no ChallengeId â€” cannot call CalculateCoaxium.");
      setLogError(true);
      return;
    }
    setBusy("coaxium");
    setLogError(false);
    const t0 = performance.now();
    try {
      const tSolve0 = performance.now();
      const result = runSolveCore(current);
      const solveMs = performance.now() - tSolve0;
      if (!result.success) {
        setLogText(formatSolveLog(result, { solveMs, totalMs: performance.now() - t0 }));
        setLogError(true);
        return;
      }
      const rootUrl = restBaseForRequests(apiBaseUrl);
      const tApi0 = performance.now();
      const post = await apiCalculateCoaxium(rootUrl, headers, cid, result.orderedRoute.map((p) => p.id), planetsById);
      const apiMs = performance.now() - tApi0;
      const totalMs = performance.now() - t0;
      setLogText(
        [
          formatSolveLog(result, { solveMs, apiMs, totalMs }),
          "",
          `CalculateCoaxium HTTP ${post.httpStatus}`,
          post.rawBody,
        ].join("\n"),
      );
      setLogError(!post.parsed.is_success);
    } catch (e) {
      const totalMs = performance.now() - t0;
      setLogText([e instanceof Error ? e.message : String(e), `total elapsed: ${formatElapsed(totalMs)}`].join("\n"));
      setLogError(true);
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = async () => {
    if (!current || !headers) return;
    const cid = current.challengeId;
    if (cid === undefined) {
      setLogText("This row has no ChallengeId â€” cannot call SubmitChallengeSolution.");
      setLogError(true);
      return;
    }
    if (currentFinished) {
      setLogText("This level is already finished on the server (IsFinished).");
      setLogError(true);
      return;
    }
    setBusy("submit");
    setLogError(false);
    const t0 = performance.now();
    try {
      const tSolve0 = performance.now();
      const result = runSolveCore(current);
      const solveMs = performance.now() - tSolve0;
      if (!result.success) {
        setLogText(formatSolveLog(result, { solveMs, totalMs: performance.now() - t0 }));
        setLogError(true);
        return;
      }
      const rootUrl = restBaseForRequests(apiBaseUrl);
      const tApi0 = performance.now();
      const post = await apiSubmitChallengeSolution(
        rootUrl,
        headers,
        cid,
        result.orderedRoute.map((p) => p.id),
        planetsById,
      );
      const apiMs = performance.now() - tApi0;
      const totalMs = performance.now() - t0;
      setLogText(
        [
          formatSolveLog(result, { solveMs, apiMs, totalMs }),
          "",
          `SubmitChallengeSolution HTTP ${post.httpStatus}`,
          post.rawBody,
        ].join("\n"),
      );
      setLogError(!post.parsed.is_success);
    } catch (e) {
      const totalMs = performance.now() - t0;
      setLogText([e instanceof Error ? e.message : String(e), `total elapsed: ${formatElapsed(totalMs)}`].join("\n"));
      setLogError(true);
    } finally {
      setBusy(null);
    }
  };

  const runMasterBatch = async (mode: "solve" | "coaxium" | "submit") => {
    if (!headers || challenges.length === 0 || planets.length === 0) return;
    if (mode === "submit") {
      const srcLabel =
        challengeSource === "daily"
          ? "server daily challenges"
          : `bundled file "${challengeSource}"`;
      const ok = window.confirm(
        `Solve each challenge in ascending ChallengeId order and call SubmitChallengeSolution for each (skipping IsFinished rows)?\n\nChallenge source: ${srcLabel}.`,
      );
      if (!ok) return;
    }
    setMasterBusy(mode);
    setMasterLog("Runningâ€¦");
    const rootUrl = restBaseForRequests(apiBaseUrl);
    const lines: string[] = [];
    let anyErr = false;
    const tBatch0 = performance.now();
    try {
      for (let i = 0; i < challenges.length; i++) {
        const ch = challenges[i]!;
        const raw = sortedRawRows[i];
        const finished = raw != null && pickBool(raw, "IsFinished", "isFinished");
        const tStep0 = performance.now();
        let solveMs = 0;
        let apiMsTotal = 0;
        let result: SolveResult;
        lines.push(`â”â” ${tabLabel(ch, i)} â”â”`);
        try {
          const ts = performance.now();
          result = runSolveCore(ch);
          solveMs = performance.now() - ts;
        } catch (e) {
          anyErr = true;
          lines.push(`${tabLabel(ch, i)}  ERROR  ${e instanceof Error ? e.message : String(e)}`);
          lines.push(`  challenge wall: ${formatElapsed(performance.now() - tStep0)}`);
          lines.push("");
          continue;
        }
        lines.push(formatSolveOneLiner(ch, result, solveMs));
        if (result.success) {
          for (const ln of buildRouteSummaryStrings(result)) {
            lines.push(`  ${ln}`);
          }
        }
        if (!result.success) {
          anyErr = true;
          lines.push(`  challenge wall: ${formatElapsed(performance.now() - tStep0)}`);
          lines.push("");
          continue;
        }
        const cid = ch.challengeId;
        if (mode === "coaxium") {
          if (cid === undefined) {
            lines.push(`  â†’ skip CalculateCoaxium (no ChallengeId)`);
            anyErr = true;
          } else {
            try {
              const ta = performance.now();
              const post = await apiCalculateCoaxium(
                rootUrl,
                headers,
                cid,
                result.orderedRoute.map((p) => p.id),
                planetsById,
              );
              const apiMs = performance.now() - ta;
              apiMsTotal += apiMs;
              lines.push(`  â†’ CalculateCoaxium HTTP ${post.httpStatus}  success=${post.parsed.is_success}  (${formatElapsed(apiMs)})`);
              if (!post.parsed.is_success) anyErr = true;
            } catch (e) {
              anyErr = true;
              lines.push(`  â†’ CalculateCoaxium ERROR ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        if (mode === "submit") {
          if (finished) {
            lines.push(`  â†’ Submit skipped (IsFinished on server)`);
          } else if (cid === undefined) {
            lines.push(`  â†’ skip Submit (no ChallengeId)`);
            anyErr = true;
          } else {
            try {
              const ta = performance.now();
              const post = await apiSubmitChallengeSolution(
                rootUrl,
                headers,
                cid,
                result.orderedRoute.map((p) => p.id),
                planetsById,
              );
              const apiMs = performance.now() - ta;
              apiMsTotal += apiMs;
              lines.push(`  â†’ SubmitChallengeSolution HTTP ${post.httpStatus}  success=${post.parsed.is_success}  (${formatElapsed(apiMs)})`);
              if (!post.parsed.is_success) anyErr = true;
            } catch (e) {
              anyErr = true;
              lines.push(`  â†’ Submit ERROR ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        const stepWall = performance.now() - tStep0;
        lines.push(
          `  timings: solve ${formatElapsed(solveMs)}` +
            (apiMsTotal > 0 ? `  Â·  API ${formatElapsed(apiMsTotal)}` : "") +
            `  Â·  challenge wall ${formatElapsed(stepWall)}`,
        );
        lines.push("");
      }
      const batchTotal = performance.now() - tBatch0;
      lines.push(`Batch total elapsed: ${formatElapsed(batchTotal)}`);
      lines.push("");
      lines.push(`Done (${mode} all). ${anyErr ? "Some steps reported errors." : "All steps completed."}`);
      setMasterLog(lines.join("\n"));
    } catch (e) {
      setMasterLog(String(e instanceof Error ? e.message : e));
    } finally {
      setMasterBusy(null);
    }
  };

  const onExportMap = () => {
    if (!planets.length) return;
    downloadJson("data.json", buildMapExport(planets, routes));
  };

  const onExportChallenges = () => {
    if (!challengesExport.length) return;
    downloadJson("challenges.json", challengesExport);
  };

  const onExportBundle = () => {
    if (!planets.length || !challengesExport.length) return;
    downloadJson("star-delivery-bundle.json", buildBundleExport(planets, routes, challengesExport));
  };

  const hasData = planets.length > 0 && challenges.length > 0;
  const canAct = Boolean(current && hasData && !loading);
  const buttonsDisabled = !canAct || busy !== null;
  const masterDisabled = !hasData || !headers || loading || masterBusy !== null || busy !== null;

  const starterName =
    current != null ? planetsById.get(current.startPlanetId)?.name?.trim() || String(current.startPlanetId) : "";
  const mandatoryNames = current?.mandatoryPlanetIds.map((id) => planetsById.get(id)?.name?.trim() || String(id)) ?? [];
  const forbiddenNames = current?.forbiddenPlanetIds.map((id) => planetsById.get(id)?.name?.trim() || String(id)) ?? [];
  const bonusLines =
    current?.bonusStops.map(
      (b) => `${escapeHtml(planetsById.get(b.planetId)?.name?.trim() || String(b.planetId))} (${b.value})`,
    ) ?? [];

  return (
    <div className="dash">
      <header className="dash-brand">
        <div className="dash-presents">
          â— <span>OUTSYSTEMS</span> PRESENTS
        </div>
        <h1 className="dash-title">
          <span className="dash-title-star">Star</span>
          <span className="dash-title-delivery">Delivery</span>
        </h1>
        <div className="dash-sub">Galaxy logistics Â· Daily challenge Â· Prizes</div>
      </header>

      {loadError ? <div className="dash-err">{loadError}</div> : null}

      <section className="dash-panel dash-panel--conn">
        <h2 className="dash-panel-h">Connection</h2>
        <div className="form-grid">
          <div className="field field--full">
            <label htmlFor="apiBase">REST API base URL</label>
            <input
              id="apiBase"
              autoComplete="off"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder={DEFAULT_STAR_DELIVERY_REST_BASE}
            />
          </div>
          <div className="field field--full">
            <label htmlFor="challengeSource">Challenges</label>
            <select
              id="challengeSource"
              value={challengeSource}
              disabled={loading}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "daily") {
                  setChallengeSource("daily");
                  void loadDaily();
                } else {
                  setChallengeSource(v);
                  void loadChallengesFromFile(v);
                }
              }}
            >
              <option value="daily">Daily Challenges</option>
              {bundledChallengeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={loading || !headers}
              onClick={() => void reloadCurrentSource()}
            >
              {loading ? "Loadingâ€¦" : "Load / reload"}
            </button>
          </div>
        </div>
        <p className="hint">
          Dev: browser calls <code>/__api/*</code> (Vite proxy). Production: set <code>VITE_API_BASE_URL</code> or use the
          URL above (watch CORS).
        </p>
      </section>

      {loading && !hasData ? (
        <div className="dash-loading">
          {challengeSource === "daily"
            ? "Loading map and missions from the APIâ€¦"
            : `Loading map from the API and challenges from ${challengeSource}â€¦`}
        </div>
      ) : null}

      {hasData ? (
        <>
          <div className="dash-toolbar">
            <button type="button" className="btn-dash" onClick={onExportMap}>
              Export map â†’ data.json
            </button>
            <button type="button" className="btn-dash btn-dash--sec" onClick={onExportChallenges}>
              Export challenges â†’ challenges.json
            </button>
            <button type="button" className="btn-dash btn-dash--gold" onClick={onExportBundle}>
              Export bundle â†’ star-delivery-bundle.json
            </button>
            <button type="button" className="btn-dash btn-dash--sec" onClick={() => void reloadCurrentSource()}>
              Reload
            </button>
          </div>

          <div className="dash-toolbar dash-master">
            <span className="dash-master-label">All challenges (ascending ChallengeId, like CLI --daily-api)</span>
            <button
              type="button"
              className="btn-act"
              disabled={masterDisabled}
              onClick={() => void runMasterBatch("solve")}
            >
              {masterBusy === "solve" ? "â€¦" : "Solve all"}
            </button>
            <button
              type="button"
              className="btn-act btn-act--gold"
              disabled={masterDisabled}
              onClick={() => void runMasterBatch("coaxium")}
            >
              {masterBusy === "coaxium" ? "â€¦" : "Calculate Coaxium all"}
            </button>
            <button
              type="button"
              className="btn-act btn-act--danger"
              disabled={masterDisabled}
              onClick={() => void runMasterBatch("submit")}
            >
              {masterBusy === "submit" ? "â€¦" : "Submit all"}
            </button>
          </div>
          {masterLog ? <pre className="dash-master-log">{masterLog}</pre> : null}

          <div className="dash-stats">
            <div className="dash-stat">
              <div className="dash-stat-n">{planets.length}</div>
              <div className="dash-stat-l">Planets</div>
            </div>
            <div className="dash-stat">
              <div className="dash-stat-n">{routes.length}</div>
              <div className="dash-stat-l">Routes</div>
            </div>
            <div className="dash-stat">
              <div className="dash-stat-n">{challenges.length}</div>
              <div className="dash-stat-l">{challengeSource === "daily" ? "Daily challenges" : "File challenges"}</div>
            </div>
          </div>

          <h2 className="dash-section">Map data</h2>
          <div className="dash-grid2">
            <div className="dash-data-panel">
              <h3>Planets</h3>
              <div className="dash-scroll">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Id</th>
                      <th>Name</th>
                      <th>X</th>
                      <th>Y</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planets.map((p) => (
                      <tr key={p.id}>
                        <td>{p.id}</td>
                        <td>{escapeHtml(p.name)}</td>
                        <td>{p.x}</td>
                        <td>{p.y}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="dash-data-panel">
              <h3>Routes</h3>
              <div className="dash-scroll">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((r, idx) => (
                      <tr key={`${r.from}-${r.to}-${idx}`}>
                        <td>{r.from}</td>
                        <td>{r.to}</td>
                        <td>{r.type === "main" ? "Main Route" : "Other Route"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="dash-missions-head">
            {challengeSource === "daily" ? "Todayâ€™s missions" : `File missions Â· ${challengeSource}`}
          </div>
          <div className="tabs-dash" role="tablist">
            {challenges.map((ch, i) => {
              const short = tabLabel(ch, i);
              const shortDisp = short.length > 28 ? `${short.slice(0, 26)}â€¦` : short;
              return (
                <button
                  key={`${ch.challengeId ?? "noid"}-${i}`}
                  type="button"
                  role="tab"
                  aria-selected={i === activeTab}
                  className={`tab-dash${i === activeTab ? " tab-dash--active" : ""}`}
                  onClick={() => setActiveTab(i)}
                >
                  <div className="tab-dash-lvl">LEVEL {String(i + 1).padStart(2, "0")}</div>
                  <div className="tab-dash-ttl">{escapeHtml(shortDisp)}</div>
                  <div className="tab-dash-dots">{"â—".repeat(i + 1)}</div>
                </button>
              );
            })}
          </div>

          {current ? (
            <article className="dash-mission-card">
              <div className="dash-mission-kicker">
                {challengeSource === "daily" ? (
                  <>â€” Todayâ€™s mission Â· {monthDay(new Date()).toUpperCase()}</>
                ) : (
                  <>â€” From file Â· {escapeHtml(challengeSource)}</>
                )}
              </div>
              <h2 className="dash-mission-title">{escapeHtml(tabLabel(current, activeTab))}</h2>
              <div className="dash-mission-desc">
                {descriptionLines(current).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
              <div className="dash-row">
                <span className="dash-row-label dash-row-label--gold">Starter planet</span>
                <span className="dash-row-val">
                  {escapeHtml(starterName)}
                  {currentFinished ? <span className="dash-badge">Finished on server</span> : null}
                </span>
              </div>
              <div className="dash-row">
                <span className="dash-row-label dash-row-label--blue">{mandatoryNames.length} mandatory stops</span>
                <span className="dash-row-val">{mandatoryNames.map(escapeHtml).join(", ")}</span>
              </div>
              {forbiddenNames.length ? (
                <div className="dash-row">
                  <span className="dash-row-label dash-row-label--forb">{forbiddenNames.length} forbidden stops</span>
                  <span className="dash-row-val">{forbiddenNames.map(escapeHtml).join(", ")}</span>
                </div>
              ) : null}
              {bonusLines.length ? (
                <div className="dash-row">
                  <span className="dash-row-label dash-row-label--bonus">{bonusLines.length} fuel bonus</span>
                  <span className="dash-row-val">{bonusLines.join(", ")}</span>
                </div>
              ) : null}

              <div className="dash-mission-toolbar">
                <button type="button" className="btn-act" disabled={buttonsDisabled} onClick={() => void onSolve()}>
                  {busy === "solve" ? "Solvingâ€¦" : "Solve"}
                </button>
                <button type="button" className="btn-act btn-act--gold" disabled={buttonsDisabled} onClick={() => void onCoaxium()}>
                  {busy === "coaxium" ? "â€¦" : "Calculate Coaxium"}
                </button>
                <button
                  type="button"
                  className="btn-act btn-act--danger"
                  disabled={buttonsDisabled || currentFinished}
                  onClick={() => void onSubmit()}
                >
                  {busy === "submit" ? "â€¦" : "Submit"}
                </button>
              </div>
              {logText ? <pre className={`dash-action-result${logError ? " dash-action-result--err" : ""}`}>{logText}</pre> : null}
            </article>
          ) : null}
        </>
      ) : !loading ? (
        <div className="dash-empty">
          Choose <strong>Daily Challenges</strong> or a JSON file, then use <strong>Load / reload</strong> (or wait for the initial
          load). The map always comes from the API; file options replace only the challenge list.
        </div>
      ) : null}
    </div>
  );
}
