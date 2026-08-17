# Mixamo sources for the 3D exercise demos

The `.fbx` files in this folder are raw Mixamo downloads. They are **gitignored**
(Adobe's terms allow using Mixamo assets inside a product, not redistributing the
files), so this README is the recipe to rebuild the folder from a free Adobe
account at mixamo.com.

The derived asset that IS committed: `public/vendor/exercise-demos-1.glb`, built by

```
(cd scripts && npm i)
node scripts/mixamo-to-glb.mjs assets/mixamo public/vendor/exercise-demos-1.glb
```

## Character (download once)

Search characters for **X Bot** → Download →
**FBX Binary (.fbx) · T-pose · With Skin** → save as `X Bot.fbx`.

## Animations (one file per exercise)

With X Bot selected as the character, pick the animation, leave sliders at
defaults (tick **In Place** if offered), then Download →
**FBX Binary (.fbx) · Without Skin · 30 fps · Keyframe Reduction: none**.

**The filename becomes the clip name**, slugified: `Air Squat.fbx` → clip
`air-squat`. Re-downloads like `Name (1).fbx` are fine — the converter keeps one
per name (preferring a proper without-skin export, then the newest file).
Files named `Idle*`, `Start *`, `* Start`, `End *`, `* To Idle` are treated as
transitions and skipped.

## Current inventory (2026-08-17)

Air Squat, Back Squat, Bicep Curl, Bicycle Crunch, Box Jump, Burpee,
Circle Crunch, Clean And Jerk, Front Raises, Jump Push Up, Jumping Jacks,
Kettlebell Swing, Overhead Squat, Pike Walk, Plank, Push Up, Quick Steps,
Situps, Snatch, Sumo High Pull — plus skipped transition files (Idle,
Idle To Push Up, Push Up To Idle, Burpee Start, Start/End Plank,
End Bicycle Sit Up).

Adding a new exercise = download its FBX here, re-run the converter (bump the
output filename `-1` → `-2`), and add a rule to `DEMO_RULES` in `public/app.js`.
