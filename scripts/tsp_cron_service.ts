#!/usr/bin/env npx tsx
/**
 * Schedule `node dist/cli.js` runs.
 *
 * New timing options:
 *
 *   --prelaunch-ms=1500
 *     Launch the child CLI before the target minute.
 *
 *   --prewarm-api
 *     When used with --prelaunch-ms, forward --prewarm-api to the child CLI.
 *
 * Recommended:
 *
 *   npm run tsp-cron -- --every-minute --window-start=07:00 --window-end=07:20 --map data.json --daily-api --submit --prelaunch-ms=1500 --prewarm-api
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(join(__dirname, ".."));
const DEFAULT_CLI = join(PKG_ROOT, "dist", "cli.js");

function stripArgQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function argvLongFlag(name: string): string | undefined {
  const prefixEq = `--${name}=`;
  const prefixColon = `--${name}:`;
  const prefixOnly = `--${name}`;

  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith(prefixEq)) {
      const v = a.slice(prefixEq.length).trim();
      if (v.length > 0) return stripArgQuotes(v);
      const next = process.argv[i + 1];
      if (next != null && !next.startsWith("-")) return stripArgQuotes(next.trim());
      continue;
    }

    if (a.startsWith(prefixColon)) {
      const v = a.slice(prefixColon.length).trim();
      if (v.length > 0) return stripArgQuotes(v);
      continue;
    }

    if (a === prefixOnly) {
      const next = process.argv[i + 1];
      if (next != null && !next.startsWith("-")) return stripArgQuotes(next.trim());
    }
  }

  return undefined;
}

function argvNumberFlag(name: string, fallback: number): number {
  const raw = argvLongFlag(name);
  if (raw == null || raw.trim() === "") return fallback;

  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative number of milliseconds.`);
  }

  return Math.trunc(n);
}

function argvAllValuesForOption(name: string): string[] {
  const out: string[] = [];
  const prefixEq = `--${name}=`;
  const prefixColon = `--${name}:`;
  const prefixOnly = `--${name}`;

  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]!;

    if (a.startsWith(prefixEq)) {
      const v = a.slice(prefixEq.length).trim();
      if (v.length > 0) out.push(stripArgQuotes(v));
      else {
        const next = process.argv[i + 1];
        if (next != null && !next.startsWith("-")) out.push(stripArgQuotes(next.trim()));
      }
      continue;
    }

    if (a.startsWith(prefixColon)) {
      const v = a.slice(prefixColon.length).trim();
      if (v.length > 0) out.push(stripArgQuotes(v));
      continue;
    }

    if (a === prefixOnly) {
      const next = process.argv[i + 1];
      if (next != null && !next.startsWith("-")) out.push(stripArgQuotes(next.trim()));
    }
  }

  return out;
}

function argvCronHasFlag(name: string): boolean {
  const eq = `--${name}=`;

  for (const a of process.argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(eq)) {
      const v = a.slice(eq.length).trim().toLowerCase();
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
      return true;
    }
  }

  return false;
}

function resolveCronPath(relOrAbs: string): string {
  const t = relOrAbs.trim();
  if (!t) return t;
  return isAbsolute(t) ? resolve(t) : resolve(PKG_ROOT, t);
}

function resolveChildCliArgvPieces(
  values: Readonly<Record<string, string | boolean | string[] | undefined>>
): string[] {
  const parsedMap = typeof values.map === "string" ? values.map.trim() : "";
  const mapArg = argvLongFlag("map")?.trim() || parsedMap;
  const hasMap = mapArg.length > 0;

  const apiMap = argvCronHasFlag("api-map") || Boolean(values["api-map"]);
  const dailyApi = argvCronHasFlag("daily-api") || Boolean(values["daily-api"]);
  const activeDailyApi = argvCronHasFlag("active-daily-api") || Boolean(values["active-daily-api"]);

  const parsedBaseUrl = typeof values["base-url"] === "string" ? values["base-url"].trim() : "";
  const baseUrl = argvLongFlag("base-url")?.trim() || parsedBaseUrl;

  const parsedChallenges = Array.isArray(values.challenge)
    ? values.challenge.map((v) => String(v))
    : [];

  const challenges = [
    ...parsedChallenges,
    ...argvAllValuesForOption("challenge"),
  ]
    .map((c) => resolveCronPath(c.trim()))
    .filter((c, index, arr) => c.length > 0 && arr.indexOf(c) === index);

  const specified = hasMap || apiMap || dailyApi || activeDailyApi || challenges.length > 0;

  if (!specified) {
    return ["--daily-api"];
  }

  if (hasMap && apiMap) {
    throw new Error("Cron: use only one of --map or --api-map for the child CLI.");
  }

  if ((dailyApi || activeDailyApi) && challenges.length > 0) {
    throw new Error("Cron: do not combine daily API modes with --challenge.");
  }

  if (dailyApi && activeDailyApi) {
    throw new Error("Cron: use only one of --daily-api or --active-daily-api.");
  }

  if (challenges.length > 0 && !hasMap && !apiMap) {
    throw new Error("Cron: --challenge requires --map or --api-map.");
  }

  if (!dailyApi && !activeDailyApi && challenges.length === 0) {
    throw new Error("Cron: need --daily-api, --active-daily-api, and/or at least one --challenge.");
  }

  const args: string[] = [];

  if (baseUrl) args.push("--base-url", baseUrl);
  if (hasMap) args.push("--map", resolveCronPath(mapArg));
  if (apiMap) args.push("--api-map");
  if (dailyApi) args.push("--daily-api");
  if (activeDailyApi) args.push("--active-daily-api");

  for (const c of challenges) args.push("--challenge", c);

  return args;
}

function argvHasEveryMinute(): boolean {
  for (const a of process.argv) {
    if (a === "--every-minute") return true;
    if (a.startsWith("--every-minute=")) {
      const v = a.slice("--every-minute=".length).trim().toLowerCase();
      return v !== "false" && v !== "0";
    }
  }

  return false;
}

function envTruthy(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envFalsy(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function argvHasCalculateCoaxium(): boolean {
  return process.argv.some((a) => {
    if (a === "--calculate-coaxium") return true;
    if (a.startsWith("--calculate-coaxium=")) {
      const v = a.slice("--calculate-coaxium=".length).trim().toLowerCase();
      return v !== "false" && v !== "0";
    }
    return false;
  });
}

function argvHasNoCalculateCoaxium(): boolean {
  return process.argv.some((a) => a === "--no-calculate-coaxium" || a.startsWith("--no-calculate-coaxium="));
}

function argvHasSubmit(): boolean {
  return process.argv.some((a) => {
    if (a === "--submit") return true;
    if (a.startsWith("--submit=")) {
      const v = a.slice("--submit=".length).trim().toLowerCase();
      return v !== "false" && v !== "0";
    }
    return false;
  });
}

function argvHasNoSubmit(): boolean {
  return process.argv.some((a) => a === "--no-submit" || a.startsWith("--no-submit="));
}

type ChildFlags = {
  submit: boolean;
  calculateCoaxium: boolean;
};

function resolveChildFlags(values: Readonly<Record<string, string | boolean | string[] | undefined>>, argvJoined: string): ChildFlags {
  let calculateCoaxium =
    argvHasCalculateCoaxium() ||
    Boolean(values["calculate-coaxium"]) ||
    envTruthy("TSP_SCHED_CALCULATE_COAXIUM");

  if (argvHasNoCalculateCoaxium() || Boolean(values["no-calculate-coaxium"])) {
    calculateCoaxium = false;
  }

  let submit = argvHasSubmit() || Boolean(values.submit) || envTruthy("TSP_SCHED_SUBMIT");

  if (argvHasNoSubmit() || Boolean(values["no-submit"])) {
    submit = false;
  } else if (process.env.TSP_SCHED_SUBMIT !== undefined && envFalsy("TSP_SCHED_SUBMIT")) {
    submit = false;
  }

  if (!submit && /--submit(?:\s|$|=)/.test(argvJoined) && !/--no-submit(?:\s|$|=)/.test(argvJoined)) {
    submit = true;
  }

  if (submit && calculateCoaxium) {
    throw new Error("Use only one of --submit or --calculate-coaxium on the child CLI.");
  }

  return { submit, calculateCoaxium };
}

function parseHHMM(label: string, s: string): [number, number] {
  const parts = s.trim().split(":");

  if (parts.length !== 2) {
    throw new Error(`${label} must be HH:MM, got ${JSON.stringify(s)}`);
  }

  const h = parseInt(parts[0]!, 10);
  const m = parseInt(parts[1]!, 10);

  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`${label}: hour 0-23, minute 0-59, got ${JSON.stringify(s)}`);
  }

  return [h, m];
}

function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function inTimeWindow(now: Date, sh: number, sm: number, eh: number, em: number): boolean {
  const smin = sh * 60 + sm;
  const emin = eh * 60 + em;
  const n = minuteOfDay(now);

  if (smin <= emin) return smin <= n && n <= emin;
  return n >= smin || n <= emin;
}

function nextFullMinuteDate(from = new Date()): Date {
  const next = new Date(from);
  next.setMinutes(next.getMinutes() + 1, 0, 0);
  return next;
}

function msToNextFullMinute(): number {
  return Math.max(1, nextFullMinuteDate().getTime() - Date.now());
}

function msUntil(target: Date): number {
  return Math.max(1, target.getTime() - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function logFileStamp(): string {
  const d = new Date();
  const z2 = (n: number) => String(n).padStart(2, "0");
  const z3 = (n: number) => String(n).padStart(3, "0");

  return `${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}_${z2(d.getHours())}${z2(d.getMinutes())}${z2(d.getSeconds())}_${z3(d.getMilliseconds())}`;
}

function buildCliArgs(cliPath: string, baseArgs: string[], child: ChildFlags): string[] {
  const args = [cliPath, ...baseArgs];

  if (child.submit) args.push("--submit");
  if (child.calculateCoaxium) args.push("--calculate-coaxium");

  return args;
}

function childEnvWithCredentials(extra: { playerGuid?: string; playerEmail?: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const g = extra.playerGuid?.trim();
  const e = extra.playerEmail?.trim();

  if (g) env.PLAYER_GUID = g;
  if (e) env.PLAYER_EMAIL = e;

  return env;
}

async function runDailySolve(
  logDir: string | null,
  cliPath: string,
  child: ChildFlags,
  credentials: { playerGuid?: string; playerEmail?: string },
  childCliArgv: string[]
): Promise<number> {
  let logPath: string | null = null;
  let logStream: WriteStream | null = null;
  let logStreamBroken = false;

  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, `route_solver_cron_${logFileStamp()}.log`);
    logStream = createWriteStream(logPath, { flags: "w", encoding: "utf8" });

    logStream.on("error", (err) => {
      logStreamBroken = true;
      console.error(`[schedule] log stream error for ${logPath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const args = buildCliArgs(cliPath, childCliArgv, child);
  const childEnv = childEnvWithCredentials(credentials);

  const header =
    `start ${new Date().toISOString()}\n` +
    `cwd: ${PKG_ROOT}\n` +
    `cmd: ${process.execPath} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n\n`;

  if (logStream && !logStreamBroken) {
    try {
      logStream.write(header);
    } catch (e) {
      logStreamBroken = true;
      console.error(`[schedule] failed writing log header: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(
    logPath
      ? `[${new Date().toISOString()}] starting child cli -> ${logPath}`
      : `[${new Date().toISOString()}] starting child cli (--no-log-file: stdout/stderr only)`
  );

  return new Promise<number>((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, args, {
      cwd: PKG_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const safeWrite = (stream: NodeJS.WriteStream, chunk: Buffer): void => {
      try {
        if (!stream.destroyed && stream.writable) {
          stream.write(chunk);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // Do not crash cron because stdout/stderr was closed by the shell/logging host.
        if (!/EPIPE|ERR_STREAM_DESTROYED|write after end/i.test(msg)) {
          console.error(`[schedule] output write error: ${msg}`);
        }
      }
    };

    const safeWriteLog = (chunk: Buffer | string): void => {
      if (!logStream || logStreamBroken) return;

      try {
        if (!logStream.destroyed && logStream.writable) {
          logStream.write(chunk);
        }
      } catch (e) {
        logStreamBroken = true;
        console.error(`[schedule] log write error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const pipe = (chunk: Buffer, out: NodeJS.WriteStream) => {
      safeWrite(out, chunk);
      safeWriteLog(chunk);
    };

    proc.stdout?.on("data", (c: Buffer) => pipe(c, process.stdout));
    proc.stderr?.on("data", (c: Buffer) => pipe(c, process.stderr));

    proc.stdout?.on("error", (err) => {
      console.error(`[schedule] child stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
    });

    proc.stderr?.on("error", (err) => {
      console.error(`[schedule] child stderr stream error: ${err instanceof Error ? err.message : String(err)}`);
    });

    proc.on("error", (err) => {
      safeWriteLog(`\nspawn error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);

      if (logStream && !logStreamBroken) {
        try {
          logStream.end();
        } catch {
          // ignore
        }
      }

      rejectPromise(err);
    });

    proc.on("close", (code, signal) => {
      const exit = code ?? (signal ? 1 : 0);

      safeWriteLog(`\nend ${new Date().toISOString()} exit=${exit}\n`);

      if (logStream && !logStreamBroken) {
        try {
          logStream.end();
        } catch {
          // ignore
        }
      }

      console.log(
        logPath
          ? `[${new Date().toISOString()}] finished exit=${exit} log=${logPath}`
          : `[${new Date().toISOString()}] finished exit=${exit} (--no-log-file)`
      );

      resolvePromise(exit);
    });
  });
}

function installSignalHandlers(): void {
  const on = () => {
    console.error("\nStopped.");
    process.exit(0);
  };

  process.once("SIGINT", on);
  process.once("SIGTERM", on);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    strict: false,
    allowPositionals: true,
    options: {
      // Scheduler flags
      "every-minute": { type: "boolean", default: false },
      "window-start": { type: "string", default: "" },
      "window-end": { type: "string", default: "" },
      "no-exit-after-window": { type: "boolean", default: false },
      "log-dir": { type: "string", default: "" },
      hour: { type: "string", default: "" },
      minute: { type: "string", default: "" },
      "run-once": { type: "boolean", default: false },
      "cli-path": { type: "string", default: "" },
      "no-log-file": { type: "boolean", default: false },
      "prelaunch-ms": { type: "string", default: "" },
      "prewarm-api": { type: "boolean", default: false },
  
      // Child CLI mode flags.
      // These are declared here so parseArgs does not misclassify their values
      // such as `data.json` as scheduler positionals/log-dir.
      map: { type: "string", default: "" },
      challenge: { type: "string", multiple: true, default: [] },
      "api-map": { type: "boolean", default: false },
      "daily-api": { type: "boolean", default: false },
      "active-daily-api": { type: "boolean", default: false },
  
      // Child CLI API/auth flags
      "base-url": { type: "string", default: "" },
      "player-guid": { type: "string", default: "" },
      "player-email": { type: "string", default: "" },
  
      // Child POST flags
      submit: { type: "boolean", default: false },
      "no-submit": { type: "boolean", default: false },
      "calculate-coaxium": { type: "boolean", default: false },
      "no-calculate-coaxium": { type: "boolean", default: false },
    },
  });

  const envWinStart = process.env.TSP_SCHED_WINDOW_START?.trim() ?? "";
  const envWinEnd = process.env.TSP_SCHED_WINDOW_END?.trim() ?? "";
  const argvWinStart = argvLongFlag("window-start");
  const argvWinEnd = argvLongFlag("window-end");
  const parsedWinStart = String(values["window-start"] ?? "").trim();
  const parsedWinEnd = String(values["window-end"] ?? "").trim();

  let windowStart = (argvWinStart?.trim() || parsedWinStart || envWinStart || "").trim();
  let windowEnd = (argvWinEnd?.trim() || parsedWinEnd || envWinEnd || "").trim();

  const argvJoined = process.argv.join(" ");

  if (!windowStart || !windowEnd) {
    const ms = /--window-start(?:=|:|\s+)(\d{1,2}:\d{2})/.exec(argvJoined);
    const me = /--window-end(?:=|:|\s+)(\d{1,2}:\d{2})/.exec(argvJoined);

    if (!windowStart && ms?.[1]) windowStart = ms[1]!.trim();
    if (!windowEnd && me?.[1]) windowEnd = me[1]!.trim();
  }

  const childFlags = resolveChildFlags(values, argvJoined);

  const credentials = {
    playerGuid: argvLongFlag("player-guid")?.trim() || process.env.PLAYER_GUID?.trim() || "",
    playerEmail: argvLongFlag("player-email")?.trim() || process.env.PLAYER_EMAIL?.trim() || "",
  };

  if (envWinStart && windowStart !== envWinStart) {
    console.error(`[schedule] window start = ${windowStart} (TSP_SCHED_WINDOW_START=${envWinStart} overridden by CLI)`);
  }

  if (envWinEnd && windowEnd !== envWinEnd) {
    console.error(`[schedule] window end = ${windowEnd} (TSP_SCHED_WINDOW_END=${envWinEnd} overridden by CLI)`);
  }

  const everyMinute =
    argvHasEveryMinute() ||
    Boolean(values["every-minute"]) ||
    (windowStart.length > 0 && windowEnd.length > 0);

  const noExitAfter = Boolean(values["no-exit-after-window"]);

  let prelaunchMs = 0;

  try {
    prelaunchMs = argvNumberFlag("prelaunch-ms", Number(process.env.TSP_SCHED_PRELAUNCH_MS || "0"));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const cronPrewarmApi =
    argvCronHasFlag("prewarm-api") ||
    Boolean(values["prewarm-api"]) ||
    envTruthy("TSP_SCHED_PREWARM_API");

  const logDirFlag = (argvLongFlag("log-dir") ?? String(values["log-dir"] ?? "").trim()).trim();
  let logDirPos = positionals[0]?.trim() ?? "";

  const mapCron = argvLongFlag("map")?.trim() ?? "";

  if (mapCron && logDirPos && resolveCronPath(logDirPos) === resolveCronPath(mapCron)) {
    logDirPos = "";
  }

  const challengeCronPaths = argvAllValuesForOption("challenge").map((c) => resolveCronPath(c.trim()));

  if (logDirPos && challengeCronPaths.some((p) => p.length > 0 && resolveCronPath(logDirPos) === p)) {
    logDirPos = "";
  }

  const logDirRaw =
    logDirFlag ||
    logDirPos ||
    process.env.TSP_SCHED_LOG_DIR?.trim() ||
    join(PKG_ROOT, "logs");

  if (positionals.length > 1) {
    console.error("Warning: extra positional arguments ignored.");
  }

  const defaultLogs = join(PKG_ROOT, "logs");

  let logDir = isAbsolute(logDirRaw) ? resolve(logDirRaw) : resolve(PKG_ROOT, logDirRaw);

  if (existsSync(logDir)) {
    try {
      if (statSync(logDir).isFile()) {
        console.error(`[schedule] log path ${logDir} is a file, not a directory. Using default: ${defaultLogs}`);
        logDir = defaultLogs;
      }
    } catch {
      // ignore stat errors
    }
  }

  const noLogFile =
    argvCronHasFlag("no-log-file") ||
    Boolean(values["no-log-file"]) ||
    envTruthy("TSP_SCHED_NO_LOG_FILE");

  const logDirForRuns: string | null = noLogFile ? null : logDir;

  if (noLogFile) {
    console.log("[schedule] per-run log files: disabled (--no-log-file); child output → stdout/stderr only");
  } else {
    console.log(`[schedule] resolved log directory: ${logDir}`);
  }

  const cliPath = resolve(String(values["cli-path"] ?? "").trim() || DEFAULT_CLI);

  if (!existsSync(cliPath)) {
    console.error(`Missing CLI at ${cliPath}. From package root run: npm run build`);
    return 1;
  }

  let childCliArgv: string[];

  try {
    childCliArgv = resolveChildCliArgvPieces(values);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const childUsesDailyTiming =
    childCliArgv.includes("--daily-api") || childCliArgv.includes("--active-daily-api");

  if (prelaunchMs > 0) {
    console.log(
      `[schedule] cron early launch: prelaunchMs=${prelaunchMs}` +
        (childUsesDailyTiming
          ? `, forward prewarmApi=${cronPrewarmApi} to child (--daily-api / --active-daily-api)`
          : " (map/challenge child: no --wait-until-next-minute; only spawn happens earlier)")
    );

    if (childUsesDailyTiming) {
      if (!childCliArgv.includes("--wait-until-next-minute")) {
        childCliArgv.push("--wait-until-next-minute");
      }

      if (cronPrewarmApi && !childCliArgv.includes("--prewarm-api")) {
        childCliArgv.push("--prewarm-api");
      }
    } else if (cronPrewarmApi) {
      console.error(
        "[schedule] --prewarm-api ignored for this child mode (only applies with --daily-api or --active-daily-api on the child CLI)."
      );
    }
  }

  if (process.env.TSP_SCHED_DEBUG?.trim()) {
    console.error("[schedule] argv:", JSON.stringify(process.argv));
    console.error("[schedule] child cli argv:", JSON.stringify(childCliArgv));
  }

  if (values["run-once"]) {
    return await runDailySolve(logDirForRuns, cliPath, childFlags, credentials, childCliArgv);
  }

  if (everyMinute) {
    if (!windowStart || !windowEnd) {
      console.error(
        "Every-minute window mode needs both --window-start HH:MM and --window-end HH:MM " +
          "(or TSP_SCHED_WINDOW_START / TSP_SCHED_WINDOW_END)."
      );
      return 2;
    }

    let sh: number;
    let sm: number;
    let eh: number;
    let em: number;

    try {
      [sh, sm] = parseHHMM("window-start", windowStart);
      [eh, em] = parseHHMM("window-end", windowEnd);
    } catch (e) {
      console.error(String(e));
      return 2;
    }

    const exitAfter = !noExitAfter;
    let entered = false;
    let running = false;
    let stopRequested = false;

    const span = sh * 60 + sm <= eh * 60 + em ? "same calendar day" : "overnight (wraps past midnight)";
    const extra = exitAfter
      ? " Exits automatically after the window ends when no run is in progress."
      : " Runs until Ctrl+C.";

    const autoNote = values["every-minute"]
      ? ""
      : " (window mode inferred: both window start and end are set).";

    const logNote = noLogFile ? "no per-run log files (--no-log-file)" : `logs -> ${logDir}`;

    console.log(
      `route-solver-cli cron: every minute at :00, only between ${windowStart} and ${windowEnd} inclusive ` +
        `(${span}, local). ${logNote}.${extra}${autoNote}`
    );

    installSignalHandlers();

    while (!stopRequested) {
      const targetMinute = nextFullMinuteDate();
      const launchAt = new Date(targetMinute.getTime() - prelaunchMs);

      await sleep(msUntil(launchAt));

      const inW = inTimeWindow(targetMinute, sh, sm, eh, em);

      if (inW) {
        entered = true;
        running = true;

        console.log(
          `[schedule] target minute=${targetMinute.toISOString()} ` +
            `launch=${new Date().toISOString()} ` +
            `prelaunchMs=${prelaunchMs}`
        );

        try {
          await runDailySolve(logDirForRuns, cliPath, childFlags, credentials, childCliArgv);
        } finally {
          running = false;
        }
      } else if (exitAfter && entered && !running) {
        stopRequested = true;
      }
    }

    console.log(`[${new Date().toISOString()}] Window finished; exiting.`);
    return 0;
  }

  const hour = parseInt(String(values.hour ?? "").trim() || process.env.TSP_SCHED_CRON_HOUR || "12", 10);
  const minute = parseInt(String(values.minute ?? "").trim() || process.env.TSP_SCHED_CRON_MINUTE || "0", 10);

  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    console.error("Invalid --hour/--minute or TSP_SCHED_CRON_HOUR / TSP_SCHED_CRON_MINUTE.");
    return 2;
  }

  let lastRunDay = "";
  const logNoteDaily = noLogFile ? "no per-run log files (--no-log-file)" : `logs -> ${logDir}`;

  console.log(
    `route-solver-cli cron: daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (local). ` +
      `${logNoteDaily}. Ctrl+C to stop.`
  );

  installSignalHandlers();

  for (;;) {
    await sleep(msToNextFullMinute());

    const now = new Date();

    if (now.getHours() !== hour || now.getMinutes() !== minute) continue;

    const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    if (dayKey === lastRunDay) continue;

    lastRunDay = dayKey;

    await runDailySolve(logDirForRuns, cliPath, childFlags, credentials, childCliArgv);
  }
}

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
});

process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
});

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });