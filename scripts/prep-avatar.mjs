// Prep pipeline: Sketchfab source model → web-ready avatar body glb.
//
//   npx -p @gltf-transform/core -p @gltf-transform/functions \
//       node scripts/prep-avatar.mjs <src.gltf|glb> <out.glb> [--roty]
//
// Strips everything but the body geometry (position+normal+index), merges to a
// single primitive, and normalizes into "figure units": y-up, feet at y=0,
// height 3.0, centered on x/z. --roty bakes a 180° turn if the model faces -z.
// Model: "Male base muscular anatomy" by Harshit Prajapati (CC-BY-4.0).
import { NodeIO, getBounds } from '@gltf-transform/core';
import { dedup, flatten, join, weld, normals, prune, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [src, out] = process.argv.slice(2);
const rotY = process.argv.includes('--roty');
if (!src || !out) { console.error('usage: prep-avatar.mjs <src> <out.glb> [--roty]'); process.exit(1); }

const io = new NodeIO();
const doc = await io.read(src);
const root = doc.getRoot();

const stat = (label) => {
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const b = getBounds(scene);
  const size = [0, 1, 2].map(i => (b.max[i] - b.min[i]).toFixed(3));
  const meshes = root.listMeshes().length;
  const tris = root.listMeshes().flatMap(m => m.listPrimitives())
    .reduce((n, p) => n + (p.getIndices() ? p.getIndices().getCount() / 3 : p.getAttribute('POSITION').getCount() / 3), 0);
  console.log(`${label}: meshes=${meshes} tris=${tris} size=[${size}] min=[${b.min.map(v => v.toFixed(3))}]`);
};
stat('source');

// 1. Drop animations, skins, cameras, and small accessory meshes (eyes etc).
root.listAnimations().forEach(a => a.dispose());
root.listSkins().forEach(s => s.dispose());
root.listCameras().forEach(c => c.dispose());
for (const mesh of root.listMeshes()) {
  const verts = mesh.listPrimitives().reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0);
  if (verts < 2000) mesh.dispose(); // body is ~20k verts; eyes are ≤ ~700
}

// 2. Drop materials/textures — the app applies its own material.
root.listMeshes().forEach(m => m.listPrimitives().forEach(p => p.setMaterial(null)));
root.listMaterials().forEach(m => m.dispose());
root.listTextures().forEach(t => t.dispose());

// 3. Bake node transforms, merge to one mesh/primitive, weld, clean normals.
await doc.transform(flatten(), join(), dedup(), weld());

// 4. Keep only POSITION (+ index) — dropping NORMAL too is what lets weld()
//    merge the original normal-seam vertex splits; smooth normals are
//    recomputed at the very end, killing the faceted "shattered glass" look.
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    for (const sem of prim.listSemantics()) {
      if (sem !== 'POSITION') prim.setAttribute(sem, null);
    }
  }
}
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.62, error: 0.001 }),
  prune());

// 5. Normalize into figure units, transforming the raw position/normal arrays.
//    glTF is +y-up by spec, so no axis guessing — but node transforms are NOT
//    baked by flatten(), so bake the node's world matrix into the vertices
//    first (Sketchfab roots typically carry a unit-conversion scale/rotation).
const meshes = root.listMeshes();
if (meshes.length !== 1 || meshes[0].listPrimitives().length !== 1)
  throw new Error(`expected 1 mesh/1 primitive after join, got ${meshes.length} meshes`);
const prim = meshes[0].listPrimitives()[0];
const pos = prim.getAttribute('POSITION');
const pa = pos.getArray().slice();

const node = root.listNodes().find(n => n.getMesh() === meshes[0]);
if (node) {
  const m = node.getWorldMatrix(); // column-major mat4
  for (let i = 0; i < pa.length; i += 3) {
    const x = pa[i], y = pa[i + 1], z = pa[i + 2];
    pa[i]     = m[0] * x + m[4] * y + m[8] * z + m[12];
    pa[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pa[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

const bounds = () => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pa.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (pa[i + k] < min[k]) min[k] = pa[i + k];
      if (pa[i + k] > max[k]) max[k] = pa[i + k];
    }
  return { min, max, size: [0, 1, 2].map(k => max[k] - min[k]) };
};

if (rotY) for (let i = 0; i < pa.length; i += 3) { pa[i] = -pa[i]; pa[i + 2] = -pa[i + 2]; }

// scale to height 3.0, feet at y=0, centered on x/z
let b = bounds();
const s = 3.0 / b.size[1];
const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
for (let i = 0; i < pa.length; i += 3) {
  pa[i] = (pa[i] - cx) * s;
  pa[i + 1] = (pa[i + 1] - b.min[1]) * s;
  pa[i + 2] = (pa[i + 2] - cz) * s;
}

// 6. Segment regions in T-POSE space (trivial thresholds: arms lie along ±x)
//    and bake as a _REGION attribute — the runtime never has to guess.
//    Region order must match REGION_INDEX in public/avatar.js.
const R = { neck: 0, shoulders: 1, chest: 2, back: 3, waist: 4,
            upperArms: 5, lowerArms: 6, upperLegs: 7, lowerLegs: 8 };
const T = {
  ARM_X: 0.55, ARM_YMIN: 2.0, ELBOW_X: 1.08,
  DELT_X: 0.28, DELT_YMIN: 2.24, NECK_Y: 2.62,
  NECK_COL_Y: 2.48, NECK_COL_X: 0.18,   // chin/throat column — keeps the jaw out of 'chest'
  CHEST_TOP: 2.02,                       // chest → waist boundary (front)
  BACK_BOT: 1.75,                        // back reaches lower than chest: lats
  WAIST_BOT: 1.55, KNEE_Y: 0.85,
};
const region = new Float32Array(pa.length / 3);
for (let i = 0, v = 0; i < pa.length; i += 3, v++) {
  const x = pa[i], y = pa[i + 1], z = pa[i + 2], ax = Math.abs(x);
  region[v] =
    (y > T.ARM_YMIN && ax > T.ARM_X) ? (ax < T.ELBOW_X ? R.upperArms : R.lowerArms) :
    (y >= T.DELT_YMIN && ax >= T.DELT_X) ? R.shoulders :
    (y >= T.NECK_Y) ? R.neck :
    (y >= T.NECK_COL_Y && ax < T.NECK_COL_X) ? R.neck :
    (z < 0 && y >= T.BACK_BOT) ? R.back :
    (y >= T.CHEST_TOP) ? R.chest :
    (y >= T.WAIST_BOT) ? R.waist :
    (y >= T.KNEE_Y) ? R.upperLegs : R.lowerLegs;
}

// 7. Re-pose: drop the T-pose arms into a natural A-pose. Blended rotation
//    about the shoulder pivot, gated by REGION so legs/feet (which also have
//    |x| past the blend start) are never touched.
const POSE = { PIVOT_X: 0.50, PIVOT_Y: 2.38, BLEND0: 0.32, BLEND1: 0.70, DROP: 1.1 };
const ARM_REGIONS = new Set([R.upperArms, R.lowerArms, R.shoulders]);
const smoothstep = (a, bb, t) => { const u = Math.min(1, Math.max(0, (t - a) / (bb - a))); return u * u * (3 - 2 * u); };
for (let i = 0, v = 0; i < pa.length; i += 3, v++) {
  if (!ARM_REGIONS.has(region[v])) continue;
  const x = pa[i], y = pa[i + 1], ax = Math.abs(x);
  if (ax < POSE.BLEND0) continue;
  const side = Math.sign(x);
  const a = -side * POSE.DROP * smoothstep(POSE.BLEND0, POSE.BLEND1, ax);
  const dx = x - side * POSE.PIVOT_X, dy = y - POSE.PIVOT_Y;
  pa[i]     = side * POSE.PIVOT_X + dx * Math.cos(a) - dy * Math.sin(a);
  pa[i + 1] = POSE.PIVOT_Y + dx * Math.sin(a) + dy * Math.cos(a);
}

pos.setArray(pa);
const regionAccessor = doc.createAccessor('_REGION')
  .setType('SCALAR').setArray(region).setBuffer(root.listBuffers()[0]);
prim.setAttribute('_REGION', regionAccessor);
console.log('final verts:', pos.getCount());
// NOTE: no normals are written — gltf-transform's normals() produces FLAT
// normals (faceted shading). The runtime computes smooth vertex normals via
// three's computeVertexNormals() on the welded, indexed geometry.

stat('final');
await io.write(out, doc);
const { statSync } = await import('fs');
const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`wrote ${out} (${kb} KB)`);
if (statSync(out).size > 2.5 * 1024 * 1024) throw new Error('glb exceeds 2.5MB budget');
