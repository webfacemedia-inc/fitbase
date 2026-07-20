# FitBase

Exercise library, workout builder, and training log. A buildless SPA on
[webface.cloud](https://webface.cloud) — live at **https://fitbase.webface.cloud**.

## Data & media

- **Exercise data** (1,324 exercises, 10 languages) from
  [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) (MIT),
  seeded into the app's PocketBase `exercises` collection.
- **Media** (GIFs + 180×180 thumbnails) is **© [Gym visual](https://gymvisual.com/)** and is
  NOT MIT. The prototype hotlinks it from the public dataset repo via jsDelivr with attribution.
  **Before any commercial release**: buy a Gym visual license (~$0.90/GIF at volume, one-time,
  royalty-free — full set ≈ $1.2K, pack deals on contact) and switch `CDN` in `app.js`
  to self-hosted files. Alternatives: MoveKit ($99/200+), ExerciseAnimatic ($599/2,000+).

## Collections

| collection  | access | fields |
|---|---|---|
| `exercises` | public read, superuser write | ex_id, name, category, body_part, equipment, target, muscle_group, secondary_muscles (json), steps (json, 10 langs), image, gif_url, attribution |
| `workouts`  | owner-only | name, owner, items (json: [{id, ex_id, name, target, image, sets, reps}]) |
| `sessions`  | owner-only | owner, workout, workout_name, entries (json: [{id, name, sets:[{reps, weight}]}]), notes |

Seed/setup script: `scripts/setup_fitbase.py` (creates collections, enables the batch API,
seeds all records — needs the PB superuser).

## Stack

Buildless: `index.html` + `app.css` + `app.js` + vendored `pocketbase.umd.js`.
`new PocketBase('/')`, same origin. Push to `master` → auto-deploy.
