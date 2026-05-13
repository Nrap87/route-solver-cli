#!/usr/bin/env npx tsx
/**
 * Schedule `node dist/cli.js --daily-api` (Star Delivery map + GetDailyChallenge + optional POST).
 *
 * Every-minute + wall-clock window (supports overnight):
 *   npm run tsp-cron -- --every-minute --window-start=00:59 --window-end=01:10 --log-dir=C:\tsp_logs
 *
 * Credentials: PLAYER_GUID, PLAYER_EMAIL (optional STAR_DELIVERY_BASE_URL / VITE_API_BASE_URL) — inherited by the child,
 * or pass --player-guid / --player-email on this script (same forms as argvLongFlag: --name=value or --name value); they are merged into the child process env.
 *
 * Env: TSP_SCHED_WINDOW_START / TSP_SCHED_WINDOW_END (HH:MM)
 *      TSP_SCHED_LOG_DIR
 *      TSP_SCHED_SUBMIT=1 → forward --submit
 *      TSP_SCHED_CALCULATE_COAXIUM=1 → forward --calculate-coaxium
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(join(__dirname, ".."));
const DEFAULT_CLI = join(PKG_ROOT, "dist", "cli.js");

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
    throw new Error("Use only one of --submit or --calculate-coaxium on the child CLI (same as route-solver-cli).");
  }

  return { submit, calculateCoaxium };
}

function stripArgQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
  }
  return t;
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

function msToNextFullMinute(): number {
  const d = new Date();
  const next = new Date(d);
  next.setMinutes(next.getMinutes() + 1, 0, 0);
  return Math.max(1, next.getTime() - d.getTime());
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

function buildCliArgs(cliPath: string, child: ChildFlags): string[] {
  const args = [cliPath, "--daily-api"];
  if (child.submit) args.push("--submit");
  if (child.calculateCoaxium) args.push("--calculate-coaxium");
  return args;
}

/** Merge optional cron argv credentials into env for the dist/cli.js child (that process only reads env + its own argv). */
function childEnvWithCredentials(extra: { playerGuid?: string; playerEmail?: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const g = extra.playerGuid?.trim();
  const e = extra.playerEmail?.trim();
  if (g) env.PLAYER_GUID = g;
  if (e) env.PLAYER_EMAIL = e;
  return env;
}

/**
 * One run: `node dist/cli.js --daily-api` (+ submit / calculate-coaxium), stdout/stderr tee to log file.
 */
async function runDailySolve(
  logDir: string,
  cliPath: string,
  child: ChildFlags,
  credentials: { playerGuid?: string; playerEmail?: string }
): Promise<number> {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `route_solver_cron_${logFileStamp()}.log`);
  const logStream: WriteStream = createWriteStream(logPath, { flags: "w", encoding: "utf8" });

  const args = buildCliArgs(cliPath, child);
  const childEnv = childEnvWithCredentials(credentials);
  const header =
    `start ${new Date().toISOString()}\n` +
    `cwd: ${PKG_ROOT}\n` +
    `cmd: ${process.execPath} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n\n`;
  logStream.write(header);

  console.log(`[${new Date().toISOString()}] starting daily-api -> ${logPath}`);

  return new Promise<number>((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, args, {
      cwd: PKG_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pipe = (chunk: Buffer, out: NodeJS.WriteStream) => {
      out.write(chunk);
      logStream.write(chunk);
    };

    proc.stdout?.on("data", (c: Buffer) => pipe(c, process.stdout));
    proc.stderr?.on("data", (c: Buffer) => pipe(c, process.stderr));

    proc.on("error", (err) => {
      logStream.write(`\nspawn error: ${err}\n`);
      logStream.end();
      rejectPromise(err);
    });

    proc.on("close", (code, signal) => {
      const exit = code ?? (signal ? 1 : 0);
      logStream.write(`\nend ${new Date().toISOString()} exit=${exit}\n`);
      logStream.end();
      console.log(`[${new Date().toISOString()}] finished exit=${exit} log=${logPath}`);
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
      "every-minute": { type: "boolean", default: false },
      "window-start": { type: "string", default: "" },
      "window-end": { type: "string", default: "" },
      "no-exit-after-window": { type: "boolean", default: false },
      "log-dir": { type: "string", default: "" },
      hour: { type: "string", default: "" },
      minute: { type: "string", default: "" },
      "run-once": { type: "boolean", default: false },
      "cli-path": { type: "string", default: "" },
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
    console.error(
      `[schedule] window start = ${windowStart} (TSP_SCHED_WINDOW_START=${envWinStart} overridden by CLI)`
    );
  }
  if (envWinEnd && windowEnd !== envWinEnd) {
    console.error(`[schedule] window end = ${windowEnd} (TSP_SCHED_WINDOW_END=${envWinEnd} overridden by CLI)`);
  }

  const everyMinute =
    argvHasEveryMinute() ||
    Boolean(values["every-minute"]) ||
    (windowStart.length > 0 && windowEnd.length > 0);
  const noExitAfter = Boolean(values["no-exit-after-window"]);

  const logDirFlag = (argvLongFlag("log-dir") ?? String(values["log-dir"] ?? "").trim()).trim();
  const logDirPos = positionals[0]?.trim() ?? "";
  const logDirRaw =
    logDirFlag ||
    logDirPos ||
    process.env.TSP_SCHED_LOG_DIR?.trim() ||
    join(PKG_ROOT, "logs");
  if (positionals.length > 1) {
    console.error("Warning: extra positional arguments ignored (only first is used as log-dir if --log-dir is omitted).");
  }
  const logDir = isAbsolute(logDirRaw) ? resolve(logDirRaw) : resolve(PKG_ROOT, logDirRaw);

  const cliPath = resolve(String(values["cli-path"] ?? "").trim() || DEFAULT_CLI);

  if (!existsSync(cliPath)) {
    console.error(`Missing CLI at ${cliPath}. From package root run: npm run build`);
    return 1;
  }

  if (process.env.TSP_SCHED_DEBUG?.trim()) {
    console.error("[schedule] argv:", JSON.stringify(process.argv));
  }

  if (values["run-once"]) {
    return await runDailySolve(logDir, cliPath, childFlags, credentials);
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
      ? " Exits automatically after the window ends (when no run is in progress)."
      : " Runs until Ctrl+C.";
    const autoNote = values["every-minute"]
      ? ""
      : " (window mode inferred: both window start and end are set).";
    console.log(
      `route-solver-cli cron: every minute at :00, only between ${windowStart} and ${windowEnd} inclusive ` +
        `(${span}, local). Logs -> ${logDir}.${extra}${autoNote}`
    );

    installSignalHandlers();

    while (!stopRequested) {
      await sleep(msToNextFullMinute());
      const now = new Date();
      const inW = inTimeWindow(now, sh, sm, eh, em);
      if (inW) {
        entered = true;
        running = true;
        try {
          await runDailySolve(logDir, cliPath, childFlags, credentials);
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

  const hour = parseInt(
    String(values.hour ?? "").trim() || process.env.TSP_SCHED_CRON_HOUR || "12",
    10
  );
  const minute = parseInt(
    String(values.minute ?? "").trim() || process.env.TSP_SCHED_CRON_MINUTE || "0",
    10
  );
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    console.error("Invalid --hour/--minute or TSP_SCHED_CRON_HOUR / TSP_SCHED_CRON_MINUTE.");
    return 2;
  }

  let lastRunDay = "";
  console.log(
    `route-solver-cli cron: daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (local). ` +
      `Logs -> ${logDir}. Ctrl+C to stop.`
  );

  installSignalHandlers();

  for (;;) {
    await sleep(msToNextFullMinute());
    const now = new Date();
    if (now.getHours() !== hour || now.getMinutes() !== minute) continue;
    const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (dayKey === lastRunDay) continue;
    lastRunDay = dayKey;
    await runDailySolve(logDir, cliPath, childFlags, credentials);
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
