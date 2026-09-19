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
  if (type !== 'error') setTimeout(() => el.remove(), 3500);
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
    amount: (p.price ?? fp.ticketPrice ?? 0) * (fp.seatsPerPerformance || 0) * pct,
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
    ticketPrice: 0, seatsPerPerformance: 0, expectedSalesPct: 100, castSize: 0,
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
let expandedTemplateTasks = new Set(); // local UI-only state — which task cards show full detail vs. just their name
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
    const subParts = [];
    if (s.director) subParts.push(`Dir: ${escapeHtml(s.director)}`);
    if (s.showType) subParts.push(escapeHtml(s.showType));
    return `
    <div class="item-row" data-open-show="${s.id}" style="cursor:pointer">
      <div class="item-name-col">
        <div class="item-name">${escapeHtml(s.name || '(untitled)')}${s.isTemplate ? ' <span class="badge badge-primary">Template</span>' : ''}</div>
        ${s.isTemplate ? '<div class="item-sub">Used to start new shows</div>' : (subParts.length ? `<div class="item-sub">${subParts.join(' · ')}</div>` : '')}
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
    director: show.director || '',
    producer: show.producer || '',
    showType: show.showType || '',
    roles: show.roles || [],
    roleAssignments: show.roleAssignments || {},
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
  sel.innerHTML = allShows.map(s => `<option value="${s.id}">${escapeHtml(s.name)}${s.isTemplate ? ' (template)' : ''}</option>`).join('');
  if (preselectSourceId) sel.value = preselectSourceId;
  document.getElementById('newShowName').value = '';
  document.getElementById('newShowDirector').value = '';
  document.getElementById('newShowProducer').value = '';
  document.getElementById('newShowType').value = '';
  document.getElementById('newShowError').textContent = '';
  document.getElementById('newShowModal').style.display = 'flex';
}
document.getElementById('newShowBtn').addEventListener('click', () => openNewShowModal());
document.getElementById('newShowCloseBtn').addEventListener('click', () => { document.getElementById('newShowModal').style.display = 'none'; });
document.getElementById('newShowModal').addEventListener('click', (e) => { if (e.target.id === 'newShowModal') e.target.style.display = 'none'; });

document.getElementById('newShowCreateBtn').addEventListener('click', async () => {
  const name = document.getElementById('newShowName').value.trim();
  const director = document.getElementById('newShowDirector').value.trim();
  const producer = document.getElementById('newShowProducer').value.trim();
  const showType = document.getElementById('newShowType').value.trim();
  const sourceId = document.getElementById('newShowSource').value;
  const errEl = document.getElementById('newShowError');
  if (!name) { errEl.textContent = 'Enter a show name.'; return; }
  const source = allShows.find(s => s.id === sourceId);
  if (!source) { errEl.textContent = 'Choose a show to start from.'; return; }

  const clone = withDefaults(source);
  const newDoc = {
    name,
    director, producer, showType,
    roles: [],
    planTemplateId: null,
    isTemplate: false,
    copiedFrom: sourceId,
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
}
document.querySelectorAll('.show-subtab-btn[data-subtab]').forEach(btn => {
  btn.addEventListener('click', () => switchShowSubtab(btn.dataset.subtab));
});

async function openShow(id) {
  const doc = await db.collection('showplanner_shows').doc(id).get();
  if (!doc.exists) { showToast('Show not found', 'error'); return; }
  currentShowId = id;
  currentShow = withDefaults({ id: doc.id, ...doc.data() });
  collapsedTaskIds = new Set();
  showEditorDirty = false;
  await loadCurrentShowTasks();
  renderEditor();
  switchTab('editor');
  switchShowSubtab('details');
}

async function loadCurrentShowTasks() {
  const snap = await db.collection('showplanner_shows').doc(currentShowId).collection('tasks').orderBy('order').get();
  currentShowTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderEditor() {
  document.getElementById('editorTitle').textContent = currentShow.name || 'Show budget';
  document.getElementById('headerTitle').textContent = 'Show Budget';
  document.getElementById('showNameInput').value = currentShow.name || '';
  document.getElementById('showDirectorInput').value = currentShow.director || '';
  document.getElementById('showProducerInput').value = currentShow.producer || '';
  document.getElementById('showTypeInput').value = currentShow.showType || '';
  document.getElementById('printShowName').textContent = currentShow.name || '';
  document.getElementById('printShowMeta').textContent = currentShow.isTemplate ? 'Template' :
    [currentShow.showType, currentShow.director && `Director: ${currentShow.director}`, currentShow.producer && `Producer: ${currentShow.producer}`]
      .filter(Boolean).join(' · ');

  const fp = currentShow.fixedParams;
  document.getElementById('fpTicketPrice').value = fp.ticketPrice || 0;
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
  renderTasksCard();
  renderPlanAccessCard();
  applyPlanCardVisibility();
}

document.getElementById('showDirectorInput').addEventListener('input', (e) => { currentShow.director = e.target.value; });
document.getElementById('showProducerInput').addEventListener('input', (e) => { currentShow.producer = e.target.value; });
document.getElementById('showTypeInput').addEventListener('input', (e) => { currentShow.showType = e.target.value; });

// ── Plan (task templates → real tasks) ──────────────────────────────────

function renderPlanCard() {
  const sel = document.getElementById('planTemplateSelect');
  sel.innerHTML = allTemplates.length
    ? allTemplates.map(t => `<option value="${t.id}"${t.id === currentShow.planTemplateId ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')
    : '<option value="">No task templates yet</option>';
  const canEdit = currentUserCanEditPlan();
  sel.disabled = !canEdit;
  document.getElementById('generatePlanBtn').disabled = !allTemplates.length || !canEdit;
  // Once a plan exists (any tasks at all — generated or hand-added), the "start from a template"
  // control has nothing left to do — Generate always means "replace everything", which isn't
  // what this row is for once there's already a real plan in progress.
  document.getElementById('planGenerateRow').style.display = (currentShowTasks.length || !canEdit) ? 'none' : '';

  const summaryEl = document.getElementById('planSummary');
  if (currentShow.isTemplate) {
    summaryEl.innerHTML = '<p class="muted">The budget template has no plan of its own.</p>';
    return;
  }
  if (!currentShowTasks.length) {
    summaryEl.innerHTML = '<p class="muted">No plan generated yet — pick a task template above and click Generate plan.</p>';
    return;
  }
  const done = currentShowTasks.filter(t => t.status === 'completed').length;
  const inProgress = currentShowTasks.filter(t => t.status === 'in_progress').length;
  const sourceTemplate = allTemplates.find(t => t.id === currentShow.planTemplateId);
  summaryEl.innerHTML = `
    <p style="margin-bottom:10px">
      <span class="badge badge-primary">${currentShowTasks.length} task${currentShowTasks.length === 1 ? '' : 's'}</span>
      <span class="badge badge-success">${done} completed</span>
      <span class="badge badge-warning">${inProgress} in progress</span>
      ${currentShow.roles.length ? `<span class="badge">${currentShow.roles.length} role${currentShow.roles.length === 1 ? '' : 's'}</span>` : ''}
    </p>
    ${sourceTemplate ? `<p class="muted" style="font-size:13px">Generated from "${escapeHtml(sourceTemplate.name)}".</p>` : ''}
  `;
}

function addDaysToIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d - days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function generatePlanFromTemplate(template, baseDate) {
  const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
  const batch = db.batch();

  currentShowTasks.forEach(t => batch.delete(tasksCol.doc(t.id)));

  const templateTasks = template.tasks || [];
  const newIds = templateTasks.map(() => tasksCol.doc().id);
  templateTasks.forEach((tt, i) => {
    const parentId = (tt.parentIndex ?? null) !== null ? newIds[tt.parentIndex] : null;
    batch.set(tasksCol.doc(newIds[i]), {
      title: tt.title || '(untitled task)',
      description: tt.description || '',
      dueMode: 'daysBeforeShow',
      daysBeforeShow: Number(tt.daysBeforeShow) || 0,
      dueDate: addDaysToIso(baseDate, Number(tt.daysBeforeShow) || 0),
      roleId: tt.roleId || null,
      assigneeIds: [],
      status: 'not_started',
      parentTaskId: parentId,
      order: i,
      comments: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  });

  batch.set(db.collection('showplanner_shows').doc(currentShowId), {
    roles: JSON.parse(JSON.stringify(template.roles || [])),
    roleAssignments: {},
    planTemplateId: template.id,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();
  currentShow.roles = JSON.parse(JSON.stringify(template.roles || []));
  currentShow.roleAssignments = {};
  currentShow.planTemplateId = template.id;
  collapsedTaskIds = new Set(); // every task just got a fresh id — nothing left for old ids to refer to
  await loadCurrentShowTasks();
  renderPlanCard();
  renderRolesCard();
  renderTasksCard();
}

document.getElementById('generatePlanBtn').addEventListener('click', async () => {
  const templateId = document.getElementById('planTemplateSelect').value;
  const template = allTemplates.find(t => t.id === templateId);
  if (!template) { showToast('Choose a task template', 'error'); return; }

  const perfDates = (currentShow.fixedParams.performances || []).map(p => p.date).filter(Boolean).sort();
  if (!perfDates.length) { showToast('Add at least one performance date first', 'error'); return; }
  const baseDate = perfDates[0];

  if (currentShowTasks.length && !confirm(`This will replace the ${currentShowTasks.length} existing task(s) with a fresh plan from "${template.name}". Continue?`)) return;

  try {
    await generatePlanFromTemplate(template, baseDate);
    showToast('Plan generated', 'success');
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
  return allShowplannerUsers.find(u => u.id === idVal)?.name
    || allMembers.find(m => m.id === idVal)?.name
    || '(unknown)';
}
function roleName(roleId) { return currentShow.roles.find(r => r.id === roleId)?.name || ''; }

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

function renderRolesCard() {
  const canEdit = currentUserCanEditPlan();
  document.getElementById('addRoleBtn').style.display = canEdit ? '' : 'none';
  const tbody = document.getElementById('rolesTableBody');
  const roles = currentShow.roles;
  tbody.innerHTML = roles.length ? roles.map((r, i) => {
    const assignedIds = currentShow.roleAssignments[r.id] || [];
    const assignedNames = assignedIds.length ? assignedIds.map(userName).join(', ') : '—';
    const nameCell = canEdit
      ? `<input type="text" class="form-control" placeholder="Role name" value="${escapeHtml(r.name || '')}" data-role-name="${i}">`
      : escapeHtml(r.name || '(unnamed role)');
    return `
      <tr>
        <td>${nameCell}</td>
        <td class="role-assignees">${escapeHtml(assignedNames)}</td>
        <td>${canEdit ? `<button class="btn btn-secondary btn-sm" data-assign-role="${r.id}">Assign</button>` : ''}</td>
        <td>${canEdit ? `<button class="grid-del-btn" data-role-delete="${i}" title="Remove">×</button>` : ''}</td>
      </tr>`;
  }).join('') : `<tr><td colspan="4" class="empty-state">No roles yet${canEdit ? ' — add one, or generate a plan from a task template above.' : '.'}</td></tr>`;
}
document.getElementById('addRoleBtn').addEventListener('click', () => {
  currentShow.roles.push({ id: uid(), name: '' });
  markDirty();
  renderRolesCard();
});
document.getElementById('rolesTableBody').addEventListener('input', (e) => {
  const i = e.target.getAttribute('data-role-name');
  if (i === null) return;
  currentShow.roles[Number(i)].name = e.target.value;
});
document.getElementById('rolesTableBody').addEventListener('click', (e) => {
  const delIdx = e.target.getAttribute('data-role-delete');
  if (delIdx !== null) {
    const removed = currentShow.roles.splice(Number(delIdx), 1)[0];
    delete currentShow.roleAssignments[removed.id];
    markDirty();
    renderRolesCard();
    renderTasksCard();
    return;
  }
  const assignRoleId = e.target.getAttribute('data-assign-role');
  if (assignRoleId) openAssignRoleModal(assignRoleId);
});

let assigningRoleId = null;
function openAssignRoleModal(roleId) {
  assigningRoleId = roleId;
  const role = currentShow.roles.find(r => r.id === roleId);
  document.getElementById('assignRoleModalTitle').textContent = `Assign: ${role?.name || 'role'}`;
  const assigned = new Set(currentShow.roleAssignments[roleId] || []);
  const people = assignablePeople();
  document.getElementById('assignRoleEmptyNote').style.display = people.length ? 'none' : '';
  document.getElementById('assignRoleChecklist').innerHTML = people.map(u => `
    <div class="checklist-row">
      <input type="checkbox" id="assignUser-${u.id}" value="${u.id}" ${assigned.has(u.id) ? 'checked' : ''}>
      <label for="assignUser-${u.id}">${escapeHtml(u.name)}</label>
    </div>
  `).join('');
  document.getElementById('assignRoleModal').style.display = 'flex';
}
document.getElementById('assignRoleCloseBtn').addEventListener('click', () => { document.getElementById('assignRoleModal').style.display = 'none'; });
document.getElementById('assignRoleModal').addEventListener('click', (e) => { if (e.target.id === 'assignRoleModal') e.target.style.display = 'none'; });
document.getElementById('assignRoleSaveBtn').addEventListener('click', () => {
  const checked = Array.from(document.querySelectorAll('#assignRoleChecklist input:checked')).map(cb => cb.value);
  currentShow.roleAssignments[assigningRoleId] = checked;
  document.getElementById('assignRoleModal').style.display = 'none';
  renderRolesCard();
  showToast('Assignment updated — click Save changes below to store it', 'success');
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
  document.getElementById('tasksCard').style.display = isTemplateShow ? 'none' : '';
  document.getElementById('planAccessCard').style.display = (isTemplateShow || !canEdit) ? 'none' : '';

  // The budget template has nothing to show on the Plan/Roles sub-tabs (see above) — hide those
  // tab buttons outright rather than leave a click landing on an empty panel, and bounce off them
  // if that's somehow the panel showing already (e.g. this show WAS a regular show a moment ago).
  ['plan', 'roles'].forEach(id => {
    const btn = document.querySelector(`.show-subtab-btn[data-subtab="${id}"]`);
    btn.style.display = isTemplateShow ? 'none' : '';
  });
  if (isTemplateShow && document.getElementById('showsubtab-plan').classList.contains('active')) switchShowSubtab('details');
  if (isTemplateShow && document.getElementById('showsubtab-roles').classList.contains('active')) switchShowSubtab('details');
}

// ── Tasks ─────────────────────────────────────────────────────────────────
// Manual task CRUD, on top of whatever generatePlanFromTemplate() seeded — each write here goes
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
function isTaskOverdue(task, status) {
  if (!task.dueDate || status === 'completed') return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = task.dueDate.split('-').map(Number);
  return new Date(y, m - 1, d) < today;
}

const taskSortFn = (a, b) => (a.dueDate || '').localeCompare(b.dueDate || '') || (a.order ?? 0) - (b.order ?? 0);
function topLevelTasksSorted() { return currentShowTasks.filter(t => !t.parentTaskId).sort(taskSortFn); }
function childTasksSorted(parentId) { return currentShowTasks.filter(t => t.parentTaskId === parentId).sort(taskSortFn); }
// Every id reachable by following parentTaskId down from this task — any depth. Used to keep a
// task from being made a sub-task of its own descendant (which would create a cycle).
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
// descendants, any depth, each due-date sorted within its own parent) — every task included
// regardless of on-screen collapse state, since this is also the one source of truth the Excel
// export (exportExcelBtn) reads — an export can't have "collapsed" rows.
function orderedTaskList() {
  const out = [];
  function walk(task, depth) {
    out.push({ task, depth });
    childTasksSorted(task.id).forEach(sub => walk(sub, depth + 1));
  }
  topLevelTasksSorted().forEach(t => walk(t, 0));
  return out;
}

function taskRowHtml(t, depth) {
  const children = childTasksSorted(t.id);
  const hasChildren = children.length > 0;
  const status = computeTaskStatus(t);
  const overdue = isTaskOverdue(t, status);
  const assigneeNames = (t.assigneeIds || []).map(userName);
  const rName = roleName(t.roleId);
  const metaParts = [];
  if (rName) metaParts.push(rName);
  if (assigneeNames.length) metaParts.push(assigneeNames.join(', '));
  const toggleHtml = hasChildren
    ? `<button class="task-toggle-btn" data-toggle-task="${t.id}" title="${collapsedTaskIds.has(t.id) ? 'Expand sub-tasks' : 'Collapse sub-tasks'}">${collapsedTaskIds.has(t.id) ? '▸' : '▾'}</button>`
    : '<span class="task-toggle-spacer"></span>';
  const subcount = hasChildren
    ? `<span class="task-subcount"> (${children.filter(c => computeTaskStatus(c) === 'completed').length}/${children.length} sub-tasks)</span>` : '';
  return `
    <div class="task-row${depth > 0 ? ' subtask' : ''}${overdue ? ' overdue' : ''}" style="${depth > 0 ? `--depth:${depth}` : ''}" data-open-task="${t.id}">
      ${toggleHtml}
      <span class="badge ${STATUS_BADGE[status] || 'badge-danger'}">${STATUS_LABEL[status] || 'Not started'}</span>
      <span class="task-title">${escapeHtml(t.title || '(untitled)')}${t.description ? `<span class="task-desc">${escapeHtml(t.description)}</span>` : ''}${subcount}</span>
      <span class="task-secondary">
        ${metaParts.length ? `<span class="task-meta">${escapeHtml(metaParts.join(' · '))}</span>` : ''}
        <span class="task-due">${t.dueDate ? fmtPerfDate({ date: t.dueDate }) : 'No due date'}${overdue ? ' · Overdue' : ''}</span>
      </span>
    </div>`;
}
// A task plus its own (collapsible) descendants, any depth — the toggle just shows/hides
// whatever's under this one task, nothing more global than that; collapsing a task hides its
// whole subtree regardless of how many further levels it has.
function taskBranchHtml(t, depth) {
  const collapsed = collapsedTaskIds.has(t.id);
  let html = taskRowHtml(t, depth);
  if (!collapsed) childTasksSorted(t.id).forEach(sub => { html += taskBranchHtml(sub, depth + 1); });
  return html;
}

function renderTasksCard() {
  const canEdit = currentUserCanEditPlan();
  document.getElementById('addTaskBtn').style.display = canEdit ? '' : 'none';
  const el = document.getElementById('tasksList');
  if (!currentShowTasks.length) {
    el.innerHTML = `<p class="empty-state">No tasks yet${canEdit ? ' — generate a plan from a task template above, or add one manually.' : '.'}</p>`;
    return;
  }
  el.innerHTML = topLevelTasksSorted().map(t => taskBranchHtml(t, 0)).join('');
}
document.getElementById('tasksList').addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-toggle-task]');
  if (toggleBtn) {
    const id = toggleBtn.getAttribute('data-toggle-task');
    if (collapsedTaskIds.has(id)) collapsedTaskIds.delete(id); else collapsedTaskIds.add(id);
    renderTasksCard();
    return;
  }
  const target = e.target.closest('[data-open-task]');
  if (target) openTaskModal(target.getAttribute('data-open-task'));
});
document.getElementById('addTaskBtn').addEventListener('click', () => openTaskModal(null));

let editingTaskId = null;   // null while creating a new task
let editingTaskDraft = null; // working copy of the task while the modal is open
let taskEditMode = 'full';   // 'full' | 'assignee' (status/comments only) | 'readonly'

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

  document.getElementById('taskModalTitle').textContent = existing ? 'Edit task' : 'New task';
  document.getElementById('taskTitleInput').value = editingTaskDraft.title || '';
  document.getElementById('taskDescInput').value = editingTaskDraft.description || '';
  document.getElementById('taskDueDateInput').value = editingTaskDraft.dueDate || '';
  document.getElementById('taskStatusSelect').value = hasChildren ? computeTaskStatus(existing) : (editingTaskDraft.status || 'not_started');
  const autoNoteEl = document.getElementById('taskStatusAutoNote');
  autoNoteEl.style.display = hasChildren ? '' : 'none';
  autoNoteEl.textContent = hasChildren
    ? `Automatic — based on its ${children.length} sub-task${children.length === 1 ? '' : 's'} (completed once every one of them is).`
    : '';

  document.getElementById('taskRoleSelect').innerHTML = '<option value="">—</option>' +
    currentShow.roles.map(r => `<option value="${r.id}"${r.id === editingTaskDraft.roleId ? ' selected' : ''}>${escapeHtml(r.name || '(unnamed role)')}</option>`).join('');

  // Any other task can be the parent, any depth — only itself and its own descendants are
  // excluded (picking one of those would create a cycle). Indented per its own depth so the
  // flat <option> list still shows roughly where each candidate sits in the tree.
  const excludedParents = taskId ? new Set([taskId, ...descendantTaskIds(taskId)]) : new Set();
  document.getElementById('taskParentSelect').innerHTML = '<option value="">Top-level</option>' +
    currentShowTasks.filter(t => !excludedParents.has(t.id))
      .map(t => `<option value="${t.id}"${t.id === editingTaskDraft.parentTaskId ? ' selected' : ''}>${'— '.repeat(taskDepth(t.id))}${escapeHtml(t.title || '(untitled)')}</option>`).join('');

  const assignedSet = new Set(editingTaskDraft.assigneeIds || []);
  const assigneeOptions = assignablePeople();
  document.getElementById('taskAssigneeChecklist').innerHTML = assigneeOptions.length
    ? assigneeOptions.map(u => `
      <div class="checklist-row">
        <input type="checkbox" id="taskAssignee-${u.id}" value="${u.id}" ${assignedSet.has(u.id) ? 'checked' : ''}>
        <label for="taskAssignee-${u.id}">${escapeHtml(u.name)}</label>
      </div>`).join('')
    : '<p class="muted" style="padding:6px">No one in the members list yet.</p>';

  ['taskTitleInput', 'taskDescInput', 'taskDueDateInput', 'taskRoleSelect', 'taskParentSelect'].forEach(id => {
    document.getElementById(id).disabled = taskEditMode !== 'full';
  });
  document.querySelectorAll('#taskAssigneeChecklist input').forEach(cb => { cb.disabled = taskEditMode !== 'full'; });
  document.getElementById('taskStatusSelect').disabled = taskEditMode === 'readonly' || hasChildren;
  document.getElementById('taskCommentInput').disabled = taskEditMode === 'readonly';
  document.getElementById('taskCommentAddBtn').style.display = taskEditMode === 'readonly' ? 'none' : '';
  document.getElementById('taskSaveBtn').style.display = taskEditMode === 'readonly' ? 'none' : '';

  renderTaskComments();
  document.getElementById('taskCommentInput').value = '';
  document.getElementById('taskDeleteBtn').style.display = (existing && taskEditMode === 'full') ? '' : 'none';
  document.getElementById('taskSaveStatusText').textContent = '';
  document.getElementById('taskModal').style.display = 'flex';
}
document.getElementById('taskModalCloseBtn').addEventListener('click', () => { document.getElementById('taskModal').style.display = 'none'; });
document.getElementById('taskModal').addEventListener('click', (e) => { if (e.target.id === 'taskModal') e.target.style.display = 'none'; });

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
});

function readTaskFormIntoDraft() {
  editingTaskDraft.title = document.getElementById('taskTitleInput').value.trim();
  editingTaskDraft.description = document.getElementById('taskDescInput').value.trim();
  const newDueDate = document.getElementById('taskDueDateInput').value;
  // A manual date edit always fixes a concrete date from here on — daysBeforeShow only describes
  // how a template-generated task originally got its date, not something a hand edit preserves.
  if (newDueDate !== editingTaskDraft.dueDate) { editingTaskDraft.dueMode = 'date'; editingTaskDraft.daysBeforeShow = null; }
  editingTaskDraft.dueDate = newDueDate;
  editingTaskDraft.status = document.getElementById('taskStatusSelect').value;
  editingTaskDraft.roleId = document.getElementById('taskRoleSelect').value || null;
  editingTaskDraft.parentTaskId = document.getElementById('taskParentSelect').value || null;
  editingTaskDraft.assigneeIds = Array.from(document.querySelectorAll('#taskAssigneeChecklist input:checked')).map(cb => cb.value);
}

document.getElementById('taskSaveBtn').addEventListener('click', async () => {
  readTaskFormIntoDraft();
  if (!editingTaskDraft.title) { showToast('Enter a task title', 'error'); return; }
  const statusEl = document.getElementById('taskSaveStatusText');
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
      await tasksCol.add(payload);
    }
    document.getElementById('taskModal').style.display = 'none';
    showToast('Task saved', 'success');
    await loadCurrentShowTasks();
    renderTasksCard();
    renderPlanCard();
  } catch (err) {
    statusEl.textContent = '';
    showToast(err.message, 'error');
  }
});

document.getElementById('taskDeleteBtn').addEventListener('click', async () => {
  if (!editingTaskId) return;
  if (!confirm('Delete this task? Any sub-tasks under it are also removed. This cannot be undone.')) return;
  try {
    const tasksCol = db.collection('showplanner_shows').doc(currentShowId).collection('tasks');
    const batch = db.batch();
    batch.delete(tasksCol.doc(editingTaskId));
    currentShowTasks.filter(t => t.parentTaskId === editingTaskId).forEach(t => batch.delete(tasksCol.doc(t.id)));
    await batch.commit();
    document.getElementById('taskModal').style.display = 'none';
    showToast('Task deleted', 'success');
    await loadCurrentShowTasks();
    renderTasksCard();
    renderPlanCard();
  } catch (err) {
    showToast(err.message, 'error');
  }
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
      <td><input type="number" class="form-control num-input" min="0" step="1" value="${p.price ?? currentShow.fixedParams.ticketPrice ?? 0}" data-perf-field="${i}:price"></td>
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
    perfs.push({ date: iso, type: 'Evening', price: currentShow.fixedParams.ticketPrice || 0 });
  }
  currentShow.fixedParams.performances = perfs;
  markDirty();
  renderPerfTable();
  refreshAfterPerfChange();
});

document.getElementById('addPerfBtn').addEventListener('click', () => {
  currentShow.fixedParams.performances.push({ date: '', type: 'Evening', price: currentShow.fixedParams.ticketPrice || 0 });
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

['fpTicketPrice', 'fpSeats', 'fpExpectedSalesPct', 'fpCastSize', 'fpRehearsalSubs'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const map = {
      fpTicketPrice: 'ticketPrice', fpSeats: 'seatsPerPerformance', fpExpectedSalesPct: 'expectedSalesPct',
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
      director: currentShow.director || '',
      producer: currentShow.producer || '',
      showType: currentShow.showType || '',
      roles: currentShow.roles || [],
      roleAssignments: currentShow.roleAssignments || {},
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
// Reusable checklists (showplanner_templates) that generatePlanFromTemplate() turns into real
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
        <button class="icon-btn icon-btn-danger" data-delete-template="${t.id}" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
      </div>
    </div>
  `).join('');
}

document.getElementById('templatesList').addEventListener('click', async (e) => {
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

document.getElementById('newTemplateBtn').addEventListener('click', () => {
  document.getElementById('newTemplateName').value = '';
  document.getElementById('newTemplateError').textContent = '';
  document.getElementById('newTemplateModal').style.display = 'flex';
});
document.getElementById('newTemplateCloseBtn').addEventListener('click', () => { document.getElementById('newTemplateModal').style.display = 'none'; });
document.getElementById('newTemplateModal').addEventListener('click', (e) => { if (e.target.id === 'newTemplateModal') e.target.style.display = 'none'; });
document.getElementById('newTemplateCreateBtn').addEventListener('click', async () => {
  const name = document.getElementById('newTemplateName').value.trim();
  const errEl = document.getElementById('newTemplateError');
  if (!name) { errEl.textContent = 'Enter a template name.'; return; }
  try {
    const ref = await db.collection('showplanner_templates').add({
      name, roles: [], tasks: [],
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
  expandedTemplateTasks = new Set();
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
    <tr>
      <td><input type="text" class="form-control" value="${escapeHtml(r.name || '')}" placeholder="Role name" data-role-field="${i}"></td>
      <td><button class="grid-del-btn" data-role-remove="${i}" title="Remove">×</button></td>
    </tr>
  `).join('') : '<tr><td colspan="2" class="empty-state">No roles yet.</td></tr>';
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
function templateTopLevelIndices() {
  return currentTemplate.tasks.map((t, i) => i).filter(i => currentTemplate.tasks[i].parentIndex == null);
}
function templateChildIndices(parentIdx) {
  return currentTemplate.tasks.map((t, i) => i).filter(i => currentTemplate.tasks[i].parentIndex === parentIdx);
}
// Every index reachable by following parentIndex down from this one — any depth. Excluded from
// its own "Sub-task of" choices, same reasoning as the real show's descendantTaskIds(): picking
// one of these as a parent would create a cycle.
function templateDescendantIndices(idx) {
  const out = new Set();
  (function walk(i) { templateChildIndices(i).forEach(ci => { out.add(ci); walk(ci); }); })(idx);
  return out;
}
// Parent hops up to a top-level task — indents a candidate's label in the flat "Sub-task of"
// <option> list so its place in the tree is legible there too. seen guards against looping
// forever if any already-saved data has a cycle in it.
function templateDepth(idx) {
  let depth = 0, cur = idx, seen = new Set();
  while (currentTemplate.tasks[cur]?.parentIndex != null && !seen.has(cur)) {
    seen.add(cur);
    cur = currentTemplate.tasks[cur].parentIndex;
    depth++;
  }
  return depth;
}
function renderTemplateTasksTable() {
  const el = document.getElementById('templateTasksList');
  const tasks = currentTemplate.tasks;
  if (!tasks.length) { el.innerHTML = '<p class="empty-state">No tasks yet.</p>'; return; }

  const roleOptions = (roleId) => `<option value=""${!roleId ? ' selected' : ''}>—</option>` +
    currentTemplate.roles.map(r => `<option value="${r.id}"${r.id === roleId ? ' selected' : ''}>${escapeHtml(r.name || '(unnamed role)')}</option>`).join('');
  const parentOptions = (i, parentIndex) => {
    const excluded = new Set([i, ...templateDescendantIndices(i)]);
    return `<option value=""${parentIndex === null || parentIndex === undefined ? ' selected' : ''}>Top-level</option>` +
      tasks.map((t, pi) => pi).filter(pi => !excluded.has(pi))
        .map(pi => `<option value="${pi}"${parentIndex === pi ? ' selected' : ''}>${'— '.repeat(templateDepth(pi))}${escapeHtml(tasks[pi].title || `Task ${pi + 1}`)}</option>`).join('');
  };

  // Collapsed (the default): just a toggle, the title, and delete — everything else lives behind
  // "expand" so a long checklist reads as a plain list of names instead of a wall of fields.
  // A freshly-added task (below) starts expanded, since its whole point is to be filled in right
  // away; anything already saved defaults to collapsed.
  function cardHtml(i, depth) {
    const t = tasks[i];
    const expanded = expandedTemplateTasks.has(i);
    return `
    <div class="tpl-task-card${depth > 0 ? ' subtask' : ''}" style="${depth > 0 ? `--depth:${depth}` : ''}">
      <div class="tpl-task-card-top">
        <button class="task-toggle-btn" data-task-toggle-detail="${i}" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '▾' : '▸'}</button>
        <input type="text" class="form-control" style="flex:1;min-width:0" value="${escapeHtml(t.title || '')}" placeholder="Task title" data-task-field="${i}:title">
        <button class="grid-del-btn" data-task-remove="${i}" title="Remove">×</button>
      </div>
      ${expanded ? `
      <div class="tpl-task-card-details">
        <input type="text" class="form-control" style="margin-bottom:8px" value="${escapeHtml(t.description || '')}" placeholder="Description (optional)" data-task-field="${i}:description">
        <div class="tpl-task-card-fields">
          <div class="form-group">
            <label>Days before show</label>
            <input type="number" class="form-control num-input" value="${t.daysBeforeShow ?? 0}" data-task-field="${i}:daysBeforeShow">
          </div>
          <div class="form-group">
            <label>Role</label>
            <select class="form-control" data-task-field="${i}:roleId">${roleOptions(t.roleId)}</select>
          </div>
          <div class="form-group">
            <label>Sub-task of</label>
            <select class="form-control" data-task-field="${i}:parentIndex">${parentOptions(i, t.parentIndex ?? null)}</select>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:10px" data-task-add-sub="${i}">+ Add sub-task</button>
      </div>` : ''}
    </div>`;
  }

  const rendered = new Set();
  let html = '';
  function walk(i, depth) {
    html += cardHtml(i, depth);
    rendered.add(i);
    templateChildIndices(i).forEach(ci => walk(ci, depth + 1));
  }
  templateTopLevelIndices().forEach(i => walk(i, 0));
  // Safety net: a task whose parentIndex points at a since-removed/invalid index still renders —
  // as its own top-level-styled subtree — rather than silently vanishing from the list.
  tasks.forEach((t, i) => { if (!rendered.has(i)) walk(i, 0); });

  el.innerHTML = html;
}
document.getElementById('addTemplateTaskBtn').addEventListener('click', () => {
  currentTemplate.tasks.push({ title: '', description: '', daysBeforeShow: 0, roleId: null, parentIndex: null });
  expandedTemplateTasks.add(currentTemplate.tasks.length - 1); // start expanded — it's blank, the point is to fill it in
  renderTemplateTasksTable();
  document.querySelector(`[data-task-field="${currentTemplate.tasks.length - 1}:title"]`)?.focus();
});
// Text/number fields mutate in place with no re-render (typing would lose focus otherwise —
// same pattern as handleLineAmountInput above); role/parent selects re-render afterwards since
// that's safe on a 'change' and keeps the parent-task dropdown's title labels current.
document.getElementById('templateTasksList').addEventListener('input', (e) => {
  const key = e.target.getAttribute('data-task-field');
  if (!key) return;
  const [idx, field] = key.split(':');
  const t = currentTemplate.tasks[Number(idx)];
  if (field === 'daysBeforeShow') t.daysBeforeShow = Math.round(Number(e.target.value) || 0);
  else if (field === 'title') t.title = e.target.value;
  else if (field === 'description') t.description = e.target.value;
});
document.getElementById('templateTasksList').addEventListener('change', (e) => {
  const key = e.target.getAttribute('data-task-field');
  if (!key) return;
  const [idx, field] = key.split(':');
  const t = currentTemplate.tasks[Number(idx)];
  if (field === 'roleId') t.roleId = e.target.value || null;
  else if (field === 'parentIndex') t.parentIndex = e.target.value === '' ? null : Number(e.target.value);
  else return;
  renderTemplateTasksTable();
});
document.getElementById('templateTasksList').addEventListener('click', (e) => {
  const toggleIdx = e.target.getAttribute('data-task-toggle-detail');
  if (toggleIdx !== null) {
    const idx = Number(toggleIdx);
    if (expandedTemplateTasks.has(idx)) expandedTemplateTasks.delete(idx); else expandedTemplateTasks.add(idx);
    renderTemplateTasksTable();
    return;
  }
  const removeIdx = e.target.getAttribute('data-task-remove');
  if (removeIdx !== null) {
    const idx = Number(removeIdx);
    currentTemplate.tasks.splice(idx, 1);
    currentTemplate.tasks.forEach(t => {
      if (t.parentIndex === idx) t.parentIndex = null;
      else if (t.parentIndex != null && t.parentIndex > idx) t.parentIndex -= 1;
    });
    // expandedTemplateTasks holds indices too — shift them the same way parentIndex above just did.
    const shifted = new Set();
    expandedTemplateTasks.forEach(ei => { if (ei < idx) shifted.add(ei); else if (ei > idx) shifted.add(ei - 1); });
    expandedTemplateTasks = shifted;
    renderTemplateTasksTable();
    return;
  }
  const addSubIdx = e.target.getAttribute('data-task-add-sub');
  if (addSubIdx !== null) {
    // Always appended at the end, so no existing task's index (and so no other parentIndex
    // reference) ever shifts — same reasoning as the top-level +Add task button.
    currentTemplate.tasks.push({ title: '', description: '', daysBeforeShow: 0, roleId: null, parentIndex: Number(addSubIdx) });
    const newRow = currentTemplate.tasks.length - 1;
    expandedTemplateTasks.add(newRow); // start expanded — same reasoning as +Add task above
    renderTemplateTasksTable();
    // Jump straight into naming the new sub-task — this button exists specifically so a whole
    // checklist under one task is click, type, click, type, not click-then-hunt-for-the-input.
    document.querySelector(`[data-task-field="${newRow}:title"]`)?.focus();
  }
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
    { Parameter: 'Default ticket price', Value: fp.ticketPrice },
    { Parameter: 'Seats per performance', Value: fp.seatsPerPerformance },
    { Parameter: 'Expected sales %', Value: fp.expectedSalesPct ?? 100 },
    { Parameter: 'Number of performances', Value: fp.performances.length },
    { Parameter: 'Number in cast', Value: fp.castSize },
    { Parameter: 'Rehearsal subs per cast member', Value: fp.rehearsalSubsPerCast },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(paramsRows), 'Show Details');

  const salesPct = (fp.expectedSalesPct ?? 100) / 100;
  const perfRows = fp.performances.map(p => ({
    Date: fmtPerfDate(p), Type: p.type || 'Evening', 'Ticket price': p.price ?? fp.ticketPrice ?? 0,
    Seats: fp.seatsPerPerformance, 'Expected sales %': fp.expectedSalesPct ?? 100,
    'Expected income': (p.price ?? fp.ticketPrice ?? 0) * (fp.seatsPerPerformance || 0) * salesPct,
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
