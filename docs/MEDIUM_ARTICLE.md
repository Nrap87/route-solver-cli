# Routing a Galaxy Under Real Rules: Building a TSP Solver for Star Delivery

*Mandatory planets, forbidden zones, bonus fuel credits, and why timing the daily drop mattered as much as the algorithm.*

---

Every day, a fresh batch of routing challenges appears. You receive a map of planets scattered in 2D space, a catalog of **hyperspace lanes** between selected pairs (each lane type cuts fuel by a fixed fraction of straight-line distance—**main** lanes at **50%**, **other** lanes at about **66%**), and a mission brief: depart from a fixed home world, touch every required stop, avoid forbidden sectors, and optionally detour for bonus pickups that reduce your final fuel bill. The tour must be a **round trip**—you finish where you started—and a remote service decides whether your path is legal and how much fuel you actually spent.

On paper, that is the Traveling Salesperson Problem. In practice, it is a different beast.

This article describes a system I built to tackle [**Star Delivery**](https://wecode.outsystems.com/StarDelivery/) challenges on the OutSystems wecode platform—a TypeScript routing engine with a command-line runner and web dashboard, automated scheduling in the cloud, and a .NET library packaged for **OutSystems Developer Cloud** so the same mathematics can run inside a low-code application. The game is where we competed; access may require a wecode account depending on how your organization runs the program. Whether you care about constrained optimization, clean system boundaries, or the gap between “fast HTTP client” and “fast server,” I hope the journey is useful.

---

## The problem as an engineering specification

Picture the galaxy as a **complete graph**: every pair of planets has a baseline travel cost from Euclidean distance—the “full fare” leg. The game then publishes **named routes**: undirected pairs of planets that count as hyperspace lanes. Only those listed pairs get a multiplier; everything else stays at 100%.

**Route fuel multipliers (crisp up front, because every solver decision depends on them):**

| Route type (game label) | You pay | Versus straight-line distance |
|-------------------------|---------|-------------------------------|
| **Main route** | **50%** of full fare | ×0.5 |
| **Other route** | **~66%** of full fare (exactly **⅔**) | ×2/3 |
| No listed route between the pair | **100%** | ×1.0 |

So a “discount” here is not a vague bonus—it is one of two fixed ratios on specific edges. Choosing a tour means deciding not only *which* planets to visit, but whether your realized path can **use** those 50% and 66% legs often enough to beat a shorter-looking tour that flies mostly at full fare.

Each challenge then constrains the tour:

| Concept | What it means for the solver |
|--------|------------------------------|
| **Start planet** | First and last waypoint; the tour is closed |
| **Mandatory planets** | Must appear somewhere on the route |
| **Forbidden planets** | Removed from the graph—you cannot route through them |
| **Bonus planets** | Optional stops; each grants coaxium that lowers *effective* fuel |

Two fuel numbers matter. **Gross fuel** is the physical cost of every leg you fly. **Effective fuel** is gross minus the bonuses you collected along the way. Validation endpoints on the game API score submissions against both the geometry of your path and these accounting rules.

The deliverable is not an abstract permutation of “important” cities. It is a **concrete walk** over the full planet list—possibly hundreds of nodes—with intermediate worlds you were never asked to name explicitly.

---

## Why textbook TSP is not enough

In classical TSP you are given a cost matrix between the cities you will visit. Here, the cities that matter for the *story* of the challenge (start, mandatories, bonuses) are rarely neighbors in the underlying map. The cheapest way to go from mandatory A to mandatory B might weave through twenty silent planets whose only role is to make the metric distance small.

A workable pipeline has three conceptual stages:

**1. Build the physical graph.**  
Precompute direct leg costs for every planet pair (main **×0.5**, other **×⅔**, else **×1.0** on the straight-line distance).

**2. Close the metric.**  
From each strategically important planet, run shortest-path search across the full map (respecting forbidden nodes). You now know the true cheapest cost—and the actual path—to move between key locations, including through anonymous intermediates.

**3. Order, then realize.**  
Search over visit orders in that compressed metric space. Bonus planets turn the problem toward **orienteering**: which optional stops are worth detours? For each promising order, **realize** it on the real graph (see below).

An ordering that looks optimal on a tiny “key planet only” sketch can fail once embedded in the full galaxy. The implementation intentionally separates **metric scoring** from **physical embedding** so the numbers you submit match what a human would fly.

### What “realization” means — the step that makes or breaks your fuel

**Realization** is the move from a neat **visit order** on important planets to the **actual route** the game will score.

In metric space you might decide: *start → mandatory A → mandatory B → optional bonus C → start*. That is only five “stops” in the story of the challenge. It is **not** yet a legal submission. Between A and B the ship might need to pass through twelve other worlds just to traverse a **main** lane and pay **50%** fuel on that leg instead of full fare. Between B and C it might detour around a forbidden sector. Each leg must be a shortest safe path on the full map—hundreds of planets—not a single hop in the abstract graph.

**Realization** stitches those legs together:

- Walk segment by segment using precomputed shortest paths on the real galaxy.
- Respect **forbidden** planets (never use them as stepping stones).
- Avoid visiting the start planet again until the tour is meant to end.
- Avoid reusing planets illegally (only the start may appear twice, at the beginning and the end).
- Sum **gross fuel** along every flown edge and credit **bonuses** only when the route actually visits the bonus world.

Two different visit orders can have nearly the same metric cost yet **realize** to very different gross fuel once intermediate planets enter the picture. That is why the solver spends serious compute on realization—not only on picking the order. A beautiful permutation that never survives physical embedding is useless; the API validates the long path, not the headline.

If there is one idea to take from this article, it is this split: **ordering** guesses the choreography among key worlds; **realization** proves the dance is possible on the real star map and tells you the fuel bill.

Smaller challenges—few mandatories, no bonuses—deserve a cheaper algorithmic path. Larger ones fall back to a deeper search with a generous wall-clock budget (on the order of fifteen minutes) so a hard instance can still terminate with the best route found so far.

At the center sits a deliberately small entry point: try the fast mandatory-only solver when the shape of the input allows it; otherwise delegate to the full engine. That **bimodal strategy** is a pattern worth stealing anywhere your workload mixes “trivial” and “terrifying” cases in one API.

---

## Architecture: orchestration versus pure solve

The mistake I wanted to avoid was letting HTTP concerns, file formats, and platform packaging leak into the graph algorithm. The solver accepts a normalized problem description—planets, routes, start, mandatories, forbidden set, bonuses—and returns an ordered route plus fuel metrics. Everything else is plumbing.

```
┌───────────────────────────────────────────────────────────────┐
│  Orchestration                                                │
│  • Fetch map and challenge lists when needed                  │
│  • Authenticate to the game API                               │
│  • Schedule runs (local cron, CI, manual triggers)            │
└────────────────────────────┬──────────────────────────────────┘
                             │ normalized challenge + map
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  Adaptation                                                   │
│  • Unify JSON from files, REST payloads, and platform records │
│  • Same internal model regardless of source                   │
└────────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  Solver (TypeScript reference, C# port for cloud)             │
│  • Fast mandatory-only path OR full Held–Karp-style search    │
└────────────────────────────┬──────────────────────────────────┘
                             │ route + gross / effective fuel
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  Optional validation                                          │
│  • Dry-run fuel calculation on the server                     │
│  • Submit final solution when automation is enabled           │
└───────────────────────────────────────────────────────────────┘
```

The same core runs in four places without forking the math:

- A **CLI** for batch runs, regression against saved challenges, and unattended jobs.
- A **browser UI** that loads the shared solver in a worker so the main thread stays responsive during long searches.
- **GitHub Actions** workflows that install, build, and invoke the runner inside time-bounded windows—useful when you want a human trigger rather than a machine under your desk.
- An **ODC External Library** that exposes solve and summary operations to OutSystems apps; the low-code layer owns REST discovery, the library owns routing intelligence.

That last split is worth emphasizing for platform integrators: **fetch the daily data in the app; pass rows into custom logic; never hide silent HTTP inside the solver** if you care about testability and clear failure modes.

---

## What shipped, in plain terms

| Component | Purpose |
|-----------|---------|
| **TypeScript monorepo** | Reference solver, API client, CLI, web front end, test harness |
| **.NET ODC package** | Same algorithm packaged for upload to OutSystems Developer Cloud |
| **Automation** | Repeatable solves and optional submission inside scheduled CI windows |

The web dashboard is not a toy visualization—it reuses the exact solver the CLI calls, which is how you catch “works in the terminal, wrong in the browser” drift before it reaches production.

For OutSystems teams, the external library offers two capabilities at the boundary: aggregating challenge metadata for dashboards, and solving (then optionally validating or submitting) a single challenge when the app supplies map and row data. Product documentation for packaging such libraries lives on the [OutSystems External Libraries SDK](https://success.outsystems.com/documentation/outsystems_developer_cloud/building_apps/extend_your_apps_with_custom_code/external_libraries_sdk_readme/) site.

---

## Lessons from the trenches

These are the moments that taught me more than tuning a heap.

### Measure the network before polishing the client

I experimented with different HTTP stacks and connection pooling, including warming up TLS before the critical read of the daily challenge list. Round-trip times stayed around half a second per call. The limit was the service and the path over the internet—not a missing npm package.

**Lesson:** Instrument end-to-end latency before rewriting clients. Keep-alive and preconnect help cold starts; they do not rewrite physics.

### Time boundaries are a systems problem

Daily content rotates on clock edges. A scheduler that launches a fresh process every minute will always land a few milliseconds after the tick—startup, module loading, and event-loop jitter are real. The fix is layered: start the worker slightly early, preload the static map while waiting for the wall-clock boundary, then issue the time-sensitive fetch. Crucially, **timing behaviors must match the mode of the run**—optimizations meant for “fetch the new daily set from the API” should not activate when you are only solving against files you already have on disk. I learned that the hard way when a scheduler forwarded “wait until next minute” semantics into a offline regression path and the CLI rightly refused an incompatible combination.

### Do not cache what must be fresh

Disk caching of daily challenge responses made iterative development pleasant and competition runs wrong after the calendar rolled. I deleted the cache. For timed games, **staleness is a correctness bug**, not a performance feature.

### One algorithm, multiple runtimes

An earlier .NET experiment used a different strategy (progressive search with a “K ladder”). The production story converged on a single Held–Karp-style engine ported faithfully from TypeScript to C#. Regression suites built from historical challenges—with independently recorded target fuel values—were the contract between runtimes.

### Packaging is its own mini-project

Publishing a library for ODC means compiling for the right target, gathering dependencies, and producing an archive the portal accepts. Tooling quirks (progress bars in embedded terminals, archive overwrite prompts) look like catastrophic failures but are often environmental. Treat release mechanics as part of the definition of done, not an afterthought.

---

## Knowing it worked

Confidence came from **oracle tests**: hundreds of challenge snapshots where an expected effective fuel was known from prior successful runs. The solver had to match those targets after full physical realization—not merely beat a relaxed lower bound in metric space.

That discipline made automation believable. The same code path that lit up green in continuous integration was the one that ran at night against the live API.

---

## Honest limits — where it stacks up, where it blows up

This is sophisticated heuristic search, not a proof of global optimality. The engine is built for the real Star Delivery galaxy—on the order of **two hundred planets**—and for daily challenges that mix a handful of mandatories with a variable number of optional bonuses. That scale is comfortable for building the dense cost matrix and running shortest-path work from each important planet. The pain arrives when **combinations** pile up, not when the map is large.

### Where the approach stacks well

**Tiny mandatory-only challenges.**  
When there are at most **three** non-start mandatories and **no optional bonus planets**, a dedicated fast path tries to solve the instance without entering the heavy search. Many daily levels fit this shape; they finish quickly and predictably.

**Moderate “forced” tours.**  
The deep search is at its best when the number of nodes that must appear on the tour—start, every mandatory, plus whichever optional bonuses are currently selected—is at most about **eleven**. In that band the solver can enumerate many visit **orderings** in metric space (best-first, pruned by cost), realize each ordering on the full map, and keep the best physically valid route. That was the sweet spot for most competition dailies I cared about.

**Warm starts and pruning.**  
Even inside the heavy path, work is not blind brute force. A dynamic-programming pass over key planets proposes bonus subsets and a first ordering; that result seeds an upper bound so worse orderings are cut early. Physical routing uses lower-bound suffix costs so unpromising partial paths die before they consume the whole budget.

**Start-only edge case.**  
No mandatories and no bonuses reduces to “stay home”: zero fuel, instant success.

### Where combinations blow up

**Optional bonuses multiply subsets.**  
Each optional bonus planet is a yes/no decision: visit or skip. With **B** optional bonuses there are **2^B** subsets to consider (every combination of which bonuses to include). Five optional stops already mean **32** masks; ten mean **1,024**. The outer loop walks those masks; inside each mask the solver still has to route and score. This is the dominant combinatorial explosion in bonus-rich dailies.

**Ordering search is factorial when the tour is “small enough.”**  
For a fixed bonus subset, if the forced tour has at most **eleven** nodes, the ordering generator explores permutations in increasing lower-bound cost—roughly **(k−1)!** possibilities in the worst case before pruning. At **eleven** nodes that is on the order of millions of orderings *in principle*; pruning and cutoffs usually shrink that sharply, but pathological instances can still grind.

**Large forced tours fall back to a single ordering.**  
When start + mandatories + selected bonuses exceed **eleven** forced stops, the solver **stops enumerating alternative orderings** for that subset. It keeps only the ordering suggested by the metric dynamic program and tries to realize that one path on the full graph. You still get a valid route if realization succeeds, but you may miss a better permutation you never considered. Challenges that stack many mandatories *and* several bonuses in one day are the risky zone.

**Hard ceilings in the implementation.**  
Several limits are explicit rather than graceful degradation:

| Guardrail | Rough meaning |
|-----------|---------------|
| **~30 key nodes** | Bitmask dynamic programming over visit states cannot exceed about thirty key planets; beyond that the code refuses the instance.|
| **~120k DP states per realization** | Each attempt to embed an ordering on the full map caps internal state space; very tangled realizations are abandoned (`null`) rather than explored forever. |
| **~1M heap pushes per realization** | The physical router uses a fixed-capacity priority queue; extremely branchy segments stop expanding when the heap fills. |
| **15-minute wall clock** | The entire solve aborts with the best route found so far (or failure if none), marked as timed out. |

**Physical realization is the hidden cost.**  
Even when ordering search looks small on paper, **realizing** one ordering runs shortest-path segment logic on the full planet set, sometimes with extra state to track bottleneck planets that appear often on metric paths. A single ordering is cheap; thousands of orderings across dozens of bonus masks is not.

**Forbidden planets and disconnected logic.**  
Forbidden nodes are removed from routing, but inconsistent challenge data (mandatory also forbidden, start missing from the map) fails fast with a clear error rather than a partial tour.

### How to read a challenge before you trust the output

| Shape | Typical behaviour |
|-------|-------------------|
| 0–3 mandatories, 0 optional bonuses | Fast path; seconds |
| Few mandatories, 1–4 optional bonuses | Heavy path, manageable 2^B masks |
| Many optional bonuses (8+) | Mask count explodes; timeout risk rises |
| Many mandatories + bonuses (forced tour > 11) | Single ordering per mask; quality may plateau |
| Bonus-heavy + tight fuel race | May return **best so far** after timeout, not proven optimum |

None of this means the solver is wrong on typical dailies—it means **knowing the combinatorics** explains why some days felt instant and others chewed most of the fifteen-minute budget while the UI spinner kept turning.

### What I would improve next

Parallelizing independent challenges after fetch (each day’s levels are embarrassingly parallel once data is local), surfacing **best-so-far** routes during long runs, and logging solve time versus oracle fuel gap would turn these limits from folklore into metrics—not only in competition retrospectives.

---

## How it ended — and what mattered more than the podium

When the competition closed, I had not taken first place, and I was not on the top three. I finished **fourth**. I am proud of that. Not because fourth is “close enough” to winning, but because it marks a position earned after weeks of dead ends, rewrites, and runs that failed in ways I did not understand on day one.

**↓ Insert leaderboard image here in Medium (see note below — do not rely on markdown image links).**

*Figure: Final **Galaxy Leaderboard** on wecode—season standings after a 14-day run with three challenge levels each day and only your best four days counted. Top five: Sushi Simba 2400, Pako 2399, María 2397, Nelson Pinto 2382, Eduardo Ribeiro 2375.*

The scoreboard tells a quieter story than the ranks suggest. The top five were separated by **25 points** across thousands of coaxium decisions—third and fourth only **15 points** apart. That is not a comfortable gap when you are reflecting on what you might have done differently; it is proof the competition was genuinely tight, and that small improvements in routing and consistency compound. Seeing my name there as **Nelson Pinto** in fourth, with **María** one step above on the podium, grounds everything in this article in something real—not a thought experiment, but a season that ended on a starfield with names attached.

The prize table was never the point. What stayed with me was the **learning**: how metric closure differs from a pretty permutation, why a fast path and a slow path can share one entry point, when to delete a cache because correctness beats convenience. It was the **evolution** of the system—from a script that sometimes worked to a tested core reused in a browser, a scheduler, and a cloud library. It was the slow **understanding** that half a second of API latency is not a challenge you solve with another npm package. Above all, it was the habit of **not giving up** when a challenge shape broke the solver or a cron job fired three milliseconds too late. Fourth place is simply where that persistence landed on the scoreboard.

I did not get there alone.

**María** finished **third**—on the podium I was looking up at. She deserves more than a footnote in my story. When enthusiasm dipped, she was the colleague who encouraged me to try again. She shared knowledge openly: how she structured her client, how she thought about fetching and composing challenges, what her code was doing when mine stalled. Looking at her approach did not mean copying it; it meant seeing another valid way to attack the same problem and borrowing the courage to change my own design. That spirit—competitive when it counts, generous in between—is rare. A sincere thank-you and a round of applause for María, for her **warrior spirit** and for lifting others while she climbed.

If you read this far as a builder facing a hard, fuzzy problem: the rank at the end is one number. The graph you understand at the end is the real trophy.

---

## What I would tell another builder

The memorable work was not reciting dynamic programming on a whiteboard. It was translating **game rules** into invariants the code could enforce: closed tours, forbidden subgraphs, optional prizes, edges at **50% / 66% / 100%** of Euclidean distance, and fuel accounting that must match the server’s arithmetic.

If you are integrating a custom optimizer behind an API you do not control—or a low-code platform that will outlive any single script—**separate orchestration from mathematics early**. Schedulers, credentials, zip uploads, and UI frameworks will churn. The graph should not.

---

### Glossary

- **Gross fuel** — Sum of leg costs along the flown path.  
- **Effective fuel** — Gross fuel minus bonus coaxium collected on the route.  
- **Main route / Other route** — Listed planet pairs billed at **50%** or **⅔** (~66%) of straight-line distance; see the multiplier table in *The problem as an engineering specification*.  
- **Metric closure** — Shortest-path costs between important planets, allowing any legal intermediate worlds.  
- **Realization** — See *What “realization” means* above: turning a key-planet visit order into the full scored path on the galaxy map.  
- **Oracle test** — A case where an independent reference fuel value is known and the solver must reproduce it.

### Technologies involved

TypeScript, Node.js, Vitest, React, Vite, GitHub Actions, .NET 8, and the OutSystems External Libraries SDK—united by one routing core, not six competing implementations.

---

*Implementations live in the **route-solver-cli** and **RouteSolver-Cli-DotNet-ODC** projects. Store API credentials in environment configuration or your platform’s secret store; never embed them in source control.*

*The challenge we took on: [Star Delivery on wecode](https://wecode.outsystems.com/StarDelivery/).*
