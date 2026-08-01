# FitBase

A home-gym **AI coaching product + coach marketplace**, live at
**https://fitbase.webface.cloud**. Members build a plan from the equipment they actually
own — self-coached by an AI, or with a real human coach they hire on the marketplace —
and log every session. Runs as a **custom Go PocketBase binary** on
[webface.cloud](https://webface.cloud).

## What it does

- **Exercise library** — 1,324 exercises with animated demos, filterable by muscle,
  equipment, and target.
- **My Gym** — you inventory the equipment you own; the library and every generated plan
  filter to what you can actually do.
- **AI coach** — generates a weekly plan from your equipment and goal, and suggests
  progressive-overload adjustments from your logged sessions. Every prescribed exercise is
  validated against the real catalog, so a plan never invents a movement or a machine you
  don't have.
- **Coach marketplace** — coaches publish services (coaching, form review, nutrition) at
  their own rates, one-off or monthly. Members hire with a card; coaches are paid out
  directly through **Stripe Connect** and the platform keeps a 15% fee. Coaches can also
  invite their own clients in via single-use email invites.
- **Training log** — run a workout, log sets/reps/weight, review history.

## Architecture

FitBase is **not** a stock buildless app. It runs a **custom Go PocketBase binary**
(`server/`) via webface.cloud's generic `custom` template — the same path Barclay/oloro
use. This unlocks server-side code: the AI routes call Claude with the Anthropic key held
in `app.env` (never in the browser), and Stripe secrets stay server-side too.

- **`server/`** — a Go module (`fitbase.webface.cloud/server`) importing the platform via
  `replace webface.cloud/platform => ../../webface-cloud`. `pbbrand.Bind` gives it the
  branded admin, SMTP/appURL env fallbacks, and row retention.
  - `main.go` — entry point: registers routes, self-heals schema on boot, serves the SPA
    from `pb_public/` with SPA fallback.
  - `ai.go` — `POST /api/ai/plan` (equipment-aware plan generation, validated ex_ids, with
    retry) and `POST /api/ai/progress` (progression from logged sessions). Model tiering via
    `resolvePlan` (comp/free/paid → Opus/Sonnet).
  - `coach.go` — the invite system (`/api/invite`, mint/accept single-use tokens) and
    `ensureSchema` (self-healing collection shape on boot).
  - `billing.go` — Stripe Connect marketplace: `/api/billing/connect` (coach onboarding),
    `/api/billing/hire` (destination-charge checkout with the platform fee), and the
    signature-verified `/hooks/stripe` webhook.
- **Frontend (`public/`)** — a buildless SPA (`index.html` + `app.css` + `app.js` + vendored
  `pocketbase.umd.js`), hash-routed, same-origin `new PocketBase('/')`, served by the Go
  binary from `pb_public/`.

## Collections

| collection | access | purpose |
|---|---|---|
| `exercises` | public read, superuser write | the 1,324-exercise catalog (ex_id, name, category, equipment, target, steps in 10 langs, image, gif_url) |
| `workouts` | owner + linked coach | a plan: `items` json `[{id, ex_id, name, target, image, sets, reps}]` |
| `sessions` | owner + linked coach | a logged workout: `workout_ref`, `entries` json `[{id, name, sets:[{reps, weight}]}]` |
| `gym_profiles` | owner-only | the member's owned `equipment` (drives My Gym + plan generation) |
| `services` | public browse, coach-owner write | a coach's offering: title, kind, `rate` (cents), cadence, `coach_name` |
| `memberships` | owner + coach | the coach↔client link (status: pending/active/revoked) |
| `invites` | coach + public-by-token | single-use, expiring email invites |
| `engagements` | client + coach | a hired service (links client↔coach↔service; Stripe session/subscription) |

Seed/setup script: `scripts/setup_fitbase.py` (seeds the exercise catalog via the PB batch
API — needs the PB superuser). Deploy: `scripts/deploy.sh` (builds + ships the binary, then
syncs `public/` → `pb_public`; the platform git webhook is intentionally skipped for
`custom` apps).

## Data & media

- **Exercise data** (1,324 exercises, 10 languages) from
  [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) (MIT).
- **Media** (GIFs + 180×180 thumbnails) is **© [Gym visual](https://gymvisual.com/)** and is
  NOT MIT. The prototype hotlinks it via jsDelivr with attribution. **Before any commercial
  release**: buy a Gym visual license (~$0.90/GIF at volume, one-time, royalty-free — full
  set ≈ $1.2K) and switch the `CDN` constant in `app.js` to self-hosted files. Alternatives:
  MoveKit ($99/200+), ExerciseAnimatic ($599/2,000+).

## Server config (`app.env` on the droplet)

`ANTHROPIC_API_KEY`, `AI_MODEL_FREE`/`AI_MODEL_PAID`, `WFC_COMP_EMAILS` (owner comp
accounts), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_FEE_BPS` (1500 = 15%).
Secrets live only here — never in the repo or the SPA.
