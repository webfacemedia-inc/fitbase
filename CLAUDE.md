# CLAUDE.md — FitBase (custom-binary app on webface.cloud)

FitBase is **not** a stock buildless app anymore. It runs a **custom Go PocketBase binary**
(`server/`) on webface.cloud via the platform's generic `custom` template — the same path Barclay
uses. This unlocks server-side code: the AI coach routes (`/api/ai/*`) call Claude with the Anthropic
key held server-side in `app.env`, never in the browser. See `docs/DESIGN.md` and the approved plan.

## Two halves of this repo

- **Frontend (repo root):** the buildless SPA — `index.html`, `app.css`, `app.js`, vendored
  `pocketbase.umd.js`. Still deploys via the git webhook into the app's `pb_public/`. Same-origin
  `new PocketBase('/')`. Escape all DB strings before DOM insertion.
- **Backend (`server/`):** a separate Go module (`fitbase.webface.cloud/server`) importing the
  platform via `replace webface.cloud/platform => ../../webface-cloud`. `pbbrand.Bind` gives it the
  branded admin, SMTP/appURL env fallbacks, and row retention for free. It serves `pb_public/` with
  SPA fallback (same smart root as the stock binary) and owns the custom routes.

## Building & shipping the binary

The binary is built and placed by an operator (NOT the git webhook, which only ships the frontend):

```bash
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o fitbase .
scp fitbase root@137.184.160.83:/srv/platform/binaries/fitbase
ssh root@137.184.160.83 'systemctl restart wfc-fitbase'   # unit already points at /binaries/fitbase
```

The fitbase `apps` record is `template=custom, binary=fitbase`; the systemd unit runs
`/srv/platform/binaries/fitbase serve --http 127.0.0.1:9005 --dir /srv/platform/apps/fitbase/pb_data`.
Same `pb_data` as before, so data survives binary swaps. Requires the webface-cloud checkout beside
this repo (`../webface-cloud`) to build.

## Server-side config (app.env on the droplet)

`/srv/platform/apps/fitbase/app.env` carries (in addition to the platform's `WFC_APP_*`/`WFC_SMTP_*`):
`ANTHROPIC_API_KEY`, `AI_MODEL_FREE`, `AI_MODEL_PAID`, `WFC_COMP_EMAILS` (owner comp accounts,
default `tommyadeniyi@gmail.com`), and later the Stripe keys. Secrets live only here — never in the
repo or the SPA.

## Collections

`exercises` (public read; 1,324 seeded), `workouts`/`sessions` (owner-only). Planned:
`gym_profiles` (My Gym equipment), `memberships`/`invites`/`services`/`engagements` (coach
marketplace). Rules and new collections are made in `/_/` or via the binary's migrations.

## SDK patterns (PocketBase JS) — unchanged

```js
const pb = new PocketBase('/');
await pb.collection('users').authWithPassword(email, password);
await pb.send('/api/ai/plan', { method: 'POST', body: { goal, days_per_week, experience } });
```

## Search (FTS5) — wired into the AI coach (2026-08-08)

`exercises` is indexed upstream in `searchedCollections`
(`webface-cloud/pbbrand/search.go`): name 10, target 6, body_part 5,
muscle_group 5, equipment 4, category 3. **To activate on the droplet set
`WFC_SEARCH_ENABLED=1` in `/srv/platform/apps/fitbase/app.env`** — it is OFF by
default fleet-wide because the module runs DDL.

**The payoff is NOT the search box — it is `selectCandidates` in `server/ai.go`.**
The library filter is client-side over a 1,324-row array already in memory;
FTS5 cannot make that faster. What FTS5 fixes is *which exercises the model is
allowed to prescribe*: BM25 ranks the catalogue against the user's goal text,
so "shoulder press for delts" surfaces shoulder work instead of an
equipment-filtered alphabetical sample. Measured on a 300-exercise fixture:
**8 relevant candidates → 43**, with leg work retained for balance.

**Search is a bonus, never a dependency.** `WFC_SEARCH_ENABLED` is off by
default and the index may not exist, so `goalRankedCandidates` returns nil on
any failure and the equipment + diversity spread carries the plan.
`TestWorksWithSearchDisabled` and `TestSearchIndexFailureIsNotFatal` hold that
line — do not let plan generation start depending on FTS5.

**Use `SearchCollectionAny` (OR), not `SearchCollection` (AND), for goal text.**
A goal is prose, not a search box: "shoulder press **for** delts" contains a
word in no exercise, and ANDing every token drops the result set to **zero**.
The first cut of this code did exactly that and silently returned nothing while
every test still passed — the tests now assert the goal *changes* the result,
which is the only assertion that catches it.

### Two adjacent fixes shipped at the same time

- **Candidate truncation (real bug).** The fetch was `sort:"name" limit:800`
  against a 1,324-row catalogue, so every exercise sorting after the cutoff was
  invisible to the coach — on a 900-row fixture the model saw only `deltoids`
  and `quadriceps`, and **could never prescribe a triceps movement**.
  Alphabetical truncation is silent: you still get a plausible plan, built from
  a truncated catalogue. Now `candidateFetchCap = 2000`; `promptCandidates`
  (150) remains the deliberate prompt-cost cap.
  Regression test: `TestLateAlphabetExercisesAreReachable`.
- **Library search box** (`public/app.js`). Was
  `name.includes(q) || target.includes(q)` — 2 of 6 text fields, substring not
  token. So "press bench" found nothing, and "chest", "shoulders", "legs" and
  "upper arms" found nothing at all. Now token-based across all six fields, and
  `loadCatalog` fetches `body_part` + `muscle_group` (it previously did not, so
  they were unsearchable even in principle). Still no `steps`/`secondary_muscles`
  — large JSON, detail view only. Deliberately not ranked: the match set was
  the gap, ordering would be polish.
