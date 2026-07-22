/* FitBase — exercise library, workout builder, training log.
   Backend: PocketBase (same origin). Media: exercises-dataset via jsDelivr CDN. */
'use strict';

const pb = new PocketBase('/');
const CDN = 'https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@main/';
const LANGS = { en:'English', es:'Español', it:'Italiano', tr:'Türkçe', ru:'Русский',
                zh:'中文', hi:'हिन्दी', pl:'Polski', ko:'한국어', fr:'Français' };
const PAGE = 36;

const $ = s => document.querySelector(s);
const view = $('#view'), overlay = $('#overlay');
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const state = {
  catalog: null,          // light list of all exercises
  q: '', cat: '', equip: '', target: '', page: 1,
  workouts: null,
  session: null,          // in-progress workout session
  detailCache: {},
};

/* ---------- helpers ---------- */

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

function needAuth() {
  if (me()) return false;
  location.hash = '#/signin';
  return true;
}

async function loadCatalog() {
  if (state.catalog) return state.catalog;
  state.catalog = await pb.collection('exercises').getFullList({
    batch: 500, sort: 'name',
    fields: 'id,ex_id,name,category,equipment,target,image',
  });
  return state.catalog;
}

async function loadWorkouts(force) {
  if (!me()) return [];
  if (state.workouts && !force) return state.workouts;
  state.workouts = await pb.collection('workouts').getFullList({ sort: '-created' });
  return state.workouts;
}

/* ---------- router ---------- */

const routes = {
  library: renderLibrary,
  workouts: renderWorkouts,
  history: renderHistory,
  signin: renderAuth,
  forgot: renderForgot,
  reset: renderResetConfirm,
  session: renderSession,
};

async function route() {
  const seg = (location.hash.replace(/^#\//, '') || 'library').split('/');
  const name = routes[seg[0]] ? seg[0] : 'library';
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
      <form onsubmit="return doAuth(event)">
        <input type="email" id="a-email" placeholder="Email" required autocomplete="email">
        <input type="password" id="a-pass" placeholder="Password" required minlength="8" autocomplete="current-password">
        <div class="err" id="a-err"></div>
        <button class="btn primary" type="submit" id="a-btn">Sign in</button>
      </form>
      <p class="alt">No account? <a href="#" onclick="return toggleAuthMode()" id="a-toggle">Create one</a>
        <span style="opacity:.4"> · </span><a href="#/forgot">Forgot password?</a></p>
    </div>`;
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
    state.workouts = null;
    location.hash = '#/library';
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
  view.innerHTML = `<h1>Exercise library</h1>
    <p class="sub">Loading the catalog…</p>`;
  const all = await loadCatalog();
  const cats = [...new Set(all.map(x => x.category))].sort();
  const equips = [...new Set(all.map(x => x.equipment))].sort();
  const targets = [...new Set(all.map(x => x.target))].sort();

  view.innerHTML = `
    <h1>Exercise library</h1>
    <p class="sub">${all.length} exercises · filter by muscle, equipment or target · media © Gym visual</p>
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
    </div>
    <div class="chips" id="f-cats">
      <button class="chip ${state.cat===''?'on':''}" data-cat="">all</button>
      ${cats.map(c => `<button class="chip ${c===state.cat?'on':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <p class="count" id="f-count"></p>
    <div class="grid" id="f-grid"></div>
    <div class="pager" id="f-pager"></div>`;

  $('#f-q').addEventListener('input', e => { state.q = e.target.value; state.page = 1; paintGrid(); });
  $('#f-equip').addEventListener('change', e => { state.equip = e.target.value; state.page = 1; paintGrid(); });
  $('#f-target').addEventListener('change', e => { state.target = e.target.value; state.page = 1; paintGrid(); });
  $('#f-cats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    state.cat = b.dataset.cat; state.page = 1;
    document.querySelectorAll('#f-cats .chip').forEach(c => c.classList.toggle('on', c === b));
    paintGrid();
  });
  paintGrid();
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.catalog.filter(x =>
    (!q || x.name.toLowerCase().includes(q) || x.target.toLowerCase().includes(q)) &&
    (!state.cat || x.category === state.cat) &&
    (!state.equip || x.equipment === state.equip) &&
    (!state.target || x.target === state.target));
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
  lang = lang || 'en';
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
      <select class="langsel" onchange="openDetail('${esc(x.id)}', this.value)">
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
    <p class="sub">Build routines from the library, then start a session to log it.</p>
    <div class="rowbar">
      <input id="w-name" placeholder="New workout name — e.g. Push Day">
      <button class="btn primary" onclick="createWorkout()">Create</button>
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
      <button class="btn primary" ${items.length?'':'disabled'} onclick="startSession('${esc(w.id)}')">Start session</button>
    </div>`;
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
    owner: me().id, workout: s.workout, workout_name: s.workout_name,
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

/* ---------- boot ---------- */
route();
