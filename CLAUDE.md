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
