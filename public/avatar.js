/* FitBase 3D avatar — a real sculpted muscular body used as an interactive menu.
   Mesh: "Male base muscular anatomy" by Harshit Prajapati (CC-BY-4.0), prepped by
   scripts/prep-avatar.mjs into figure units (y-up, feet y=0, height 3.0).
   Regions are segmented per-vertex at load; hover/selection glow is a shader
   patch (per-vertex region id → interpolated glow weight → mint emissive).
   Loaded lazily from app.js via dynamic import; the top-level await below means
   a failed mesh fetch rejects that import and app.js falls back to no-3D. */
import * as THREE from './vendor/three-0.185.1.min.js';
import { GLTFLoader } from './vendor/GLTFLoader-0.185.1.js';

const ACCENT = 0x2dd4a7;
const BODY = 0x1a1f2a;

/* region ids — order shared by segmentation, shader uniforms, and picking */
const REGION_INDEX = {
  neck: 0, shoulders: 1, chest: 2, back: 3, waist: 4,
  upperArms: 5, lowerArms: 6, upperLegs: 7, lowerLegs: 8,
};
const REGION_BY_INDEX = Object.keys(REGION_INDEX);

/* ---------- support probe ---------- */

let _supported = null;
export function isSupported() {
  if (_supported !== null) return _supported;
  try {
    const c = document.createElement('canvas');
    _supported = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { _supported = false; }
  return _supported;
}

/* ---------- segmentation ----------
   Classifies each vertex into a body_part region from its position in figure
   units. The source is a T-pose (arms straight out along ±x, armspan 3.38).
   Tuned against this specific mesh via the debug mode below. */

const SEG = {
  ARM_X: 0.52,      // |x| beyond this (in the arm band) = arm
  ARM_YMIN: 2.05,   // arms are horizontal at shoulder height in T-pose
  ELBOW_X: 1.05,    // |x| where the forearm starts
  DELT_X: 0.30,     // delts/outer traps start here…
  DELT_YMIN: 2.28,  // …above this height
  NECK_Y: 2.62,
  WAIST_TOP: 2.02,  // chest/back above, waist below
  WAIST_BOT: 1.55,
  KNEE_Y: 0.85,
};

function classifyVertex(x, y, z) {
  const ax = Math.abs(x);
  if (y > SEG.ARM_YMIN && ax > SEG.ARM_X)
    return ax < SEG.ELBOW_X ? REGION_INDEX.upperArms : REGION_INDEX.lowerArms;
  if (y >= SEG.DELT_YMIN && ax >= SEG.DELT_X) return REGION_INDEX.shoulders;
  if (y >= SEG.NECK_Y) return REGION_INDEX.neck;
  if (y >= SEG.WAIST_TOP) return z >= 0 ? REGION_INDEX.chest : REGION_INDEX.back;
  if (y >= SEG.WAIST_BOT) return REGION_INDEX.waist;
  if (y >= SEG.KNEE_Y) return REGION_INDEX.upperLegs;
  return REGION_INDEX.lowerLegs;
}

function segmentRegions(geo) {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++)
    arr[i] = classifyVertex(pos.getX(i), pos.getY(i), pos.getZ(i));
  geo.setAttribute('aRegion', new THREE.BufferAttribute(arr, 1));
}

/* ---------- mesh load (module-level: import fails ⇒ app degrades) ---------- */

const bodyGeometry = await (async () => {
  const gltf = await new GLTFLoader().loadAsync(
    new URL('./vendor/avatar-body-1.glb', import.meta.url).href);
  let geo = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(o => {
    if (o.isMesh && !geo) { o.geometry.applyMatrix4(o.matrixWorld); geo = o.geometry; }
  });
  if (!geo) throw new Error('avatar body mesh missing from glb');
  // belt & braces: re-normalize if the prep pipeline slipped
  geo.computeBoundingBox();
  const bb = geo.boundingBox, h = bb.max.y - bb.min.y;
  if (h < 2.9 || h > 3.1) {
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    geo.scale(3 / h, 3 / h, 3 / h);
    geo.computeBoundingBox();
  }
  // regions are baked by scripts/prep-avatar.mjs in T-pose space (exact);
  // the runtime classifier is only a fallback for an un-baked mesh
  const baked = geo.getAttribute('_REGION') || geo.getAttribute('_region');
  if (baked) geo.setAttribute('aRegion', baked);
  else segmentRegions(geo);
  // the glb ships positions only; smooth shading comes from computing vertex
  // normals here on the welded indexed geometry (the prep tool's normals()
  // would bake flat/faceted ones)
  geo.computeVertexNormals();
  return geo;
})();

/* ---------- module singleton state ---------- */

let renderer = null, scene = null, camera = null, root = null;
let bodyMesh = null, bodyMat = null, glowUniforms = null;
let regions = null;          // { id: { glow, glowTarget } }
let anchors = null;          // { name: Object3D } for nav labels
let running = false;

let mounted = null;          // { container, opts, labelLayer, labelEls, ro }
let selected = null;         // region id or null
let hovered = null;

let rotTarget = 0, tiltTarget = 0;
let lastInteraction = 0;
const IDLE_DELAY = 3000, IDLE_SPEED = 0.15; // rad/s
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- material: dark satin + shader-patched region glow ---------- */

function makeMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({
    color: BODY, roughness: 0.35, metalness: 0.1, clearcoat: 0.4,
    clearcoatRoughness: 0.35, emissive: ACCENT, emissiveIntensity: 1,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRegions = { value: new Float32Array([-1, -1, -1, -1]) };
    shader.uniforms.uGlows = { value: new Float32Array([0, 0, 0, 0]) };
    glowUniforms = shader.uniforms;
    // vertex: match this vertex's region against ≤4 active regions and pass the
    // summed weight — interpolation feathers region boundaries for free
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aRegion;
        uniform float uRegions[4];
        uniform float uGlows[4];
        varying float vGlow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlow = 0.0;
        for (int i = 0; i < 4; i++) {
          if (abs(aRegion - uRegions[i]) < 0.5) vGlow += uGlows[i];
        }`);
    // fragment: the material's emissive is full mint; scale it by the weight
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGlow;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vGlow;`);
  };
  mat.customProgramCacheKey = () => 'fitbase-avatar-body';
  return mat;
}

/* ---------- scene ---------- */

function buildFigure() {
  root = new THREE.Group();
  regions = {};
  for (const id of REGION_BY_INDEX) regions[id] = { glow: 0, glowTarget: 0 };

  bodyMat = makeMaterial();
  bodyMesh = new THREE.Mesh(bodyGeometry, bodyMat);
  root.add(bodyMesh);

  /* floor: fake contact shadow + faint accent ring (no shadow maps) */
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  })();
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 48),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.005; shadow.scale.set(1, 0.8, 1);
  scene.add(shadow);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.78, 0.802, 64),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.28, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
  scene.add(ring);

  /* nav label anchors (re-tuned for the real mesh's T-pose proportions) */
  anchors = {
    head:      new THREE.Object3D(),
    shoulderR: new THREE.Object3D(),
    wristL:    new THREE.Object3D(),
    torso:     new THREE.Object3D(),
    floor:     new THREE.Object3D(), // fixed to scene, not the body
  };
  anchors.head.position.set(0, 3.14, 0);
  anchors.shoulderR.position.set(0.62, 2.56, 0);
  anchors.wristL.position.set(-1.0, 1.5, 0.08); // A-pose wrist after the prep re-pose
  anchors.torso.position.set(0.45, 1.95, 0.15);
  for (const k of ['head', 'shoulderR', 'wristL', 'torso']) root.add(anchors[k]);
  anchors.floor.position.set(0.95, 0.14, 0.35);
  scene.add(anchors.floor);

  root.rotation.y = 0.5; // pleasing 3/4 starting pose
  rotTarget = 0.5;
  scene.add(root);

  if (typeof window !== 'undefined' && window.__AVATAR_DEBUG) enableSegDebug();
}

/* debug: false-color the mesh by region + live threshold tuning.
   Inert in production (only runs when window.__AVATAR_DEBUG is set). */
function enableSegDebug() {
  const HUES = [0x888888, 0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8,
                0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6];
  const paint = () => {
    const region = bodyGeometry.getAttribute('aRegion');
    const colors = new Float32Array(region.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < region.count; i++) {
      c.setHex(HUES[region.getX(i)]);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    bodyGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  };
  paint();
  bodyMesh.material = new THREE.MeshBasicMaterial({ vertexColors: true });
  window.__seg = {
    SEG,
    repaint() { segmentRegions(bodyGeometry); paint(); kick(); },
  };
}

function buildScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(33, 1, 0.1, 30);
  camera.position.set(0, 1.75, 6.4);
  camera.lookAt(0, 1.4, 0);   // center below mid-figure → breathing room under the ring

  const key = new THREE.DirectionalLight(0xcfd6e4, 2.8);
  key.position.set(1.6, 3.4, 2.4);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x2a3242, 0x0a0c10, 1.3));
  // the mint rims: permanent tasteful edge glow on both silhouette sides
  const rimL = new THREE.DirectionalLight(ACCENT, 2.6); rimL.position.set(-2.4, 1.6, -2.0); scene.add(rimL);
  const rimR = new THREE.DirectionalLight(ACCENT, 2.0); rimR.position.set(2.4, 1.2, -2.2); scene.add(rimR);

  buildFigure();
}

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.className = 'avatar-canvas';
  // pan-y: horizontal drags rotate the figure, vertical swipes still scroll the
  // page — a full-width canvas with touch-action:none traps mobile scrolling.
  renderer.domElement.style.touchAction = 'pan-y';
  renderer.domElement.style.display = 'block';
  buildScene();
  bindPointer(renderer.domElement);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
}

/* ---------- interaction ---------- */

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let dragging = false, moved = 0, lastX = 0, lastY = 0;
let lastHover = 0;

function pickAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(bodyMesh, false);
  if (!hits.length || !hits[0].face) return null;
  const attr = bodyGeometry.getAttribute('aRegion');
  const { a, b, c } = hits[0].face;
  const ra = attr.getX(a), rb = attr.getX(b), rc = attr.getX(c);
  return REGION_BY_INDEX[(ra === rb || ra === rc) ? ra : rb];
}

function bindPointer(el) {
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    lastInteraction = performance.now();
    kick();
  });
  el.addEventListener('pointermove', e => {
    lastInteraction = performance.now();
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      rotTarget += dx * 0.011;
      tiltTarget = Math.max(-0.22, Math.min(0.22, tiltTarget + dy * 0.004));
    } else if (e.pointerType === 'mouse' && performance.now() - lastHover > 30) {
      lastHover = performance.now();
      setHover(pickAt(e.clientX, e.clientY));
    }
    kick();
  });
  const end = e => {
    if (!dragging) return;
    dragging = false;
    lastInteraction = performance.now();
    if (moved < 6) {                       // a click, not a drag
      const r = pickAt(e.clientX, e.clientY);
      if (r && mounted?.opts.onRegion) {
        if (mounted.opts.mode === 'filter') {
          setSelected(r === selected ? null : r);
          mounted.opts.onRegion(selected);
        } else {
          mounted.opts.onRegion(r);
        }
      }
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { dragging = false; });
  el.addEventListener('pointerleave', () => setHover(null));
}

function setHover(r) {
  if (r === hovered) return;
  hovered = r;
  renderer.domElement.style.cursor = r ? 'pointer' : 'grab';
  applyGlowTargets();
}

export function setSelected(r) {
  selected = r || null;
  applyGlowTargets();
  kick();
}

function applyGlowTargets() {
  for (const [id, reg] of Object.entries(regions)) {
    reg.glowTarget = id === selected ? 0.55 : id === hovered ? 0.07 : 0;
  }
}

/* ---------- frame loop ---------- */

function frame(now) {
  if (!renderer || document.hidden || !renderer.domElement.isConnected) {
    running = false;                       // self-pause; kick() resumes
    return;
  }
  requestAnimationFrame(frame);

  // idle auto-rotation, eased back in after interaction pause
  if (!reduceMotion.matches && !dragging && now - lastInteraction > IDLE_DELAY) {
    const ramp = Math.min(1, (now - lastInteraction - IDLE_DELAY) / 1500);
    rotTarget += IDLE_SPEED * ramp * (1 / 60);
    tiltTarget *= 0.985;                   // drift the tilt back to level
  }
  const ease = reduceMotion.matches ? 1 : 0.1;
  root.rotation.y += (rotTarget - root.rotation.y) * ease;
  root.rotation.x += (tiltTarget - root.rotation.x) * ease;

  // per-region glow → ≤4 shader uniform slots (cross-fades + hover coexist)
  let slot = 0;
  for (const [id, reg] of Object.entries(regions)) {
    reg.glow += (reg.glowTarget - reg.glow) * (reduceMotion.matches ? 1 : 0.12);
    if (glowUniforms && reg.glow > 0.001 && slot < 4) {
      let g = reg.glow;
      if (id === selected && !reduceMotion.matches) g *= 1 + 0.07 * Math.sin(now / 300);
      glowUniforms.uRegions.value[slot] = REGION_INDEX[id];
      glowUniforms.uGlows.value[slot] = g;
      slot++;
    }
  }
  if (glowUniforms)
    for (; slot < 4; slot++) { glowUniforms.uRegions.value[slot] = -1; glowUniforms.uGlows.value[slot] = 0; }

  if (mounted?.opts.mode === 'nav') updateLabels();
  renderer.render(scene, camera);
}

function kick() {
  if (running || !renderer) return;
  running = true;
  requestAnimationFrame(frame);
}

/* ---------- nav labels ---------- */

const _v = new THREE.Vector3();
function updateLabels() {
  if (!mounted?.labelEls) return;
  const rect = { w: mounted.container.clientWidth, h: mounted.container.clientHeight };
  const camDist = camera.position.distanceTo(_v.set(0, 1.5, 0));
  for (const { el, anchor } of mounted.labelEls) {
    anchor.getWorldPosition(_v);
    const behind = camera.position.distanceTo(_v) > camDist + 0.18;
    _v.project(camera);
    // clamp into the container so labels never spill past the panel edges
    const x = Math.max(34, Math.min(rect.w - 34, (_v.x * 0.5 + 0.5) * rect.w));
    const y = Math.max(16, Math.min(rect.h - 16, (-_v.y * 0.5 + 0.5) * rect.h));
    el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    el.style.opacity = behind ? 0.15 : 1;
    el.style.pointerEvents = behind ? 'none' : 'auto';
  }
}

/* ---------- mount / unmount ---------- */

export function mount(container, opts = {}) {
  if (!isSupported()) return false;
  ensureRenderer();
  unmountInternal();

  container.classList.add('avatar-host');
  container.appendChild(renderer.domElement);

  mounted = { container, opts, labelEls: null, ro: null };
  selected = opts.selected || null;
  hovered = null;
  applyGlowTargets();

  if (opts.mode === 'nav' && Array.isArray(opts.labels)) {
    const layer = document.createElement('div');
    layer.className = 'avatar-labels';
    container.appendChild(layer);
    mounted.labelLayer = layer;
    mounted.labelEls = opts.labels
      .filter(l => anchors[l.anchor])
      .map(l => {
        const a = document.createElement('a');
        a.className = 'avatar-label';
        a.href = l.hash;
        a.textContent = l.text;
        layer.appendChild(a);
        return { el: a, anchor: anchors[l.anchor] };
      });
  }

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); // updateStyle=true: CSS size must track the container,
                            // or high-DPR phones display the canvas at buffer size
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  };
  mounted.ro = new ResizeObserver(resize);
  mounted.ro.observe(container);
  resize();
  lastInteraction = performance.now() - IDLE_DELAY; // start idling immediately
  kick();
  return true;
}

function unmountInternal() {
  if (!mounted) return;
  mounted.ro?.disconnect();
  mounted.labelLayer?.remove();
  if (renderer.domElement.parentNode) renderer.domElement.remove();
  mounted = null;
}

export function unmount() {
  unmountInternal();
  running = false;
}
