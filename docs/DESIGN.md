# FitBase — design (2026-07-19)

## What

Personal fitness app prototype: exercise library + workout builder + training log.
Doubles as a demo for fitness-coaching prospects (e.g. the Hurst Method client).

## Decisions

- **Platform**: webface.cloud app (PocketBase backend, buildless SPA frontend,
  push-to-deploy). Re-spawnable per client.
- **Scope**: Library (search/filter 1,324 exercises), Builder (named workouts with
  target sets×reps), Log (session runner + history). No charts/timers in v1.
- **Data**: exercises-dataset (MIT) seeded into PocketBase. All 10 instruction
  languages kept (steps json), selectable in the exercise detail view.
- **Media**: hotlinked via jsDelivr from the public dataset repo, with the required
  "© Gym visual" attribution in the detail view and footer. Thumbnails (jpg) in
  lists; GIF only in the detail modal to keep bandwidth sane.
  License plan: Gym visual N-CRFL ≈ $0.90/GIF at 10+ (full set ≈ $1.2K one-time)
  before any commercial release; then flip the `CDN` constant to self-hosted media.
  Generating animations with video models was rejected: $2–5+/usable clip after
  accuracy retries, inconsistent style across 1,300+ clips.
- **Auth**: PocketBase email/password (self-serve signup). Library is public;
  workouts/sessions are owner-scoped by API rules.
- **Client-side catalog**: one `getFullList` of light fields (~200KB) for instant
  search/filter; full record (steps, muscles) fetched per detail view.

## Collections

See README. Rules: exercises public-read/superuser-write; workouts & sessions
`owner = @request.auth.id` on list/view/create/update/delete.
