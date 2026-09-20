'use strict';

const functionsRegion = firebase.app().functions('europe-west1');

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) { return Math.round(Number(n) || 0).toLocaleString('en-GB'); }
function uid() { return crypto.randomUUID(); }

// Shared .icon-btn glyphs (Feather-style, matching the outline icons used elsewhere in the
// suite) — used in place of text labels for the common Open/Copy/Delete row actions.
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = `toast-msg ${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => el.remove());
  el.append(text, closeBtn);
  toast.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ── Formula engine ───────────────────────────────────────────────────────
// Every income/spend line either carries a manually-entered `amount`, or a `formula` key that
// recomputes it live from fixedParams / sibling income lines. Formula lines are read-only in the
// UI — editing the inputs that feed them (fixed params, or the bar-receipts income line) is how
// you change them.

const INCOME_FORMULAS = {
  rehearsalSubs: (fp) => (fp.rehearsalSubsPerCast || 0) * ((fp.castSize || 0) + 1), // +1 = director
};

function barReceipts(income) {
  return income.find(i => i.id === 'barReceipts')?.amount || 0;
}

// Bar costs/VH levy's percentage lives on the item itself (item.pct) rather than hardcoded, so
// it's editable inline — DEFAULT_PCT only fills in for items saved before that field existed.
const DEFAULT_PCT = { barCosts: 40, vhBarLevy: 10 };
function itemPct(item) { return item.pct ?? DEFAULT_PCT[item.id] ?? 0; }

const SPEND_FORMULAS = {
  barCosts: (fp, income, item) => (itemPct(item) / 100) * barReceipts(income),
  vhBarLevy: (fp, income, item) => (itemPct(item) / 100) * barReceipts(income),
};

function resolveAmount(item, fp, income, formulas) {
  const fn = item.formula && formulas[item.formula];
  return fn ? fn(fp, income, item) : Number(item.amount || 0);
}

function fmtPerfDate(p) {
  if (!p.date) return '(no date)';
  const [y, m, d] = p.date.split('-');
  return `${d}/${m}/${y}`;
}

// Ticket sales isn't a single formula line any more — it's one computed, read-only income line
// per performance (price × seats × expected sales %), so changing a performance's own price
// only moves that one line. Derived entirely from fixedParams; nothing here is persisted
// separately.
function performanceIncomeLines(show) {
  const fp = show.fixedParams;
  const pct = (fp.expectedSalesPct ?? 100) / 100;
  return (fp.performances || []).map((p, i) => ({
    id: `perf-${i}`,
    label: `Ticket sales — ${fmtPerfDate(p)}`,
    formula: 'perf',
    amount: (p.price ?? 0) * (fp.seatsPerPerformance || 0) * pct,
    isPerformance: true,
  }));
}

function resolvedIncome(show) {
  const manual = show.income.map(i => ({ ...i, amount: resolveAmount(i, show.fixedParams, show.income, INCOME_FORMULAS) }));
  return [...performanceIncomeLines(show), ...manual];
}
function resolvedSpend(show) { return show.spend.map(i => ({ ...i, amount: resolveAmount(i, show.fixedParams, show.income, SPEND_FORMULAS) })); }
function incomeTotal(show) { return resolvedIncome(show).reduce((s, i) => s + i.amount, 0); }
function spendTotal(show) { return resolvedSpend(show).reduce((s, i) => s + i.amount, 0); }
function forecast(show) { return incomeTotal(show) - spendTotal(show); }

// ── Template seed — the fixed/income/spend items from the spec ─────────────

function emptyFixedParams() {
  return {
    performances: [],
    seatsPerPerformance: 0, expectedSalesPct: 100, castSize: 0,
    rehearsalSubsPerCast: 0,
  };
}

function defaultTemplateData() {
  return {
    name: 'Template',
    isTemplate: true,
    copiedFrom: null,
    fixedParams: emptyFixedParams(),
    income: [
      { id: 'rehearsalSubs',  label: 'Rehearsal subs expected',  formula: 'rehearsalSubs',  amount: 0 },
      { id: 'barReceipts',    label: 'Expected bar receipts',    formula: null,             amount: 0 },
      { id: 'programSales',   label: 'Programme sales',          formula: null,             amount: 0 },
      { id: 'iceCreamSales',  label: 'Ice cream sales',          formula: null,             amount: 0 },
      { id: 'sponsorship',    label: 'Sponsorship',              formula: null,             amount: 0 },
    ],
    spend: [
      { id: 'licenses',            label: 'Licenses',                formula: null,        amount: 0 },
      { id: 'setConstruction',     label: 'Set construction',        formula: null,        amount: 0 },
      { id: 'lighting',            label: 'Lighting',                formula: null,        amount: 0 },
      { id: 'costumes',            label: 'Costumes',                formula: null,        amount: 0 },
      { id: 'scripts',             label: 'Scripts',                 formula: null,        amount: 0 },
      { id: 'props',               label: 'Props',                   formula: null,        amount: 0 },
      { id: 'marketing',           label: 'Marketing',               formula: null,        amount: 0 },
      { id: 'barCosts',            label: 'Bar costs',               formula: 'barCosts',  amount: 0, pct: 40 },
      { id: 'vhBarLevy',           label: 'VH bar levy',             formula: 'vhBarLevy', amount: 0, pct: 10 },
      { id: 'gifts',               label: 'Gifts',                   formula: null,        amount: 0 },
      { id: 'iceCream',            label: 'Ice cream',               formula: null,        amount: 0 },
      { id: 'hallHire',            label: 'Hall hire',               formula: null,        amount: 0 },
      { id: 'misc',                label: 'Misc',                    formula: null,         amount: 0 },
    ],
  };
}

// ── State ────────────────────────────────────────────────────────────────

let allShows = [];      // [{id, ...data}]
let currentShow = null; // the show doc currently open in the editor (working copy, unsaved edits live here)
let currentShowId = null;
let currentShowTasks = [];  // [{id, ...data}] — showplanner_shows/{id}/tasks for the open show
let allTemplates = [];      // [{id, ...data}] — task-checklist templates (showplanner_templates)
let currentTemplate = null; // working copy of the template doc currently open in its editor
let currentTemplateId = null;
let collapsedTemplateChildren = new Set(); // local UI-only state — which tasks have their sub-task cards hidden
let showEditorDirty = false; // any pending edit to the OPEN show not yet written by Save changes
function markDirty() { showEditorDirty = true; }
// Text/number/select edits inside the editor (or the two modals that feed it — Add income/spend
// item, Assign role) mark dirty generically; the handful of pure button actions with no typed
// input of their own (generate/add/remove performance, add/remove role, remove income/spend
// line) call markDirty() explicitly at their own call sites below. The Task modal is deliberately
// excluded — task edits commit to Firestore immediately on their own, never part of this show
// doc's pending Save changes.
function isShowEditorScoped(el) { return !!el.closest('#tab-editor, #addItemModal, #assignRoleModal'); }
document.addEventListener('input', (e) => { if (e.target.matches('input, textarea, select') && isShowEditorScoped(e.target)) markDirty(); });
document.addEventListener('change', (e) => { if (e.target.matches('input, textarea, select') && isShowEditorScoped(e.target)) markDirty(); });
window.addEventListener('beforeunload', (e) => {
  if (!showEditorDirty) return;
  e.preventDefault();
  e.returnValue = ''; // required for Chrome to show its own native prompt
});

async function loadShows() {
  const snap = await db.collection('showplanner_shows').get();
  allShows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.isTemplate ? 1 : 0) - (a.isTemplate ? 1 : 0) || (a.name || '').localeCompare(b.name || ''));
  renderShowsList();
}

function renderShowsList() {
  const el = document.getElementById('showsList');
  if (!allShows.length) {
    el.innerHTML = '<p class="empty-state">No shows yet — the template is created automatically the first time you open this app.</p>';
    return;
  }
  el.innerHTML = allShows.map(s => {
    return `
    <div class="item-row" data-open-show="${s.id}" style="cursor:pointer">
      <div class="item-name-col">
        <div class="item-name">${escapeHtml(s.name || '(untitled)')}${s.isTemplate ? ' <span class="badge badge-primary">Template</span>' : ''}</div>
        ${s.isTemplate ? '<div class="item-sub">Used to start new shows</div>' : ''}
      </div>
      <div class="item-actions">
        <button class="icon-btn" data-open-show="${s.id}" title="Open" aria-label="Open">${ICON_EDIT}</button>
        <button class="icon-btn" data-copy-show="${s.id}" title="Copy" aria-label="Copy">${ICON_COPY}</button>
        <button class="icon-btn icon-btn-danger" data-delete-show="${s.id}" ${s.isTemplate ? 'disabled title="Make another show the template first"' : 'title="Delete" aria-label="Delete"'}>${ICON_TRASH}</button>
      </div>
    </div>
  `;
  }).join('');
}

// The row itself also carries data-open-show (see above) so clicking anywhere on a row opens it,
// same as the Open button — Copy/Delete are checked first so they keep doing their own thing.
document.getElementById('showsList').addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy-show]');
  if (copyBtn) { openNewShowModal(copyBtn.getAttribute('data-copy-show')); return; }

  const deleteBtn = e.target.closest('[data-delete-show]');
  if (deleteBtn) {
    const id = deleteBtn.getAttribute('data-delete-show');
    const show = allShows.find(s => s.id === id);
    if (!show || show.isTemplate) return;
    if (!confirm(`Delete "${show.name}"? This cannot be undone.`)) return;
    try {
      await db.collection('showplanner_shows').doc(id).delete();
      showToast('Show deleted', 'success');
      if (currentShowId === id) { currentShowId = null; currentShow = null; switchTab('shows'); }
      await loadShows();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const openTarget = e.target.closest('[data-open-show]');
  if (openTarget) openShow(openTarget.getAttribute('data-open-show'));
});

// costumes/scripts used to be cost-per-cast formula lines; hall hire used to be two separate
// lines (rehearsals/show week). Shows saved before those changes still have the old shape —
// convert on load rather than losing whatever amount was already entered.
function cleanSpend(spend) {
  let list = (spend || []).map(i =>
    (i.id === 'costumes' || i.id === 'scripts') ? { ...i, formula: null } : i
  );
  const rehearsals = list.find(i => i.id === 'hallHireRehearsals');
  const showWeek = list.find(i => i.id === 'hallHireShowWeek');
  if (rehearsals || showWeek) {
    list = list.filter(i => i.id !== 'hallHireRehearsals' && i.id !== 'hallHireShowWeek');
    list.push({ id: 'hallHire', label: 'Hall hire', formula: null, amount: (rehearsals?.amount || 0) + (showWeek?.amount || 0) });
  }
  return list;
}

// Defensive: fills in any field a show doc might be missing (e.g. added to the spec after that
// show was created) so the rest of the app can assume every field always exists.
function withDefaults(show) {
  return {
    ...show,
    roles: show.roles || [],
    roleAssignments: show.roleAssignments || {},
    cast: show.cast || [],
    castAssignments: show.castAssignments || {},
    planAccess: show.planAccess || {},
    planTemplateId: show.planTemplateId || null,
    fixedParams: { ...emptyFixedParams(), ...(show.fixedParams || {}) },
    // Drop the old single "Ticket sales" formula line some shows still have saved from before
    // ticket sales became one line per performance — it now just sits there permanently reading
    // £0 with no way to remove it from the UI, showing up as a stray extra income/performance
    // row. Self-heals here on load; persists once the show is next saved.
    income: (show.income || []).filter(i => i.id !== 'ticketSales'),
    spend: cleanSpend(show.spend),
  };
}

// ── New show / Copy ─────────────────────────────────────────────────────

function openNewShowModal(preselectSourceId) {
  const sel = document.getElementById('newShowSource');
  sel.innerHTML = '<option value="">— Start from scratch (blank) —</option>' +
    allShows.map(s => `<option value="${s.id}">${escapeHtml(s.name)}${s.isTemplate ? ' (template)' : ''}</option>`).join('');
  if (preselectSourceId) sel.value = preselectSourceId;
  document.getElementById('newShowName').value = '';
  document.getElementById('newShowError').textContent = '';
  document.getElementById('newShowModal').style.display = 'flex';
}
document.getElementById('newShowBtn').addEventListener('click', () => openNewShowModal());
document.getElementById('newShowCloseBtn').addEventListener('click', () => { document.getElementById('newShowModal').style.display = 'none'; });
document.getElementById('newShowModal').addEventListener('click', (e) => { if (e.target.id === 'newShowModal') e.target.style.display = 'none'; });

document.getElementById('newShowCreateBtn').addEventListener('click', async () => {
  const name = document.getElementById('newShowName').value.trim();
  const sourceId = document.getElementById('newShowSource').value;
  const errEl = document.getElementById('newShowError');
  if (!name) { errEl.textContent = 'Enter a show name.'; return; }
  // Blank sourceId (the "Start from scratch" option) skips cloning entirely — an empty budget
  // the producer builds up with +Add income/spend item, same as it would look after clearing
  // every line out of a cloned one anyway.
  const clone = sourceId ? withDefaults(allShows.find(s => s.id === sourceId) || {}) : withDefaults({});

  const newDoc = {
    name,
    roles: [],
    planTemplateId: null,
    isTemplate: false,
    copiedFrom: sourceId || null,
    fixedParams: JSON.parse(JSON.stringify(clone.fixedParams)),
    income: JSON.parse(JSON.stringify(clone.income)),
    spend: JSON.parse(JSON.stringify(clone.spend)),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  try {
    const ref = await db.collection('showplanner_shows').add(newDoc);
    document.getElementById('newShowModal').style.display = 'none';
    showToast('Show created', 'success');
    await loadShows();
    openShow(ref.id);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ── Editor ───────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}
function confirmLeaveEditor() {
  if (!showEditorDirty) return true;
  return confirm('You have unsaved changes on this show. Leave without saving?');
}
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const leavingEditor = document.getElementById('tab-editor').classList.contains('active') && btn.dataset.tab !== 'editor';
    if (leavingEditor && !confirmLeaveEditor()) return;
    switchTab(btn.dataset.tab);
    document.getElementById('mainMenuDropdown').classList.remove('open');
  });
});
document.getElementById('backToShowsBtn').addEventListener('click', () => {
  if (!confirmLeaveEditor()) return;
  currentShowId = null; currentShow = null; switchTab('shows'); loadShows();
});

// A second, independent tab system nested inside the show editor (Details/Plan/Roles/Budget) —
// deliberately separate from switchTab()/.tab-panel above, which queries the whole document and
// would otherwise also toggle the outer Shows/Task Templates/editor panels on every click here.
function switchShowSubtab(id) {
  document.querySelectorAll('.show-subtab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('showsubtab-' + id).classList.add('active');
  document.querySelectorAll('.show-subtab-btn[data-subtab]').forEach(b => b.classList.toggle('active', b.dataset.subtab === id));
  updatePullTasksBtnVisibility();
}
// "Pull in tasks" lives beside Save changes (outside the sub-tab panels) but only makes sense on
// the Plan sub-tab, and only for someone who can edit the plan on a real (non-template) show.
function updatePullTasksBtnVisibility() {
  const onPlan = document.getElementById('showsubtab-plan').classList.contains('active');
  document.getElementById('planAddTasksBtn').style.display = onPlan && currentShow && !currentShow.isTemplate && currentUserCanEditPlan() ? '' : 'none';
}
document.querySelectorAll('.show-subtab-btn[data-subtab]').forEach(btn => {
  btn.addEventListener('click', () => switchShowSubtab(btn.dataset.subtab));
});

async function openShow(id) {
  const doc = await db.collection('showplanner_shows').doc(id).get();
  if (!doc.exists) { showToast('Show not found', 'error'); return; }
  currentShowId = id;
  currentShow = withDefaults({ id: doc.id, ...doc.data() });
  showEditorDirty = false;
  await loadCurrentShowTasks();
  collapseAllTasks();
  renderEditor();
  switchTab('editor');
  switchShowSubtab('details');
}

async function loadCurrentShowTasks() {
  // No orderBy() here deliberately — Firestore silently EXCLUDES any document that doesn't have
  // the sorted-on field set, so a task saved before 'order' existed (or by any path that ever
  // omitted it) would vanish from every load. Fetch everything, sort client-side via taskSortFn
  // instead — same approach the task template editor already uses for its own (embedded-array,
  // not queried) tasks, and it treats a missing order as 0 rather than dropping the task.
  const snap = await db.collection('showplanner_shows').doc(currentShowId).collection('tasks').get();
  currentShowTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderEditor() {
  document.getElementById('editorTitle').textContent = currentShow.name || 'Show budget';
  document.getElementById('headerTitle').textContent = 'Show Budget';
  document.getElementById('showNameInput').value = currentShow.name || '';
  document.getElementById('printShowName').textContent = currentShow.name || '';
  document.getElementById('printShowMeta').textContent = currentShow.isTemplate ? 'Template' : '';

  const fp = currentShow.fixedParams;
  document.getElementById('fpSeats').value = fp.seatsPerPerformance || 0;
  document.getElementById('fpExpectedSalesPct').value = fp.expectedSalesPct ?? 100;
  document.getElementById('fpCastSize').value = fp.castSize || 0;
  document.getElementById('fpRehearsalSubs').value = fp.rehearsalSubsPerCast || 0;

  document.getElementById('setTemplateBtn').style.display = currentShow.isTemplate ? 'none' : '';

  renderPerfTable();
  renderLinesTable('income', INCOME_FORMULAS);
  renderLinesTable('spend', SPEND_FORMULAS);
  renderForecast();
  renderPlanCard();
  renderRolesCard();
  renderCastCard();
  renderTasksCard();
  renderPlanAccessCard();
  applyPlanCardVisibility();
}


// ── Plan (task templates → real tasks) ──────────────────────────────────

function renderPlanCard() {
  const canEdit = currentUserCanEditPlan();
  const addSel = document.getElementById('planAddTemplateSelect');
  addSel.innerHTML = allTemplates.length
    ? allTemplates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
    : '<option value="">No task templates yet</option>';
  addSel.disabled = !canEdit;
  document.getElementById('planAddTasksBtn').disabled = !allTemplates.length || !canEdit;
  updatePullTasksBtnVisibility();

  const summaryEl = document.getElementById('planSummary');
  if (currentShow.isTemplate) {
    summaryEl.innerHTML = '<p class="muted">The budget template has no plan of its own.</p>';
    return;
  }
  if (!currentShowTasks.length) {
    summaryEl.innerHTML = '<p class="muted">No plan yet — use “Pull in tasks” at the bottom to add tasks from a task template, or add tasks manually below.</p>';
    return;
  }
  const done = currentShowTasks.filter(t => t.status === 'completed').length;
  const inProgress = currentShowTasks.filter(t => t.status === 'in_progress').length;
  summaryEl.innerHTML = `
    <p style="margin-bottom:10px">
      <span class="badge badge-primary">${currentShowTasks.length} task${currentShowTasks.length === 1 ? '' : 's'}</span>
      <span class="badge badge-success">${done} completed</span>
      <span class="badge badge-warning">${inProgress} in progress</span>
      ${currentShow.roles.length ? `<span class="badge">${currentShow.roles.length} role${currentShow.roles.length === 1 ? '' : 's'}</span>` : ''}
    </p>
  `;
}

function addDaysToIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d - days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Appends a template's tasks as new
// top-level trees (fresh ids, so pulling the same template in twice just adds a second copy —
// deliberately no de-duplication, since re-running a template on purpose, e.g. one per act, is a
// legitimate use) rather than replacing the plan, and merges in any of its roles not already
// present by name rather than wiping currentShow.roles. Doesn't record a source template, since a plan built
// from several pulled-in templates doesn't have one.
async function addTasksFromTemplate(template, baseDate) {
  const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
  const batch = db.batch();

  const templateTasks = normalizeTemplateTasks(template.tasks || []);
  const idMap = new Map(templateTasks.map(tt => [tt.id, tasksCol.doc().id]));
  const topLevelStart = topLevelTasksSorted().length;
  templateTasks.forEach((tt, i) => {
    const parentId = tt.parentId ? idMap.get(tt.parentId) : null;
    batch.set(tasksCol.doc(idMap.get(tt.id)), {
      title: tt.title || '(untitled task)',
      description: tt.description || '',
      dueMode: 'daysBeforeShow',
      daysBeforeShow: Number(tt.daysBeforeShow) || 0,
      dueDate: addDaysToIso(baseDate, Number(tt.daysBeforeShow) || 0),
      roleId: null, // this show's roles are a different set of ids than the pulled-in template's — see role-name merge below
      assigneeIds: [],
      status: 'not_started',
      parentTaskId: parentId,
      order: parentId ? (tt.order ?? i) : topLevelStart + (tt.order ?? i),
      comments: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  });

  const existingNames = new Set(currentShow.roles.map(r => (r.name || '').trim().toLowerCase()));
  const newRoles = (template.roles || []).filter(r => (r.name || '').trim() && !existingNames.has(r.name.trim().toLowerCase()))
    .map(r => ({ id: uid(), name: r.name.trim() }));
  const mergedRoles = [...currentShow.roles, ...newRoles];
  batch.set(db.collection('showplanner_shows').doc(currentShowId), {
    roles: mergedRoles,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();
  currentShow.roles = mergedRoles;
  await loadCurrentShowTasks();
  collapseAllTasks();
  renderPlanCard();
  renderRolesCard();
  renderTasksCard();
}
document.getElementById('planAddTasksBtn').addEventListener('click', () => {
  document.getElementById('pullTasksModal').style.display = 'flex';
});
document.getElementById('pullTasksCloseBtn').addEventListener('click', () => { document.getElementById('pullTasksModal').style.display = 'none'; });
document.getElementById('pullTasksModal').addEventListener('click', (e) => { if (e.target.id === 'pullTasksModal') e.target.style.display = 'none'; });
document.getElementById('pullTasksConfirmBtn').addEventListener('click', async () => {
  const templateId = document.getElementById('planAddTemplateSelect').value;
  const template = allTemplates.find(t => t.id === templateId);
  if (!template) { showToast('Choose a task template', 'error'); return; }

  const perfDates = (currentShow.fixedParams.performances || []).map(p => p.date).filter(Boolean).sort();
  if (!perfDates.length) { showToast('Add at least one performance date first', 'error'); return; }

  try {
    await addTasksFromTemplate(template, perfDates[0]);
    document.getElementById('pullTasksModal').style.display = 'none';
    showToast(`Tasks added from "${template.name}"`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Roles (per-show — who holds each role) ──────────────────────────────

let allShowplannerUsers = []; // [{id, name, email}] — everyone with an actual ShowPlanner login
let allMembers = [];          // [{id, name, email}] — showdrinks_tabMembers, the whole suite's shared "everyone" directory

async function loadShowplannerUsers() {
  try {
    const result = await functionsRegion.httpsCallable('listShowplannerUsers')();
    allShowplannerUsers = result.data.users || [];
  } catch (err) {
    console.warn('listShowplannerUsers failed', err);
    allShowplannerUsers = [];
  }
}
async function loadShowplannerMembers() {
  try {
    const snap = await db.collection('showdrinks_tabMembers').orderBy('name').get();
    allMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('loadShowplannerMembers failed', err);
    allMembers = [];
  }
}
// Roles/tasks can be assigned to anyone in the general membership, not just accounts with their
// own ShowPlanner login — most cast/crew never need one just to have a task next to their name.
// Login accounts are listed first and a member already covered by one (matched by email) is
// skipped, so the same person never shows up twice under two different ids.
function assignablePeople() {
  const loginEmails = new Set(allShowplannerUsers.map(u => (u.email || '').toLowerCase()).filter(Boolean));
  const members = allMembers.filter(m => !loginEmails.has((m.email || '').toLowerCase()));
  return [...allShowplannerUsers, ...members].map(p => ({ id: p.id, name: p.name || p.email || '(unnamed)' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function userName(idVal) {
  if (isGuestId(idVal)) return idVal.slice(6);
  return allShowplannerUsers.find(u => u.id === idVal)?.name
    || allMembers.find(m => m.id === idVal)?.name
    || '(unknown)';
}
function roleName(roleId) { return currentShow.roles.find(r => r.id === roleId)?.name || ''; }
function castName(castId) { return currentShow.cast.find(c => c.id === castId)?.name || ''; }
// A free-text ("guest") assignee has no real users/showdrinks_tabMembers doc behind it — its
// whole identity is the literal name typed into the people picker, string-encoded as
// "guest:<name>" so it can still live in the same plain array-of-strings shape assigneeIds/
// roleAssignments/castAssignments already use everywhere (including firestore.rules' own
// membership checks, which assume exactly that shape).
function makeGuestId(name) { return 'guest:' + name.trim(); }
function isGuestId(id) { return typeof id === 'string' && id.startsWith('guest:'); }

// Mirrors firestore.rules' showPlanEditable(): an empty/missing planAccess map is "open to
// everyone" (a fresh show, or one nobody's ever restricted) — only once a producer explicitly
// sets it does anyone without an 'edit' entry drop to read-only. Client-side this only decides
// what the UI shows; the rule above is the actual enforcement.
function currentUserCanEditPlan() {
  if (currentUserData?.isManager === true) return true;
  const map = currentShow.planAccess || {};
  if (Object.keys(map).length === 0) return true;
  const uidVal = firebase.auth().currentUser?.uid;
  return map[uidVal] === 'edit';
}
function currentUserIsTaskAssignee(t) {
  const uidVal = firebase.auth().currentUser?.uid;
  if (!uidVal) return false;
  if ((t.assigneeIds || []).includes(uidVal)) return true;
  if (t.roleId && (currentShow.roleAssignments[t.roleId] || []).includes(uidVal)) return true;
  return false;
}

// Crew and Cast are two independent, identically-behaved rosters (currentShow.roles/
// roleAssignments and currentShow.cast/castAssignments) — one render function parameterised by
// which one, rather than two near-duplicate copies.
function renderGroupCard(kind) {
  const isCast = kind === 'cast';
  const items = isCast ? currentShow.cast : currentShow.roles;
  const assignments = isCast ? currentShow.castAssignments : currentShow.roleAssignments;
  const canEdit = currentUserCanEditPlan();
  document.getElementById(isCast ? 'addCastBtn' : 'addRoleBtn').style.display = canEdit ? '' : 'none';
  const tbody = document.getElementById(isCast ? 'castTableBody' : 'rolesTableBody');
  const nameAttr = isCast ? 'data-cast-name' : 'data-role-name';
  const assignAttr = isCast ? 'data-assign-cast' : 'data-assign-role';
  const deleteAttr = isCast ? 'data-cast-delete' : 'data-role-delete';
  const noun = isCast ? 'part' : 'role';
  const handleCell = canEdit ? '<td><span class="task-drag-handle group-drag-handle" title="Drag to move">⠿</span></td>' : '<td></td>';
  tbody.innerHTML = items.length ? items.map((r, i) => {
    const assignedIds = assignments[r.id] || [];
    const assignedNames = assignedIds.length ? assignedIds.map(userName).join(', ') : '—';
    const nameCell = canEdit
      ? '<input type="text" class="form-control" placeholder="' + (isCast ? 'Part' : 'Role') + ' name" value="' + escapeHtml(r.name || '') + '" ' + nameAttr + '="' + i + '">'
      : escapeHtml(r.name || ('(unnamed ' + noun + ')'));
    return `
      <tr data-item-id="${r.id}">
        ${handleCell}
        <td>${nameCell}<div class="role-assignees" style="margin-top:3px">${escapeHtml(assignedNames)}</div></td>
        <td>${canEdit ? ('<button class="icon-btn" ' + assignAttr + '="' + r.id + '" title="Assign" aria-label="Assign">' + ICON_PERSON + '</button>') : ''}</td>
        <td>${canEdit ? ('<button class="grid-del-btn" ' + deleteAttr + '="' + i + '" title="Remove">×</button>') : ''}</td>
      </tr>`;
  }).join('') : `<tr><td colspan="4" class="empty-state">No ${noun}s yet${canEdit ? (` — add one${isCast ? '' : ', or pull in a task template on the Plan tab'}.`) : '.'}</td></tr>`;
  if (canEdit) initGroupSortable(kind); else destroyGroupSortable(kind);
}
function renderRolesCard() { renderGroupCard('crew'); }
function renderCastCard() { renderGroupCard('cast'); }

// ── Drag-and-drop ordering for flat lists (Crew/Cast on a show, Roles in a template editor) —
// same Sortable.js pattern as the task lists above (handle-only drag, reindex the underlying
// array from final DOM order on drop, re-render), just without any nesting/reparenting. One
// registry keyed by an arbitrary string id (not tied to 'crew'/'cast') so the template roles list
// can share the exact same mechanism as the show-level ones.
const GROUP_SORTABLE_CONFIG = {
  crew: { tbodyId: 'rolesTableBody', getItems: () => currentShow.roles, onReorder: () => { markDirty(); renderRolesCard(); } },
  cast: { tbodyId: 'castTableBody', getItems: () => currentShow.cast, onReorder: () => { markDirty(); renderCastCard(); } },
  'template-roles': { tbodyId: 'templateRolesTableBody', getItems: () => currentTemplate.roles, onReorder: () => renderTemplateRolesTable() },
};
const groupSortables = {};
function destroyGroupSortable(kind) { groupSortables[kind]?.destroy(); groupSortables[kind] = null; }
async function initGroupSortable(kind) {
  const cfg = GROUP_SORTABLE_CONFIG[kind];
  try {
    await loadScript(SORTABLE_LIB_URL, 'Sortable');
  } catch (err) {
    console.warn('Sortable failed to load — drag reordering unavailable this session', err);
    return;
  }
  destroyGroupSortable(kind);
  const tbody = document.getElementById(cfg.tbodyId);
  groupSortables[kind] = Sortable.create(tbody, {
    handle: '.group-drag-handle',
    animation: 150,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fallbackOnBody: true,
    delay: 250,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    ghostClass: 'task-drag-ghost',
    chosenClass: 'task-drag-chosen',
    dragClass: 'task-drag-active',
    onEnd: () => {
      const ids = Array.from(tbody.querySelectorAll('tr[data-item-id]')).map(tr => tr.dataset.itemId);
      cfg.getItems().sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      cfg.onReorder();
    },
  });
}

// Assignments are written the moment they're picked (just that one entry, merged into the show's
// map) rather than waiting for Save changes — the rest of the editor stays a pending edit.
async function saveAssignmentNow(field, itemId, selected) {
  try {
    await db.collection('showplanner_shows').doc(currentShowId).set({
      [field]: { [itemId]: selected },
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    showToast('Assignment saved', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}
document.getElementById('addRoleBtn').addEventListener('click', () => {
  currentShow.roles.push({ id: uid(), name: '' });
  markDirty();
  renderRolesCard();
});
document.getElementById('addCastBtn').addEventListener('click', () => {
  currentShow.cast.push({ id: uid(), name: '' });
  markDirty();
  renderCastCard();
});
document.getElementById('rolesTableBody').addEventListener('input', (e) => {
  const i = e.target.getAttribute('data-role-name');
  if (i === null) return;
  currentShow.roles[Number(i)].name = e.target.value;
  markDirty();
});
document.getElementById('castTableBody').addEventListener('input', (e) => {
  const i = e.target.getAttribute('data-cast-name');
  if (i === null) return;
  currentShow.cast[Number(i)].name = e.target.value;
  markDirty();
});
document.getElementById('rolesTableBody').addEventListener('click', (e) => {
  const delIdx = e.target.closest('[data-role-delete]')?.getAttribute('data-role-delete') ?? null;
  if (delIdx !== null) {
    const item = currentShow.roles[Number(delIdx)];
    if (!confirm(`Remove ${item?.name ? `"${item.name}"` : 'this role'}?`)) return;
    const removed = currentShow.roles.splice(Number(delIdx), 1)[0];
    delete currentShow.roleAssignments[removed.id];
    markDirty();
    renderRolesCard();
    renderTasksCard();
    return;
  }
  const assignRoleId = e.target.closest('[data-assign-role]')?.getAttribute('data-assign-role');
  if (assignRoleId) {
    const role = currentShow.roles.find(r => r.id === assignRoleId);
    openPeopleModal(`Assign: ${role?.name || 'role'}`, currentShow.roleAssignments[assignRoleId] || [], (selected) => {
      currentShow.roleAssignments[assignRoleId] = selected;
      renderRolesCard();
      saveAssignmentNow('roleAssignments', assignRoleId, selected);
    });
  }
});
document.getElementById('castTableBody').addEventListener('click', (e) => {
  const delIdx = e.target.closest('[data-cast-delete]')?.getAttribute('data-cast-delete') ?? null;
  if (delIdx !== null) {
    const item = currentShow.cast[Number(delIdx)];
    if (!confirm(`Remove ${item?.name ? `"${item.name}"` : 'this part'}?`)) return;
    const removed = currentShow.cast.splice(Number(delIdx), 1)[0];
    delete currentShow.castAssignments[removed.id];
    markDirty();
    renderCastCard();
    return;
  }
  const assignCastId = e.target.closest('[data-assign-cast]')?.getAttribute('data-assign-cast');
  if (assignCastId) {
    const part = currentShow.cast.find(r => r.id === assignCastId);
    openPeopleModal(`Assign: ${part?.name || 'part'}`, currentShow.castAssignments[assignCastId] || [], (selected) => {
      currentShow.castAssignments[assignCastId] = selected;
      renderCastCard();
      saveAssignmentNow('castAssignments', assignCastId, selected);
    });
  }
});

// ── Shared people picker (Crew/Cast assignment, and the real show's task assignees) ─────────
// One modal, driven by whatever opened it: a search box filters assignablePeople() by name, an
// exact-no-match query offers "+ Add "<text>" as a guest" (a free-text, non-member assignee —
// see makeGuestId() above), and a Save button hands the final selected id list back to whoever
// opened the modal via onSave.
let peopleModalOnSave = null;
function openPeopleModal(title, selectedIds, onSave) {
  peopleModalOnSave = onSave;
  document.getElementById('assignRoleModalTitle').textContent = title;
  document.getElementById('assignRoleFilter').value = '';
  renderPeopleModalList(selectedIds || [], '');
  document.getElementById('assignRoleModal').style.display = 'flex';
}
function renderPeopleModalList(selectedIds, filterText) {
  const selectedSet = new Set(selectedIds);
  const people = assignablePeople();
  // Guests already assigned won't be in assignablePeople() (they're not real accounts/members)
  // — surface them too, so they still show up checked and can be unchecked/removed.
  const guestExtras = selectedIds.filter(id => isGuestId(id) && !people.some(p => p.id === id))
    .map(id => ({ id, name: userName(id), isGuest: true }));
  let list = [...people, ...guestExtras].sort((a, b) => a.name.localeCompare(b.name));
  const q = filterText.trim().toLowerCase();
  if (q) list = list.filter(p => selectedSet.has(p.id) || p.name.toLowerCase().includes(q));
  document.getElementById('assignRoleChecklist').innerHTML = list.length ? list.map(u => `
    <div class="checklist-row">
      <input type="checkbox" id="assignUser-${u.id}" value="${u.id}" ${selectedSet.has(u.id) ? 'checked' : ''}>
      <label for="assignUser-${u.id}">${escapeHtml(u.name)}${u.isGuest ? ' <span class="muted" style="font-size:11px">(guest)</span>' : ''}</label>
    </div>
  `).join('') : '<p class="muted" style="padding:6px">No matches.</p>';
  const exactMatch = q && list.some(p => p.name.toLowerCase() === q);
  const guestRow = document.getElementById('assignRoleAddGuestRow');
  guestRow.style.display = (filterText.trim() && !exactMatch) ? '' : 'none';
  document.getElementById('assignRoleAddGuestLabel').textContent = `+ Add "${filterText.trim()}" as a guest`;
}
document.getElementById('assignRoleFilter').addEventListener('input', (e) => {
  const checked = Array.from(document.querySelectorAll('#assignRoleChecklist input:checked')).map(cb => cb.value);
  renderPeopleModalList(checked, e.target.value);
});
document.getElementById('assignRoleAddGuestRow').addEventListener('click', () => {
  const filterInput = document.getElementById('assignRoleFilter');
  const name = filterInput.value.trim();
  if (!name) return;
  const checked = Array.from(document.querySelectorAll('#assignRoleChecklist input:checked')).map(cb => cb.value);
  checked.push(makeGuestId(name));
  filterInput.value = '';
  renderPeopleModalList(checked, '');
});
document.getElementById('assignRoleCloseBtn').addEventListener('click', () => { document.getElementById('assignRoleModal').style.display = 'none'; });
document.getElementById('assignRoleModal').addEventListener('click', (e) => { if (e.target.id === 'assignRoleModal') e.target.style.display = 'none'; });
document.getElementById('assignRoleSaveBtn').addEventListener('click', () => {
  const checked = Array.from(document.querySelectorAll('#assignRoleChecklist input:checked')).map(cb => cb.value);
  document.getElementById('assignRoleModal').style.display = 'none';
  peopleModalOnSave?.(checked);
});


function renderPlanAccessCard() {
  const el = document.getElementById('planAccessList');
  if (!allShowplannerUsers.length) {
    el.innerHTML = '<p class="muted" style="padding:6px">No other ShowPlanner accounts yet.</p>';
    return;
  }
  const explicit = Object.keys(currentShow.planAccess || {}).length > 0;
  el.innerHTML = allShowplannerUsers.map(u => {
    const checked = explicit ? currentShow.planAccess[u.id] === 'edit' : true;
    return `
      <div class="checklist-row">
        <input type="checkbox" id="planAccess-${u.id}" value="${u.id}" ${checked ? 'checked' : ''}>
        <label for="planAccess-${u.id}">${escapeHtml(u.name)}</label>
      </div>`;
  }).join('');
}

// isTemplate: the budget template has no plan at all. Plan access card specifically: only a
// plan editor manages who else can edit — mirrors the Roles/Tasks cards' own canEdit gating.
function applyPlanCardVisibility() {
  const isTemplateShow = currentShow.isTemplate;
  const canEdit = currentUserCanEditPlan();
  document.getElementById('planCard').style.display = isTemplateShow ? 'none' : '';
  document.getElementById('rolesCard').style.display = isTemplateShow ? 'none' : '';
  document.getElementById('castCard').style.display = isTemplateShow ? 'none' : '';
  document.getElementById('tasksCard').style.display = isTemplateShow ? 'none' : '';
  document.getElementById('planAccessCard').style.display = (isTemplateShow || !canEdit) ? 'none' : '';

  // The budget template has nothing to show on the Plan/Crew/Cast sub-tabs (see above) — hide
  // those tab buttons outright rather than leave a click landing on an empty panel, and bounce off
  // them if that's somehow the panel showing already (e.g. this show WAS a regular show a moment
  // ago).
  ['plan', 'roles', 'cast'].forEach(id => {
    const btn = document.querySelector(`.show-subtab-btn[data-subtab="${id}"]`);
    btn.style.display = isTemplateShow ? 'none' : '';
    if (isTemplateShow && document.getElementById('showsubtab-' + id).classList.contains('active')) switchShowSubtab('details');
  });
}

// ── Tasks ─────────────────────────────────────────────────────────────────
// Manual task CRUD, on top of whatever a pulled-in template seeded — each write here goes
// straight to Firestore (unlike roles/budget lines above, which wait for the page's own Save
// changes button) since tasks live in their own subcollection, not on the show doc itself.

const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
const STATUS_BADGE = { not_started: 'badge-danger', in_progress: 'badge-warning', completed: 'badge-success' };

let collapsedTaskIds = new Set(); // local UI state only (which parent tasks are collapsed) — never persisted

// A task with sub-tasks doesn't carry its own status — it's derived: completed only once every
// sub-task is completed, in progress as soon as any sub-task has started, otherwise not started.
// A leaf task (no children) just reports its own stored status unchanged. Recursive — a child
// that itself has children is judged by ITS derived status, not its raw (usually stale/unused)
// stored one, so a deeply-nested tree's status bubbles up correctly at every level.
function computeTaskStatus(task) {
  const children = currentShowTasks.filter(t => t.parentTaskId === task.id);
  if (!children.length) return task.status || 'not_started';
  const childStatuses = children.map(computeTaskStatus);
  if (childStatuses.every(s => s === 'completed')) return 'completed';
  if (childStatuses.some(s => s === 'in_progress' || s === 'completed')) return 'in_progress';
  return 'not_started';
}
// A task only counts as overdue if it has a real target — an explicit date, or a "days before
// show" that was actually set (not left at the 0 default) — so a template-generated task nobody
// has reviewed yet doesn't show as overdue the moment a plan's generated.
function isTaskOverdue(task, status) {
  if (!task.dueDate || status === 'completed') return false;
  const hasRealTarget = task.dueMode === 'date' || (task.daysBeforeShow ?? 0) !== 0;
  if (!hasRealTarget) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = task.dueDate.split('-').map(Number);
  return new Date(y, m - 1, d) < today;
}

const taskSortFn = (a, b) => (a.order ?? 0) - (b.order ?? 0);
function topLevelTasksSorted() { return currentShowTasks.filter(t => !t.parentTaskId).sort(taskSortFn); }
function childTasksSorted(parentId) { return currentShowTasks.filter(t => t.parentTaskId === parentId).sort(taskSortFn); }
// Every id reachable by following parentTaskId down from this task — any depth. Used to keep a
// task from being made a sub-task of its own descendant (which would create a cycle), and as a
// valid drag target.
function descendantTaskIds(taskId) {
  const out = new Set();
  (function walk(id) { childTasksSorted(id).forEach(c => { out.add(c.id); walk(c.id); }); })(taskId);
  return out;
}
// How many parentTaskId hops up to a top-level task — used only to indent a task's label in the
// flat "Sub-task of" <option> list so its place in the tree is legible there too.
function taskDepth(id) {
  let depth = 0, cur = currentShowTasks.find(t => t.id === id), seen = new Set();
  while (cur?.parentTaskId && !seen.has(cur.id)) { seen.add(cur.id); cur = currentShowTasks.find(t => t.id === cur.parentTaskId); depth++; }
  return depth;
}

// Flattened [{ task, depth }] in display order (each task immediately followed by all of its
// descendants, any depth, each in manual drag order within its own parent) — every task included
// regardless of on-screen collapse/filter state, since this is also the one source of truth the
// Excel export (exportExcelBtn) reads — an export can't have "collapsed" or "filtered" rows.
function orderedTaskList() {
  const out = [];
  function walk(task, depth) {
    out.push({ task, depth });
    childTasksSorted(task.id).forEach(sub => walk(sub, depth + 1));
  }
  topLevelTasksSorted().forEach(t => walk(t, 0));
  return out;
}

// Row colour follows status (not depth) — see .task-status-* in style.css. Nesting is shown by the
// indented .task-children container.
function taskRowHtml(t, depth, canEdit) {
  const children = childTasksSorted(t.id);
  const hasChildren = children.length > 0;
  const toggleHtml = hasChildren
    ? `<button class="task-toggle-btn" data-toggle-task="${t.id}" title="${collapsedTaskIds.has(t.id) ? 'Expand sub-tasks' : 'Collapse sub-tasks'}">${collapsedTaskIds.has(t.id) ? '▸' : '▾'}</button>`
    : '<span class="task-toggle-spacer"></span>';
  const handleHtml = canEdit ? '<span class="task-drag-handle" title="Drag to move">⠿</span>' : '';
  const menuHtml = canEdit ? `<button class="tpl-task-more-btn" data-task-open-menu="${t.id}" title="Task menu">…</button>` : '';
  return `
    <div class="task-row task-status-${computeTaskStatus(t)}" data-open-task="${t.id}">
      ${handleHtml}
      ${toggleHtml}
      <span class="task-title">${escapeHtml(t.title || '(untitled)')}</span>
      ${menuHtml}
    </div>`;
}
// A task card: its own row, plus an ACTUAL nested .task-children container for its descendants
// (not a flat sibling with a visual indent) — always rendered, even empty, so Sortable's own
// nested-list dragging can drop a task onto a currently-childless one, and so the collapse toggle
// can just show/hide one container element.
function taskCardHtml(t, depth, canEdit) {
  const collapsed = collapsedTaskIds.has(t.id);
  const children = childTasksSorted(t.id);
  return `
    <div class="task-card" data-task-id="${t.id}">
      ${taskRowHtml(t, depth, canEdit)}
      <div class="task-children" data-parent-id="${t.id}">${(!collapsed) ? children.map(c => taskCardHtml(c, depth + 1, canEdit)).join('') : ''}</div>
    </div>`;
}

// Every task with at least one sub-task starts collapsed — called once when a show's plan is
// first opened (and again after anything that reshapes the whole tree: generating or pulling in
// more tasks from a template), not on every render, so manually expanding a branch to work in it
// survives normal re-renders (status changes, drag-and-drop, quick-add, etc).
function collapseAllTasks() {
  collapsedTaskIds = new Set(currentShowTasks.filter(t => currentShowTasks.some(c => c.parentTaskId === t.id)).map(t => t.id));
}

function renderTasksCard() {
  const canEdit = currentUserCanEditPlan();
  document.getElementById('addTaskBtn').style.display = canEdit ? '' : 'none';
  const el = document.getElementById('tasksList');
  if (!currentShowTasks.length) {
    el.innerHTML = `<p class="empty-state">No tasks yet${canEdit ? ' — pull in a task template above, or add one manually.' : '.'}</p>`;
    destroyTaskSortables();
    return;
  }
  el.innerHTML = topLevelTasksSorted().map(t => taskCardHtml(t, 0, canEdit)).join('');
  if (canEdit) initTaskSortables(); else destroyTaskSortables();
}
document.getElementById('tasksList').addEventListener('click', (e) => {
  if (e.target.closest('.task-drag-handle')) return;
  const toggleBtn = e.target.closest('[data-toggle-task]');
  if (toggleBtn) {
    const id = toggleBtn.getAttribute('data-toggle-task');
    if (collapsedTaskIds.has(id)) collapsedTaskIds.delete(id); else collapsedTaskIds.add(id);
    renderTasksCard();
    return;
  }
  const menuBtn = e.target.closest('[data-task-open-menu]');
  if (menuBtn) { openRealTaskMenu(menuBtn, menuBtn.getAttribute('data-task-open-menu')); return; }
  const target = e.target.closest('[data-open-task]');
  if (target) openTaskModal(target.getAttribute('data-open-task'));
});
document.getElementById('addTaskBtn').addEventListener('click', () => openQuickAddTask(null));

// ── Quick-add (name only) ── adding a task or sub-task asks for just its title — the full detail
// modal only opens afterwards, by tapping the task once it exists. Confirming with Enter creates
// it and immediately opens a fresh blank quick-add in the same spot so several can be typed in a
// row; clicking away always discards whatever's typed, same "explicit confirm only" rule as the
// task template editor's own draft flow.
let quickAddParentId = undefined; // undefined = no quick-add open; null = open at top level
function quickAddContainer(parentId) {
  return parentId ? document.querySelector(`.task-children[data-parent-id="${parentId}"]`) : document.getElementById('tasksList');
}
function openQuickAddTask(parentId) {
  closeQuickAddTask();
  quickAddParentId = parentId;
  if (parentId) collapsedTaskIds.delete(parentId); // reveal the container the input is about to land in
  const container = quickAddContainer(parentId);
  if (!container) { quickAddParentId = undefined; return; }
  const row = document.createElement('div');
  row.className = 'task-quick-add';
  row.innerHTML = '<input type="text" class="form-control" id="taskQuickAddInput" placeholder="Task name…">';
  container.appendChild(row);
  const input = row.querySelector('input');
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmQuickAddTask(); }
    else if (e.key === 'Escape') { closeQuickAddTask(); }
  });
  input.addEventListener('blur', () => closeQuickAddTask());
}
// Removing the focused input fires 'blur' on it SYNCHRONOUSLY, mid-removal — so a plain
// close-on-blur handler re-enters this function while the browser is still unwinding its own
// removeChild call, which throws ("node no longer a child... moved in a blur handler?"). The
// guard makes the reentrant call a no-op instead.
let quickAddClosing = false;
function closeQuickAddTask() {
  if (quickAddClosing) return;
  quickAddClosing = true;
  try {
    document.querySelector('.task-quick-add')?.remove();
  } finally {
    quickAddClosing = false;
  }
  quickAddParentId = undefined;
}
async function confirmQuickAddTask() {
  const input = document.getElementById('taskQuickAddInput');
  const title = input?.value.trim();
  const parentId = quickAddParentId;
  if (!title) { closeQuickAddTask(); return; }
  quickAddParentId = undefined; // the blur this triggers must not also close the row we're about to replace
  const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
  try {
    await tasksCol.add({
      title, description: '', dueDate: '', dueMode: 'date', daysBeforeShow: null,
      roleId: null, assigneeIds: [], status: 'not_started', parentTaskId: parentId || null,
      comments: [], order: currentShowTasks.filter(t => (t.parentTaskId || null) === (parentId || null)).length,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await loadCurrentShowTasks();
    renderTasksCard();
    renderPlanCard();
    openQuickAddTask(parentId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── "…" task menu — one shared floating panel (#realTaskMenu in index.html, same .tpl-task-menu
// styling/positioning as the task template editor's own menu), built here since it needs the
// shared ICON_* constants and STATUS_LABEL. Adds a row of status pills above the usual Edit/Add
// sub-task/Delete actions so the everyday case (mark something in progress/done) never needs the
// full detail modal at all.
document.getElementById('realTaskMenu').innerHTML = `
  <div class="tpl-task-menu-header">
    <span>Task</span>
    <button type="button" class="tpl-task-menu-close" data-realtask-menu-close aria-label="Close menu">${ICON_CLOSE}</button>
  </div>
  <div class="status-pill-row" id="realTaskMenuPills" style="padding:4px 8px 10px">
    <button type="button" class="status-pill" data-realtask-status="not_started">Not started</button>
    <button type="button" class="status-pill" data-realtask-status="in_progress">In progress</button>
    <button type="button" class="status-pill" data-realtask-status="completed">Completed</button>
  </div>
  <button type="button" data-realtask-menu-action="add-sub">${ICON_PLUS}<span>Add sub-task</span></button>
  <button type="button" data-realtask-menu-action="edit">${ICON_EDIT}<span>Edit</span></button>
  <button type="button" class="danger" data-realtask-menu-action="delete">${ICON_TRASH}<span>Delete task</span></button>
`;
let realTaskMenuTargetId = null;
function openRealTaskMenu(anchorBtn, taskId) {
  realTaskMenuTargetId = taskId;
  const t = currentShowTasks.find(x => x.id === taskId);
  if (!t) return;
  const hasChildren = currentShowTasks.some(c => c.parentTaskId === taskId);
  const effectiveStatus = hasChildren ? computeTaskStatus(t) : (t.status || 'not_started');
  document.querySelectorAll('#realTaskMenuPills .status-pill').forEach(btn => {
    btn.hidden = hasChildren || btn.getAttribute('data-realtask-status') === effectiveStatus; // only offer the statuses it isn't
  });
  // A task with sub-tasks has a derived status (see computeTaskStatus()), so it can't be set here.
  document.getElementById('realTaskMenuPills').hidden = hasChildren;
  const menu = document.getElementById('realTaskMenu');
  const rect = anchorBtn.getBoundingClientRect();
  menu.hidden = false;
  const menuWidth = menu.offsetWidth;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8))}px`;
}
function closeRealTaskMenu() {
  document.getElementById('realTaskMenu').hidden = true;
  realTaskMenuTargetId = null;
}
document.getElementById('realTaskMenu').addEventListener('click', async (e) => {
  if (e.target.closest('[data-realtask-menu-close]')) { closeRealTaskMenu(); return; }
  const taskId = realTaskMenuTargetId;
  if (!taskId) return;
  const pillBtn = e.target.closest('[data-realtask-status]');
  if (pillBtn) {
    closeRealTaskMenu();
    await setRealTaskStatus(taskId, pillBtn.getAttribute('data-realtask-status'));
    return;
  }
  const action = e.target.closest('[data-realtask-menu-action]')?.getAttribute('data-realtask-menu-action');
  if (!action) return;
  closeRealTaskMenu();
  if (action === 'add-sub') openQuickAddTask(taskId);
  else if (action === 'edit') openTaskModal(taskId);
  else if (action === 'delete') deleteRealTask(taskId);
});
// Click anywhere outside the menu (and not on a "…" button that opens it — that has its own
// handler above) closes it.
document.addEventListener('click', (e) => {
  if (document.getElementById('realTaskMenu').hidden) return;
  if (e.target.closest('#realTaskMenu') || e.target.closest('[data-task-open-menu]')) return;
  closeRealTaskMenu();
});
async function setRealTaskStatus(taskId, status) {
  const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
  try {
    const batch = db.batch();
    [taskId, ...descendantTaskIds(taskId)].forEach(id => {
      batch.set(tasksCol.doc(id), { status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    await batch.commit();
    await loadCurrentShowTasks();
    renderTasksCard();
    renderPlanCard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
async function deleteRealTask(taskId) {
  const descendants = descendantTaskIds(taskId);
  if (!confirm(`Delete this task${descendants.size ? ` and its ${descendants.size} sub-task${descendants.size === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return;
  try {
    const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
    const batch = db.batch();
    batch.delete(tasksCol.doc(taskId));
    descendants.forEach(id => batch.delete(tasksCol.doc(id)));
    await batch.commit();
    document.getElementById('taskModal').style.display = 'none';
    showToast('Task deleted', 'success');
    await loadCurrentShowTasks();
    renderTasksCard();
    renderPlanCard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Drag-and-drop ordering — same Sortable.js pattern as the task template editor: one instance
// per drop zone (the top-level list, plus every task's own .task-children container), all sharing
// a group so dragging between any of them reparents, and within one reorders. Persisted
// immediately to Firestore on drop, matching "saved automatically" everywhere else in this modal.
// Only wired up for a full plan editor — an assignee/read-only viewer never gets a drag handle.
let realTaskSortables = [];
function destroyTaskSortables() { realTaskSortables.forEach(s => s.destroy()); realTaskSortables = []; }
async function initTaskSortables() {
  try {
    await loadScript(SORTABLE_LIB_URL, 'Sortable');
  } catch (err) {
    console.warn('Sortable failed to load — drag reordering unavailable this session', err);
    return;
  }
  destroyTaskSortables();
  const containers = [document.getElementById('tasksList'), ...document.querySelectorAll('#tasksList .task-children')];
  containers.forEach(container => {
    realTaskSortables.push(Sortable.create(container, {
      group: 'real-tasks',
      handle: '.task-drag-handle',
      // The quick-add "name only" input row sits in these same containers while it's open — it
      // has no drag handle so it was never draggable itself, but without excluding it here
      // Sortable still treats it as a reorderable slot and can shuffle it around mid-drag of
      // something else.
      filter: '.task-quick-add',
      preventOnFilter: false,
      animation: 150,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fallbackOnBody: true,
      swapThreshold: 0.65,
      delay: 250,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      ghostClass: 'task-drag-ghost',
      chosenClass: 'task-drag-chosen',
      dragClass: 'task-drag-active',
      onMove: (evt) => {
        const draggedId = evt.dragged.dataset.taskId;
        const targetParentId = evt.to.id === 'tasksList' ? null : evt.to.dataset.parentId;
        if (!draggedId || !targetParentId) return true; // dropping to top-level is always fine
        if (targetParentId === draggedId || descendantTaskIds(draggedId).has(targetParentId)) return false;
        return true;
      },
      onEnd: handleTaskSortEnd,
    }));
  });
}
async function handleTaskSortEnd(evt) {
  const task = currentShowTasks.find(t => t.id === evt.item.dataset.taskId);
  if (!task) return;
  task.parentTaskId = evt.to.id === 'tasksList' ? null : (evt.to.dataset.parentId || null);
  const touched = [];
  const reindex = (container) => {
    Array.from(container.children).forEach((el, idx) => {
      const t = currentShowTasks.find(t => t.id === el.dataset.taskId);
      if (t) { t.order = idx; touched.push(t); }
    });
  };
  reindex(evt.to);
  if (evt.from !== evt.to) reindex(evt.from);
  renderTasksCard();
  try {
    const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
    const batch = db.batch();
    touched.forEach(t => {
      batch.set(tasksCol.doc(t.id), { order: t.order, parentTaskId: t.parentTaskId || null, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    await batch.commit();
  } catch (err) {
    showToast(err.message, 'error');
  }
}


let editingTaskId = null;   // null while creating a new task (not yet written to Firestore)
let editingTaskDraft = null; // working copy of the task while the modal is open
let taskEditMode = 'full';   // 'full' | 'assignee' (status/comments only) | 'readonly'
let taskAutoSaveTimer = null;

function openTaskModal(taskId) {
  editingTaskId = taskId;
  const existing = taskId ? currentShowTasks.find(t => t.id === taskId) : null;
  editingTaskDraft = existing
    ? { ...existing, comments: [...(existing.comments || [])] }
    : { title: '', description: '', dueDate: '', dueMode: 'date', daysBeforeShow: null,
        roleId: null, assigneeIds: [], status: 'not_started', parentTaskId: null, comments: [] };

  const canEditPlan = currentUserCanEditPlan();
  taskEditMode = canEditPlan ? 'full' : (existing && currentUserIsTaskAssignee(existing)) ? 'assignee' : 'readonly';

  const children = existing ? currentShowTasks.filter(t => t.parentTaskId === existing.id) : [];
  const hasChildren = children.length > 0;
  // A task with sub-tasks doesn't carry its own status — see computeTaskStatus() — so its pills
  // just mirror that derived value and can't be clicked.
  const effectiveStatus = hasChildren ? computeTaskStatus(existing) : (editingTaskDraft.status || 'not_started');
  editingTaskDraft.status = effectiveStatus;

  document.getElementById('taskModalTitle').textContent = existing ? 'Edit task' : 'New task';
  document.getElementById('taskTitleInput').value = editingTaskDraft.title || '';
  const descEl = document.getElementById('taskDescInput');
  descEl.value = editingTaskDraft.description || '';
  autoGrowTextarea(descEl);
  document.getElementById('taskDueDateInput').value = editingTaskDraft.dueDate || '';

  document.querySelectorAll('#taskStatusPills .status-pill').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-status-pill') === effectiveStatus);
    btn.disabled = taskEditMode === 'readonly' || hasChildren;
  });

  document.getElementById('taskRoleSelect').innerHTML = '<option value="">—</option>' +
    currentShow.roles.map(r => `<option value="${r.id}"${r.id === editingTaskDraft.roleId ? ' selected' : ''}>${escapeHtml(r.name || '(unnamed role)')}</option>`).join('');

  // Any other task can be the parent, any depth — only itself and its own descendants are
  // excluded (picking one of those would create a cycle). Indented per its own depth so the
  // flat <option> list still shows roughly where each candidate sits in the tree.
  const excludedParents = taskId ? new Set([taskId, ...descendantTaskIds(taskId)]) : new Set();
  document.getElementById('taskParentSelect').innerHTML = '<option value="">Top-level</option>' +
    currentShowTasks.filter(t => !excludedParents.has(t.id))
      .map(t => `<option value="${t.id}"${t.id === editingTaskDraft.parentTaskId ? ' selected' : ''}>${'— '.repeat(taskDepth(t.id))}${escapeHtml(t.title || '(untitled)')}</option>`).join('');

  document.getElementById('taskAssigneesCount').textContent = (editingTaskDraft.assigneeIds || []).length;
  document.getElementById('taskCommentsCount').textContent = (editingTaskDraft.comments || []).length;

  ['taskTitleInput', 'taskDescInput', 'taskDueDateInput', 'taskRoleSelect', 'taskParentSelect'].forEach(id => {
    document.getElementById(id).disabled = taskEditMode !== 'full';
  });
  document.getElementById('taskAssigneesBtn').disabled = taskEditMode !== 'full';

  document.getElementById('taskDeleteBtn').style.display = (existing && taskEditMode === 'full') ? '' : 'none';
  document.getElementById('taskSaveStatusText').textContent = '';
  document.getElementById('taskModal').style.display = 'flex';
}
document.getElementById('taskModalCloseBtn').addEventListener('click', () => { document.getElementById('taskModal').style.display = 'none'; });
document.getElementById('taskModal').addEventListener('click', (e) => { if (e.target.id === 'taskModal') e.target.style.display = 'none'; });

function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
document.getElementById('taskDescInput').addEventListener('input', (e) => {
  autoGrowTextarea(e.target);
  scheduleTaskAutoSave();
});

document.querySelectorAll('#taskStatusPills .status-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    editingTaskDraft.status = btn.getAttribute('data-status-pill');
    document.querySelectorAll('#taskStatusPills .status-pill').forEach(b => b.classList.toggle('active', b === btn));
    scheduleTaskAutoSave(true);
  });
});

document.getElementById('taskAssigneesBtn').addEventListener('click', () => {
  openPeopleModal('Assigned people', editingTaskDraft.assigneeIds || [], (selected) => {
    editingTaskDraft.assigneeIds = selected;
    document.getElementById('taskAssigneesCount').textContent = selected.length;
    scheduleTaskAutoSave(true);
  });
});

document.getElementById('taskCommentsBtn').addEventListener('click', () => {
  renderTaskComments();
  document.getElementById('taskCommentInput').value = '';
  document.getElementById('taskCommentInput').disabled = taskEditMode === 'readonly';
  document.getElementById('taskCommentAddBtn').style.display = taskEditMode === 'readonly' ? 'none' : '';
  document.getElementById('taskCommentsModal').style.display = 'flex';
});
document.getElementById('taskCommentsCloseBtn').addEventListener('click', () => { document.getElementById('taskCommentsModal').style.display = 'none'; });
document.getElementById('taskCommentsModal').addEventListener('click', (e) => { if (e.target.id === 'taskCommentsModal') e.target.style.display = 'none'; });

function renderTaskComments() {
  const el = document.getElementById('taskCommentsList');
  const comments = editingTaskDraft.comments || [];
  el.innerHTML = comments.length
    ? comments.map(c => `
      <div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
        <strong>${escapeHtml(c.authorName || '')}</strong>
        <span class="muted" style="font-size:11px">${c.createdAt ? new Date(c.createdAt).toLocaleString('en-GB') : ''}</span><br>
        ${escapeHtml(c.text || '')}
      </div>`).join('')
    : '<p class="muted" style="font-size:13px">No comments yet.</p>';
}
document.getElementById('taskCommentAddBtn').addEventListener('click', () => {
  const input = document.getElementById('taskCommentInput');
  const text = input.value.trim();
  if (!text) return;
  const user = firebase.auth().currentUser;
  // Comments live inside an array field — Firestore rejects FieldValue.serverTimestamp() inside
  // an array element, so this is a plain client-side epoch ms instead (only used for display
  // ordering/formatting, never compared against anything server-side).
  editingTaskDraft.comments.push({
    authorUid: user?.uid || null,
    authorName: currentUserData?.name || user?.email || 'Someone',
    text,
    createdAt: Date.now(),
  });
  input.value = '';
  renderTaskComments();
  document.getElementById('taskCommentsCount').textContent = editingTaskDraft.comments.length;
  scheduleTaskAutoSave(true);
});

function readTaskFormIntoDraft() {
  editingTaskDraft.title = document.getElementById('taskTitleInput').value.trim();
  editingTaskDraft.description = document.getElementById('taskDescInput').value.trim();
  const newDueDate = document.getElementById('taskDueDateInput').value;
  // A manual date edit always fixes a concrete date from here on — daysBeforeShow only describes
  // how a template-generated task originally got its date, not something a hand edit preserves.
  if (newDueDate !== editingTaskDraft.dueDate) { editingTaskDraft.dueMode = 'date'; editingTaskDraft.daysBeforeShow = null; }
  editingTaskDraft.dueDate = newDueDate;
  editingTaskDraft.roleId = document.getElementById('taskRoleSelect').value || null;
  editingTaskDraft.parentTaskId = document.getElementById('taskParentSelect').value || null;
}

['taskTitleInput', 'taskDueDateInput', 'taskRoleSelect', 'taskParentSelect'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => scheduleTaskAutoSave());
  document.getElementById(id).addEventListener('change', () => scheduleTaskAutoSave(true));
});

// Debounced for free-typed text (title/description), immediate for discrete choices (status
// pill, due date, role/parent select, assignee picker, a posted comment) — matches the template
// task editor's "don't hammer Firestore on every keystroke" approach while still feeling instant
// for anything that's a single click.
function scheduleTaskAutoSave(immediate) {
  if (taskEditMode === 'readonly') return;
  clearTimeout(taskAutoSaveTimer);
  if (immediate) { performTaskAutoSave(); return; }
  taskAutoSaveTimer = setTimeout(performTaskAutoSave, 600);
}

async function performTaskAutoSave() {
  readTaskFormIntoDraft();
  const statusEl = document.getElementById('taskSaveStatusText');
  // Mirrors the template task editor: a task with no title is never written to Firestore — an
  // abandoned "New task" modal just closes with nothing saved.
  if (!editingTaskDraft.title) { statusEl.textContent = editingTaskId ? '' : 'Enter a title to save'; return; }
  statusEl.textContent = 'Saving…';
  const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
  try {
    // An assignee without full plan-edit rights can only ever change status/comments — matches
    // firestore.rules' isTaskAssignee() exception exactly (anything else in the payload would be
    // rejected outright, so it's never sent).
    const payload = taskEditMode === 'assignee' ? {
      status: editingTaskDraft.status || 'not_started',
      comments: editingTaskDraft.comments || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    } : {
      title: editingTaskDraft.title,
      description: editingTaskDraft.description || '',
      dueDate: editingTaskDraft.dueDate || '',
      dueMode: editingTaskDraft.dueMode || 'date',
      daysBeforeShow: editingTaskDraft.daysBeforeShow ?? null,
      roleId: editingTaskDraft.roleId || null,
      assigneeIds: editingTaskDraft.assigneeIds || [],
      status: editingTaskDraft.status || 'not_started',
      parentTaskId: editingTaskDraft.parentTaskId || null,
      comments: editingTaskDraft.comments || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (editingTaskId) {
      await tasksCol.doc(editingTaskId).set(payload, { merge: true });
    } else {
      payload.order = currentShowTasks.length;
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await tasksCol.add(payload);
      editingTaskId = ref.id;
      document.getElementById('taskModalTitle').textContent = 'Edit task';
      document.getElementById('taskDeleteBtn').style.display = taskEditMode === 'full' ? '' : 'none';
    }
    statusEl.textContent = 'Saved';
    await loadCurrentShowTasks();
    renderTasksCard();
    renderPlanCard();
  } catch (err) {
    statusEl.textContent = '';
    showToast(err.message, 'error');
  }
}

document.getElementById('taskDeleteBtn').addEventListener('click', () => {
  if (!editingTaskId) return;
  deleteRealTask(editingTaskId);
});

// ── Performances ─────────────────────────────────────────────────────────
// Each performance is its own editable row: date and a ticket price that defaults to the show's
// default ticket price but can be overridden per row. Ticket sales income (one line per
// performance — see performanceIncomeLines) recomputes from whatever's here, live.

function refreshAfterPerfChange() {
  renderLinesTable('income', INCOME_FORMULAS);
  renderForecast();
}

const PERF_TYPES = ['Matinee', 'Evening', 'Other'];

function renderPerfTable() {
  const perfs = currentShow.fixedParams.performances;
  const tbody = document.getElementById('perfTableBody');
  tbody.innerHTML = perfs.length ? perfs.map((p, i) => `
    <tr>
      <td><input type="date" class="form-control" value="${p.date || ''}" data-perf-field="${i}:date"></td>
      <td><select class="form-control" data-perf-field="${i}:type">${PERF_TYPES.map(t => `<option value="${t}"${(p.type || 'Evening') === t ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input type="number" class="form-control num-input" min="0" step="1" value="${p.price ?? 0}" data-perf-field="${i}:price"></td>
      <td class="no-print"><button class="grid-del-btn" data-perf-remove="${i}" title="Remove">×</button></td>
    </tr>
  `).join('') : '<tr><td colspan="4" class="empty-state">No performances yet — generate some above.</td></tr>';
  // The date/count/Generate row is only useful before there are any performances (Generate
  // replaces the lot, with a confirm() guard) — once rows exist, editing/adding/removing them
  // below is how you manage the list; it comes back automatically if they're all removed.
  document.getElementById('perfGenRow').style.display = perfs.length ? 'none' : '';
}

document.getElementById('generatePerfsBtn').addEventListener('click', () => {
  const date = document.getElementById('genPerfDate').value;
  const count = Math.max(1, Number(document.getElementById('genPerfCount').value) || 1);
  if (!date) { showToast('Pick the first performance date', 'error'); return; }
  const existing = currentShow.fixedParams.performances;
  if (existing.length && !confirm(`Replace the ${existing.length} existing performance(s) with ${count} consecutive one(s) starting ${date}?`)) return;

  const [y, m, d] = date.split('-').map(Number);
  const perfs = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(y, m - 1, d + i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    perfs.push({ date: iso, type: 'Evening', price: 0 });
  }
  currentShow.fixedParams.performances = perfs;
  markDirty();
  renderPerfTable();
  refreshAfterPerfChange();
});

document.getElementById('addPerfBtn').addEventListener('click', () => {
  const perfs = currentShow.fixedParams.performances;
  const lastPrice = perfs.length ? (perfs[perfs.length - 1].price || 0) : 0;
  perfs.push({ date: '', type: 'Evening', price: lastPrice });
  markDirty();
  renderPerfTable();
  refreshAfterPerfChange();
});

function handlePerfFieldChange(e) {
  const key = e.target.getAttribute('data-perf-field');
  if (!key) return;
  const [idx, field] = key.split(':');
  const p = currentShow.fixedParams.performances[Number(idx)];
  p[field] = field === 'price' ? (Math.round(Number(e.target.value) || 0)) : e.target.value;
  refreshAfterPerfChange();
}
// 'change' too, not just 'input' — <select> (the Type column) doesn't reliably fire 'input' in
// every browser the way date/number inputs do.
document.getElementById('perfTableBody').addEventListener('input', handlePerfFieldChange);
document.getElementById('perfTableBody').addEventListener('change', handlePerfFieldChange);

document.getElementById('perfTableBody').addEventListener('click', (e) => {
  const i = e.target.getAttribute('data-perf-remove');
  if (i === null) return;
  currentShow.fixedParams.performances.splice(Number(i), 1);
  markDirty();
  renderPerfTable();
  refreshAfterPerfChange();
});

['fpSeats', 'fpExpectedSalesPct', 'fpCastSize', 'fpRehearsalSubs'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const map = {
      fpSeats: 'seatsPerPerformance', fpExpectedSalesPct: 'expectedSalesPct',
      fpCastSize: 'castSize', fpRehearsalSubs: 'rehearsalSubsPerCast',
    };
    currentShow.fixedParams[map[id]] = Math.round(Number(e.target.value) || 0);
    renderLinesTable('income', INCOME_FORMULAS);
    renderLinesTable('spend', SPEND_FORMULAS);
    renderForecast();
  });
});
document.getElementById('showNameInput').addEventListener('input', (e) => { currentShow.name = e.target.value; });

// Income's rows are two different things stacked in one table: the per-performance ticket-sales
// lines (computed, read-only — see performanceIncomeLines) always come first, then the manually-
// editable/removable array (currentShow.income) that the +Add/-Remove buttons manage. Spend has
// only the second kind. Line indices in data-line-* attributes always refer to position within
// currentShow[kind] (the editable array), never the combined display list.
function renderLinesTable(kind, formulas) {
  const tbody = document.getElementById(kind + 'TableBody');
  let rowsHtml = '';
  let total = 0;

  if (kind === 'income') {
    const perfLines = performanceIncomeLines(currentShow);
    total += perfLines.reduce((s, l) => s + l.amount, 0);
    rowsHtml += perfLines.map(line => `
      <tr>
        <td>${escapeHtml(line.label)}</td>
        <td class="amount-cell"><input type="text" class="form-control num-input" style="text-align:right" value="${money(line.amount)}" disabled></td>
        <td class="no-print"></td>
      </tr>`).join('');
  }

  const items = currentShow[kind];
  rowsHtml += items.map((item, i) => {
    const isFormula = !!item.formula;
    const amount = resolveAmount(item, currentShow.fixedParams, currentShow.income, formulas);
    total += amount;
    // Bar costs/VH levy carry their own editable percentage, instead of a fixed 40%/10% baked
    // into the formula — right next to the amount it produces rather than inline in the label.
    const pctInput = item.formula in DEFAULT_PCT
      ? `<span class="pct-wrap"><input type="number" class="form-control pct-input" min="0" max="100" step="1" value="${itemPct(item)}" data-line-pct="${kind}:${i}"><span class="pct-sign">%</span></span>`
      : '';
    return `
      <tr>
        <td>${escapeHtml(item.label)}</td>
        <td class="amount-cell${pctInput ? ' amount-cell-with-pct' : ''}">${pctInput}${isFormula
          ? `<input type="text" class="form-control num-input" style="text-align:right" value="${money(amount)}" disabled>`
          : `<input type="number" class="form-control num-input" style="text-align:right" min="0" step="1" value="${amount}" data-line-amount="${kind}:${i}">`}</td>
        <td class="no-print">${isFormula ? '' : `<button class="grid-del-btn" data-line-remove="${kind}:${i}" title="Remove">×</button>`}</td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rowsHtml;
  document.getElementById(kind + 'TotalText').textContent = money(total);
}

document.getElementById('incomeTableBody').addEventListener('input', handleLineAmountInput);
document.getElementById('spendTableBody').addEventListener('input', handleLineAmountInput);
function handleLineAmountInput(e) {
  const key = e.target.getAttribute('data-line-amount');
  if (!key) return;
  const [kind, idx] = key.split(':');
  currentShow[kind][Number(idx)].amount = Math.round(Number(e.target.value) || 0);
  // barReceipts feeds barCosts/vhBarLevy — keep the spend table's calculated cells live. Never
  // re-render the table currently being typed in, though — that would rebuild the very input
  // under the cursor and drop focus on every keystroke; just recompute its total instead.
  if (kind === 'income') renderLinesTable('spend', SPEND_FORMULAS);
  document.getElementById(kind + 'TotalText').textContent = money(kind === 'income' ? incomeTotal(currentShow) : spendTotal(currentShow));
  renderForecast();
}

document.getElementById('incomeTableBody').addEventListener('input', handleLinePctInput);
document.getElementById('spendTableBody').addEventListener('input', handleLinePctInput);
function handleLinePctInput(e) {
  const key = e.target.getAttribute('data-line-pct');
  if (!key) return;
  const [kind, idx] = key.split(':');
  const item = currentShow[kind][Number(idx)];
  item.pct = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
  // Update just this row's own calculated-amount box in place rather than re-rendering the
  // whole table — that would rebuild the % input under the cursor and drop focus mid-edit.
  const amountBox = e.target.closest('tr')?.querySelector('td.amount-cell input');
  if (amountBox) amountBox.value = money(resolveAmount(item, currentShow.fixedParams, currentShow.income, kind === 'income' ? INCOME_FORMULAS : SPEND_FORMULAS));
  document.getElementById(kind + 'TotalText').textContent = money(kind === 'income' ? incomeTotal(currentShow) : spendTotal(currentShow));
  renderForecast();
}

document.getElementById('incomeTableBody').addEventListener('click', (e) => handleLineRemove(e, 'income'));
document.getElementById('spendTableBody').addEventListener('click', (e) => handleLineRemove(e, 'spend'));
function handleLineRemove(e, kind) {
  const key = e.target.getAttribute('data-line-remove');
  if (!key) return;
  const idx = Number(key.split(':')[1]);
  currentShow[kind].splice(idx, 1);
  markDirty();
  renderLinesTable(kind, kind === 'income' ? INCOME_FORMULAS : SPEND_FORMULAS);
  renderForecast();
}

function renderForecast() {
  const cardsEl = document.getElementById('forecastCards');
  // The template's numbers are all zero/placeholder by design — a forecast for it isn't
  // meaningful, so skip it there rather than show a permanent £0 row.
  if (currentShow.isTemplate) { cardsEl.innerHTML = ''; return; }
  const inc = incomeTotal(currentShow);
  const sp = spendTotal(currentShow);
  const fc = inc - sp;
  cardsEl.innerHTML = `
    <div class="summary-card"><div class="snum">${money(inc)}</div><div class="slabel">Total income</div></div>
    <div class="summary-card"><div class="snum">${money(sp)}</div><div class="slabel">Total spend</div></div>
    <div class="summary-card"><div class="snum" style="color:${fc >= 0 ? 'var(--success)' : 'var(--danger)'}">${money(fc)}</div><div class="slabel">Forecast (income − spend)</div></div>
  `;
}

// ── Add income/spend item ───────────────────────────────────────────────

let addItemKind = null;
function openAddItemModal(kind) {
  addItemKind = kind;
  document.getElementById('addItemTitle').textContent = `Add ${kind} item`;
  document.getElementById('addItemLabel').value = '';
  document.getElementById('addItemAmount').value = 0;
  document.getElementById('addItemModal').style.display = 'flex';
}
document.getElementById('addIncomeItemBtn').addEventListener('click', () => openAddItemModal('income'));
document.getElementById('addSpendItemBtn').addEventListener('click', () => openAddItemModal('spend'));
document.getElementById('addItemCloseBtn').addEventListener('click', () => { document.getElementById('addItemModal').style.display = 'none'; });
document.getElementById('addItemModal').addEventListener('click', (e) => { if (e.target.id === 'addItemModal') e.target.style.display = 'none'; });

document.getElementById('addItemSubmitBtn').addEventListener('click', () => {
  const label = document.getElementById('addItemLabel').value.trim();
  const amount = Math.round(Number(document.getElementById('addItemAmount').value) || 0);
  if (!label) { showToast('Enter a label', 'error'); return; }
  currentShow[addItemKind].push({ id: uid(), label, formula: null, amount });
  document.getElementById('addItemModal').style.display = 'none';
  renderLinesTable(addItemKind, addItemKind === 'income' ? INCOME_FORMULAS : SPEND_FORMULAS);
  renderForecast();
});

// ── Save / Template / Delete ────────────────────────────────────────────

document.getElementById('saveShowBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('saveStatusText');
  if (!currentShow.name?.trim()) { showToast('Enter a show name', 'error'); return; }
  if (!currentShow.isTemplate && currentUserCanEditPlan()) {
    const checked = new Set(Array.from(document.querySelectorAll('#planAccessList input:checked')).map(cb => cb.value));
    const map = {};
    allShowplannerUsers.forEach(u => { map[u.id] = checked.has(u.id) ? 'edit' : 'read'; });
    currentShow.planAccess = map;
  }
  statusEl.textContent = 'Saving…';
  try {
    await db.collection('showplanner_shows').doc(currentShowId).set({
      name: currentShow.name.trim(),
      roles: currentShow.roles || [],
      roleAssignments: currentShow.roleAssignments || {},
      cast: currentShow.cast || [],
      castAssignments: currentShow.castAssignments || {},
      planAccess: currentShow.planAccess || {},
      planTemplateId: currentShow.planTemplateId || null,
      isTemplate: currentShow.isTemplate === true,
      copiedFrom: currentShow.copiedFrom || null,
      fixedParams: currentShow.fixedParams,
      income: currentShow.income,
      spend: currentShow.spend,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    statusEl.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB');
    showToast('Saved', 'success');
    showEditorDirty = false;
    await loadShows();
  } catch (err) {
    statusEl.textContent = '';
    showToast(err.message, 'error');
  }
});

// Only one show is ever the template — same "Set as Current" pattern showdrinks uses for its
// shows, applied here to isTemplate instead.
document.getElementById('setTemplateBtn').addEventListener('click', async () => {
  if (!confirm(`Make "${currentShow.name}" the template for new shows?`)) return;
  try {
    const batch = db.batch();
    allShows.forEach(s => batch.update(db.collection('showplanner_shows').doc(s.id), { isTemplate: s.id === currentShowId }));
    await batch.commit();
    currentShow.isTemplate = true;
    document.getElementById('setTemplateBtn').style.display = 'none';
    showToast('Template updated', 'success');
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('deleteShowBtn').addEventListener('click', async () => {
  if (currentShow.isTemplate) { showToast('Make another show the template first — there must always be one.', 'error'); return; }
  if (!confirm(`Delete "${currentShow.name}"? This cannot be undone.`)) return;
  try {
    await db.collection('showplanner_shows').doc(currentShowId).delete();
    showToast('Show deleted', 'success');
    currentShowId = null; currentShow = null;
    switchTab('shows');
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Task Templates ───────────────────────────────────────────────────────
// Reusable checklists (showplanner_templates) that pulling into a plan turns into real
// dated tasks on a show — kept entirely separate from the budget "template" concept above
// (isTemplate on a show doc), which is why these are always called "task template" in the UI.

async function loadTemplates() {
  const snap = await db.collection('showplanner_templates').get();
  allTemplates = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  renderTemplatesList();
}

function renderTemplatesList() {
  const el = document.getElementById('templatesList');
  if (!allTemplates.length) {
    el.innerHTML = '<p class="empty-state">No task templates yet — create one to start generating show plans.</p>';
    return;
  }
  el.innerHTML = allTemplates.map(t => `
    <div class="item-row" data-open-template="${t.id}" style="cursor:pointer">
      <div class="item-name-col">
        <div class="item-name">${escapeHtml(t.name || '(untitled)')}</div>
        <div class="item-sub">${(t.tasks || []).length} task${(t.tasks || []).length === 1 ? '' : 's'} · ${(t.roles || []).length} role${(t.roles || []).length === 1 ? '' : 's'}</div>
      </div>
      <div class="item-actions">
        <button class="icon-btn" data-open-template="${t.id}" title="Open" aria-label="Open">${ICON_EDIT}</button>
        <button class="icon-btn" data-copy-template="${t.id}" title="Copy" aria-label="Copy">${ICON_COPY}</button>
        <button class="icon-btn icon-btn-danger" data-delete-template="${t.id}" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
      </div>
    </div>
  `).join('');
}

document.getElementById('templatesList').addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy-template]');
  if (copyBtn) { openNewTemplateModal(copyBtn.getAttribute('data-copy-template')); return; }

  const deleteBtn = e.target.closest('[data-delete-template]');
  if (deleteBtn) {
    const id = deleteBtn.getAttribute('data-delete-template');
    const t = allTemplates.find(x => x.id === id);
    if (!t) return;
    if (!confirm(`Delete task template "${t.name}"? Shows already generated from it keep their tasks — this only removes it from the picker.`)) return;
    try {
      await db.collection('showplanner_templates').doc(id).delete();
      showToast('Template deleted', 'success');
      await loadTemplates();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }
  const openTarget = e.target.closest('[data-open-template]');
  if (openTarget) openTemplate(openTarget.getAttribute('data-open-template'));
});

let copyTemplateSourceId = null; // set only when the modal was opened via the Copy button
function openNewTemplateModal(copySourceId) {
  copyTemplateSourceId = copySourceId || null;
  const source = copySourceId ? allTemplates.find(t => t.id === copySourceId) : null;
  document.getElementById('newTemplateName').value = source ? `${source.name} (copy)` : '';
  document.getElementById('newTemplateError').textContent = '';
  document.getElementById('newTemplateModal').style.display = 'flex';
}
document.getElementById('newTemplateBtn').addEventListener('click', () => openNewTemplateModal());
document.getElementById('newTemplateCloseBtn').addEventListener('click', () => { document.getElementById('newTemplateModal').style.display = 'none'; });
document.getElementById('newTemplateModal').addEventListener('click', (e) => { if (e.target.id === 'newTemplateModal') e.target.style.display = 'none'; });
document.getElementById('newTemplateCreateBtn').addEventListener('click', async () => {
  const name = document.getElementById('newTemplateName').value.trim();
  const errEl = document.getElementById('newTemplateError');
  if (!name) { errEl.textContent = 'Enter a template name.'; return; }
  const source = copyTemplateSourceId ? allTemplates.find(t => t.id === copyTemplateSourceId) : null;
  try {
    const ref = await db.collection('showplanner_templates').add({
      name,
      roles: source ? JSON.parse(JSON.stringify(source.roles || [])) : [],
      tasks: source ? JSON.parse(JSON.stringify(normalizeTemplateTasks(source.tasks || []))) : [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('newTemplateModal').style.display = 'none';
    await loadTemplates();
    openTemplate(ref.id);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('backToTemplatesBtn').addEventListener('click', () => { currentTemplateId = null; currentTemplate = null; switchTab('templates'); loadTemplates(); });

async function openTemplate(id) {
  const doc = await db.collection('showplanner_templates').doc(id).get();
  if (!doc.exists) { showToast('Template not found', 'error'); return; }
  currentTemplateId = id;
  currentTemplate = { roles: [], tasks: [], ...doc.data(), id: doc.id };
  currentTemplate.tasks = normalizeTemplateTasks(currentTemplate.tasks);
  collapsedTemplateChildren = new Set();
  renderTemplateEditor();
  switchTab('templateEditor');
}

function renderTemplateEditor() {
  document.getElementById('templateEditorTitle').textContent = currentTemplate.name || 'Task template';
  document.getElementById('templateNameInput').value = currentTemplate.name || '';
  renderTemplateRolesTable();
  renderTemplateTasksTable();
}
document.getElementById('templateNameInput').addEventListener('input', (e) => { currentTemplate.name = e.target.value; });

function renderTemplateRolesTable() {
  const tbody = document.getElementById('templateRolesTableBody');
  const roles = currentTemplate.roles;
  tbody.innerHTML = roles.length ? roles.map((r, i) => `
    <tr data-item-id="${r.id}">
      <td><span class="task-drag-handle group-drag-handle" title="Drag to move">⠿</span></td>
      <td><input type="text" class="form-control" value="${escapeHtml(r.name || '')}" placeholder="Role name" data-role-field="${i}"></td>
      <td><button class="grid-del-btn" data-role-remove="${i}" title="Remove">×</button></td>
    </tr>
  `).join('') : '<tr><td colspan="3" class="empty-state">No roles yet.</td></tr>';
  initGroupSortable('template-roles');
}
document.getElementById('addTemplateRoleBtn').addEventListener('click', () => {
  currentTemplate.roles.push({ id: uid(), name: '' });
  renderTemplateRolesTable();
  renderTemplateTasksTable();
});
document.getElementById('templateRolesTableBody').addEventListener('input', (e) => {
  const i = e.target.getAttribute('data-role-field');
  if (i === null) return;
  currentTemplate.roles[Number(i)].name = e.target.value;
});
// 'change' (fires on blur/commit, not per keystroke) is what refreshes the tasks table's role
// selects — re-rendering THIS table (roles) on every keystroke would drop focus mid-edit, same
// reasoning as the income/spend tables above; re-rendering the OTHER table (tasks) is safe.
document.getElementById('templateRolesTableBody').addEventListener('change', (e) => {
  if (e.target.getAttribute('data-role-field') === null) return;
  renderTemplateTasksTable();
});
document.getElementById('templateRolesTableBody').addEventListener('click', (e) => {
  const i = e.target.getAttribute('data-role-remove');
  if (i === null) return;
  const removed = currentTemplate.roles.splice(Number(i), 1)[0];
  currentTemplate.tasks.forEach(t => { if (t.roleId === removed.id) t.roleId = null; });
  renderTemplateRolesTable();
  renderTemplateTasksTable();
});

// A card per task rather than a table row — five columns' worth of fields (title, description,
// days-before, role, parent) has no good table layout on a phone; a card that lets the field
// grid below the title wrap onto as many rows as the screen needs does.
//
// Sub-tasks nest any number of levels deep — a sub-task can itself have sub-tasks. Every card
// (any depth) gets its own "+ Add sub-task" that appends a new task with parentIndex already set
// to it, so a whole checklist under one task is a few clicks with no dropdown fiddling. Cards
// render top-level-then-its-descendants (not raw array order) so a task's sub-tasks visually sit
// under it, but data-task-field="{i}:..." always uses the task's real position in
// currentTemplate.tasks — visual grouping never touches the underlying array or its indices.
// Sub-tasks nest any number of levels deep — a sub-task can itself have sub-tasks. Every task
// carries a stable id and a parentId (not an array index) specifically so drag-and-drop
// reorder/reparent (below) is a simple "update parentId + sibling order" instead of an
// array-index renumbering exercise. A template loaded from Firestore before this existed (plain
// array position + parentIndex) is migrated to this shape on open — normalizeTemplateTasks().
const templateTaskSortFn = (a, b) => (a.order ?? 0) - (b.order ?? 0);
function templateTopLevelSorted() { return currentTemplate.tasks.filter(t => !t.parentId).sort(templateTaskSortFn); }
function templateChildrenSorted(parentId) { return currentTemplate.tasks.filter(t => t.parentId === parentId).sort(templateTaskSortFn); }
// Every id reachable by following parentId down from this one — any depth. Excluded from its own
// "Sub-task of" choices and as a valid drag target, same reasoning as the real show's
// descendantTaskIds(): picking/dropping onto one of these would create a cycle.
function templateDescendantIds(taskId) {
  const out = new Set();
  (function walk(id) { templateChildrenSorted(id).forEach(c => { out.add(c.id); walk(c.id); }); })(taskId);
  return out;
}
// Parent hops up to a top-level task — indents a candidate's label in the flat "Sub-task of"
// <option> list so its place in the tree is legible there too. seen guards against looping
// forever if any already-saved data has a cycle in it.
function templateDepth(taskId) {
  let depth = 0, cur = currentTemplate.tasks.find(t => t.id === taskId), seen = new Set();
  while (cur?.parentId && !seen.has(cur.id)) { seen.add(cur.id); cur = currentTemplate.tasks.find(t => t.id === cur.parentId); depth++; }
  return depth;
}
// Migrates an old-shape (array-position identity + parentIndex) task list to the current one
// (stable id + parentId) — a template saved before drag-and-drop existed has no ids at all yet.
// Idempotent: a template already in the new shape passes through unchanged.
function normalizeTemplateTasks(tasks) {
  if (!tasks?.length) return [];
  if (tasks.every(t => t.id)) return tasks.map(t => ({ ...t, parentId: t.parentId ?? null }));
  const ids = tasks.map(() => uid());
  return tasks.map((t, i) => {
    const { parentIndex, ...rest } = t;
    return { ...rest, id: ids[i], parentId: (parentIndex ?? null) !== null ? ids[parentIndex] : null, order: t.order ?? i };
  });
}

let templateSortables = [];
function destroyTemplateSortables() { templateSortables.forEach(s => s.destroy()); templateSortables = []; }
const SORTABLE_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.2/Sortable.min.js';
// One Sortable instance per drop zone — the top-level list itself, plus every task's own
// .tpl-task-children container (rendered for every task, empty or not, so a childless task is
// still a valid place to drag a new first sub-task onto) — all sharing one group so dragging
// between any of them is exactly "reparent", and dragging within one is exactly "reorder".
async function initTemplateSortables() {
  try {
    await loadScript(SORTABLE_LIB_URL, 'Sortable');
  } catch (err) {
    console.warn('Sortable failed to load — drag reordering unavailable this session', err);
    return;
  }
  destroyTemplateSortables();
  const containers = [document.getElementById('templateTasksList'), ...document.querySelectorAll('.tpl-task-children')];
  containers.forEach(container => {
    templateSortables.push(Sortable.create(container, {
      group: 'template-tasks',
      handle: '.tpl-drag-handle',
      filter: '.task-quick-add',
      preventOnFilter: false,
      animation: 150,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fallbackOnBody: true,
      swapThreshold: 0.65,
      // A touch on the handle needs a genuine press-and-hold before the drag activates, so a
      // finger just tapping through or scrolling past the list doesn't accidentally grab a task
      // — mouse users still get an instant drag on mousedown, since click-and-drag is already the
      // natural desktop gesture and an artificial delay there would just feel laggy.
      delay: 250,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      ghostClass: 'tpl-drag-ghost',
      chosenClass: 'tpl-drag-chosen',
      dragClass: 'tpl-drag-active',
      onMove: (evt) => {
        const draggedId = evt.dragged.dataset.taskId;
        const targetParentId = evt.to.id === 'templateTasksList' ? null : evt.to.dataset.parentId;
        if (!draggedId || !targetParentId) return true; // dropping to top-level is always fine
        if (targetParentId === draggedId || templateDescendantIds(draggedId).has(targetParentId)) return false;
        return true;
      },
      onEnd: handleTemplateSortEnd,
    }));
  });
}
function handleTemplateSortEnd(evt) {
  const task = currentTemplate.tasks.find(t => t.id === evt.item.dataset.taskId);
  if (!task) return;
  task.parentId = evt.to.id === 'templateTasksList' ? null : (evt.to.dataset.parentId || null);
  const reindex = (container) => {
    Array.from(container.children).forEach((el, idx) => {
      const t = currentTemplate.tasks.find(t => t.id === el.dataset.taskId);
      if (t) t.order = idx;
    });
  };
  reindex(evt.to);
  if (evt.from !== evt.to) reindex(evt.from);
  renderTemplateTasksTable();
}
function renderTemplateTasksTable() {
  const el = document.getElementById('templateTasksList');
  const tasks = currentTemplate.tasks;
  if (!tasks.length) { el.innerHTML = '<p class="empty-state">No tasks yet.</p>'; destroyTemplateSortables(); return; }

  // Collapsed (the only state now — editing opens a modal instead of expanding inline): a drag
  // handle, a sub-task toggle (only if it has children — controls whether ITS sub-task cards are
  // shown at all, nothing to do with this task's own fields), the title, and a "…" that opens a
  // small menu (Edit/Add sub-task/Delete). Edit opens tplTaskEditModal with the description/
  // days-before/role/parent fields; Add sub-task and Delete live in the same menu, not their own
  // icons, so the row never grows past drag handle + toggle + title + one button. Every task,
  // freshly added or already saved, looks the same — its title is right there to type into
  // either way. Children render inside an ACTUAL nested container (not a flat sibling with a
  // visual indent) so Sortable's own nested-list dragging handles reparenting for free — the
  // container always exists, even with no children yet, so a childless task is still a place you
  // can drag a new sub-task onto.
  function cardHtml(taskId) {
    const t = tasks.find(x => x.id === taskId);
    const children = templateChildrenSorted(taskId);
    const hasChildren = children.length > 0;
    const childrenCollapsed = collapsedTemplateChildren.has(taskId);
    const subToggle = hasChildren
      ? `<button class="task-toggle-btn" data-task-toggle-children="${taskId}" title="${childrenCollapsed ? 'Show sub-tasks' : 'Hide sub-tasks'}">${childrenCollapsed ? '▸' : '▾'}</button>`
      : '<span class="task-toggle-spacer"></span>';
    return `
    <div class="tpl-task-card" data-task-id="${taskId}">
      <div class="tpl-task-card-top">
        <span class="tpl-drag-handle" title="Drag to move">⠿</span>
        ${subToggle}
        <input type="text" class="form-control" style="flex:1;min-width:0" value="${escapeHtml(t.title || '')}" placeholder="Task title" data-task-field="${taskId}:title">
        <button class="tpl-task-more-btn" data-task-open-detail="${taskId}" title="Task menu">…</button>
      </div>
      <div class="tpl-task-children" data-parent-id="${taskId}">${(!childrenCollapsed) ? children.map(c => cardHtml(c.id)).join('') : ''}</div>
    </div>`;
  }

  const reachable = new Set();
  templateTopLevelSorted().forEach(t => { reachable.add(t.id); templateDescendantIds(t.id).forEach(d => reachable.add(d)); });
  // Safety net: a task whose parentId points at a since-removed/invalid id still renders — as its
  // own top-level-styled subtree — rather than silently vanishing from the list.
  let html = templateTopLevelSorted().map(t => cardHtml(t.id)).join('');
  tasks.forEach(t => { if (!reachable.has(t.id)) html += cardHtml(t.id); });

  el.innerHTML = html;
  initTemplateSortables();
}
document.getElementById('addTemplateTaskBtn').addEventListener('click', () => openTplTaskNewModal(null));

// ── Paste tasks — one line of pasted/typed text per task, all added as new top-level tasks after
// whatever's already in the template (never touches existing tasks, never guesses at sub-tasks —
// a plain flat batch-add, same as typing each one into "+ Add task" in a row but without the
// per-task modal round-trip).
document.getElementById('pasteTemplateTasksBtn').addEventListener('click', () => {
  document.getElementById('pasteTasksTextarea').value = '';
  document.getElementById('pasteTasksModal').style.display = 'flex';
  document.getElementById('pasteTasksTextarea').focus();
});
document.getElementById('pasteTasksCloseBtn').addEventListener('click', () => { document.getElementById('pasteTasksModal').style.display = 'none'; });
document.getElementById('pasteTasksModal').addEventListener('click', (e) => { if (e.target.id === 'pasteTasksModal') e.target.style.display = 'none'; });
document.getElementById('pasteTasksConfirmBtn').addEventListener('click', () => {
  const lines = document.getElementById('pasteTasksTextarea').value.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { document.getElementById('pasteTasksModal').style.display = 'none'; return; }
  const start = templateTopLevelSorted().length;
  lines.forEach((title, i) => {
    currentTemplate.tasks.push({ id: uid(), title, description: '', daysBeforeShow: 0, roleId: null, parentId: null, order: start + i });
  });
  document.getElementById('pasteTasksModal').style.display = 'none';
  renderTemplateTasksTable();
  showToast(`${lines.length} task${lines.length === 1 ? '' : 's'} added`, 'success');
});
// Text/number fields mutate in place with no re-render (typing would lose focus otherwise —
// same pattern as handleLineAmountInput above); role/parent selects re-render afterwards since
// that's safe on a 'change' and keeps the parent-task dropdown's title labels current.
// Title is the only field left on the collapsed row itself (everything else moved into the Edit
// modal) — mutates in place with no re-render, same reasoning as every other live-bound field in
// this editor: re-rendering the input currently being typed into would drop focus mid-keystroke.
document.getElementById('templateTasksList').addEventListener('input', (e) => {
  const key = e.target.getAttribute('data-task-field');
  if (!key) return;
  const [taskId, field] = key.split(':');
  if (field !== 'title') return;
  const t = currentTemplate.tasks.find(t => t.id === taskId);
  if (t) t.title = e.target.value;
});
// Delete task is shared between the "…" menu below and nowhere else now — factored out so both
// call the exact same logic. Add sub-task just opens the new-task modal pre-set to this parent.
function addTemplateSubTask(parentId) {
  collapsedTemplateChildren.delete(parentId); // the parent's sub-tasks must be visible, or a newly-confirmed one would be invisible right after creating it
  openTplTaskNewModal(parentId);
}
function deleteTemplateTask(taskId) {
  const descendants = templateDescendantIds(taskId);
  if (descendants.size && !confirm(`Delete this task and its ${descendants.size} sub-task${descendants.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
  currentTemplate.tasks = currentTemplate.tasks.filter(t => t.id !== taskId && !descendants.has(t.id));
  [taskId, ...descendants].forEach(id => collapsedTemplateChildren.delete(id));
  renderTemplateTasksTable();
}

// One shared floating menu (#tplTaskMenu in index.html) repositioned to whichever card's "…" was
// clicked, rather than one menu per card. tplTaskMenuTargetId tracks which task it's currently
// open for. Built here (not as static HTML) since it needs the shared ICON_* constants.
document.getElementById('tplTaskMenu').innerHTML = `
  <div class="tpl-task-menu-header">
    <span>Task</span>
    <button type="button" class="tpl-task-menu-close" data-tpl-menu-close aria-label="Close menu">${ICON_CLOSE}</button>
  </div>
  <button type="button" data-tpl-menu-action="edit">${ICON_EDIT}<span>Edit</span></button>
  <button type="button" data-tpl-menu-action="add-sub">${ICON_PLUS}<span>Add sub-task</span></button>
  <button type="button" class="danger" data-tpl-menu-action="delete">${ICON_TRASH}<span>Delete task</span></button>
`;
let tplTaskMenuTargetId = null;
function openTplTaskMenu(anchorBtn, taskId) {
  tplTaskMenuTargetId = taskId;
  const menu = document.getElementById('tplTaskMenu');
  const rect = anchorBtn.getBoundingClientRect();
  menu.hidden = false;
  const menuWidth = menu.offsetWidth;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8))}px`;
}
function closeTplTaskMenu() {
  document.getElementById('tplTaskMenu').hidden = true;
  tplTaskMenuTargetId = null;
}
document.getElementById('tplTaskMenu').addEventListener('click', (e) => {
  if (e.target.closest('[data-tpl-menu-close]')) { closeTplTaskMenu(); return; }
  const action = e.target.closest('[data-tpl-menu-action]')?.getAttribute('data-tpl-menu-action');
  if (!action) return;
  const taskId = tplTaskMenuTargetId;
  closeTplTaskMenu();
  if (!taskId) return;
  if (action === 'edit') openTplTaskEditModal(taskId);
  else if (action === 'add-sub') addTemplateSubTask(taskId);
  else if (action === 'delete') deleteTemplateTask(taskId);
});
// Click anywhere outside the menu (and not on the "…" button that opens it — that has its own
// handler below) closes it.
document.addEventListener('click', (e) => {
  if (document.getElementById('tplTaskMenu').hidden) return;
  if (e.target.closest('#tplTaskMenu') || e.target.closest('[data-task-open-detail]')) return;
  closeTplTaskMenu();
});

// ── Edit task modal (reached via the "…" menu) ──────────────────────────────────────────────
// Fields live-bind straight into currentTemplate.tasks on input/change, same as every other
// field in this editor — there's no separate Save, just Close. The task list re-renders once,
// on close, so a title/role/parent change is reflected there without fighting focus mid-type.
function templateRoleOptionsHtml(roleId) {
  return `<option value=""${!roleId ? ' selected' : ''}>—</option>` +
    currentTemplate.roles.map(r => `<option value="${r.id}"${r.id === roleId ? ' selected' : ''}>${escapeHtml(r.name || '(unnamed role)')}</option>`).join('');
}
function templateParentOptionsHtml(excludeTaskId, parentId) {
  const excluded = excludeTaskId ? new Set([excludeTaskId, ...templateDescendantIds(excludeTaskId)]) : new Set();
  return `<option value=""${!parentId ? ' selected' : ''}>Top-level</option>` +
    currentTemplate.tasks.filter(t => !excluded.has(t.id))
      .map(t => `<option value="${t.id}"${parentId === t.id ? ' selected' : ''}>${'— '.repeat(templateDepth(t.id))}${escapeHtml(t.title || '(untitled)')}</option>`).join('');
}
let tplTaskEditTargetId = null; // set when editing a task already in currentTemplate.tasks
function tplTaskEditFocusTarget() {
  return currentTemplate.tasks.find(x => x.id === tplTaskEditTargetId);
}
function fillTplTaskEditFields(t, excludeTaskId) {
  document.getElementById('tplTaskEditTitle').value = t.title || '';
  document.getElementById('tplTaskEditDesc').value = t.description || '';
  document.getElementById('tplTaskEditDays').value = t.daysBeforeShow ?? 0;
  document.getElementById('tplTaskEditRole').innerHTML = templateRoleOptionsHtml(t.roleId);
  document.getElementById('tplTaskEditParent').innerHTML = templateParentOptionsHtml(excludeTaskId, t.parentId ?? null);
}
function openTplTaskEditModal(taskId) {
  const t = currentTemplate.tasks.find(x => x.id === taskId);
  if (!t) return;
  tplTaskEditTargetId = taskId;
  document.getElementById('tplTaskEditModalTitle').textContent = 'Edit task';
  fillTplTaskEditFields(t, taskId);
  document.getElementById('tplTaskEditModal').style.display = 'flex';
  document.getElementById('tplTaskEditTitle').focus();
}
// Adding a task/sub-task asks for just a name, inline where the task will land — same quick-add
// flow as a real show's plan. Enter confirms and opens a fresh blank input in the same spot to chain
// the next one; Escape or clicking away discards. Everything else is set later via "…" > Edit.
let tplQuickAddParentId = undefined; // undefined = closed; null = open at top level
function openTplTaskNewModal(parentId) {
  closeTplQuickAdd();
  tplQuickAddParentId = parentId || null;
  if (parentId) collapsedTemplateChildren.delete(parentId);
  renderTemplateTasksTable();
  const container = parentId ? document.querySelector(`.tpl-task-children[data-parent-id="${parentId}"]`) : document.getElementById('templateTasksList');
  if (!container) { tplQuickAddParentId = undefined; return; }
  const row = document.createElement('div');
  row.className = 'task-quick-add';
  row.innerHTML = '<input type="text" class="form-control" id="tplQuickAddInput" placeholder="Task name…">';
  container.appendChild(row);
  const input = row.querySelector('input');
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmTplQuickAdd(); }
    else if (e.key === 'Escape') closeTplQuickAdd();
  });
  input.addEventListener('blur', () => closeTplQuickAdd());
}
let tplQuickAddClosing = false; // removing the focused input fires blur synchronously — guard the reentrant call
function closeTplQuickAdd() {
  if (tplQuickAddClosing) return;
  tplQuickAddClosing = true;
  try { document.querySelector('.task-quick-add')?.remove(); } finally { tplQuickAddClosing = false; }
  tplQuickAddParentId = undefined;
}
function confirmTplQuickAdd() {
  const title = document.getElementById('tplQuickAddInput')?.value.trim();
  const parentId = tplQuickAddParentId;
  if (!title) { closeTplQuickAdd(); return; }
  tplQuickAddParentId = undefined; // the blur from re-rendering must not close the row we're about to open
  currentTemplate.tasks.push({ id: uid(), title, description: '', daysBeforeShow: 0, roleId: null, parentId: parentId || null,
    order: (parentId ? templateChildrenSorted(parentId) : templateTopLevelSorted()).length });
  openTplTaskNewModal(parentId);
}
document.getElementById('tplTaskEditCloseBtn').addEventListener('click', () => closeTplTaskEditModal());
document.getElementById('tplTaskEditModal').addEventListener('click', (e) => { if (e.target.id === 'tplTaskEditModal') closeTplTaskEditModal(); });
function closeTplTaskEditModal() {
  document.getElementById('tplTaskEditModal').style.display = 'none';
  tplTaskEditTargetId = null;
  renderTemplateTasksTable();
}
document.getElementById('tplTaskEditModal').addEventListener('input', (e) => {
  const t = tplTaskEditFocusTarget();
  if (!t) return;
  if (e.target.id === 'tplTaskEditTitle') t.title = e.target.value;
  else if (e.target.id === 'tplTaskEditDesc') t.description = e.target.value;
  else if (e.target.id === 'tplTaskEditDays') t.daysBeforeShow = Math.round(Number(e.target.value) || 0);
});
document.getElementById('tplTaskEditModal').addEventListener('change', (e) => {
  const t = tplTaskEditFocusTarget();
  if (!t) return;
  if (e.target.id === 'tplTaskEditRole') t.roleId = e.target.value || null;
  else if (e.target.id === 'tplTaskEditParent') {
    t.parentId = e.target.value || null;
    t.order = (t.parentId ? templateChildrenSorted(t.parentId) : templateTopLevelSorted()).length;
  }
});

document.getElementById('templateTasksList').addEventListener('click', (e) => {
  const toggleChildrenId = e.target.getAttribute('data-task-toggle-children');
  if (toggleChildrenId !== null) {
    if (collapsedTemplateChildren.has(toggleChildrenId)) collapsedTemplateChildren.delete(toggleChildrenId); else collapsedTemplateChildren.add(toggleChildrenId);
    renderTemplateTasksTable();
    return;
  }
  const openDetailBtn = e.target.closest('[data-task-open-detail]');
  if (openDetailBtn) openTplTaskMenu(openDetailBtn, openDetailBtn.getAttribute('data-task-open-detail'));
});

document.getElementById('saveTemplateBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('saveTemplateStatusText');
  if (!currentTemplate.name?.trim()) { showToast('Enter a template name', 'error'); return; }
  statusEl.textContent = 'Saving…';
  try {
    await db.collection('showplanner_templates').doc(currentTemplateId).set({
      name: currentTemplate.name.trim(),
      roles: currentTemplate.roles,
      tasks: currentTemplate.tasks,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    statusEl.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB');
    showToast('Saved', 'success');
    await loadTemplates();
  } catch (err) {
    statusEl.textContent = '';
    showToast(err.message, 'error');
  }
});

document.getElementById('deleteTemplateBtn').addEventListener('click', async () => {
  if (!confirm(`Delete task template "${currentTemplate.name}"? This cannot be undone.`)) return;
  try {
    await db.collection('showplanner_templates').doc(currentTemplateId).delete();
    showToast('Template deleted', 'success');
    currentTemplateId = null; currentTemplate = null;
    switchTab('templates');
    await loadTemplates();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Export to Excel ──────────────────────────────────────────────────────

// Loaded lazily on first actual export rather than a static <script> tag on every single page
// load — xlsx.full.min.js is a heavy library (over a second to fetch on a slow connection) for
// a feature most visits to this page never touch at all.
const XLSX_LIB_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

document.getElementById('exportExcelBtn').addEventListener('click', async () => {
  try {
    await loadScript(XLSX_LIB_URL, 'XLSX');
  } catch(e) {
    showToast(e.message, 'error');
    return;
  }
  const wb = XLSX.utils.book_new();

  const fp = currentShow.fixedParams;
  const paramsRows = [
    { Parameter: 'Show name', Value: currentShow.name },
    { Parameter: 'Seats per performance', Value: fp.seatsPerPerformance },
    { Parameter: 'Expected sales %', Value: fp.expectedSalesPct ?? 100 },
    { Parameter: 'Number of performances', Value: fp.performances.length },
    { Parameter: 'Number in cast', Value: fp.castSize },
    { Parameter: 'Rehearsal subs per cast member', Value: fp.rehearsalSubsPerCast },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(paramsRows), 'Show Details');

  const salesPct = (fp.expectedSalesPct ?? 100) / 100;
  const perfRows = fp.performances.map(p => ({
    Date: fmtPerfDate(p), Type: p.type || 'Evening', 'Ticket price': p.price ?? 0,
    Seats: fp.seatsPerPerformance, 'Expected sales %': fp.expectedSalesPct ?? 100,
    'Expected income': (p.price ?? 0) * (fp.seatsPerPerformance || 0) * salesPct,
  }));
  if (perfRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(perfRows), 'Performances');

  const income = resolvedIncome(currentShow).map(i => ({ Item: i.label, Amount: i.amount }));
  income.push({ Item: 'TOTAL INCOME', Amount: incomeTotal(currentShow) });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(income), 'Income');

  const spend = resolvedSpend(currentShow).map(i => ({ Item: i.label, Amount: i.amount }));
  spend.push({ Item: 'TOTAL SPEND', Amount: spendTotal(currentShow) });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(spend), 'Spend');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Income: incomeTotal(currentShow), Spend: spendTotal(currentShow), Forecast: forecast(currentShow) }]), 'Forecast');

  if (!currentShow.isTemplate && currentShow.roles.length) {
    const roleRows = currentShow.roles.map(r => ({
      Role: r.name || '(unnamed role)',
      Assigned: (currentShow.roleAssignments[r.id] || []).map(userName).join(', ') || '—',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(roleRows), 'Roles');
  }
  if (!currentShow.isTemplate && currentShow.cast.length) {
    const castRows = currentShow.cast.map(c => ({
      Part: c.name || '(unnamed part)',
      Assigned: (currentShow.castAssignments[c.id] || []).map(userName).join(', ') || '—',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(castRows), 'Cast');
  }
  if (!currentShow.isTemplate && currentShowTasks.length) {
    const taskRows = orderedTaskList().map(({ task: t, depth }) => ({
      Task: '— '.repeat(depth) + (t.title || '(untitled)'),
      Description: t.description || '',
      'Due date': t.dueDate ? fmtPerfDate({ date: t.dueDate }) : '',
      Status: STATUS_LABEL[computeTaskStatus(t)] || 'Not started',
      Role: roleName(t.roleId),
      Assigned: (t.assigneeIds || []).map(userName).join(', '),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(taskRows), 'Tasks');
  }

  XLSX.writeFile(wb, `${(currentShow.name || 'show').replace(/[^a-z0-9]+/gi, '-')}-plan.xlsx`);
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

// ── Sidebar collapse (same pattern as expenses/showdrinks admin) ───────────

document.getElementById('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = document.getElementById('mainMenuDropdown').classList.toggle('open');
  // See body.menu-open in style.css — a full-viewport tap target, so there's always somewhere
  // to tap to close this even when the menu itself runs taller than the screen on a phone.
  document.body.classList.toggle('menu-open', open);
});
document.addEventListener('click', () => {
  document.getElementById('mainMenuDropdown').classList.remove('open');
  document.body.classList.remove('menu-open');
});

const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
function applySidebarState(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
}
applySidebarState(localStorage.getItem('showplanner_sidebar_collapsed') === '1');
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarState(collapsed);
  localStorage.setItem('showplanner_sidebar_collapsed', collapsed ? '1' : '0');
});

// ── Auth ─────────────────────────────────────────────────────────────────

document.getElementById('togglePasswordBtn').addEventListener('click', (e) => {
  const input = document.getElementById('loginPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.style.opacity = input.type === 'text' ? '1' : '';
});
document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const errorEl = document.getElementById('loginError');
  errorEl.style.display = 'none';
  try {
    await firebase.auth().signInWithEmailAndPassword(email, password);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});
document.getElementById('forgotPasswordLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) { showToast('Enter your email above first', 'error'); return; }
  try {
    await firebase.auth().sendPasswordResetEmail(email);
    showToast('Password reset email sent', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});
document.getElementById('signOutBtn').addEventListener('click', () => firebase.auth().signOut());
document.getElementById('sidebarSignOutBtn').addEventListener('click', () => firebase.auth().signOut());
document.getElementById('changePasswordSignOutBtn').addEventListener('click', () => firebase.auth().signOut());

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('changePasswordError');
  errorEl.textContent = '';
  const password = document.getElementById('newPasswordInput').value.trim();
  const passwordConfirm = document.getElementById('newPasswordConfirmInput').value.trim();
  if (password !== passwordConfirm) { errorEl.textContent = 'Passwords do not match.'; return; }
  try {
    await firebase.auth().currentUser.updatePassword(password);
    await db.collection('users').doc(firebase.auth().currentUser.uid).update({ mustChangePassword: false });
  } catch (err) {
    errorEl.textContent = err.code === 'auth/requires-recent-login'
      ? 'Please sign out and sign in again, then retry.'
      : err.message;
  }
});

let dashboardInitialized = false;
let currentUserData = null; // the signed-in account's users/{uid} doc (name/email) — comment authorship

firebase.auth().onAuthStateChanged(async user => {
  if (user) {
    const allowed = await checkAccess(user.uid, 'showplanner').catch(() => null);
    if (!allowed) {
      await firebase.auth().signOut();
      document.getElementById('loginError').textContent = 'This account does not have ShowPlanner access — ask a manager to grant it from the showmanager portal.';
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('authGate').style.display = 'none';
      return;
    }
    currentUserData = allowed;
    mountSuiteNav(allowed, 'showplanner', '../');
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('changePasswordEmailText').textContent = user.email;

    if (allowed.mustChangePassword) {
      document.getElementById('adminApp').style.display = 'none';
      document.getElementById('changePasswordScreen').style.display = 'flex';
    } else {
      document.getElementById('changePasswordScreen').style.display = 'none';
      document.getElementById('adminApp').style.display = 'block';
      if (!dashboardInitialized) {
        dashboardInitialized = true;
        document.getElementById('headerVersion').textContent = typeof APP_VERSION !== 'undefined' ? `v${APP_VERSION}` : '';
        await ensureTemplateExists();
        await loadShowplannerUsers();
        await loadShowplannerMembers();
        await loadTemplates();
        await loadShows();
      }
    }
  } else {
    dashboardInitialized = false;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('changePasswordScreen').style.display = 'none';
    document.getElementById('adminApp').style.display = 'none';
    document.getElementById('changePasswordForm').reset();
    document.getElementById('authGate').style.display = 'none';
  }
});

// The template is basically a show in itself (per spec) — created automatically, once, the
// first time anyone opens ShowPlanner, so there's always something to start a new show from.
async function ensureTemplateExists() {
  const snap = await db.collection('showplanner_shows').where('isTemplate', '==', true).limit(1).get();
  if (!snap.empty) return;
  const data = defaultTemplateData();
  await db.collection('showplanner_shows').add({
    ...data,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Service worker update banner (same pattern as expenses/showdrinks) ─────

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(e => console.warn('SW failed', e));
  }
  checkForUpdate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}

async function checkForUpdate() {
  if (typeof APP_VERSION === 'undefined') return;
  try {
    const res = await fetch('../shared/version.js?_=' + Date.now(), { cache: 'no-store' });
    const latest = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
    if (latest && latest !== APP_VERSION) showUpdateBanner();
  } catch (err) { /* offline — nothing meaningful to report */ }
}

let updateBtnWired = false;
function showUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  banner.classList.add('visible');
  if (updateBtnWired) return;
  updateBtnWired = true;
  document.getElementById('updateBtn').addEventListener('click', async () => {
    banner.querySelector('span').textContent = 'Updating…';
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    } catch (err) { console.error(err); }
    window.location.href = window.location.pathname + '?v=' + Date.now();
  });
}

initServiceWorker();
document.getElementById('headerVersion').textContent = typeof APP_VERSION !== 'undefined' ? `v${APP_VERSION}` : '';
