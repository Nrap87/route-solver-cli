# Route Solver CLI

Held–Karp style **Star Delivery** route solver, packaged as a **Node CLI**, optional **REST integration** with OutSystems Star Delivery services, and a small **React + Vite** dashboard for daily challenges.

## What problem this solves

**Star Delivery** challenges give you a **map of planets** (2D coordinates), **hyperspace routes** between some pairs (with cheaper travel along those lanes), and a **challenge definition**: a start planet, planets you **must** visit, planets you **must not** visit, and optional **bonus stops** that credit fuel when visited.

The solver’s job is to produce a **round trip** that:

- Begins and ends at the required start planet  
- Visits every **mandatory** planet at least once  
- Never uses **forbidden** planets as stops (they are removed from routing)  
- May optionally visit **bonus** planets to reduce **effective** fuel cost  

**Fuel** is computed from **Euclidean** distances between planets. Every pair of planets is implicitly connected; if the game lists a **main** or **other** route for a pair, that edge uses a **discounted** multiplier (`buildCostMatrix` in `costMatrix.ts` matches the usual Star Delivery rules: main and other routes shave cost relative to the straight-line distance).

Because you can leave the “key” planets and cross the full graph in between, the implementation works on a **metric closure**: shortest-path costs between important nodes, then **ordering** those visits. Candidate orderings are scored in metric space, then many are **physically realized** on the full planet graph (actual shortest paths segment by segment) so the final route and **gross** / **effective** fuel match real movement—not just the simplified complete graph over key nodes.

The public entry point is `solve()` in `src/solver/solve.ts`: tiny mandatory-only challenges use a **fast path**; everything else goes through **`heldKarpSolve`**, which combines timeout limits, optional **orienteering** DP for bonus subsets, and a **Held–Karp–style** best-first generator over orderings (`heldKarp.ts`).

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

If you use a **Web Service** instead of a static site, set the build command the same way, then set the start command to something that serves `web/dist` (for example install `serve` and run `npx serve web/dist -s -l $PORT`), or run `npm run web:preview` / `npm run web:dev` after `web:install` — **`web/vite.config.ts` binds `host: true` (all interfaces) and uses `process.env.PORT` when set**, which is what Render expects for health checks. Prefer a **Static Site** + `web/dist` when you do not need a long-lived Node process.

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
| `src/solver/` | Types, Held–Karp pipeline, `solve()` — see **`src/solver` module reference** below |
| `challenges/` | Example challenge JSON; **`challenges/challenges_all_with_fuel.json`** adds **`realFuel`** per challenge for solver regression checks |
| `web/` | Vite + React dashboard |

Test files under `src/solver/__tests__/` use Vitest-style `describe` / `it` / `expect` APIs; they are excluded from the default `tsc` build (add Vitest—or another runner—and a script when you want CI to execute them). Each file is summarized in the **Unit tests** subsection below.

**`realWorld.test.ts`** is driven only by **`challenges/challenges_all_with_fuel.json`** and **`realWorld.fixture`**: each row with **`realFuel`** is converted to **`SolveInput`** via **`recordToChallenge`** and **`challengeToSolveInput`**, then **`solve`** must satisfy **`Math.round(effectiveFuel) === Math.round(realFuel)`** (long per-case timeout for heavy instances).

## `src/solver` module reference

| File | Role |
|------|------|
| **`types.ts`** | Core data contracts: `Planet`, `Route`, `Bonus`, `SolveInput` (everything the solver needs from a challenge + map), and `SolveResult` (ordered planets, gross/effective fuel, bonus total, errors / timeout). |
| **`edgeCost.ts`** | Shared geometry and routing helpers: Euclidean distance, canonical undirected `routeKey` for edges, optional **`edgeCost`** / **`buildRouteSets`** when you need costs without building a full matrix. |
| **`costMatrix.ts`** | Builds a dense **`n × n`** `Float64Array` of direct leg costs between all planets from coordinates + route discounts (`main` / `other`). Exposes `idToIdx` / `idxToId` for dense ↔ API id mapping. |
| **`allPairsSP.ts`** | Shortest paths **from each key source** (start / mandatory / bonus nodes) over the dense cost matrix: **O(k·n²)** Dijkstra with **linear min-selection** (no global Floyd–Warshall). Forbidden planets are excluded as nodes. Emits per-source **cost** rows and **path** reconstruction for realizing legs. |
| **`heap.ts`** | Generic **`MinHeap<T>`** (binary heap, parallel priority/value arrays). The hot paths in **`heldKarpGen`** and realization in **`heldKarpSolve`** use **specialized inlined heaps** instead of this class. |
| **`heldKarp.ts`** | **`heldKarpGen`**: best-first expansion of **round-trip visit orderings** over key nodes using metric-closure costs and an **inlined parallel-array min-heap**, with **`maxCost`** pruning. Yields orderings in non-decreasing lower-bound cost (see file comment—**not** classical Held–Karp DP on `(mask, last)`). |
| **`orienteeringDP.ts`** | Standalone **orienteering-style DP** (`orienteeringDPCandidates`). **`heldKarpSolve`** currently uses an **inlined** `orienteeringDPCandidates` with the same role (bonus subsets + metric ordering); this file is not imported by the main pipeline. |
| **`selectiveTsp.ts`** | Another DP (**`selectiveTspCandidates`**) for selective TSP-style tours with per-node bonuses in metric space. It is **not** imported by `solve()` / `heldKarpSolve` today; kept as a self-contained algorithm module for experiments or future wiring. |
| **`mandatoryOnlySolve.ts`** | Fast path for **very small** instances: at most three mandatory planets (excluding start), **no** bonus planets. Enumerates safe mandatory-only routes using blocked Dijkstra-style shortest paths on the dense matrix. Exported as **`trySolveSmallMandatoryOnly`** (returns `null` if it declines). |
| **`heldKarpSolve.ts`** | Main solver: cost matrix, **key-source** all-pairs SP, inlined **orienteering DP** for bonus subsets, **`heldKarpGen`** for orderings, **physical realization** (typed DP / heap caps in-file), fuel accounting, and **`TIMEOUT_MS`**. |
| **`solve.ts`** | Facade **`solve(input)`**: tries the mandatory-only fast path when input matches its guard, otherwise logs and delegates to **`heldKarpSolve`**. |
| **`adapters.ts`** | Maps **Star Delivery OpenAPI** shapes (`PlanetOut`, `RouteOut`, `ChallengeOut`) into internal **`SolveInput`**, plus **`toPlanetSimple`** for API responses. |
| **`solver.worker.ts`** | Browser **Web Worker** entry: receives a `SolveInput` via `postMessage`, runs **`solve`**, posts back `{ ok, result }` or an error string. |

### Unit tests (`src/solver/__tests__/`)

| File | Role |
|------|------|
| **`solver.test.ts`** | Vitest coverage for **`buildCostMatrix`**, **`computeAllPairsSP`**, **`heldKarpGen`**, and end-to-end **`solve`** on small hand-crafted maps (discounts, mandatories, bonuses, forbidden nodes). |
| **`adapters.test.ts`** | Tests **`adaptPlanet`**, **`adaptRoute`**, **`adaptChallenge`**, and **`toPlanetSimple`** against representative API-shaped payloads. |
| **`realWorld.fixture.ts`** | Static snapshot of **GetPlanetsAndRoutes**–style planets and routes (full game galaxy) used as shared test data. |
| **`realWorld.test.ts`** | **`solve`** regression on the full **`realWorld.fixture`** galaxy: every challenge in **`challenges/challenges_all_with_fuel.json`** that includes **`realFuel`** must match **`Math.round(effectiveFuel)`** (long per-case timeout for heavy instances). |

## Default REST host

If no base URL is configured, the client targets:

`https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices`

Use your own base URL for other environments or self-hosted stacks.

## Security note

Do **not** commit real `PLAYER_GUID` / credentials or checked-in secrets. Use environment variables or local `.env` files that are listed in `.gitignore`.
