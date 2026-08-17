# Animated 3D Exercise Demos (Mixamo) — Exercise Detail Modal

## Context

Tommy wants Mixamo animated 3D exercise demos in FitBase — "impress me and not break my
work," and "plan something that fits and is compatible, not looking incomplete." He has
**already downloaded 35 FBX files into `assets/mixamo/`**: `X Bot.fbx` (the character) plus
~20 distinct exercises with some duplicate variants and transition clips. The feature must
use the full inventory — this is a catalog-wide capability, not a 3-clip demo.

Decisions made: demos appear in the **exercise detail modal** (augmenting the 2D GIF, GIF
stays as loading state + fallback), character is **X Bot** re-materialed in FitBase's
dark + mint aesthetic, plus a small **"3D" badge on library cards** that have a demo so the
feature is discoverable, not an easter egg.

Hard constraint: the existing 3D body map (`public/avatar.js`, module singleton, static
region-shaded mesh) must not change. `GLTFLoader`, `AnimationMixer`, `SkeletonUtils` are
already vendored (three r185, `public/vendor/`) — **zero new vendor dependencies**.
`app.js` is a classic script (not a module) — top-level functions are global. Deploy:
`public/` → droplet `pb_public/` via GitHub Actions; committed GLBs ship automatically.
`deploy.sh` substitutes `__V__` in HTML only → GLB is filename-versioned
(`exercise-demos-1.glb`, like `avatar-body-1.glb`).

## The actual inventory (verified on disk, `assets/mixamo/`)

**Character:** `X Bot.fbx` (1.75 MB, with skin, T-pose).

**Main loop clips → GLB (20):** Air Squat, Back Squat, Bicep Curl, Bicycle Crunch,
Box Jump, Burpee, Circle Crunch, Clean And Jerk, Front Raises, Jump Push Up, Jumping Jacks,
Kettlebell Swing, Overhead Squat, Pike Walk, Plank, Push Up, Quick Steps, Situps, Snatch,
Sumo High Pull.

**Skip (transitions/idle — log them, don't ship):** Idle, Idle To Push Up, Push Up To Idle,
Burpee Start, Start Plank, End Plank, End Bicycle Sit Up.

**Duplicate variants** (`Back Squat (1)`, `Kettlebell Swing (1)/(2)`, `Overhead Squat
(1)/(2)`, `Sumo High Pull (1)/(2)`): sizes differ, so they're re-downloads with different
export settings (some likely with-skin or not-in-place). The converter picks **one per
slug**: prefer the export whose scene has NO SkinnedMesh (a proper "without skin" export),
tie-break by newest mtime; log every choice + each clip's duration so we can eyeball and
override with an explicit skip-list if a variant animates better.

**Props (Tommy wants them — in scope):** Mixamo clips are prop-less mime, but the hands
move exactly as if gripping the equipment, so procedural props built from three.js
primitives (dark metal + mint accents, matching the avatar recipe) ride the hand bones:

- **Barbell** (back-squat, overhead-squat, clean-and-jerk, snatch): long thin cylinder +
  plate discs. Positioned **per frame** in the render loop: center at the midpoint of the
  `mixamorig:LeftHand`/`RightHand` world positions, oriented along the hand-to-hand vector
  (works for back squat too — the hands hold the bar on the shoulders). Small palm offset
  from the wrist joint tuned visually.
- **Kettlebell** (kettlebell-swing, sumo-high-pull): sphere + torus handle, same
  hands-midpoint placement.
- **Dumbbells** (bicep-curl, front-raises): short cylinder + discs, one per hand, parented
  directly to each hand bone (`bone.add(prop)`) with a fixed local offset — no per-frame
  work.
- Bodyweight clips get no prop. A `PROP_BY_CLIP` table in `exercise-demo.js` drives it;
  props are hidden/shown on clip switch. Risk: wrist-vs-palm offset needs visual tuning
  per prop type (one offset per prop, not per clip) — verified by screenshot during the
  Playwright pass.

## Implementation steps

### 1. Spike the converter FIRST
The one unproven link is three's `GLTFExporter` under Node 22 (v22.21.1 present; Blender is
NOT installed; `npx fbx2gltf` is x86_64-only → Rosetta fallback). Run the converter against
X Bot + one animation before building everything out. If GLTFExporter throws on a DOM API:
fallback `npx fbx2gltf` under Rosetta per-file + gltf-transform merge.

### 2. Repo prep
- `.gitignore`: add `assets/mixamo/*.fbx` and `node_modules/` (Mixamo terms: OK to use in
  products, not to redistribute raw files; repo is on GitHub). FBXs stay on disk locally.
- `assets/mixamo/README.md`: inventory list + re-download instructions (FBX Binary,
  Without Skin, 30 fps, no reduction, In Place) so the folder is reproducible.

### 3. `scripts/mixamo-to-glb.mjs` (new; conventions from `scripts/prep-avatar.mjs`)
Header run line (npx style like prep-avatar.mjs:1-16):
`npx -p three -p @gltf-transform/core -p @gltf-transform/functions node scripts/mixamo-to-glb.mjs assets/mixamo public/vendor/exercise-demos-1.glb`
- **Character = `X Bot.fbx` by name** (explicit, since some animation re-downloads also
  embed a skin — auto-detect-by-SkinnedMesh would misfire). All other files contribute
  `.animations[0]` only (mesh ignored if present).
- Skip-list for transitions (`Idle*`, `* Start`, `Start *`, `End *`, `* To *`) and variant
  dedup per slug as above.
- Stub `TextureLoader`/`ImageLoader` for Node (materials discarded anyway).
- Rename each clip from Mixamo's `"mixamo.com"` to the slugified filename
  (`Air Squat.fbx` → `air-squat`). Clips bind by `mixamorig:*` bone names — same character
  was selected for every download, no retargeting.
- Export ONE binary GLB, all named clips; post-process gltf-transform
  `dedup() + prune() + resample()`.
- Print: chosen file per slug, clip durations, ready-to-paste `DEMO_RULES` skeleton, final
  size. **Warn > 4 MB, fail > 8 MB** (20 resampled clips + ~0.5–1 MB mesh; expect 2–4 MB —
  lazy-loaded once per session, acceptable).
- Output `public/vendor/exercise-demos-1.glb` (bump `-1` on regeneration).

### 4. `public/exercise-demo.js` (new, ~150 lines) — sibling to avatar.js
Never imports avatar.js (its top-level await fetches the 311 KB body GLB). Imports the same
vendored URLs `./vendor/three-0.185.1.min.js` + `./vendor/GLTFLoader-0.185.1.js` (browser
module cache → single THREE instance, no double download). No top-level await — GLB loads
inside `mount()` so failures degrade per-open.
- Exports: `isSupported()` (WebGL probe copied from avatar.js:24-31),
  `async mount(container, clipName) → bool`, `unmount()`.
- **Module-level cache** (once/session): memoized GLB load → model in a Group, scaled to
  height 3.0, feet y=0 (Mixamo is cm, ~185 tall), `frustumCulled = false` on every
  SkinnedMesh (or the mannequin vanishes mid-burpee), materials replaced with the avatar
  recipe (`MeshPhysicalMaterial` 0x2a3140, clearcoat, mint 0x2dd4a7 emissive ~0.06 —
  avatar.js:120-151), one `AnimationMixer`, lights from avatar.js:236-244, contact-shadow
  blob from avatar.js:165-177.
- **Per-mount, destroyed on unmount:** own `WebGLRenderer` (antialias, alpha, pixelRatio≤2,
  ACES), fixed 3/4 `PerspectiveCamera(33)`, `THREE.Clock`, ResizeObserver, rAF loop:
  `mixer.update(clock.getDelta())` + slow turntable (0.15 rad/s; disabled under
  `prefers-reduced-motion` — the clip keeps playing, it IS the instruction, same as the GIF
  it replaces). Floor-level clips (plank, push-up, sit-ups, bicycle/circle crunch) get a
  slightly raised camera target — pick via a small per-clip `{lowPose:true}` table baked
  from the clip list. Loop self-pauses on `document.hidden || !canvas.isConnected`
  (avatar.js:366-369 pattern).
- **`unmount()`:** cancel rAF, disconnect RO, `mixer.stopAllAction()`,
  `renderer.dispose()` + `forceContextLoss()`, remove canvas. Parsed GLB/mixer stay cached.
  Steady state ≤ 2 live WebGL contexts (body map + one demo); repeated opens can't
  accumulate contexts.

### 5. `app.js` — five surgical edits
1. **Loader + mapping** next to `loadAvatar` (app.js:18-19):
   `let demoModP = null; const loadDemo = () => (demoModP ||= import('./exercise-demo.js?v='+ASSET_V));`
   plus `DEMO_RULES` (~20 rules: name regex + equipment gate where needed) and
   `demoClipFor(x)`. With the real inventory the rules now cover equipment moves too —
   e.g. `kettlebell-swing` → /kettlebell swing/i, `clean-and-jerk` → /clean and jerk/i,
   `snatch` → /\bsnatch\b/i, `back-squat`/`overhead-squat` map to their barbell exercises,
   while `air-squat`/`push-up`/`situps` keep a `body weight` equipment gate so a barbell
   variant never gets the bodyweight mime. **Finalize every rule against the live catalog
   names** (converter prints the skeleton; `state.catalog` has all 1,324 names) — the rule
   set must be verified to hit real records, not guessed.
2. **Cleanup hook:** `let exDemoStop = null;` — call `exDemoStop?.(); exDemoStop = null;`
   at the top of BOTH `modal()` (app.js:66) and `closeModal()` (app.js:70): other modals
   replace `overlay.innerHTML` without `closeModal()`, and the language selector re-invokes
   `openDetail` → `modal()` (app.js:660). Covers click-away (app.js:71) too.
3. **`openDetail` (app.js:632-667):** `const clip = demoClipFor(x)`.
   - No match → emit **exactly the current** `<img>` string (app.js:644) — byte-identical
     for unmapped exercises.
   - Match → `<div class="exmedia" id="ex-demo"><img …same attrs…></div>` (GIF = loading
     state + fallback). After `modal(...)`, fire-and-forget async in try/catch:
     `loadDemo()`; bail unless `$('#ex-demo')?.isConnected && m.isSupported()`;
     `await m.mount(host, clip)` (false → GIF stays); on success add `.live` (hides img) +
     a small GIF/3D toggle chip; `exDemoStop = () => m.unmount()`. Any failure → GIF
     untouched.
4. **Library card badge:** in the grid card template, if `demoClipFor(x)` matches, render a
   tiny mint `3D` chip on the card — makes ~dozens of demo-enabled exercises discoverable.
   (`demoClipFor` is a cheap regex scan; fine at grid-render time over the current page.)
5. Nothing else — avatar.js, initBodyMap, routes, /gyms/ untouched.

### 6. CSS (`app.css`, ~14 lines)
`.exmedia` 220×220 relative (matches modal img, app.css:105-106); canvas absolute-inset,
border-radius 12, panel background; `.exmedia.live img{visibility:hidden}`; toggle chip
bottom-right; `.card .badge3d` tiny mint chip; mobile mirrors app.css:209-210 (full-width,
aspect-ratio 1).

## Verification (local harness + Playwright)

Recreate the throwaway harness (not committed): Node server serving `public/` with
`__V__`→`dev` in HTML, SPA fallback, `/api/*` proxied to https://fitbase.webface.cloud.
Library + detail modal are public — no signin needed. Playwright via npx cache
(`find ~/.npm/_npx -maxdepth 3 -name playwright -type d`); Chromium already downloaded.

- **(a) Demo animates:** #/library → "squat" → open a mapped card → canvas inside
  `#ex-demo`; two canvas screenshots 500 ms apart differ (mixer running). Spot-check one
  floor clip (plank/situps) for camera framing, and screenshot every prop clip (barbell ×4,
  kettlebell ×2, dumbbell ×2) to eyeball grip alignment; tune the palm offsets from those.
- **(b) Rule coverage report:** run `demoClipFor` over the full live catalog; print
  matches per clip. Every one of the 20 clips must hit ≥ 1 real exercise, and spot-check
  for false positives (e.g. "snatch" matching something weird).
- **(c) Unmapped byte-identical:** an unmapped exercise's modal innerHTML equals
  pre-change snapshot; zero canvas; network shows NO exercise-demo.js / GLB fetch.
- **(d) WebGL off** (`--disable-webgl --disable-webgl2`): mapped exercise shows GIF, no
  console errors.
- **(e) No context leak:** with the library body map mounted, open/close a mapped modal
  10×; canvas count ≤ 2, no context-lost warnings, body map still rotates on drag.
- **(f) Mobile 390×844:** body map toggle works; modal media full-width; scroll unaffected.
- **(g) No-regression smoke:** `/` hero avatar mounts, `/gyms/` loads clean, #/home
  dashboard unchanged.
- **(h) Idle cost:** #/library without opening a modal fetches neither demo module nor GLB
  (the badge uses only the regex, no 3D code).

Then deploy via the normal GitHub Actions path and spot-check production.

## Risks
- GLTFExporter-under-Node is the only unproven link → front-loaded spike; fbx2gltf/Rosetta
  fallback defined.
- Variant re-downloads may differ in in-place vs root-motion → converter logs choices;
  fixed camera frames a generous volume; explicit skip-list override if a variant is bad.
- iOS Safari context-loss churn from repeated dispose → watch item; pivot is a singleton
  renderer (avatar.js style) with canvas detach instead of dispose.
- 20-clip GLB size → resample + budget gate (warn 4 MB / fail 8 MB), lazy single fetch.

## Critical files
- `public/app.js` — edits at ~18-19 (loader/rules), 66-71 (cleanup), 632-667 (openDetail),
  grid card template (badge)
- `public/exercise-demo.js` — NEW module
- `scripts/mixamo-to-glb.mjs` — NEW converter (conventions from `scripts/prep-avatar.mjs`)
- `public/app.css` — media-slot + badge styles (~105-106, ~209-210)
- `public/avatar.js` — REFERENCE ONLY (material/light recipes); must not change
- `assets/mixamo/README.md` + `.gitignore` — NEW
