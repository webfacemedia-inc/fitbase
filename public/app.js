/* FitBase — exercise library, workout builder, training log.
   Backend: PocketBase (same origin). Media: exercises-dataset via jsDelivr CDN. */
'use strict';

const pb = new PocketBase('/');
const CDN = 'https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@main/';
const LANGS = { en:'English', es:'Español', it:'Italiano', tr:'Türkçe', ru:'Русский',
                zh:'中文', hi:'हिन्दी', pl:'Polski', ko:'한국어', fr:'Français' };
const PAGE = 36;

/* 3D body-map avatar — a lazy ES-module island (avatar.js + vendored three.js).
   ASSET_V comes from this script's own ?v= tag so avatar.js cache-busts per
   deploy; the three.js vendor file is versioned by filename and needs none. */
const ASSET_V = (() => {
  try { return new URL(document.currentScript.src).searchParams.get('v') || 'dev'; }
  catch { return 'dev'; }
})();
let avatarModP = null, avatarMod = null;
const loadAvatar = () => (avatarModP ||= import(`./avatar.js?v=${ASSET_V}`).then(m => (avatarMod = m)));
// avatar region → exercises.body_part (verified against the live catalog).
// 'cardio' is the one body_part with no body region — chips/search cover it.
const BP_MAP = {
  neck: 'neck', shoulders: 'shoulders', chest: 'chest', back: 'back', waist: 'waist',
  upperArms: 'upper arms', lowerArms: 'lower arms',
  upperLegs: 'upper legs', lowerLegs: 'lower legs',
};
const REGION_BY_BP = Object.fromEntries(Object.entries(BP_MAP).map(([r, b]) => [b, r]));

const $ = s => document.querySelector(s);
const view = $('#view'), overlay = $('#overlay');
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const state = {
  catalog: null,          // light list of all exercises
  q: '', cat: '', equip: '', target: '', bodyPart: '', page: 1,
  ownedOnly: false,       // filter library to My Gym equipment
  gym: null,              // { record, equipment:[...] } — the user's owned equipment
  workouts: null,
  session: null,          // in-progress workout session
  detailCache: {},
};

/* ---------- helpers ---------- */

/* Inline SVG icons (Lucide-style, currentColor). Buildless app → no icon lib;
   these keep the UI crisp and themeable without a dependency. */
const ICONS = {
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  trend: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  dumbbell: '<path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  whistle: '<path d="M12 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M16 12h5a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H8.5"/><path d="M8.5 8 7 5"/>',
};
const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2600);
}

function modal(html) {
  overlay.innerHTML = `<div class="modal">${html}<button class="close" onclick="closeModal()">✕</button></div>`;
  overlay.classList.remove('hidden');
}
function closeModal() { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

const me = () => pb.authStore.isValid ? pb.authStore.record : null;

/* ---------- steps/AI language preference ----------
   Resolution: account field > device (localStorage) > browser auto-detect.
   The server guards which fields a self-update may touch (see server/lang.go). */

function stepsLang() {
  const u = me();
  if (u?.lang && LANGS[u.lang]) return u.lang;
  const ls = localStorage.getItem('fb_lang');
  if (ls && LANGS[ls]) return ls;
  const nav = (navigator.language || '').slice(0, 2).toLowerCase();
  return LANGS[nav] ? nav : 'en';
}

async function setStepsLang(lang) {
  if (!LANGS[lang] || lang === stepsLang()) return;
  localStorage.setItem('fb_lang', lang);
  const u = me();
  if (u) {
    try {
      await pb.collection('users').update(u.id, { lang });
      if (me()?.lang !== lang) pb.authStore.save(pb.authStore.token, { ...me(), lang });
    } catch { /* offline/rule issue → device-level preference still applies */ }
  }
  toast('Steps language saved');
}

// One-time up-sync: a signed-in account with no language yet inherits the
// device preference (covers fresh Google accounts and pre-existing users).
async function syncLangUp() {
  const u = me(), ls = localStorage.getItem('fb_lang');
  if (u && !u.lang && ls && LANGS[ls]) {
    try {
      await pb.collection('users').update(u.id, { lang: ls });
      if (me()?.lang !== ls) pb.authStore.save(pb.authStore.token, { ...me(), lang: ls });
    } catch { /* non-fatal */ }
  }
}

function needAuth() {
  if (me()) return false;
  location.hash = '#/signin';
  return true;
}

async function loadCatalog() {
  if (state.catalog) return state.catalog;
  state.catalog = await pb.collection('exercises').getFullList({
    batch: 500, sort: 'name',
    // body_part + muscle_group are fetched so search can match them — without
    // them the filter silently cannot find "quads" or "upper arms", which is
    // exactly how the old 2-field search lost most of its recall. Still no
    // `steps`/`secondary_muscles` (large JSON blobs, detail view only).
    fields: 'id,ex_id,name,category,equipment,target,body_part,muscle_group,image',
  });
  return state.catalog;
}

async function loadWorkouts(force) {
  if (!me()) return [];
  if (state.workouts && !force) return state.workouts;
  state.workouts = await pb.collection('workouts').getFullList({ sort: '-created' });
  return state.workouts;
}

// The user's "My Gym" equipment profile (one per user). Returns the equipment
// array (empty if none set). Cached in state.gym.
async function loadGym(force) {
  if (!me()) return [];
  if (state.gym && !force) return state.gym.equipment;
  try {
    const rec = await pb.collection('gym_profiles').getFirstListItem(`owner="${me().id}"`);
    state.gym = { record: rec, equipment: Array.isArray(rec.equipment) ? rec.equipment : [] };
  } catch {
    state.gym = { record: null, equipment: [] }; // no profile yet
  }
  return state.gym.equipment;
}

async function saveGym(equipment) {
  const owner = me().id;
  if (state.gym?.record) {
    state.gym.record = await pb.collection('gym_profiles').update(state.gym.record.id, { equipment });
  } else {
    state.gym = { record: await pb.collection('gym_profiles').create({ owner, equipment }), equipment };
  }
  state.gym.equipment = equipment;
}

/* ---------- router ---------- */

const routes = {
  home: renderHome,
  library: renderLibrary,
  workouts: renderWorkouts,
  history: renderHistory,
  gym: renderGym,
  coach: renderCoach,
  coaches: renderCoaches,
  accept: renderAccept,
  signin: renderAuth,
  forgot: renderForgot,
  reset: renderResetConfirm,
  session: renderSession,
};

let params = new URLSearchParams();
async function route() {
  // signed-in users land on their plan (Workouts), not the reference library
  const raw = location.hash.replace(/^#\//, '') || (me() ? 'workouts' : 'home');
  const qi = raw.indexOf('?');
  params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const seg = (qi >= 0 ? raw.slice(0, qi) : raw).split('/');
  const name = routes[seg[0]] ? seg[0] : 'library';
  document.body.dataset.route = name; // drives per-route layout width (see main{} in CSS)
  document.querySelectorAll('#nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.route === name));
  renderAuthbox();
  try { await routes[name](seg[1]); }
  catch (err) {
    console.error(err);
    view.innerHTML = `<p class="empty">Something went wrong loading this page. ${esc(err?.message || '')}</p>`;
  }
}
window.addEventListener('hashchange', route);

function renderAuthbox() {
  const u = me();
  const nav = $('#nav'); if (nav) nav.style.display = u ? 'flex' : 'none';
  $('#authbox').innerHTML = u
    ? `<span class="who">${esc(u.email)}</span><button class="btn sm" onclick="signOut()">Sign out</button>`
    : `<a class="btn sm primary" href="#/signin">Sign in</a>`;
}

/* ---------- auth ---------- */

function renderAuth() {
  if (me()) { location.hash = '#/library'; return; }
  view.innerHTML = `
    <div class="authcard">
      <h1>Fit<span style="color:var(--accent)">Base</span></h1>
      <p class="sub" style="margin:6px 0 0">Sign in to build workouts and log training.</p>
      <div id="a-oauth"></div>
      <form onsubmit="return doAuth(event)">
        <input type="email" id="a-email" placeholder="Email" required autocomplete="email">
        <input type="password" id="a-pass" placeholder="Password" required minlength="8" autocomplete="current-password">
        <div class="err" id="a-err"></div>
        <button class="btn primary" type="submit" id="a-btn">Sign in</button>
      </form>
      <p class="alt">No account? <a href="#" onclick="return toggleAuthMode()" id="a-toggle">Create one</a>
        <span style="opacity:.4"> · </span><a href="#/forgot">Forgot password?</a></p>
      <p class="legal-note">By continuing you agree to the <a href="/terms/">Terms of Service</a>
        and <a href="/privacy/">Privacy Policy</a>.</p>
    </div>`;
  // Show the Google button only when the server actually has the provider
  // configured (ensureOAuth on the binary + GOOGLE_CLIENT_ID/SECRET in app.env)
  // — so this lights up on its own once the keys land, and never dead-clicks.
  pb.collection('users').listAuthMethods().then(m => {
    const box = $('#a-oauth');
    if (!box?.isConnected) return;
    if (!m?.oauth2?.enabled || !m.oauth2.providers?.some(p => p.name === 'google')) return;
    box.innerHTML = `
      <button class="btn oauth-btn" type="button" onclick="signInGoogle(this)">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Continue with Google
      </button>
      <div class="or-sep"><span>or</span></div>`;
  }).catch(() => {});
}

// Google OAuth2 via PocketBase's all-in-one popup flow (redirect URI is the
// server's /api/oauth2-redirect). New Google users are auto-created by PB.
async function signInGoogle(btn) {
  const errEl = $('#a-err'); if (errEl) errEl.textContent = '';
  btn.disabled = true;
  try {
    await pb.collection('users').authWithOAuth2({ provider: 'google' });
    syncLangUp(); // fire-and-forget: adopt the device language on first sign-in
    state.workouts = null;
    const pending = sessionStorage.getItem('pendingInvite');
    if (pending) { sessionStorage.removeItem('pendingInvite'); location.hash = '#/accept/' + pending; }
    else if (sessionStorage.getItem('pendingHire')) location.hash = '#/coaches'; // resume interrupted hire
    else location.hash = '#/library';
    toast('Signed in with Google.');
  } catch (err) {
    // a closed popup is a user choice, not an error worth shouting about
    if (errEl && !/cancell|closed|abort/i.test(String(err?.message)))
      errEl.textContent = err?.data?.message || err?.message || 'Google sign-in failed.';
  }
  btn.disabled = false;
}

function renderForgot() {
  if (me()) { location.hash = '#/library'; return; }
  view.innerHTML = `
    <div class="authcard">
      <h1>Reset password</h1>
      <p class="sub" style="margin:6px 0 0">Enter your email and we'll send a reset link.</p>
      <form onsubmit="return doForgot(event)">
        <input type="email" id="fp-email" placeholder="Email" required autocomplete="email">
        <div class="err" id="fp-msg"></div>
        <button class="btn primary" type="submit" id="fp-btn">Send reset link</button>
      </form>
      <p class="alt"><a href="#/signin">← Back to sign in</a></p>
    </div>`;
}

async function doForgot(e) {
  e.preventDefault();
  const email = $('#fp-email').value.trim();
  const msg = $('#fp-msg'); const btn = $('#fp-btn');
  msg.className = 'err'; msg.textContent = ''; btn.disabled = true;
  try {
    await pb.collection('users').requestPasswordReset(email);
  } catch (_) { /* never reveal whether an address exists */ }
  msg.className = 'err'; msg.style.color = 'var(--accent)';
  msg.textContent = 'If that email has an account, a reset link is on its way. Check your inbox.';
  btn.disabled = false;
  return false;
}

function renderResetConfirm(token) {
  if (!token) { location.hash = '#/forgot'; return; }
  view.innerHTML = `
    <div class="authcard">
      <h1>Set a new password</h1>
      <p class="sub" style="margin:6px 0 0">Choose a new password for your FitBase account.</p>
      <form onsubmit="return doReset(event, '${esc(token)}')">
        <input type="password" id="rp-pass" placeholder="New password" required minlength="8" autocomplete="new-password">
        <input type="password" id="rp-pass2" placeholder="Confirm new password" required minlength="8" autocomplete="new-password">
        <div class="err" id="rp-err"></div>
        <button class="btn primary" type="submit" id="rp-btn">Update password</button>
      </form>
      <p class="alt"><a href="#/forgot">Request a new link</a></p>
    </div>`;
}

async function doReset(e, token) {
  e.preventDefault();
  const p1 = $('#rp-pass').value, p2 = $('#rp-pass2').value;
  const err = $('#rp-err'); err.textContent = '';
  if (p1 !== p2) { err.textContent = 'Passwords do not match.'; return false; }
  $('#rp-btn').disabled = true;
  try {
    await pb.collection('users').confirmPasswordReset(token, p1, p2);
    location.hash = '#/signin';
    toast('Password updated — sign in with your new password.');
  } catch (err2) {
    err.textContent = (err2?.data?.message || err2.message || 'That link is invalid or expired.')
      + ' Request a fresh link below.';
    $('#rp-btn').disabled = false;
  }
  return false;
}

let signupMode = false;
function toggleAuthMode() {
  signupMode = !signupMode;
  $('#a-btn').textContent = signupMode ? 'Create account' : 'Sign in';
  $('#a-toggle').textContent = signupMode ? 'Sign in instead' : 'Create one';
  return false;
}

async function doAuth(e) {
  e.preventDefault();
  const email = $('#a-email').value.trim(), pass = $('#a-pass').value;
  const errEl = $('#a-err'); errEl.textContent = '';
  try {
    if (signupMode) {
      await pb.collection('users').create({ email, password: pass, passwordConfirm: pass });
    }
    await pb.collection('users').authWithPassword(email, pass);
    syncLangUp(); // fire-and-forget: adopt the device language on first sign-in
    state.workouts = null;
    const pending = sessionStorage.getItem('pendingInvite');
    if (pending) { sessionStorage.removeItem('pendingInvite'); location.hash = '#/accept/' + pending; }
    else if (sessionStorage.getItem('pendingHire')) location.hash = '#/coaches'; // resume interrupted hire
    else location.hash = '#/library';
    toast(signupMode ? 'Account created — welcome.' : 'Signed in.');
  } catch (err) {
    errEl.textContent = err?.data?.message || err.message || 'Failed.';
  }
  return false;
}

function signOut() {
  pb.authStore.clear();
  state.workouts = null; state.session = null;
  location.hash = '#/library';
  renderAuthbox();
}

/* ---------- library ---------- */

async function renderLibrary() {
  // deep links from the home avatar (and shareable URLs): #/library?bp=upper%20arms
  if (params.get('bp') !== null) {
    state.bodyPart = params.get('bp');
    state.page = 1;
  }
  view.innerHTML = `<h1>Exercise library</h1>
    <p class="sub">Loading the catalog…</p>`;
  const all = await loadCatalog();
  if (me()) await loadGym();
  // The catalog fetch is slow on first load; if the user navigated to another
  // route while it was in flight, don't clobber that view with the library.
  if (document.body.dataset.route !== 'library') return;
  const cats = [...new Set(all.map(x => x.category))].sort();
  const equips = [...new Set(all.map(x => x.equipment))].sort();
  const targets = [...new Set(all.map(x => x.target))].sort();
  const gymCount = state.gym?.equipment?.length || 0;
  if (state.bodyPart && !REGION_BY_BP[state.bodyPart] && state.bodyPart !== 'cardio')
    console.warn('unknown body_part filter:', state.bodyPart);

  view.innerHTML = `
    <h1>Exercise library</h1>
    <p class="sub">${all.length} exercises · filter by muscle, equipment or target</p>
    <div class="lib-head" id="lib-head">
      <div class="bodymap-panel" id="bm-panel"><div class="bm-shimmer"></div></div>
      <div class="lib-controls">
        <button class="btn sm" id="bm-toggle">🧍 Filter by body map</button>
        <div class="filters">
          <input type="search" id="f-q" placeholder="Search exercises…" value="${esc(state.q)}">
          <select id="f-equip">
            <option value="">All equipment</option>
            ${equips.map(x => `<option ${x===state.equip?'selected':''} value="${esc(x)}">${esc(x)}</option>`).join('')}
          </select>
          <select id="f-target">
            <option value="">All targets</option>
            ${targets.map(x => `<option ${x===state.target?'selected':''} value="${esc(x)}">${esc(x)}</option>`).join('')}
          </select>
          ${me() ? (gymCount
            ? `<label class="mygym-toggle"><input type="checkbox" id="f-owned" ${state.ownedOnly?'checked':''}> Only my gym (${gymCount})</label>`
            : `<a class="btn sm" href="#/gym">Set up My Gym →</a>`) : ''}
        </div>
        <div class="chips" id="f-cats">
          <button class="chip ${state.cat===''?'on':''}" data-cat="">all</button>
          ${cats.map(c => `<button class="chip ${c===state.cat?'on':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <p class="count countrow"><span id="f-count"></span><button class="chip bp hidden" id="f-bp"></button></p>
      </div>
    </div>
    <div class="grid" id="f-grid"></div>
    <div class="pager" id="f-pager"></div>`;

  $('#f-q').addEventListener('input', e => { state.q = e.target.value; state.page = 1; paintGrid(); });
  $('#f-equip').addEventListener('change', e => { state.equip = e.target.value; state.page = 1; paintGrid(); });
  $('#f-target').addEventListener('change', e => { state.target = e.target.value; state.page = 1; paintGrid(); });
  $('#f-owned')?.addEventListener('change', e => { state.ownedOnly = e.target.checked; state.page = 1; paintGrid(); });
  $('#f-cats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    state.cat = b.dataset.cat; state.page = 1;
    document.querySelectorAll('#f-cats .chip').forEach(c => c.classList.toggle('on', c === b));
    paintGrid();
  });
  $('#f-bp').addEventListener('click', () => {
    state.bodyPart = ''; state.page = 1;
    avatarMod?.setSelected(null);
    paintGrid(); paintBpChip();
  });
  paintGrid();
  paintBpChip();
  initBodyMap();
}

/* Mount the 3D body map into the library panel. Desktop: loaded in idle time
   after the grid paints. Mobile: only when the user opens the toggle, so the
   three.js payload is never fetched on phones unless asked for. */
function initBodyMap() {
  const panel = $('#bm-panel');
  const mountIt = async () => {
    await loadAvatar();
    if (document.body.dataset.route !== 'library' || !panel.isConnected) return;
    if (!avatarMod.isSupported()) { $('#lib-head')?.classList.add('no3d'); return; }
    avatarMod.mount(panel, {
      mode: 'filter',
      selected: REGION_BY_BP[state.bodyPart] || null,
      onRegion: r => {
        state.bodyPart = r ? BP_MAP[r] : '';
        state.page = 1;
        paintGrid(); paintBpChip();
      },
    });
    panel.classList.add('ready');
  };
  if (matchMedia('(max-width:640px)').matches) {
    $('#bm-toggle').addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      if (open) mountIt().catch(() => $('#lib-head')?.classList.add('no3d'));
    });
  } else {
    (window.requestIdleCallback || setTimeout)(() =>
      mountIt().catch(() => $('#lib-head')?.classList.add('no3d')));
  }
}

function paintBpChip() {
  const b = $('#f-bp'); if (!b) return;
  if (state.bodyPart) {
    b.textContent = `body: ${state.bodyPart} ✕`;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

/* ---------- My Gym (equipment inventory) ---------- */

async function renderGym() {
  if (needAuth()) return;
  view.innerHTML = `<h1>My Gym</h1><p class="sub">Loading…</p>`;
  const all = await loadCatalog();
  await loadGym();
  const equips = [...new Set(all.map(x => x.equipment))].sort();
  const sel = new Set(state.gym.equipment);
  view.innerHTML = `
    <h1>My Gym</h1>
    <p class="sub">Tick the equipment your gym has. The library filter and your AI plans use this to
      show only exercises you can actually do.</p>
    <div class="chips" id="g-chips">
      ${equips.map(x => `<button class="chip ${sel.has(x)?'on':''}" data-eq="${esc(x)}">${esc(x)}</button>`).join('')}
    </div>
    <div class="rowbar" style="max-width:none">
      <span class="count" id="g-count">${sel.size} selected</span>
      <button class="btn" onclick="location.hash='#/library'">← Library</button>
      <button class="btn primary" id="g-save">Save my gym</button>
    </div>`;
  $('#g-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-eq]'); if (!b) return;
    const eq = b.dataset.eq;
    if (sel.has(eq)) sel.delete(eq); else sel.add(eq);
    b.classList.toggle('on');
    $('#g-count').textContent = `${sel.size} selected`;
  });
  $('#g-save').addEventListener('click', async () => {
    const btn = $('#g-save'); btn.disabled = true;
    try {
      await saveGym([...sel]);
      toast('Gym saved — used across the library and AI plans.');
    } catch (err) {
      toast('Could not save: ' + (err?.data?.message || err?.message || 'error'));
    }
    btn.disabled = false;
  });
}

// Searchable text per exercise, built once and cached on the record.
//
// Was: `name.includes(q) || target.includes(q)` — 2 of the 6 text fields, and
// substring rather than token. So "dumbbell" found nothing unless it happened
// to be in the name, and "press bench" found nothing at all because it is not
// a contiguous substring of "Barbell Bench Press".
function haystack(x) {
  if (x._hay === undefined) {
    x._hay = [x.name, x.target, x.body_part, x.muscle_group, x.equipment, x.category]
      .filter(Boolean).join(' ').toLowerCase();
  }
  return x._hay;
}

// Every token must appear somewhere, in any order and any field. This is the
// client-side stand-in for what FTS5 does server-side: token matching rather
// than substring. Ranking is deliberately NOT attempted here — the catalogue
// is a fixed 1,324 rows filtered in memory, so ordering by relevance would be
// polish; correctness of the match set is the actual gap.
function matchesQuery(x, tokens) {
  if (!tokens.length) return true;
  const hay = haystack(x);
  return tokens.every(t => hay.includes(t));
}

function filtered() {
  const tokens = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const owned = state.ownedOnly && state.gym?.equipment?.length ? new Set(state.gym.equipment) : null;
  return state.catalog.filter(x =>
    matchesQuery(x, tokens) &&
    (!state.cat || x.category === state.cat) &&
    (!state.equip || x.equipment === state.equip) &&
    (!state.target || x.target === state.target) &&
    (!state.bodyPart || x.body_part === state.bodyPart) &&
    (!owned || owned.has(x.equipment)));
}

function paintGrid() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  state.page = Math.min(state.page, pages);
  const slice = list.slice((state.page - 1) * PAGE, state.page * PAGE);
  $('#f-count').textContent = `${list.length} exercise${list.length === 1 ? '' : 's'}`;
  $('#f-grid').innerHTML = slice.map(x => `
    <div class="card" onclick="openDetail('${esc(x.id)}')">
      <img loading="lazy" src="${CDN}${esc(x.image)}" alt="${esc(x.name)}">
      <div class="cb">
        <div class="nm">${esc(x.name)}</div>
        <div class="mt">${esc(x.target)} · ${esc(x.equipment)}</div>
      </div>
    </div>`).join('') || `<p class="empty">Nothing matches those filters.</p>`;
  $('#f-pager').innerHTML = pages > 1 ? `
    <button class="btn sm" ${state.page<=1?'disabled':''} onclick="state.page--;paintGrid();scrollTo(0,0)">← Prev</button>
    <span style="color:var(--muted);font-size:13px;align-self:center">${state.page} / ${pages}</span>
    <button class="btn sm" ${state.page>=pages?'disabled':''} onclick="state.page++;paintGrid();scrollTo(0,0)">Next →</button>` : '';
}

async function openDetail(id, lang) {
  lang = lang || stepsLang();
  let x = state.detailCache[id];
  if (!x) {
    x = await pb.collection('exercises').getOne(id);
    state.detailCache[id] = x;
  }
  const steps = (x.steps && x.steps[lang]) || x.steps?.en || [];
  const secondary = Array.isArray(x.secondary_muscles) ? x.secondary_muscles.join(', ') : '';
  modal(`
    <h2>${esc(x.name)}</h2>
    <div class="exhead">
      <img src="${CDN}${esc(x.gif_url)}" alt="${esc(x.name)} animation">
      <div>
        <div class="tags">
          <span class="tag">target <b>${esc(x.target)}</b></span>
          <span class="tag">muscle group <b>${esc(x.muscle_group)}</b></span>
          <span class="tag">equipment <b>${esc(x.equipment)}</b></span>
          <span class="tag">category <b>${esc(x.category)}</b></span>
        </div>
        ${secondary ? `<div class="tags"><span class="tag">also works <b>${esc(secondary)}</b></span></div>` : ''}
        <div style="margin-top:16px">
          <button class="btn primary" onclick="pickWorkout('${esc(x.id)}')">+ Add to workout</button>
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center">
      <h2 style="font-size:15px;text-transform:none">How to do it</h2>
      <select class="langsel" onchange="setStepsLang(this.value); openDetail('${esc(x.id)}', this.value)">
        ${Object.entries(LANGS).map(([k,v]) =>
          `<option value="${k}" ${k===lang?'selected':''}>${v}</option>`).join('')}
      </select>
    </div>
    <ol class="steps">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <p class="attr">${esc(x.attribution || '© Gym visual — https://gymvisual.com/')}</p>`);
}

/* ---------- workouts ---------- */

async function renderWorkouts(editId) {
  if (needAuth()) return;
  if (editId) return renderWorkoutEditor(editId);
  const ws = await loadWorkouts();
  view.innerHTML = `
    <h1>Workouts</h1>
    <p class="sub">Build routines from the library, or let the AI coach build a week from your gym.</p>
    <div class="rowbar">
      <button class="btn primary" onclick="openAIPlan()">${icon('sparkles')}Generate with AI</button>
      <span style="color:var(--muted);font-size:13px">— a weekly plan from your My&nbsp;Gym equipment</span>
    </div>
    <div class="rowbar">
      <input id="w-name" placeholder="…or a manual workout name — e.g. Push Day">
      <button class="btn" onclick="createWorkout()">Create</button>
    </div>
    <div class="wlist">
      ${ws.map(w => {
        const n = (w.items || []).length;
        return `<div class="wrow">
          <div class="grow">
            <div class="nm">${esc(w.name)}</div>
            <div class="mt">${n} exercise${n===1?'':'s'}</div>
          </div>
          <button class="btn sm" onclick="location.hash='#/workouts/${esc(w.id)}'">Edit</button>
          <button class="btn sm primary" ${n?'':'disabled'} onclick="startSession('${esc(w.id)}')">Start</button>
          <button class="btn sm danger" onclick="deleteWorkout('${esc(w.id)}')">✕</button>
        </div>`;
      }).join('') || `<p class="empty">No workouts yet — name one above, then add exercises from the Library.</p>`}
    </div>`;
}

async function createWorkout() {
  const name = $('#w-name').value.trim();
  if (!name) return toast('Give the workout a name first.');
  const w = await pb.collection('workouts').create({ name, owner: me().id, items: [] });
  await loadWorkouts(true);
  location.hash = `#/workouts/${w.id}`;
}

/* ---------- AI plan generation ---------- */

function openAIPlan() {
  if (!me()) { location.hash = '#/signin'; return; }
  modal(`
    <h2 style="text-transform:none;display:flex;align-items:center;gap:9px">${icon('sparkles','ico')}Generate a weekly plan</h2>
    <p class="sub" style="margin:6px 0 16px">The AI coach builds workouts from the equipment in your
      <a href="#/gym" onclick="closeModal()">My Gym</a>. Tell it what you're training for.</p>
    <form onsubmit="return doAIPlan(event)">
      <div class="rowbar" style="margin:0 0 12px">
        <input id="ai-goal" placeholder="Goal — e.g. build muscle, get stronger, lose fat" required style="flex:1">
      </div>
      <div class="field-grid">
        <label class="fld">Days/week
          <select id="ai-days">${[2,3,4,5,6].map(d=>`<option ${d===3?'selected':''}>${d}</option>`).join('')}</select>
        </label>
        <label class="fld">Experience
          <select id="ai-exp"><option>beginner</option><option selected>intermediate</option><option>advanced</option></select>
        </label>
        <label class="fld">Minutes/session
          <select id="ai-min">${[30,45,60,75,90].map(m=>`<option ${m===60?'selected':''}>${m}</option>`).join('')}</select>
        </label>
      </div>
      <input id="ai-inj" placeholder="Injuries / limitations (optional)" style="width:100%;margin-bottom:14px">
      <div class="err" id="ai-err"></div>
      <button class="btn primary" type="submit" id="ai-btn" style="width:100%">Generate my plan</button>
    </form>`);
}

async function doAIPlan(e) {
  e.preventDefault();
  const btn = $('#ai-btn'), err = $('#ai-err');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Building your plan… (up to a minute)';
  try {
    const res = await pb.send('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: $('#ai-goal').value.trim(),
        days_per_week: Number($('#ai-days').value),
        experience: $('#ai-exp').value,
        injuries: $('#ai-inj').value.trim(),
        session_minutes: Number($('#ai-min').value),
      }),
    });
    closeModal();
    await loadWorkouts(true);
    renderWorkouts();
    const n = (res.created || []).length;
    toast(`Created ${n} workout${n===1?'':'s'} from your gym.`);
  } catch (err2) {
    err.textContent = err2?.data?.message || err2?.message || 'Could not generate a plan.';
    btn.disabled = false; btn.textContent = 'Generate my plan';
  }
  return false;
}

async function deleteWorkout(id) {
  if (!confirm('Delete this workout? Logged sessions are kept.')) return;
  await pb.collection('workouts').delete(id);
  await loadWorkouts(true);
  renderWorkouts();
}

async function renderWorkoutEditor(id) {
  let w;
  try { w = await pb.collection('workouts').getOne(id); }
  catch { location.hash = '#/workouts'; return; }
  const items = w.items || [];
  view.innerHTML = `
    <h1>${esc(w.name)}</h1>
    <p class="sub">${items.length} exercise${items.length===1?'':'s'} — set target sets × reps per exercise.
      <a href="#/library">Add more from the Library →</a></p>
    <div class="ilist">
      ${items.map((it, i) => `
        <div class="itemrow">
          <img loading="lazy" src="${CDN}${esc(it.image)}" alt="">
          <div class="grow">
            <div class="nm">${esc(it.name)}</div>
            <div class="mt">${esc(it.target || '')}</div>
          </div>
          <input type="number" min="1" value="${Number(it.sets)||3}" title="sets"
                 onchange="updItem('${esc(w.id)}',${i},'sets',this.value)">
          <span style="color:var(--muted)">×</span>
          <input type="number" min="1" value="${Number(it.reps)||10}" title="reps"
                 onchange="updItem('${esc(w.id)}',${i},'reps',this.value)">
          <button class="btn sm" ${i?'' :'disabled'} onclick="moveItem('${esc(w.id)}',${i},-1)">↑</button>
          <button class="btn sm" ${i<items.length-1?'':'disabled'} onclick="moveItem('${esc(w.id)}',${i},1)">↓</button>
          <button class="btn sm danger" onclick="rmItem('${esc(w.id)}',${i})">✕</button>
        </div>`).join('') || `<p class="empty">Empty — open the <a href="#/library">Library</a> and hit “Add to workout”.</p>`}
    </div>
    <div class="rowbar">
      <button class="btn" onclick="location.hash='#/workouts'">← All workouts</button>
      <button class="btn" ${items.length?'':'disabled'} onclick="suggestProgress('${esc(w.id)}')">${icon('trend')}Suggest progression</button>
      <button class="btn primary" ${items.length?'':'disabled'} onclick="startSession('${esc(w.id)}')">Start session</button>
    </div>`;
}

// AI progression: suggest next-session sets/reps/weight from logged history.
async function suggestProgress(id) {
  const w = await getW(id);
  const byId = Object.fromEntries((w.items || []).map(it => [it.ex_id, it]));
  toast('Coach is reviewing your logs…');
  let res;
  try {
    res = await pb.send('/api/ai/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workout_id: id }),
    });
  } catch (err) {
    return toast(err?.data?.message || err?.message || 'Could not get suggestions.');
  }
  const sugg = (res.items || []).filter(s => byId[s.ex_id]);
  if (!sugg.length) return toast('No suggestions — log a session first, then try again.');
  window._progress = { id, sugg };
  modal(`
    <h2 style="text-transform:none">Progression suggestions</h2>
    <p class="sub" style="margin:6px 0 14px">Based on your recent logged sets. Apply to update this
      workout's targets; the weight is a cue for your next session.</p>
    <div class="ilist">
      ${sugg.map(s => {
        const it = byId[s.ex_id];
        return `<div class="itemrow">
          <img loading="lazy" src="${CDN}${esc(it.image)}" alt="">
          <div class="grow">
            <div class="nm">${esc(it.name)}</div>
            <div class="mt">→ <b>${Number(s.next_sets)}×${Number(s.next_reps)}</b>
              ${s.suggested_weight ? `@ ${esc(s.suggested_weight)}` : ''} · ${esc(s.note || '')}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="rowbar" style="margin-bottom:0">
      <button class="btn" onclick="closeModal()">Not now</button>
      <button class="btn primary" id="prog-apply">Apply to targets</button>
    </div>`);
  $('#prog-apply').addEventListener('click', applyProgress);
}

async function applyProgress() {
  const { id, sugg } = window._progress || {};
  if (!id) return;
  $('#prog-apply').disabled = true;
  const w = await getW(id);
  const next = new Map(sugg.map(s => [s.ex_id, s]));
  const items = (w.items || []).map(it => {
    const s = next.get(it.ex_id);
    return s ? { ...it, sets: Math.max(1, Number(s.next_sets) || it.sets), reps: Math.max(1, Number(s.next_reps) || it.reps) } : it;
  });
  await saveItems(id, items);
  closeModal();
  renderWorkoutEditor(id);
  toast('Targets updated from your progression.');
}

async function getW(id) {
  const ws = await loadWorkouts();
  return ws.find(x => x.id === id) || await pb.collection('workouts').getOne(id);
}

async function saveItems(id, items) {
  await pb.collection('workouts').update(id, { items });
  state.workouts = null;
}

async function updItem(id, i, key, val) {
  const w = await getW(id); const items = [...(w.items||[])];
  items[i] = { ...items[i], [key]: Math.max(1, Number(val)||1) };
  await saveItems(id, items);
}
async function moveItem(id, i, d) {
  const w = await getW(id); const items = [...(w.items||[])];
  const [it] = items.splice(i, 1); items.splice(i + d, 0, it);
  await saveItems(id, items); renderWorkoutEditor(id);
}
async function rmItem(id, i) {
  const w = await getW(id); const items = [...(w.items||[])];
  items.splice(i, 1);
  await saveItems(id, items); renderWorkoutEditor(id);
}

async function pickWorkout(exId) {
  if (!me()) { closeModal(); location.hash = '#/signin'; return; }
  const ws = await loadWorkouts();
  modal(`
    <h2 style="text-transform:none">Add to workout</h2>
    <div class="wlist" style="margin-top:16px">
      ${ws.map(w => `<div class="wrow">
          <div class="grow"><div class="nm">${esc(w.name)}</div>
          <div class="mt">${(w.items||[]).length} exercises</div></div>
          <button class="btn sm primary" onclick="addToWorkout('${esc(w.id)}','${esc(exId)}')">Add</button>
        </div>`).join('') || `<p class="empty">No workouts yet.</p>`}
    </div>
    <div class="rowbar" style="margin-bottom:0">
      <input id="pw-name" placeholder="…or a new workout name">
      <button class="btn primary" onclick="addToNewWorkout('${esc(exId)}')">Create & add</button>
    </div>`);
}

async function addToWorkout(wid, exId) {
  const x = state.detailCache[exId] || await pb.collection('exercises').getOne(exId);
  state.detailCache[exId] = x;
  const w = await getW(wid);
  const items = [...(w.items||[])];
  if (items.some(it => it.id === exId)) { toast('Already in that workout.'); return; }
  items.push({ id: x.id, ex_id: x.ex_id, name: x.name, target: x.target,
               image: x.image, gif_url: x.gif_url, sets: 3, reps: 10 });
  await saveItems(wid, items);
  closeModal(); toast(`Added to “${w.name}”.`);
}

async function addToNewWorkout(exId) {
  const name = $('#pw-name').value.trim();
  if (!name) return toast('Type a name for the new workout.');
  const w = await pb.collection('workouts').create({ name, owner: me().id, items: [] });
  state.workouts = null;
  await addToWorkout(w.id, exId);
}

/* ---------- session runner ---------- */

async function startSession(wid) {
  if (needAuth()) return;
  const w = await getW(wid);
  state.session = {
    workout: w.id, workout_name: w.name, startedAt: Date.now(),
    entries: (w.items||[]).map(it => ({
      id: it.id, ex_id: it.ex_id, name: it.name, image: it.image,
      sets: Array.from({ length: Number(it.sets)||3 },
                       () => ({ reps: Number(it.reps)||10, weight: '' })),
    })),
  };
  location.hash = '#/session';
}

function renderSession() {
  const s = state.session;
  if (!s) { location.hash = '#/workouts'; return; }
  view.innerHTML = `
    <h1>${esc(s.workout_name)}</h1>
    <p class="sub">Log your sets — weight in whatever unit you train in.</p>
    <div class="sess">
      ${s.entries.map((en, ei) => `
        <div class="sessx">
          <header>
            <img loading="lazy" src="${CDN}${esc(en.image)}" alt="">
            <div><div class="nm" style="font-weight:600">${esc(en.name)}</div>
            <button class="btn sm" style="margin-top:4px" onclick="openDetail('${esc(en.id)}')">Form check</button></div>
          </header>
          <div class="sethead"><span>Set</span><span>Reps</span><span>Weight</span><span></span></div>
          ${en.sets.map((st, si) => `
            <div class="setrow">
              <span class="no">${si+1}</span>
              <input type="number" min="0" value="${esc(st.reps)}" onchange="setVal(${ei},${si},'reps',this.value)">
              <input type="number" min="0" step="0.5" value="${esc(st.weight)}" placeholder="—" onchange="setVal(${ei},${si},'weight',this.value)">
              <button class="xdel" onclick="delSet(${ei},${si})">✕</button>
            </div>`).join('')}
          <div style="margin-top:10px"><button class="btn sm" onclick="addSet(${ei})">+ Add set</button></div>
        </div>`).join('')}
      <div class="rowbar" style="max-width:none">
        <input id="s-notes" placeholder="Session notes (optional)">
        <button class="btn danger" onclick="discardSession()">Discard</button>
        <button class="btn primary" onclick="finishSession()">Finish & save</button>
      </div>
    </div>`;
}

function setVal(ei, si, k, v) { state.session.entries[ei].sets[si][k] = v === '' ? '' : Number(v); }
function addSet(ei) {
  const sets = state.session.entries[ei].sets;
  sets.push({ ...(sets[sets.length-1] || { reps: 10, weight: '' }) });
  renderSession();
}
function delSet(ei, si) { state.session.entries[ei].sets.splice(si, 1); renderSession(); }
function discardSession() {
  if (confirm('Discard this session? Nothing will be saved.')) {
    state.session = null; location.hash = '#/workouts';
  }
}

async function finishSession() {
  const s = state.session;
  const entries = s.entries
    .map(en => ({ ...en, sets: en.sets.filter(x => x.reps !== '' && x.reps > 0) }))
    .filter(en => en.sets.length);
  if (!entries.length) return toast('No completed sets to save.');
  await pb.collection('sessions').create({
    owner: me().id, workout_ref: s.workout, workout_name: s.workout_name,
    entries, notes: $('#s-notes').value.trim(),
  });
  state.session = null;
  toast('Session saved.');
  location.hash = '#/history';
}

/* ---------- history ---------- */

async function renderHistory() {
  if (needAuth()) return;
  const list = await pb.collection('sessions').getList(1, 50, { sort: '-created' });
  view.innerHTML = `
    <h1>Training history</h1>
    <p class="sub">${list.totalItems} logged session${list.totalItems===1?'':'s'}.</p>
    ${list.items.map(s => {
      const vol = (s.entries||[]).reduce((a,en) =>
        a + en.sets.reduce((b,x) => b + (Number(x.reps)||0) * (Number(x.weight)||0), 0), 0);
      const nsets = (s.entries||[]).reduce((a,en) => a + en.sets.length, 0);
      const d = new Date(s.created);
      return `<div class="hrow">
        <div class="top" onclick="this.parentNode.querySelector('.hdetail').classList.toggle('hidden')">
          <div class="nm">${esc(s.workout_name || 'Workout')}</div>
          <div class="mt">${nsets} sets${vol ? ` · ${Math.round(vol).toLocaleString()} volume` : ''} · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div class="hdetail hidden">
          ${(s.entries||[]).map(en => `<div class="ex"><b>${esc(en.name)}</b> —
            <span>${en.sets.map(x => `${esc(x.reps)}×${x.weight===''?'bw':esc(x.weight)}`).join(', ')}</span></div>`).join('')}
          ${s.notes ? `<div class="ex"><span>${esc(s.notes)}</span></div>` : ''}
        </div>
      </div>`;
    }).join('') || `<p class="empty">Nothing logged yet — start a session from Workouts.</p>`}`;
}

/* ---------- coach marketplace ---------- */

const money = c => '$' + (Number(c || 0) / 100).toFixed(2);

async function renderCoach() {
  if (needAuth()) return;
  view.innerHTML = `<h1>Coach dashboard</h1><p class="sub">Loading…</p>`;
  const [services, clients, pay] = await Promise.all([
    pb.collection('services').getFullList({ filter: `coach="${me().id}"`, sort: '-created' }),
    pb.collection('memberships').getFullList({ filter: `coach="${me().id}" && status="active"`, expand: 'client' }),
    pb.send('/api/billing/status', { method: 'GET' }).catch(() => ({ onboarded: false, payouts_ready: false })),
  ]);
  const payBanner = pay.payouts_ready
    ? `<div class="rowbar" style="background:rgba(140,198,63,.08);border:1px solid var(--accent);border-radius:10px;padding:10px 14px;margin-bottom:16px">
         <div class="grow"><div class="nm" style="color:var(--accent)">✓ Payouts active</div>
           <div class="mt">Clients can hire your services and you get paid out directly.</div></div>
         <button class="btn sm" onclick="setupPayouts()">Manage</button></div>`
    : `<div class="rowbar" style="background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:16px">
         <div class="grow"><div class="nm">${pay.onboarded ? 'Finish setting up payouts' : 'Set up payouts to get paid'}</div>
           <div class="mt">Connect a bank account so clients can hire you. FitBase keeps a 15% platform fee.</div></div>
         <button class="btn sm primary" onclick="setupPayouts()">${pay.onboarded ? 'Continue' : 'Set up payouts'}</button></div>`;
  view.innerHTML = `
    <h1>Coach dashboard</h1>
    <p class="sub">Publish services at your own rates, invite clients, and review their training.</p>
    ${payBanner}

    <h2 style="margin-top:8px">Your services</h2>
    <div class="wlist" style="margin-bottom:14px">
      ${services.map(s => `<div class="wrow">
        <div class="grow"><div class="nm">${esc(s.title)} <span class="mt">· ${esc(s.kind)}</span></div>
          <div class="mt">${money(s.rate)} ${s.cadence==='monthly'?'/mo':'one-off'} · ${s.active?'live':'hidden'}</div></div>
        <button class="btn sm" onclick="toggleService('${esc(s.id)}',${!s.active})">${s.active?'Hide':'Publish'}</button>
        <button class="btn sm danger" onclick="deleteService('${esc(s.id)}')">✕</button>
      </div>`).join('') || `<p class="empty" style="padding:14px 0">No services yet.</p>`}
    </div>
    <form class="rowbar" style="flex-wrap:wrap;gap:8px" onsubmit="return createService(event)">
      <input id="sv-title" placeholder="Service title — e.g. 12-week coaching" required style="flex:2;min-width:180px">
      <select id="sv-kind"><option>coaching</option><option>review</option><option>nutrition</option><option>custom</option></select>
      <input id="sv-rate" type="number" min="1" step="1" placeholder="Rate $" required style="width:90px">
      <select id="sv-cadence"><option value="monthly">/month</option><option value="one_off">one-off</option></select>
      <button class="btn primary" type="submit">Add service</button>
    </form>

    <h2 style="margin-top:22px">Invite a client</h2>
    <form class="rowbar" onsubmit="return sendInvite(event)">
      <input id="inv-email" type="email" placeholder="client@email.com" required style="flex:1">
      <button class="btn primary" type="submit">Send invite</button>
    </form>
    <div class="err" id="inv-msg" style="color:var(--accent)"></div>

    <h2 style="margin-top:22px">Your clients</h2>
    <div class="wlist">
      ${clients.map(m => {
        const c = m.expand?.client;
        return `<div class="wrow"><div class="grow"><div class="nm">${esc(c?.email || m.client)}</div></div>
          <button class="btn sm" onclick="viewClient('${esc(m.client)}','${esc(c?.email || 'Client')}')">View plan</button></div>`;
      }).join('') || `<p class="empty" style="padding:14px 0">No clients yet — send an invite above.</p>`}
    </div>`;
}

async function createService(e) {
  e.preventDefault();
  try {
    await pb.collection('services').create({
      coach: me().id, coach_name: me().name || me().email,
      title: $('#sv-title').value.trim(), kind: $('#sv-kind').value,
      rate: Math.round(Number($('#sv-rate').value) * 100), cadence: $('#sv-cadence').value, active: true,
    });
    renderCoach();
  } catch (err) { toast(err?.data?.message || 'Could not add service.'); }
  return false;
}
async function setupPayouts() {
  try {
    const r = await pb.send('/api/billing/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.url) { location.href = r.url; return; }
    toast('Could not start payout setup.');
  } catch (err) { toast(err?.data?.message || 'Could not start payout setup.'); }
}
async function toggleService(id, active) { await pb.collection('services').update(id, { active }); renderCoach(); }
async function deleteService(id) { if (confirm('Delete this service?')) { await pb.collection('services').delete(id); renderCoach(); } }

async function sendInvite(e) {
  e.preventDefault();
  const msg = $('#inv-msg'); msg.textContent = '';
  try {
    const r = await pb.send('/api/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#inv-email').value.trim(), role: 'client' }),
    });
    msg.textContent = r.emailed === false
      ? 'Invite created. Email relay was unavailable — share this link: ' + r.link
      : 'Invite emailed. They accept via the link to join you.';
    $('#inv-email').value = '';
  } catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = err?.data?.message || 'Could not send invite.'; }
  return false;
}

async function viewClient(clientId, label) {
  let ws = [];
  try { ws = await pb.collection('workouts').getFullList({ filter: `owner="${clientId}"`, sort: '-created' }); }
  catch { return toast('Could not load client.'); }
  modal(`<h2 style="text-transform:none">${esc(label)}'s plan</h2>
    <p class="sub" style="margin:6px 0 12px">Read-only view of your client's workouts.</p>
    <div class="wlist">
      ${ws.map(w => `<div class="wrow"><div class="grow"><div class="nm">${esc(w.name)}</div>
        <div class="mt">${(w.items||[]).length} exercises</div></div></div>`).join('')
        || `<p class="empty">No workouts yet.</p>`}
    </div>`);
}

async function renderCoaches() {
  view.innerHTML = `<h1>Find a coach</h1><p class="sub">Loading…</p>`;
  const services = await pb.collection('services').getFullList({ filter: 'active=true', sort: '-created' });
  view.innerHTML = `
    <h1>Find a coach</h1>
    <p class="sub">Hire a coach for personalized programming, form review, or nutrition — you keep training in your own gym.</p>
    <div class="wlist">
      ${services.map(s => {
        return `<div class="wrow">
          <div class="grow"><div class="nm">${esc(s.title)}</div>
            <div class="mt">${esc(s.coach_name || 'Coach')} · ${esc(s.kind)} · ${esc(s.description||'')}</div></div>
          <div style="text-align:right"><div class="nm">${money(s.rate)}</div><div class="mt">${s.cadence==='monthly'?'/mo':'one-off'}</div></div>
          <button class="btn sm primary" onclick="hireService('${esc(s.id)}',this)">Hire</button>
        </div>`;
      }).join('') || `<p class="empty">No coaches offering services yet.</p>`}
    </div>`;
  if (params.get('hired')) toast('Payment received — your coach can now see your training. 💪');
  // resume a hire that was interrupted by sign-in
  const pending = sessionStorage.getItem('pendingHire');
  if (pending && me()) {
    sessionStorage.removeItem('pendingHire');
    if (services.some(s => s.id === pending)) hireService(pending);
  }
}

async function hireService(serviceId, btn) {
  if (!me()) {
    // '#/login' was not a real route — unknown routes fall back to the library,
    // which silently dumped the user mid-hire. Remember the intent and resume
    // checkout after sign-in (renderCoaches picks pendingHire back up).
    sessionStorage.setItem('pendingHire', serviceId);
    toast('Sign in to hire a coach — we\'ll bring you right back.');
    location.hash = '#/signin';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await pb.send('/api/billing/hire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: serviceId }),
    });
    if (r.url) { location.href = r.url; return; }
    toast('Could not start checkout.');
  } catch (err) { toast(err?.data?.message || 'Could not start checkout.'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Hire'; }
}

async function renderAccept(token) {
  if (!token) { location.hash = '#/library'; return; }
  view.innerHTML = `<div class="authcard"><h1>Invite</h1><p class="sub">Loading…</p></div>`;
  let info;
  try { info = await pb.send('/api/invite/' + encodeURIComponent(token), { method: 'GET' }); }
  catch { view.innerHTML = `<div class="authcard"><h1>Invite not found</h1><p class="sub">This link is invalid.</p></div>`; return; }
  if (info.status !== 'pending') {
    view.innerHTML = `<div class="authcard"><h1>Invite ${esc(info.status)}</h1>
      <p class="sub">This invite is no longer usable. Ask your coach to send a new one.</p></div>`;
    return;
  }
  if (!me()) {
    view.innerHTML = `<div class="authcard">
      <h1>${esc(info.coach)} invited you</h1>
      <p class="sub" style="margin:6px 0 14px">Sign in or create your account to accept and join as their ${esc(info.role)}.</p>
      <a class="btn primary" href="#/signin" onclick="sessionStorage.setItem('pendingInvite','${esc(token)}')" style="display:block;text-align:center">Sign in / Create account</a>
    </div>`;
    return;
  }
  view.innerHTML = `<div class="authcard">
    <h1>${esc(info.coach)} invited you</h1>
    <p class="sub" style="margin:6px 0 14px">Accept to connect as their ${esc(info.role)} — they'll be able to build and review your plan.</p>
    <div class="err" id="acc-err"></div>
    <button class="btn primary" id="acc-btn" style="width:100%">Accept invite</button>
  </div>`;
  $('#acc-btn').addEventListener('click', async () => {
    $('#acc-btn').disabled = true;
    try {
      await pb.send('/api/invite/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      toast('Connected with your coach.');
      location.hash = '#/workouts';
    } catch (err) {
      $('#acc-err').textContent = err?.data?.message || 'Could not accept.';
      $('#acc-btn').disabled = false;
    }
  });
}

/* ---------- landing ---------- */

function renderHome() {
  if (me()) { renderDashboard(); return; }
  const shot = (src, alt) => `<div class="shotframe hero-shot">
    <div class="sfbar"><span class="sfdot"></span><span class="sfdot"></span><span class="sfdot"></span>
      <span class="sfurl">fitbase.ca</span></div>
    <img loading="lazy" src="${src}" alt="${alt}"></div>`;
  view.innerHTML = `
    <section class="hero">
      <div class="home-hero">
        <div class="hero-copy">
          <p class="eyebrow">Home-gym coaching, rebuilt</p>
          <h1 class="hero-h1">Your gym. Your plan. A coach only when you want one.</h1>
          <p class="hero-sub">FitBase turns whatever you've got — a rack in the garage, a few dumbbells,
            a building gym — into a real weekly plan, and adjusts it every time you lift. Want eyes on your
            form? <b>Hire a real coach at their rate</b> — no standing appointment required. You keep
            training in your own gym.</p>
          <div class="hero-cta">
            <a class="btn primary lg" href="#/signin">Start training — free</a>
            <a class="btn lg" href="#/library">Browse 1,324 exercises</a>
          </div>
          <p class="hero-note">Free to train. Coaching is optional. Your data stays yours.</p>
        </div>
        ${shot('/img/home-plan.jpg', 'A weekly plan built from your equipment')}
      </div>
    </section>

    <section class="band">
      <div class="steps3">
        <div class="step">
          <div class="step-n">1</div>
          <h3>Tell us your gym</h3>
          <p>Tick the equipment you actually have. Home rack, hotel dumbbells, or a full commercial floor —
            FitBase only ever prescribes what you can do.</p>
        </div>
        <div class="step">
          <div class="step-n">2</div>
          <h3>Get your plan</h3>
          <p>A weekly program built from your equipment and your goal — with an animated demo for every
            movement in ten languages. A new plan in seconds, not a week of back-and-forth.</p>
        </div>
        <div class="step">
          <div class="step-n">3</div>
          <h3>Log &amp; level up</h3>
          <p>Log your sets and your plan progresses with you — it reads your last session and nudges
            weight or reps so you keep moving forward.</p>
        </div>
      </div>
    </section>

    <section>
      <div class="scast">
        <div class="sc-copy">
          <p class="kicker2">The AI coach</p>
          <h2>Tell it your goal. It writes the week from your gym.</h2>
          <p>Inventory your equipment once. Ask for a plan and FitBase picks only exercises you can
            actually do — then checks every one against the real 1,324-exercise catalog, so it
            <b>never lists a machine you don't own</b> or an exercise that doesn't exist.</p>
          <a class="btn primary" href="#/signin">Generate my plan</a>
        </div>
        <div class="sc-media">${shot('/img/home-ai.jpg', 'Generate a weekly plan')}</div>
      </div>
      <div class="scast reverse">
        <div class="sc-media">${shot('/img/home-workouts.jpg', 'Your weekly split, ready to run')}</div>
        <div class="sc-copy">
          <p class="kicker2">Progression built in</p>
          <h2>Log your sets. The plan levels up with you.</h2>
          <p>Every movement has an animated demo. Finish a session and hit <b>Suggest progression</b> —
            FitBase reads your last workout and bumps weight or reps for progressive overload, so you're
            never guessing what comes next.</p>
        </div>
      </div>
    </section>

    <section class="band">
      <div class="scast">
        <div class="sc-copy">
          <p class="kicker2">The marketplace</p>
          <h2>Or bring in a real coach — at their rate.</h2>
          <p>Coaches publish services — coaching, form review, nutrition — priced one-off or monthly.
            Hire with a card; they're paid out directly through Stripe and <b>FitBase keeps 15%</b>.
            A coach can also invite their own clients straight in.</p>
          <a class="btn" href="#/coaches">Find a coach</a>
        </div>
        <div class="sc-media">${shot('/img/home-coaches.jpg', 'Find a coach and hire by the service')}</div>
      </div>
    </section>

    <section class="split">
      <div class="split-card">
        <h2>For lifters</h2>
        <p>Stop guessing. Get a structured plan from the equipment in front of you, follow along with
          real demos, and watch the numbers climb. It's free — train as long as you like.</p>
        <a class="btn primary" href="#/signin">Create your plan</a>
      </div>
      <div class="split-card">
        <h2>For coaches</h2>
        <p>Bring your clients onto one place that already handles the programming and logging. Publish your
          services at <b>your</b> rates and reach home-gym lifters who want a pro — you're paid out directly.</p>
        <a class="btn" href="#/coach">Set up as a coach</a>
      </div>
    </section>

    <section class="band statsband">
      <div class="stats3">
        <div><div class="stat-n">1,324</div><div class="stat-l">exercises with animated demos</div></div>
        <div><div class="stat-n">10</div><div class="stat-l">languages, step by step</div></div>
        <div><div class="stat-n">28</div><div class="stat-l">equipment types — home to commercial</div></div>
      </div>
    </section>

    <section class="band">
      <div class="split" style="padding:0">
        <div class="split-card">
          <p class="kicker2">For gyms</p>
          <h2>Run a gym? Put it in every member's pocket.</h2>
          <p>Members get AI plans built from <b>your floor's</b> equipment, demos in ten
            languages, and your trainers earn through the built-in marketplace.</p>
          <a class="btn" href="/gyms/">FitBase for gyms →</a>
        </div>
        <div class="split-card">
          <h2>Branded for your gym</h2>
          <p>Optional white-label setup — your name, your logo, your domain. The platform stays
            ours to run, the brand stays yours.</p>
          <a class="btn" href="mailto:tommy@webfacemedia.com?subject=Branded%20FitBase%20for%20my%20gym">Ask about branding</a>
        </div>
      </div>
    </section>

    <section class="finalcta">
      <h2>The gym you have is enough.</h2>
      <p>Set it up in two minutes and train today.</p>
      <a class="btn primary lg" href="#/signin">Start free</a>
    </section>`;
}

/* ---------- signed-in dashboard (3D navigator) ---------- */

function renderDashboard() {
  const u = me();
  const first = (u.name || '').split(' ')[0];
  view.innerHTML = `
    <section class="dash">
      <p class="eyebrow">Your training hub</p>
      <h1>Welcome back${first ? ', ' + esc(first) : ''}.</h1>
      <p class="sub">Spin the figure and tap a muscle group to explore its exercises — or jump straight in below.</p>
      <div class="dash-avatar" id="dash-avatar"></div>
      <div class="dash-links">
        <a class="btn" href="#/workouts">${icon('dumbbell')}Workouts</a>
        <a class="btn" href="#/library">${icon('grid')}Library</a>
        <a class="btn" href="#/history">${icon('clock')}History</a>
        <a class="btn" href="#/gym">${icon('home')}My Gym</a>
        <a class="btn" href="#/coach">${icon('sparkles')}AI Coach</a>
        <a class="btn" href="#/coaches">${icon('users')}Coaches</a>
      </div>
    </section>`;
  loadAvatar().then(() => {
    const el = $('#dash-avatar');
    if (document.body.dataset.route !== 'home' || !el?.isConnected) return;
    if (!avatarMod.isSupported()) { el.remove(); return; } // link chips carry the screen
    avatarMod.mount(el, {
      mode: 'nav',
      labels: [
        { anchor: 'head', text: 'AI Coach', hash: '#/coach' },
        { anchor: 'shoulderR', text: 'Workouts', hash: '#/workouts' },
        { anchor: 'wristL', text: 'History', hash: '#/history' },
        { anchor: 'floor', text: 'My Gym', hash: '#/gym' },
      ],
      onRegion: r => { location.hash = '#/library?bp=' + encodeURIComponent(BP_MAP[r]); },
    });
    el.classList.add('ready');
  }).catch(() => $('#dash-avatar')?.remove());
}

/* ---------- boot ---------- */
syncLangUp();
route();
