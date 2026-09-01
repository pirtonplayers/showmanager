'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) { return Math.round(Number(n) || 0).toLocaleString('en-GB'); }
function uid() { return crypto.randomUUID(); }

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

async function loadShows() {
  const snap = await db.collection('budget_shows').get();
  allShows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.isTemplate ? 1 : 0) - (a.isTemplate ? 1 : 0) || (a.name || '').localeCompare(b.name || ''));
  renderShowsList();
}

function renderShowsList() {
  const el = document.getElementById('showsList');
  if (!allShows.length) {
    el.innerHTML = '<p class="empty-state">No shows yet — the template is created automatically the first time you open ShowBudget.</p>';
    return;
  }
  el.innerHTML = allShows.map(s => `
    <div class="item-row">
      <div class="item-name">${escapeHtml(s.name || '(untitled)')}${s.isTemplate ? ' <span class="badge badge-primary">Template</span>' : ''}</div>
      <div class="item-sub amount-cell">${s.isTemplate ? 'Used to start new shows' : `Forecast: ${money(forecast(withDefaults(s)))}`}</div>
      <div class="item-actions">
        <button class="btn btn-secondary btn-sm" data-open-show="${s.id}">Open</button>
        <button class="btn btn-secondary btn-sm" data-copy-show="${s.id}">Copy</button>
        <button class="btn btn-danger btn-sm" data-delete-show="${s.id}" ${s.isTemplate ? 'disabled title="Make another show the template first"' : ''}>Delete</button>
      </div>
    </div>
  `).join('');
}

document.getElementById('showsList').addEventListener('click', async (e) => {
  if (e.target.matches('[data-open-show]')) { openShow(e.target.getAttribute('data-open-show')); return; }
  if (e.target.matches('[data-copy-show]')) { openNewShowModal(e.target.getAttribute('data-copy-show')); return; }
  if (e.target.matches('[data-delete-show]')) {
    const id = e.target.getAttribute('data-delete-show');
    const show = allShows.find(s => s.id === id);
    if (!show || show.isTemplate) return;
    if (!confirm(`Delete "${show.name}"? This cannot be undone.`)) return;
    try {
      await db.collection('budget_shows').doc(id).delete();
      showToast('Show deleted', 'success');
      if (currentShowId === id) { currentShowId = null; currentShow = null; switchTab('shows'); }
      await loadShows();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
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
  const source = allShows.find(s => s.id === sourceId);
  if (!source) { errEl.textContent = 'Choose a show to start from.'; return; }

  const clone = withDefaults(source);
  const newDoc = {
    name,
    isTemplate: false,
    copiedFrom: sourceId,
    fixedParams: JSON.parse(JSON.stringify(clone.fixedParams)),
    income: JSON.parse(JSON.stringify(clone.income)),
    spend: JSON.parse(JSON.stringify(clone.spend)),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  try {
    const ref = await db.collection('budget_shows').add(newDoc);
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
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => { switchTab(btn.dataset.tab); document.getElementById('mainMenuDropdown').style.display = 'none'; });
});
document.getElementById('backToShowsBtn').addEventListener('click', () => { currentShowId = null; currentShow = null; switchTab('shows'); loadShows(); });

async function openShow(id) {
  const doc = await db.collection('budget_shows').doc(id).get();
  if (!doc.exists) { showToast('Show not found', 'error'); return; }
  currentShowId = id;
  currentShow = withDefaults({ id: doc.id, ...doc.data() });
  renderEditor();
  switchTab('editor');
}

function renderEditor() {
  document.getElementById('editorTitle').textContent = currentShow.name || 'Show budget';
  document.getElementById('headerTitle').textContent = currentShow.name || 'ShowBudget';
  document.getElementById('showNameInput').value = currentShow.name || '';
  document.getElementById('printShowName').textContent = currentShow.name || '';
  document.getElementById('printShowMeta').textContent = currentShow.isTemplate ? 'Template' : '';

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
}

// ── Performances ─────────────────────────────────────────────────────────
// Each performance is its own editable row: date and a ticket price that defaults to the show's
// default ticket price but can be overridden per row. Ticket sales income (one line per
// performance — see performanceIncomeLines) recomputes from whatever's here, live.

function refreshAfterPerfChange() {
  renderLinesTable('income', INCOME_FORMULAS);
  renderForecast();
}

function renderPerfTable() {
  const perfs = currentShow.fixedParams.performances;
  const tbody = document.getElementById('perfTableBody');
  tbody.innerHTML = perfs.length ? perfs.map((p, i) => `
    <tr>
      <td><input type="date" class="form-control" value="${p.date || ''}" data-perf-field="${i}:date"></td>
      <td><input type="number" class="form-control num-input" min="0" step="1" value="${p.price ?? currentShow.fixedParams.ticketPrice ?? 0}" data-perf-field="${i}:price"></td>
      <td class="no-print"><button class="grid-del-btn" data-perf-remove="${i}" title="Remove">×</button></td>
    </tr>
  `).join('') : '<tr><td colspan="3" class="empty-state">No performances yet — generate some above.</td></tr>';
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
    perfs.push({ date: iso, price: currentShow.fixedParams.ticketPrice || 0 });
  }
  currentShow.fixedParams.performances = perfs;
  renderPerfTable();
  refreshAfterPerfChange();
});

document.getElementById('addPerfBtn').addEventListener('click', () => {
  currentShow.fixedParams.performances.push({ date: '', price: currentShow.fixedParams.ticketPrice || 0 });
  renderPerfTable();
  refreshAfterPerfChange();
});

document.getElementById('perfTableBody').addEventListener('input', (e) => {
  const key = e.target.getAttribute('data-perf-field');
  if (!key) return;
  const [idx, field] = key.split(':');
  const p = currentShow.fixedParams.performances[Number(idx)];
  p[field] = field === 'price' ? (Math.round(Number(e.target.value) || 0)) : e.target.value;
  refreshAfterPerfChange();
});

document.getElementById('perfTableBody').addEventListener('click', (e) => {
  const i = e.target.getAttribute('data-perf-remove');
  if (i === null) return;
  currentShow.fixedParams.performances.splice(Number(i), 1);
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
        <td class="amount-cell"><input type="text" class="form-control num-input" value="${money(line.amount)}" disabled></td>
        <td class="no-print"></td>
      </tr>`).join('');
  }

  const items = currentShow[kind];
  rowsHtml += items.map((item, i) => {
    const isFormula = !!item.formula;
    const amount = resolveAmount(item, currentShow.fixedParams, currentShow.income, formulas);
    total += amount;
    // Bar costs/VH levy carry their own editable percentage inline in the label, instead of a
    // fixed 40%/10% baked into the formula.
    const pctInput = item.formula in DEFAULT_PCT
      ? ` (<input type="number" class="form-control pct-input" min="0" max="100" step="1" value="${itemPct(item)}" data-line-pct="${kind}:${i}">%)`
      : '';
    return `
      <tr>
        <td>${escapeHtml(item.label)}${pctInput}</td>
        <td class="amount-cell">${isFormula
          ? `<input type="text" class="form-control num-input" value="${money(amount)}" disabled>`
          : `<input type="number" class="form-control num-input" min="0" step="1" value="${amount}" data-line-amount="${kind}:${i}">`}</td>
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
  statusEl.textContent = 'Saving…';
  try {
    await db.collection('budget_shows').doc(currentShowId).set({
      name: currentShow.name.trim(),
      isTemplate: currentShow.isTemplate === true,
      copiedFrom: currentShow.copiedFrom || null,
      fixedParams: currentShow.fixedParams,
      income: currentShow.income,
      spend: currentShow.spend,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    statusEl.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB');
    showToast('Saved', 'success');
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
    allShows.forEach(s => batch.update(db.collection('budget_shows').doc(s.id), { isTemplate: s.id === currentShowId }));
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
    await db.collection('budget_shows').doc(currentShowId).delete();
    showToast('Show deleted', 'success');
    currentShowId = null; currentShow = null;
    switchTab('shows');
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Export to Excel ──────────────────────────────────────────────────────

document.getElementById('exportExcelBtn').addEventListener('click', () => {
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
    Date: p.date, 'Ticket price': p.price ?? fp.ticketPrice ?? 0,
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

  XLSX.writeFile(wb, `${(currentShow.name || 'show').replace(/[^a-z0-9]+/gi, '-')}-budget.xlsx`);
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

// ── Sidebar collapse (same pattern as expenses/showdrinks admin) ───────────

document.getElementById('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.getElementById('mainMenuDropdown');
  menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
});
document.addEventListener('click', () => { document.getElementById('mainMenuDropdown').style.display = 'none'; });

const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
function applySidebarState(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
}
applySidebarState(localStorage.getItem('budget_sidebar_collapsed') === '1');
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarState(collapsed);
  localStorage.setItem('budget_sidebar_collapsed', collapsed ? '1' : '0');
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

firebase.auth().onAuthStateChanged(async user => {
  if (user) {
    const allowed = await checkAccess(user.uid, 'budget').catch(() => null);
    if (!allowed) {
      await firebase.auth().signOut();
      document.getElementById('loginError').textContent = 'This account does not have ShowBudget access — ask a manager to grant it from the showmanager portal.';
      document.getElementById('loginError').style.display = 'block';
      return;
    }
    document.getElementById('loginScreen').style.display = 'none';
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
        await loadShows();
      }
    }
  } else {
    dashboardInitialized = false;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('changePasswordScreen').style.display = 'none';
    document.getElementById('adminApp').style.display = 'none';
    document.getElementById('changePasswordForm').reset();
  }
});

// The template is basically a show in itself (per spec) — created automatically, once, the
// first time anyone opens ShowBudget, so there's always something to start a new show from.
async function ensureTemplateExists() {
  const snap = await db.collection('budget_shows').where('isTemplate', '==', true).limit(1).get();
  if (!snap.empty) return;
  const data = defaultTemplateData();
  await db.collection('budget_shows').add({
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
    const res = await fetch('version.js?_=' + Date.now(), { cache: 'no-store' });
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
