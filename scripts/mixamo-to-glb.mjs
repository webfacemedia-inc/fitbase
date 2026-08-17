// Mixamo FBX batch → one web-ready GLB with named animation clips.
//
//   (cd scripts && npm i)   # deps live in scripts/node_modules, gitignored
//   node scripts/mixamo-to-glb.mjs assets/mixamo public/vendor/exercise-demos-1.glb
//
// (npx -p three does NOT work here: ESM imports can't resolve from the npx cache.)
//
// Input: X Bot.fbx (character, with skin, T-pose) + one FBX per exercise
// animation exported for X Bot (ideally "without skin", 30fps, no reduction).
// The FILENAME becomes the clip name, slugified: "Air Squat.fbx" → "air-squat".
//
// - Transition/idle files (Idle*, *Start, Start*, End*, *To Idle) are skipped.
// - Re-download variants "Name (1).fbx" collapse to one clip per slug:
//   prefer the export with NO embedded skin, tie-break newest mtime.
// - Tracks are slimmed to quaternions + Hips position (Mixamo scale/position
//   tracks on other bones are constant noise — ~3x size for zero motion).
// - Materials are stripped; the runtime (public/exercise-demo.js) re-materials
//   by mesh name (Alpha_Surface / Alpha_Joints).
// Mixamo assets may be used in products but not redistributed as raw files —
// the FBX sources are gitignored; only this derived GLB is committed.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, quantize, resample, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

const [srcDir, out] = process.argv.slice(2);
if (!srcDir || !out) { console.error('usage: mixamo-to-glb.mjs <srcDir> <out.glb>'); process.exit(1); }

// Node has no DOM: GLTFExporter reads its output Blob via FileReader.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend?.(); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buf => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

// Node has no DOM: neuter texture loading (materials are discarded anyway).
THREE.TextureLoader.prototype.load = function (url, onLoad) {
  const t = new THREE.Texture();
  if (onLoad) setTimeout(() => onLoad(t), 0);
  return t;
};
THREE.ImageLoader.prototype.load = function (url, onLoad) {
  const img = { width: 1, height: 1 };
  if (onLoad) setTimeout(() => onLoad(img), 0);
  return img;
};

const loader = new FBXLoader();
const parseFbx = (file) => {
  const buf = readFileSync(file);
  return loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
};
const hasSkin = (g) => { let s = false; g.traverse(o => { if (o.isSkinnedMesh) s = true; }); return s; };
const slugify = (name) => name.replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase().replace(/\s+/g, '-');
const isTransition = (name) =>
  /^idle\b/i.test(name) || /\bidle$/i.test(name) || /^start\b/i.test(name) ||
  /\bstart$/i.test(name) || /^end\b/i.test(name);

const files = readdirSync(srcDir).filter(f => /\.fbx$/i.test(f));
const charFile = files.find(f => /^x ?bot\.fbx$/i.test(f));
if (!charFile) throw new Error('X Bot.fbx not found in ' + srcDir);

// ---- character -------------------------------------------------------------
const character = parseFbx(join(srcDir, charFile));
if (!hasSkin(character)) throw new Error(charFile + ' has no SkinnedMesh — re-download With Skin');
character.animations = [];
const meshNames = [];
character.traverse(o => {
  if (o.isMesh) {
    meshNames.push(o.name);
    o.material = new THREE.MeshStandardMaterial({ name: o.name });
    o.castShadow = o.receiveShadow = false;
  }
});
console.log(`character: ${charFile} meshes=[${meshNames}]`);

// ---- animations ------------------------------------------------------------
const bySlug = new Map();
for (const f of files) {
  if (f === charFile) continue;
  const base = basename(f, '.fbx');
  if (isTransition(base.replace(/\s*\(\d+\)\s*$/, ''))) { console.log(`skip (transition): ${f}`); continue; }
  const slug = slugify(base);
  (bySlug.get(slug) || bySlug.set(slug, []).get(slug)).push(f);
}

const clips = [];
for (const [slug, candidates] of [...bySlug.entries()].sort()) {
  // prefer a proper "without skin" export; tie-break newest download
  const scored = candidates.map(f => {
    const g = parseFbx(join(srcDir, f));
    return { f, g, skin: hasSkin(g), mtime: statSync(join(srcDir, f)).mtimeMs };
  }).sort((a, b) => (a.skin - b.skin) || (b.mtime - a.mtime));
  const pick = scored[0];
  const clip = pick.g.animations && pick.g.animations[0];
  if (!clip) { console.log(`skip (no animation): ${pick.f}`); continue; }
  clip.name = slug;
  // Slim: keep rotations everywhere, position only on the hips root; Mixamo
  // scale tracks and non-root position tracks are constant — dead weight.
  clip.tracks = clip.tracks.filter(t =>
    t.name.endsWith('.quaternion') || (t.name.endsWith('.position') && /hips/i.test(t.name)));
  clips.push(clip);
  const alts = candidates.filter(f => f !== pick.f);
  console.log(`clip ${slug}: ${pick.f} (${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks)` +
    (alts.length ? `  [over: ${alts.join(', ')}]` : ''));
}
if (!clips.length) throw new Error('no animation clips found');
const dupes = clips.map(c => c.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) throw new Error('clip name collision: ' + dupes);

// ---- export ----------------------------------------------------------------
const glb = await new GLTFExporter().parseAsync(character, { binary: true, animations: clips });
const tmp = out + '.tmp';
writeFileSync(tmp, Buffer.from(glb));

// ---- post-process + validate ----------------------------------------------
const io = new NodeIO();
const doc = await io.read(tmp);
// X Bot ships ~147K verts (normal-split, unwelded) — 6.7 MB of the raw GLB.
// Weld + simplify + quantize takes the mesh down an order of magnitude; the
// vendored three r185 GLTFLoader reads KHR_mesh_quantization natively.
const vertCount = () => doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())
  .reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0);
const vertsBefore = vertCount();
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.001 }),
  resample(),
  dedup(),
  quantize(),
  prune());
console.log(`mesh verts: ${vertsBefore} -> ${vertCount()}`);
const anims = doc.getRoot().listAnimations();
console.log('\nGLB clips:');
for (const a of anims) {
  const ch = a.listChannels().length;
  if (!ch) throw new Error(`clip ${a.getName()} exported with 0 channels — track binding failed`);
  console.log(`  ${a.getName()}  channels=${ch}`);
}
const missing = clips.filter(c => !anims.some(a => a.getName() === c.name));
if (missing.length) throw new Error('clips lost in export: ' + missing.map(c => c.name));
await io.write(out, doc);
const { unlinkSync } = await import('fs');
unlinkSync(tmp);

const mb = statSync(out).size / 1024 / 1024;
console.log(`\nwrote ${out} (${mb.toFixed(2)} MB)`);
console.log('\nDEMO_RULES skeleton (finalize regexes against the live catalog):');
for (const c of clips) console.log(`  { clip: '${c.name}', re: /${c.name.replace(/-/g, ' ')}/i },`);
if (mb > 8) throw new Error('glb exceeds 8MB hard budget');
if (mb > 4) console.warn('WARNING: glb over 4MB soft budget — consider quantize/fewer clips');
