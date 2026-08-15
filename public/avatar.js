/* FitBase 3D avatar — stylized athletic mannequin used as an interactive menu.
   Procedural (no model file): every body region is its own named mesh group so
   raycast picking maps 1:1 onto the catalog's `body_part` values. Loaded lazily
   from app.js via dynamic import; Three.js is vendored (versioned filename, so
   the import specifier below never needs cache-busting). */
import * as THREE from './vendor/three-0.185.1.min.js';

const ACCENT = 0x2dd4a7;
const BODY = 0x1a1f2a;

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

/* ---------- module singleton state ---------- */

let renderer = null, scene = null, camera = null, root = null;
let regions = null;          // { id: { group, mat, baseScale } }
let anchors = null;          // { name: Object3D } for nav labels
let raycastTargets = null;   // flat mesh list for picking
let running = false;

let mounted = null;          // { container, opts, labelLayer, labelEls, ro }
let selected = null;         // region id or null
let hovered = null;

let rotTarget = 0, tiltTarget = 0;
let lastInteraction = 0;
const IDLE_DELAY = 3000, IDLE_SPEED = 0.15; // rad/s
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- mannequin construction ----------
   Proportions in "figure units": feet at y=0, top of head ~3.0 (≈7.5 heads).
   The torso is two lathe segments (upper torso + waist) with the front/back
   muscle plates embedded so the silhouette reads athletic from any angle. */

function capsule(r, len, mat) {
  return new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 16), mat);
}
function sphere(r, mat, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), mat);
  m.scale.set(sx, sy, sz);
  return m;
}
function taperedLimb(rTop, rBottom, len, mat) {
  // CapsuleGeometry can't taper; cylinder + sphere caps reads as a muscle mass.
  const g = new THREE.Group();
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, len, 18), mat);
  g.add(cyl);
  const top = sphere(rTop, mat); top.position.y = len / 2; g.add(top);
  const bot = sphere(rBottom, mat); bot.position.y = -len / 2; g.add(bot);
  return g;
}
function lathe(profile, mat, zScale) {
  const pts = profile.map(([y, r]) => new THREE.Vector2(r, y));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 36), mat);
  m.scale.z = zScale;
  return m;
}

function makeMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: BODY, roughness: 0.35, metalness: 0.1, clearcoat: 0.4,
    clearcoatRoughness: 0.35, emissive: ACCENT, emissiveIntensity: 0,
  });
}

function buildMannequin() {
  root = new THREE.Group();
  regions = {};
  raycastTargets = [];

  const region = (id) => {
    const mat = makeMaterial();
    const group = new THREE.Group();
    group.userData.region = id;
    regions[id] = { group, mat, glow: 0, glowTarget: 0 };
    root.add(group);
    return { group, mat };
  };
  const pick = (group, mesh, regionId) => {
    mesh.traverse ? mesh.traverse(o => { if (o.isMesh) { o.userData.region = regionId; raycastTargets.push(o); } })
                  : null;
    if (mesh.isMesh) { mesh.userData.region = regionId; raycastTargets.push(mesh); }
    group.add(mesh);
  };
  const mirror = (group, make, regionId) => {
    for (const side of [1, -1]) {
      const m = make(side);
      pick(group, m, regionId);
    }
  };

  /* upper torso — non-pickable core; hits resolve to chest/back/waist by
     local position (see resolveRegion). Own neutral material so region glow
     never lights the whole trunk. */
  const torsoMat = makeMaterial();
  const upperTorso = lathe([
    [1.95, 0.265], [2.05, 0.28], [2.25, 0.33], [2.42, 0.34], [2.50, 0.27], [2.56, 0.13],
  ], torsoMat, 0.72);
  upperTorso.userData.region = '__torso';
  root.add(upperTorso); raycastTargets.push(upperTorso);

  /* waist — its own lathe segment so the core can glow independently */
  {
    const { group, mat } = region('waist');
    const w = lathe([
      [1.42, 0.245], [1.52, 0.275], [1.66, 0.25], [1.80, 0.218], [1.90, 0.235], [1.96, 0.262],
    ], mat, 0.72);
    pick(group, w, 'waist');
    // pelvis block closes the hips
    const pelvis = sphere(0.25, mat, 1.06, 0.58, 0.72); pelvis.position.set(0, 1.47, 0);
    pick(group, pelvis, 'waist');
  }

  /* head + neck */
  {
    const { group, mat } = region('neck');
    const head = sphere(0.178, mat, 0.9, 1.1, 0.95); head.position.y = 2.79;
    pick(group, head, 'neck');
    const neck = capsule(0.09, 0.14, mat); neck.position.y = 2.58;
    pick(group, neck, 'neck');
  }

  /* delts — slightly oversized caps make the athletic silhouette */
  {
    const { group, mat } = region('shoulders');
    mirror(group, side => {
      const d = sphere(0.185, mat, 1, 0.85, 0.95);
      d.position.set(side * 0.425, 2.435, 0);
      return d;
    }, 'shoulders');
    // traps hint: small wedge from neck to delt
    mirror(group, side => {
      const t = sphere(0.11, mat, 1.6, 0.55, 0.7);
      t.position.set(side * 0.22, 2.52, -0.02);
      t.rotation.z = side * -0.25;
      return t;
    }, 'shoulders');
  }

  /* chest — one broad connected mass hugging the torso front (two separate
     pec spheres read as pebbles stuck on, not an athlete's chest) */
  {
    const { group, mat } = region('chest');
    const chest = sphere(0.16, mat, 2.05, 0.8, 0.5);
    chest.position.set(0, 2.26, 0.115);
    chest.rotation.x = 0.2;                 // lower edge forward — pec hang
    pick(group, chest, 'chest');
    // clavicle fill so the slab flows out of the upper torso instead of ledging
    const clav = sphere(0.135, mat, 2.2, 0.62, 0.42);
    clav.position.set(0, 2.4, 0.075);
    clav.rotation.x = -0.18;
    pick(group, clav, 'chest');
  }

  /* back — one broad slab, traps → lats */
  {
    const { group, mat } = region('back');
    // two flat plates: traps (upper) + lats (lower, wider) — hugging the torso
    const traps = sphere(0.17, mat, 1.35, 0.75, 0.4);
    traps.position.set(0, 2.38, -0.12); traps.rotation.x = -0.25;
    pick(group, traps, 'back');
    const lats = sphere(0.2, mat, 1.5, 0.95, 0.42);
    lats.position.set(0, 2.12, -0.115); lats.rotation.x = -0.12;
    pick(group, lats, 'back');
  }

  /* arms — A-pose ~18°, slight elbow bend forward */
  const armAng = 0.32;
  {
    const { group, mat } = region('upperArms');
    mirror(group, side => {
      const ua = taperedLimb(0.10, 0.082, 0.36, mat);
      ua.position.set(side * 0.435, 2.40, 0);
      ua.rotation.z = side * armAng;
      // shift so the top cap sits at the shoulder joint
      ua.translateY(-0.26);
      return ua;
    }, 'upperArms');
  }
  {
    const { group, mat } = region('lowerArms');
    mirror(group, side => {
      const g2 = new THREE.Group();
      const fa = taperedLimb(0.075, 0.058, 0.34, mat);
      const fist = sphere(0.085, mat, 0.9, 1.05, 0.9); fist.position.y = -0.26;
      g2.add(fa); g2.add(fist);
      // elbow position from the upper-arm transform, embedded for a smooth joint
      const ex = 0.435 + Math.sin(armAng) * 0.48, ey = 2.40 - Math.cos(armAng) * 0.48;
      g2.position.set(side * ex, ey, 0.02);
      g2.rotation.z = side * (armAng + 0.06);
      g2.rotation.x = -0.14;             // forearms drift slightly forward
      g2.translateY(-0.17);
      return g2;
    }, 'lowerArms');
  }

  /* legs */
  {
    const { group, mat } = region('upperLegs');
    mirror(group, side => {
      const q = taperedLimb(0.15, 0.105, 0.52, mat);
      q.position.set(side * 0.175, 1.46, 0);
      q.rotation.z = side * 0.045;
      q.translateY(-0.31);
      return q;
    }, 'upperLegs');
  }
  {
    const { group, mat } = region('lowerLegs');
    mirror(group, side => {
      const g2 = new THREE.Group();
      const shin = taperedLimb(0.10, 0.055, 0.5, mat);
      const calf = sphere(0.085, mat, 0.9, 1.25, 0.85); calf.position.set(0, 0.12, -0.05);
      const foot = sphere(0.075, mat, 1.05, 0.6, 1.9); foot.position.set(0, -0.30, 0.09);
      g2.add(shin); g2.add(calf); g2.add(foot);
      g2.position.set(side * 0.20, 0.86, 0);
      g2.translateY(-0.30);
      return g2;
    }, 'lowerLegs');
  }

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

  /* nav label anchors (world positions tracked each frame) */
  anchors = {
    head:      new THREE.Object3D(), // above head — rotates with body
    shoulderR: new THREE.Object3D(),
    wristL:    new THREE.Object3D(),
    torso:     new THREE.Object3D(),
    floor:     new THREE.Object3D(), // fixed to scene, not the body
  };
  anchors.head.position.set(0, 3.1, 0);
  anchors.shoulderR.position.set(0.68, 2.52, 0);
  anchors.wristL.position.set(-0.72, 1.55, 0.05);
  anchors.torso.position.set(0.45, 1.95, 0.15);
  for (const k of ['head', 'shoulderR', 'wristL', 'torso']) root.add(anchors[k]);
  anchors.floor.position.set(0.95, 0.14, 0.35);
  scene.add(anchors.floor);

  root.rotation.y = 0.5; // pleasing 3/4 starting pose
  rotTarget = 0.5;
  scene.add(root);
}

/* torso-core hits resolve to a real region by where the ray landed */
function resolveRegion(hit) {
  const r = hit.object.userData.region;
  if (r !== '__torso') return r;
  const p = root.worldToLocal(hit.point.clone());
  if (p.y < 1.97) return 'waist';
  return p.z >= 0 ? 'chest' : 'back';
}

/* ---------- scene setup ---------- */

function buildScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(33, 1, 0.1, 30);
  camera.position.set(0, 1.75, 6.4);
  camera.lookAt(0, 1.4, 0);   // center below mid-figure → figure rides high, breathing room under the ring

  const key = new THREE.DirectionalLight(0xcfd6e4, 2.8);
  key.position.set(1.6, 3.4, 2.4);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x2a3242, 0x0a0c10, 1.3));
  // the mint rims: permanent tasteful edge glow on both silhouette sides
  const rimL = new THREE.DirectionalLight(ACCENT, 2.6); rimL.position.set(-2.4, 1.6, -2.0); scene.add(rimL);
  const rimR = new THREE.DirectionalLight(ACCENT, 2.0); rimR.position.set(2.4, 1.2, -2.2); scene.add(rimR);

  buildMannequin();
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
  const hits = ray.intersectObjects(raycastTargets, false);
  return hits.length ? resolveRegion(hits[0]) : null;
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
    reg.glowTarget = id === selected ? 0.45 : id === hovered ? 0.05 : 0;
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

  // per-region emissive + selection pulse
  for (const reg of Object.values(regions)) {
    reg.glow += (reg.glowTarget - reg.glow) * (reduceMotion.matches ? 1 : 0.12);
    reg.mat.emissiveIntensity = reg.glow;
    const s = 1 + reg.glow * 0.036;
    reg.group.scale.setScalar(s);
  }

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
