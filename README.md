# Route Solver CLI

Held–Karp style **Star Delivery** route solver (solver logic aligned with [majos95/route-solver-web](https://github.com/majos95/route-solver-web)), packaged as a **Node CLI**, optional **REST integration** with OutSystems Star Delivery services, and a small **React + Vite** dashboard for daily challenges.

## Requirements

- **Node.js** ≥ 18.19

## Install and build

From the repository root:

```bash
npm install
npm run build
```

This compiles TypeScript from `src/` to `dist/` (NodeNext / ESM). A short usage summary is printed to stderr if you run the CLI without a valid mode (for example with no arguments). See **CLI usage** below for concrete examples.

```bash
npm run solve -- --daily-api --player-guid "<guid>" --player-email "<email>"
```

(Pass CLI arguments after `--` so npm forwards them to `node dist/cli.js`.)

## CLI usage

Credentials and base URL can be passed as flags or environment variables:

| Variable | Purpose |
|----------|---------|
| `STAR_DELIVERY_BASE_URL` or `VITE_API_BASE_URL` | REST root (trailing slashes stripped) |
| `PLAYER_GUID` | Player GUID header |
| `PLAYER_EMAIL` | Player email header |

Flags: `--base-url`, `--player-guid`, `--player-email` override env when provided.

### Local map + challenge JSON

```bash
node dist/cli.js --map path/to/data.json --challenge path/to/challenges.json
```

You can pass multiple `--challenge` files. The map file must include `Planets` / `planets` and `Routes` / `routes` in the same shape as a `GetPlanetsAndRoutes` export.

### API map + local challenges

Loads the galaxy from the API, then solves each challenge from your JSON files:

```bash
node dist/cli.js --api-map --challenge challenges/challenges_0805.json ^
  --player-guid "<guid>" --player-email "<email>"
```

(On Unix, replace `^` with `\`.)

### Daily challenges from the API

Fetches **GetPlanetsAndRoutes** and **GetDailyChallenge**, sorts by `ChallengeId`, and solves each row:

```bash
node dist/cli.js --daily-api --player-guid "<guid>" --player-email "<email>"
```

Optional **POST** (exactly one per run):

- `--calculate-coaxium` — calls **CalculateCoaxium** with the solved route (oracle / dry run).
- `--submit` — calls **SubmitChallengeSolution** to persist.

### Active level daily (read-only)

Prints **GetActiveLevelDailyChallenge** JSON to stdout:

```bash
node dist/cli.js --active-level-daily --player-guid "<guid>" --player-email "<email>"
```

## Challenge JSON shapes

Challenge lists are normalized by `entriesFromChallengeDocument` (see `src/challengeDocument.ts`). Supported shapes include:

- A **top-level array** of challenge objects.
- An object with **`items`**, **`challenges`**, **`Challenges`**, **`data`**, or **`Data`** holding that array.
- **Legacy / compact** rows: `StartPlanetId`, `MandatoryPlanetIds`, `ForbiddenPlanetIds`, `BonusStops` (`planetId` + `value`).
- **API-style** rows: `ChallengeName`, string `StartPlanetId`, `MandatoryPlanets` / `ForbiddenPlanets` (`PlanetId` + `Name`), `BonusPlanets` (`PlanetId`, `Name`, `Bonus`), `IsFinished`.

`src/adapt.ts` (`recordToChallenge`) maps these into the internal shape consumed by the solver.

Sample files live under **`challenges/`** (bundled into the web UI at build time via Vite).

## Web UI

```bash
cd web
npm install
npm run dev
```

From the repo root you can install web dependencies and run the dev server with:

```bash
npm run web:install
npm run web:dev
```

By default the dev server proxies API calls under **`/__api`** to avoid CORS (see `web/vite.config.ts`). Override the upstream with `VITE_PROXY_TARGET` or `VITE_API_BASE_URL` in `web/.env` if needed.

Production build:

```bash
npm run web:install   # once, or if web/package.json changed
npm run web:build
```

The UI loads the map and daily list from Star Delivery (or bundled challenge files), runs the **same** `solve()` as the CLI, and can batch **Calculate Coaxium** / **Submit** for all challenges.

### Deploying the web app (e.g. Render)

If you see **`vite: not found`** (exit 127), it is almost always because:

1. **Only the root `npm install` ran** — `vite` is declared in **`web/package.json`**, so dependencies must be installed there too (`npm install --prefix web`, or use the script below).
2. **`npm run web:dev` is not a production command** — it starts the Vite *development* server. On Render you normally **build** static assets and host `web/dist`, or run `vite preview` behind a process manager—not `web:dev`.

**Recommended: Render Static Site**

| Setting | Value |
|--------|--------|
| Build command | `npm run render:build` |
| Publish directory | `web/dist` |

`render:build` runs root install, **`web/` install** (so `vite` exists), then `vite build`.

If you use a **Web Service** instead of a static site, set the build command the same way, then set the start command to something that serves `web/dist` (for example install `serve` and run `npx serve web/dist -s -l $PORT`), or run `cd web && npx vite preview --host 0.0.0.0 --port $PORT` only if `web/node_modules` is present from the build step and dev dependencies were not pruned.

## npm scripts (root)

| Script | Description |
|--------|-------------|
| `npm run build` | `tsc` → `dist/` |
| `npm run solve` | `node dist/cli.js` (pass args after `--`) |
| `npm run web:install` | `npm install` in `web/` (installs Vite, React, etc.) |
| `npm run web:dev` | Vite dev server in `web/` |
| `npm run web:build` | Production build of `web/` |
| `npm run render:build` | Root + `web/` install, then `web:build` (for Render / CI) |
| `npm run web:preview` | Preview production build |
| `npm run tsp-cron` | Cron helper (`scripts/run-cron.mjs`) |

## Repository layout

| Path | Role |
|------|------|
| `src/cli.ts` | CLI entry |
| `src/api.ts` | Star Delivery REST helpers |
| `src/adapt.ts` | JSON / API → solver models |
| `src/challengeDocument.ts` | Challenge list JSON normalization |
| `src/solver/` | Types, Held–Karp pipeline, `solve()` |
| `challenges/` | Example challenge JSON |
| `web/` | Vite + React dashboard |

Solver unit tests live under `src/solver/__tests__/` and are excluded from the default `tsc` build; run them with your preferred test runner if you wire one in.

## Default REST host

If no base URL is configured, the client targets:

`https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices`

Use your own base URL for other environments or self-hosted stacks.

## Security note

Do **not** commit real `PLAYER_GUID` / credentials or checked-in secrets. Use environment variables or local `.env` files that are listed in `.gitignore`.
