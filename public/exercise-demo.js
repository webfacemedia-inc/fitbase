/* FitBase 3D exercise demo — an animated Mixamo mannequin (X Bot) performing
   the exercise in the detail modal. Sibling to avatar.js, deliberately NOT
   sharing its renderer: the library body map may be live behind the modal, so
   this module owns a small renderer per mount and disposes it on unmount
   (steady state ≤ 2 WebGL contexts). Asset: vendor/exercise-demos-1.glb, built
   by scripts/mixamo-to-glb.mjs — one skinned mesh + 20 named clips.
   Equipment props (barbell/kettlebell/dumbbells) are procedural primitives
   riding the hand bones — Mixamo clips mime the movement, the props make it
   read as the real lift. Loaded lazily from app.js; no top-level await, so a
   failed GLB fetch degrades that one open (GIF stays), not the whole import. */
import * as THREE from './vendor/three-0.185.1.min.js';
import { GLTFLoader } from './vendor/GLTFLoader-0.185.1.js';

const ACCENT = 0x2dd4a7;
const BODY = 0x2a3140;
const IRON = 0x11151d;   // prop metal — darker than the body so the lift reads
const TURN_SPEED = 0.15; // rad/s turntable, same idle speed as the body map
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- support probe (duplicated from avatar.js: cheap, and importing
   avatar.js would top-level-await the 311KB body mesh) ---------- */

let _supported = null;
export function isSupported() {
  if (_supported !== null) return _supported;
  try {
    const c = document.createElement('canvas');
    _supported = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { _supported = false; }
  return _supported;
}

/* ---------- props: which clips hold what ---------- */

const PROP_BY_CLIP = {
  'back-squat': 'barbell', 'overhead-squat': 'barbell',
  'clean-and-jerk': 'barbell', 'snatch': 'barbell',
  'kettlebell-swing': 'kettlebell', 'sumo-high-pull': 'kettlebell',
  'bicep-curl': 'dumbbell', 'front-raises': 'dumbbell',
};
/* floor work: aim the camera lower so the mannequin isn't in the bottom third */
const LOW_POSE = new Set(['plank', 'push-up', 'jump-push-up', 'situps',
                          'bicycle-crunch', 'circle-crunch']);

/* Prop geometry is built in MODEL units (Mixamo cm — the group scale
   normalizes to figure units afterwards). Mint end-caps echo the app accent. */
function metal(extra = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: IRON, roughness: 0.3, metalness: 0.7, clearcoat: 0.5,
    clearcoatRoughness: 0.3, ...extra,
  });
}
function mintCap() {
  return new THREE.MeshPhysicalMaterial({
    color: BODY, roughness: 0.35, metalness: 0.2,
    emissive: ACCENT, emissiveIntensity: 0.5,
  });
}
function makeBarbell() {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 190, 12), metal());
  bar.rotation.z = Math.PI / 2;
  g.add(bar);
  for (const side of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 5, 24), metal());
    plate.rotation.z = Math.PI / 2; plate.position.x = side * 80;
    g.add(plate);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 6.5, 16), mintCap());
    cap.rotation.z = Math.PI / 2; cap.position.x = side * 80;
    g.add(cap);
  }
  return g;
}
function makeKettlebell() {
  const g = new THREE.Group();                       // origin = handle grip point
  const handle = new THREE.Mesh(new THREE.TorusGeometry(7, 1.7, 10, 24, Math.PI), metal());
  handle.rotation.z = Math.PI;                       // opening faces down toward the ball
  g.add(handle);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(10.5, 20, 16), metal());
  ball.position.y = -14;
  g.add(ball);
  const band = new THREE.Mesh(new THREE.TorusGeometry(10.4, 0.8, 8, 24), mintCap());
  band.rotation.x = Math.PI / 2; band.position.y = -14;
  g.add(band);
  return g;
}
function makeDumbbell() {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 22, 10), metal());
  g.add(bar);
  for (const side of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 6, 16), metal());
    head.position.y = side * 10;
    g.add(head);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 6.6, 12), mintCap());
    cap.position.y = side * 10;
    g.add(cap);
  }
  g.rotation.x = Math.PI / 2;                        // bar axis → z, set per-frame anyway
  return g;
}

/* ---------- asset: one GLB, memoized for the session ---------- */

let assetP = null;
function loadAsset() {
  return (assetP ||= (async () => {
    const gltf = await new GLTFLoader().loadAsync(
      new URL('./vendor/exercise-demos-1.glb', import.meta.url).href);
    const model = gltf.scene;
    const bones = {};
    model.traverse(o => {
      if (o.isBone) bones[o.name] = o;
      if (o.isSkinnedMesh) {
        // bind-pose bounds don't cover a burpee — never let culling hide it
        o.frustumCulled = false;
        o.material = /joint/i.test(o.name)
          ? new THREE.MeshPhysicalMaterial({    // mint articulation joints
              color: 0x1a1f2a, roughness: 0.4, metalness: 0.3,
              emissive: ACCENT, emissiveIntensity: 0.35 })
          : new THREE.MeshPhysicalMaterial({    // satin body, avatar recipe
              color: BODY, roughness: 0.35, metalness: 0.1, clearcoat: 0.4,
              clearcoatRoughness: 0.35, emissive: ACCENT, emissiveIntensity: 0.045 });
      }
    });
    // normalize Mixamo cm → figure units: height 3, feet at y=0 (T-pose bbox)
    const bb = new THREE.Box3().setFromObject(model);
    const s = 3 / (bb.max.y - bb.min.y);
    const group = new THREE.Group();
    group.add(model);
    model.scale.setScalar(s);
    model.position.y = -bb.min.y * s;
    const props = {
      barbell: makeBarbell(), kettlebell: makeKettlebell(), dumbbell2: makeDumbbell(),
    };
    props.dumbbell = makeDumbbell();
    for (const p of Object.values(props)) { p.visible = false; model.add(p); }
    const mixer = new THREE.AnimationMixer(model);
    const clips = Object.fromEntries(gltf.animations.map(c => [c.name, c]));
    return { group, model, mixer, clips, bones, props };
  })().catch(e => { assetP = null; throw e; }));
}

/* ---------- per-frame prop placement (model space) ---------- */

const _l = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Vector3();
const _dir = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);

function placeProps(asset, prop) {
  const { bones, props, model } = asset;
  const L = bones.mixamorigLeftHand, R = bones.mixamorigRightHand;
  if (!L || !R) return;
  L.getWorldPosition(_l); R.getWorldPosition(_r);
  model.worldToLocal(_l); model.worldToLocal(_r);
  _m.addVectors(_l, _r).multiplyScalar(0.5);
  if (prop === 'barbell') {
    // bar center at the hands' midpoint, axis along the hand-to-hand line.
    // Long clips (clean & jerk, snatch) include transitions where the hands
    // leave the bar — a near-vertical or zero-width hand line would impale
    // the figure, so the bar only shows when the grip reads as a real lift.
    _dir.subVectors(_r, _l);
    const grip = _dir.length() > 20 && Math.abs(_dir.y / _dir.length()) < 0.25;
    props.barbell.visible = grip;
    if (grip) {
      _dir.normalize();
      props.barbell.position.copy(_m);
      props.barbell.quaternion.setFromUnitVectors(X_AXIS, _dir);
    }
  } else if (prop === 'kettlebell') {
    // handle at the hands, bell hanging along the arm line (forearm → hand)
    const fl = bones.mixamorigLeftForeArm, fr = bones.mixamorigRightForeArm;
    if (fl && fr) {
      fl.getWorldPosition(_dir); fr.getWorldPosition(_t);
      _dir.add(_t).multiplyScalar(0.5);
      model.worldToLocal(_dir);
      _dir.subVectors(_m, _dir).normalize();        // elbows → hands
    } else _dir.set(0, -1, 0);
    props.kettlebell.position.copy(_m);
    props.kettlebell.quaternion.setFromUnitVectors(_t.set(0, -1, 0), _dir);
  } else if (prop === 'dumbbell') {
    // one per hand; grip axis ≈ the thumb bone direction (X Bot has fingers)
    for (const [hand, thumbName, mesh] of [
      [L, 'mixamorigLeftHandThumb2', props.dumbbell],
      [R, 'mixamorigRightHandThumb2', props.dumbbell2],
    ]) {
      hand.getWorldPosition(_t); model.worldToLocal(_t);
      mesh.position.copy(_t);
      const thumb = bones[thumbName];
      if (thumb) {
        thumb.getWorldPosition(_dir); model.worldToLocal(_dir);
        _dir.sub(_t).normalize();
        _q.setFromUnitVectors(Y_AXIS, _dir);
        mesh.quaternion.copy(_q);
      }
    }
  }
}

/* ---------- mount / unmount ---------- */

let active = null;   // { renderer, scene, camera, ro, raf, last, clipName, prop }

export async function mount(container, clipName) {
  if (!isSupported()) return false;
  const asset = await loadAsset();
  if (!asset.clips[clipName] || !container.isConnected) return false;
  unmount();

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch { return false; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.className = 'exdemo-canvas';
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 30);
  const low = LOW_POSE.has(clipName);
  camera.position.set(1.4, low ? 2.3 : 1.85, low ? 5.2 : 6.0);
  camera.lookAt(0, low ? 0.55 : 1.3, 0);

  // lighting: the avatar rig (key/fill/hemi + mint rims), verbatim
  const key = new THREE.DirectionalLight(0xdfe5f0, 3.4); key.position.set(1.6, 3.4, 2.4); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb0c8, 1.1); fill.position.set(-2.2, 1.8, 2.6); scene.add(fill);
  scene.add(new THREE.HemisphereLight(0x3a4458, 0x0f1218, 1.6));
  const rimL = new THREE.DirectionalLight(ACCENT, 2.6); rimL.position.set(-2.4, 1.6, -2.0); scene.add(rimL);
  const rimR = new THREE.DirectionalLight(ACCENT, 2.0); rimR.position.set(2.4, 1.2, -2.2); scene.add(rimR);

  // floor: fake contact shadow + accent ring, as on the body map
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  })();
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.15, 48),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.005;
  scene.add(shadow);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 0.975, 64),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.28, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
  scene.add(ring);

  const prop = PROP_BY_CLIP[clipName] || null;
  for (const [name, p] of Object.entries(asset.props))
    p.visible = prop !== null && name.startsWith(prop);
  asset.group.rotation.y = 0.5;             // pleasing 3/4 start, as the body map
  scene.add(asset.group);

  asset.mixer.stopAllAction();
  asset.mixer.clipAction(asset.clips[clipName]).reset().setLoop(THREE.LoopRepeat, Infinity).play();
  asset.mixer.update(0);                    // pose frame 0 before first paint

  const st = active = { renderer, scene, camera, ro: null, raf: 0, last: 0, clipName, prop };

  const frame = (now) => {
    if (active !== st) return;
    if (document.hidden || !renderer.domElement.isConnected) { st.raf = 0; return; }
    st.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, st.last ? (now - st.last) / 1000 : 0.016);
    st.last = now;
    asset.mixer.update(dt);
    if (prop) placeProps(asset, prop);
    if (!reduceMotion.matches) asset.group.rotation.y += TURN_SPEED * dt;
    renderer.render(scene, camera);
  };
  const kick = () => { if (active === st && !st.raf) { st.last = 0; st.raf = requestAnimationFrame(frame); } };
  st.onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', st.onVis);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  };
  st.ro = new ResizeObserver(resize);
  st.ro.observe(container);
  container.appendChild(renderer.domElement);
  resize();
  kick();
  return true;
}

export function unmount() {
  if (!active) return;
  const st = active;
  active = null;                            // frame() sees this and stops
  if (st.raf) cancelAnimationFrame(st.raf);
  st.ro?.disconnect();
  document.removeEventListener('visibilitychange', st.onVis);
  assetP?.then(a => { a.mixer.stopAllAction(); a.group.removeFromParent(); }).catch(() => {});
  st.renderer.domElement.remove();
  st.renderer.dispose();
  st.renderer.forceContextLoss?.();
}
