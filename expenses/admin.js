const storage = firebase.storage();
// Cloud Functions are deployed to europe-west1 — the default region is us-central1, so this
// has to be requested explicitly or callable functions 404.
const functionsRegion = firebase.app().functions('europe-west1');

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared .icon-btn glyph (Feather-style, matching the outline icons used elsewhere in the
// suite) — used in place of a text label for the common Delete/Remove row actions. (Copy link's
// icon is inlined directly in admin.html's static markup, not rendered from here.)
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function money(n) {
  return `£${Number(n).toFixed(2)}`;
}

function formatDate(d) {
  return d.toLocaleDateString('en-GB'); // day/month/year, not the browser locale's default
}

// receiptPaths is the current (possibly-multiple) field; receiptPath is the older single-file
// one still sitting on any expense submitted before this became an array.
function receiptPathsOf(r) {
  return r.receiptPaths || (r.receiptPath ? [r.receiptPath] : []);
}

// A single receipt is a plain link; several become a dropdown instead of a row of "View N"
// links, which stops scaling once there's more than a couple.
function receiptLinksHtml(r) {
  const paths = receiptPathsOf(r);
  if (!paths.length) return '—';
  if (paths.length === 1) {
    return `<a href="#" class="receipt-link" data-view-receipt="${escapeHtml(paths[0])}">View</a>`;
  }
  const options = paths.map((p, i) => `<option value="${escapeHtml(p)}">Receipt ${i + 1}</option>`).join('');
  return `
    <select class="form-control" data-view-receipt-select style="width:auto;min-width:0;padding:4px 22px 4px 8px;font-size:13px">
      <option value="" selected>${paths.length} receipts…</option>
      ${options}
    </select>`;
}

async function viewReceipt(path) {
  try {
    const url = await storage.ref(path).getDownloadURL();
    window.open(url, '_blank');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = `toast-msg ${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => el.remove());
  el.append(text, closeBtn);
  toast.appendChild(el);
  // Errors stay up until dismissed by hand — plenty of time to read and copy the message,
  // instead of it vanishing after 3.5s.
  if (type !== 'error') setTimeout(() => el.remove(), 3500);
}

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
document.getElementById('changePasswordSignOutBtn').addEventListener('click', () => firebase.auth().signOut());

let userDocUnsub = null;
let dashboardInitialized = false;

firebase.auth().onAuthStateChanged(async user => {
  if (user) {
    // Shared login (shared/auth.js): isManager or access.expensesAdmin gets in.
    const allowed = await checkAccess(user.uid, 'expensesAdmin').catch(() => null);
    if (!allowed) {
      await firebase.auth().signOut();
      document.getElementById('loginError').textContent = 'This account does not have Expenses admin access — ask a manager to grant it from the showmanager portal.';
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('authGate').style.display = 'none';
      return;
    }
    mountSuiteNav(allowed, 'expensesAdmin', '../');
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('changePasswordEmailText').textContent = user.email;

    // Live listener, not a one-off get: flips straight to the dashboard the moment
    // mustChangePassword clears — including if it's cleared from the entry app instead of here,
    // since it's the same field on the same users/{uid} doc, not tracked separately per app.
    if (userDocUnsub) userDocUnsub();
    userDocUnsub = db.collection('users').doc(user.uid).onSnapshot(doc => {
      const data = doc.data();
      if (!data || data.mustChangePassword) {
        document.getElementById('adminApp').style.display = 'none';
        document.getElementById('changePasswordScreen').style.display = 'flex';
      } else {
        document.getElementById('changePasswordScreen').style.display = 'none';
        document.getElementById('adminApp').style.display = 'block';
        if (!dashboardInitialized) { dashboardInitialized = true; initDashboard(); }
      }
    }, err => {
      console.error(err);
      document.getElementById('adminApp').style.display = 'none';
      document.getElementById('changePasswordScreen').style.display = 'flex';
    });
  } else {
    if (userDocUnsub) { userDocUnsub(); userDocUnsub = null; }
    if (expensesUnsub) { expensesUnsub(); expensesUnsub = null; }
    dashboardInitialized = false;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('changePasswordScreen').style.display = 'none';
    document.getElementById('adminApp').style.display = 'none';
    document.getElementById('changePasswordForm').reset();
    document.getElementById('authGate').style.display = 'none';
  }
});

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('changePasswordError');
  errorEl.textContent = '';
  const password = document.getElementById('newPasswordInput').value.trim();
  const passwordConfirm = document.getElementById('newPasswordConfirmInput').value.trim();

  if (password !== passwordConfirm) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }

  try {
    await firebase.auth().currentUser.updatePassword(password);
    await db.collection('users').doc(firebase.auth().currentUser.uid).update({ mustChangePassword: false });
    // The live listener above picks this up and moves on to the dashboard by itself.
  } catch (err) {
    errorEl.textContent = err.code === 'auth/requires-recent-login'
      ? 'Please sign out and sign in again, then retry.'
      : err.message;
  }
});

// ── Menu / tabs ──────────────────────────────────────────────────────────

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

// The nav buttons exist twice — once in the mobile dropdown, once in the desktop sidebar —
// sharing the same data-tab values, so switching via either keeps both in sync. Pulled out into
// its own function so the show/user "View expenses" links (below) can jump to the Expenses tab
// the same way a nav click does, not just the nav buttons themselves.
function activateTab(tab) {
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById('mainMenuDropdown').classList.remove('open');
  if (tab === 'users') loadExpensesUsers();
}
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

document.getElementById('sidebarSignOutBtn').addEventListener('click', () => firebase.auth().signOut());

const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
function applySidebarState(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
}
applySidebarState(localStorage.getItem('expenses_sidebar_collapsed') === '1');
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarState(collapsed);
  localStorage.setItem('expenses_sidebar_collapsed', collapsed ? '1' : '0');
});

// ── State ────────────────────────────────────────────────────────────────

let shows = [];
let allExpenses = [];

async function initDashboard() {
  document.getElementById('headerVersion').textContent = typeof APP_VERSION !== 'undefined' ? `v${APP_VERSION}` : '';
  await loadShows();
  subscribeExpenses();
  await loadNotifySettings();
}

// ── Shows ────────────────────────────────────────────────────────────────

async function loadShows() {
  try {
    const snap = await db.collection('expenses_shows').get();
    shows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.showDate || '').localeCompare(a.showDate || ''));
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  renderShowFilter();
  renderShowList();
}

function renderShowFilter() {
  const options = '<option value="">All shows</option>' + shows.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  ['filterShow', 'reportFilterShow'].forEach(id => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = options;
    sel.value = current;
  });
}

function renderShowList() {
  const el = document.getElementById('showList');
  el.innerHTML = shows.map(s => `
    <div class="item-row ${s.active ? '' : 'inactive'}">
      <div class="item-name">${escapeHtml(s.name)}</div>
      <div class="item-sub">${s.showDate || ''}</div>
      <div class="item-actions">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="checkbox" data-toggle-show="${s.id}" ${s.active ? 'checked' : ''}> Active
        </label>
        <button class="btn btn-secondary btn-sm" data-view-show-expenses="${s.id}">View expenses</button>
        <button class="icon-btn icon-btn-danger" data-delete-show="${s.id}" title="Remove" aria-label="Remove">${ICON_TRASH}</button>
      </div>
    </div>
  `).join('') || '<p class="empty-state">No shows yet — add one above.</p>';
}

document.getElementById('addShowForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('newShowName').value.trim();
  const showDate = document.getElementById('newShowDate').value || null;
  if (!name) return;
  try {
    await db.collection('expenses_shows').add({
      name,
      showDate,
      active: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    e.target.reset();
    showToast('Show added', 'success');
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('showList').addEventListener('change', async (e) => {
  if (!e.target.matches('[data-toggle-show]')) return;
  const id = e.target.getAttribute('data-toggle-show');
  try {
    await db.collection('expenses_shows').doc(id).update({ active: e.target.checked });
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Expenses keep their own copy of the show's name, so a show going away never breaks how a past
// expense displays — it just drops out of the entry form's show picker. But an UNPAID one still
// needs that show around (it's how it gets found/paid), so removal is blocked outright while any
// exist; a show with only paid expenses offers removing them alongside it instead of a bare
// confirm(), since that's a real choice (they're not otherwise cleaned up by removing the show).
let deleteShowId = null;

function openDeleteShowModal(id) {
  const show = shows.find(s => s.id === id);
  if (!show) return;
  deleteShowId = id;
  const showExpenses = allExpenses.filter(e => e.showId === id);
  const unpaidCount = showExpenses.filter(e => !e.paid).length;
  const paidCount = showExpenses.length - unpaidCount;

  document.getElementById('deleteShowName').textContent = show.name;
  const msgEl = document.getElementById('deleteShowMessage');
  const confirmBtn = document.getElementById('deleteShowConfirmBtn');
  const withExpensesBtn = document.getElementById('deleteShowWithExpensesBtn');

  if (unpaidCount > 0) {
    const plural = unpaidCount === 1 ? '' : 's';
    msgEl.textContent = `Can't remove — ${unpaidCount} unpaid expense${plural} ${unpaidCount === 1 ? 'is' : 'are'} still recorded against this show. Mark ${unpaidCount === 1 ? 'it' : 'them'} paid, or delete ${unpaidCount === 1 ? 'it' : 'them'}, first.`;
    confirmBtn.style.display = 'none';
    withExpensesBtn.style.display = 'none';
  } else if (paidCount > 0) {
    const plural = paidCount === 1 ? '' : 's';
    msgEl.textContent = `This show has ${paidCount} paid expense${plural} recorded against it. Removing just the show leaves ${paidCount === 1 ? 'it' : 'them'} in place — or remove both together.`;
    confirmBtn.style.display = '';
    confirmBtn.textContent = 'Remove show only';
    withExpensesBtn.style.display = '';
    withExpensesBtn.textContent = `Remove show + ${paidCount} expense${plural}`;
  } else {
    msgEl.textContent = 'No expenses are recorded against it.';
    confirmBtn.style.display = '';
    confirmBtn.textContent = 'Remove show';
    withExpensesBtn.style.display = 'none';
  }

  document.getElementById('deleteShowModal').style.display = 'flex';
}

function closeDeleteShowModal() {
  document.getElementById('deleteShowModal').style.display = 'none';
  deleteShowId = null;
}
document.getElementById('deleteShowCloseBtn').addEventListener('click', closeDeleteShowModal);
document.getElementById('deleteShowCancelBtn').addEventListener('click', closeDeleteShowModal);
document.getElementById('deleteShowModal').addEventListener('click', (e) => {
  if (e.target.id === 'deleteShowModal') closeDeleteShowModal();
});

document.getElementById('showList').addEventListener('click', (e) => {
  // .closest(), not .matches() — the delete button's icon is an inline <svg>, so a click can
  // land on that (or its child path) rather than the <button> itself.
  const deleteBtn = e.target.closest('[data-delete-show]');
  if (deleteBtn) {
    openDeleteShowModal(deleteBtn.getAttribute('data-delete-show'));
    return;
  }
  if (e.target.matches('[data-view-show-expenses]')) {
    openShowExpenses(e.target.getAttribute('data-view-show-expenses'));
  }
});

// Jumps to the Expenses tab pre-filtered to just this show (every status, not just Unpaid, so
// "view this show's expenses" actually shows all of them).
function openShowExpenses(showId) {
  document.getElementById('filterShow').value = showId;
  document.getElementById('filterUser').value = '';
  document.getElementById('filterPaid').value = '';
  renderExpenseTable();
  activateTab('dashboard');
}

document.getElementById('deleteShowConfirmBtn').addEventListener('click', async () => {
  if (!deleteShowId) return;
  try {
    await db.collection('expenses_shows').doc(deleteShowId).delete();
    showToast('Show removed', 'success');
    closeDeleteShowModal();
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('deleteShowWithExpensesBtn').addEventListener('click', async () => {
  if (!deleteShowId) return;
  const id = deleteShowId;
  try {
    const showExpenses = allExpenses.filter(e => e.showId === id);
    await Promise.all(showExpenses.map(async (row) => {
      await db.collection('expenses').doc(row.id).delete();
      receiptPathsOf(row).forEach(p => storage.ref(p).delete().catch(() => {}));
    }));
    await db.collection('expenses_shows').doc(id).delete();
    showToast('Show and its expenses removed', 'success');
    closeDeleteShowModal();
    await loadShows();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Expenses ─────────────────────────────────────────────────────────────

let expensesUnsub = null;

// Live listener, not a one-off get: a player submitting, or another manager marking something
// paid, shows up here immediately — no manual reload needed.
function subscribeExpenses() {
  if (expensesUnsub) expensesUnsub();
  expensesUnsub = db.collection('expenses').onSnapshot(snap => {
    allExpenses = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderSummary();
    renderExpenseTable();
    renderReports();
  }, err => {
    console.error(err);
    showToast(err.message, 'error');
  });
}

function renderSummary() {
  const unpaidExpenses = allExpenses.filter(e => !e.paid);
  const unpaid = unpaidExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
  document.getElementById('summaryCards').innerHTML = `
    <div class="summary-card"><div class="snum">${money(unpaid)}</div><div class="slabel">Unpaid (${unpaidExpenses.length} expense${unpaidExpenses.length === 1 ? '' : 's'})</div></div>
  `;
}

function filteredExpenses() {
  const showId = document.getElementById('filterShow').value;
  const user = document.getElementById('filterUser').value.trim().toLowerCase();
  const paid = document.getElementById('filterPaid').value;
  return allExpenses.filter(e => {
    if (showId && e.showId !== showId) return false;
    if (paid !== '' && String(e.paid ? 1 : 0) !== paid) return false;
    if (user && !e.userName.toLowerCase().includes(user) && !e.userEmail.toLowerCase().includes(user)) return false;
    return true;
  });
}

// Which rows' own checkbox is ticked, for the bulk Delete selected button — a Set rather than
// tracking it on each row's own data, since filtering/live updates rebuild the table constantly
// and this needs to survive that. Pruned to whatever still exists in allExpenses on every
// render, so ticking a row then deleting it via its own icon-btn doesn't leave a stale id
// sitting around forever (harmless — Firestore's delete() on an already-gone doc is a silent
// no-op — but there's no reason to let it accumulate).
let selectedExpenseIds = new Set();

function renderExpenseTable() {
  // Bulk delete is for cleaning up old paid records — an unpaid expense doesn't even get a
  // checkbox, so there's no way to select (and so no risk of bulk-deleting) one by mistake.
  selectedExpenseIds = new Set([...selectedExpenseIds].filter(id => allExpenses.some(r => r.id === id && r.paid)));
  const rows = filteredExpenses();
  const tbody = document.getElementById('expenseTableBody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.paid ? `<input type="checkbox" data-select-expense="${r.id}" ${selectedExpenseIds.has(r.id) ? 'checked' : ''}>` : ''}</td>
      <td>${escapeHtml(r.showName || '—')}</td>
      <td>${escapeHtml(r.description)}</td>
      <td>${escapeHtml(r.userName)}<br><span class="muted">${escapeHtml(r.userEmail)}</span></td>
      <td>${receiptLinksHtml(r)}</td>
      <td>${r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : ''}</td>
      <td class="amount-cell${r.paid ? '' : ' unpaid'}">${money(r.amount)}</td>
      <td><span class="badge ${r.paid ? 'badge-success' : 'badge-warning'}">${r.paid ? 'Paid' : 'Unpaid'}</span></td>
      <td><button class="icon-btn icon-btn-danger" data-delete-expense="${r.id}" title="Delete" aria-label="Delete">${ICON_TRASH}</button></td>
    </tr>
  `).join('') || `<tr><td colspan="9" class="empty-state">No expenses match these filters.</td></tr>`;

  const paidRows = rows.filter(r => r.paid);
  const selectAll = document.getElementById('expenseSelectAll');
  selectAll.style.visibility = paidRows.length ? '' : 'hidden'; // nothing to select against the default Unpaid-only filter
  selectAll.checked = paidRows.length > 0 && paidRows.every(r => selectedExpenseIds.has(r.id));
  updateDeleteSelectedBtn();
}

function updateDeleteSelectedBtn() {
  const btn = document.getElementById('deleteSelectedBtn');
  btn.style.display = selectedExpenseIds.size ? '' : 'none';
  btn.textContent = `Delete selected (${selectedExpenseIds.size})`;
}

document.getElementById('expenseSelectAll').addEventListener('change', (e) => {
  filteredExpenses().filter(r => r.paid).forEach(r => {
    if (e.target.checked) selectedExpenseIds.add(r.id); else selectedExpenseIds.delete(r.id);
  });
  renderExpenseTable();
});

document.getElementById('deleteSelectedBtn').addEventListener('click', async () => {
  const ids = [...selectedExpenseIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected expense${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const btn = document.getElementById('deleteSelectedBtn');
  btn.disabled = true;
  try {
    for (const id of ids) {
      const row = allExpenses.find(r => r.id === id);
      await db.collection('expenses').doc(id).delete();
      if (row) receiptPathsOf(row).forEach(p => storage.ref(p).delete().catch(() => {}));
    }
    selectedExpenseIds.clear();
    showToast(`${ids.length} expense${ids.length === 1 ? '' : 's'} deleted`, 'success');
    // The live listener in subscribeExpenses re-renders as soon as the writes land.
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

['filterShow', 'filterUser', 'filterPaid'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderExpenseTable);
  document.getElementById(id).addEventListener('change', renderExpenseTable);
});

document.getElementById('expenseTableBody').addEventListener('change', (e) => {
  if (e.target.matches('[data-select-expense]')) {
    const id = e.target.getAttribute('data-select-expense');
    if (e.target.checked) selectedExpenseIds.add(id); else selectedExpenseIds.delete(id);
    // Just the select-all checkbox + button, not a full re-render — that'd rebuild every row's
    // own checkbox mid-click, right under the one just ticked.
    const paidRows = filteredExpenses().filter(r => r.paid);
    document.getElementById('expenseSelectAll').checked = paidRows.length > 0 && paidRows.every(r => selectedExpenseIds.has(r.id));
    updateDeleteSelectedBtn();
    return;
  }
  if (!e.target.matches('[data-view-receipt-select]')) return;
  const path = e.target.value;
  e.target.value = '';
  if (path) viewReceipt(path);
});

document.getElementById('expenseTableBody').addEventListener('click', async (e) => {
  const deleteBtn = e.target.closest('[data-delete-expense]'); // icon-btn's <svg> is the actual click target
  if (deleteBtn) {
    if (!confirm('Delete this expense? This cannot be undone.')) return;
    const id = deleteBtn.getAttribute('data-delete-expense');
    const row = allExpenses.find(r => r.id === id);
    try {
      await db.collection('expenses').doc(id).delete();
      if (row) receiptPathsOf(row).forEach(p => storage.ref(p).delete().catch(() => {}));
      // The live listener in subscribeExpenses re-renders as soon as the write lands.
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }
  if (e.target.matches('[data-view-receipt]')) {
    e.preventDefault();
    viewReceipt(e.target.getAttribute('data-view-receipt'));
  }
});

// ── Export ───────────────────────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', () => {
  const rows = filteredExpenses().map(r => ({
    Show: r.showName || '',
    Description: r.description,
    Amount: Number(r.amount),
    Name: r.userName,
    Email: r.userEmail,
    Status: r.paid ? 'Paid' : 'Unpaid',
    'Paid At': r.paidAt?.toDate ? formatDate(r.paidAt.toDate()) : '',
    Submitted: r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : '',
  }));
  if (!rows.length) { showToast('Nothing to export with the current filters', 'info'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 32 }, { wch: 10 }, { wch: 20 }, { wch: 28 }, { wch: 10 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses');
  XLSX.writeFile(wb, `expenses-${new Date().toISOString().slice(0, 10)}.xlsx`);
});

// ── Reports ──────────────────────────────────────────────────────────────

function summarize(rows) {
  const total = rows.reduce((sum, e) => sum + Number(e.amount), 0);
  const unpaid = rows.filter(e => !e.paid).reduce((sum, e) => sum + Number(e.amount), 0);
  return { count: rows.length, total, unpaid, paid: total - unpaid };
}

function reportFilteredExpenses() {
  const showId = document.getElementById('reportFilterShow').value;
  const paid = document.getElementById('reportFilterPaid').value;
  const from = document.getElementById('reportFilterFrom').value;
  const to = document.getElementById('reportFilterTo').value;
  const fromDate = from ? new Date(`${from}T00:00:00`) : null;
  const toDate = to ? new Date(`${to}T23:59:59`) : null;

  return allExpenses.filter(e => {
    if (showId && e.showId !== showId) return false;
    if (paid !== '' && String(e.paid ? 1 : 0) !== paid) return false;
    const created = e.createdAt?.toDate ? e.createdAt.toDate() : null;
    if (fromDate && (!created || created < fromDate)) return false;
    if (toDate && (!created || created > toDate)) return false;
    return true;
  });
}

function byShowReport(rows) {
  return shows.map(s => ({ name: s.name, ...summarize(rows.filter(e => e.showId === s.id)) }))
    .filter(r => r.count > 0);
}

function byUserReport(rows) {
  const byEmail = new Map();
  rows.forEach(e => {
    if (!byEmail.has(e.userEmail)) byEmail.set(e.userEmail, { name: e.userName, email: e.userEmail, rows: [] });
    byEmail.get(e.userEmail).rows.push(e);
  });
  return [...byEmail.values()]
    .map(u => ({ name: u.name, email: u.email, ...summarize(u.rows) }))
    .sort((a, b) => b.total - a.total);
}

function renderReports() {
  const rows = reportFilteredExpenses();

  document.getElementById('reportByShowBody').innerHTML = byShowReport(rows).map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="amount-cell">${r.count}</td>
      <td class="amount-cell">${money(r.total)}</td>
      <td class="amount-cell${r.unpaid ? ' unpaid' : ''}">${money(r.unpaid)}</td>
      <td class="amount-cell">${money(r.paid)}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="empty-state">No expenses match these filters.</td></tr>`;

  document.getElementById('reportByUserBody').innerHTML = byUserReport(rows).map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.email)}</td>
      <td class="amount-cell">${r.count}</td>
      <td class="amount-cell">${money(r.total)}</td>
      <td class="amount-cell${r.unpaid ? ' unpaid' : ''}">${money(r.unpaid)}</td>
      <td class="amount-cell">${money(r.paid)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="empty-state">No expenses match these filters.</td></tr>`;

  document.getElementById('reportDetailBody').innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.showName || '—')}</td>
      <td>${escapeHtml(r.description)}</td>
      <td>${escapeHtml(r.userName)}<br><span class="muted">${escapeHtml(r.userEmail)}</span></td>
      <td>${receiptLinksHtml(r)}</td>
      <td>${r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : ''}</td>
      <td class="amount-cell${r.paid ? '' : ' unpaid'}">${money(r.amount)}</td>
      <td><span class="badge ${r.paid ? 'badge-success' : 'badge-warning'}">${r.paid ? 'Paid' : 'Unpaid'}</span></td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="empty-state">No expenses match these filters.</td></tr>`;
}

['reportFilterShow', 'reportFilterFrom', 'reportFilterTo', 'reportFilterPaid'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderReports);
  document.getElementById(id).addEventListener('change', renderReports);
});

document.getElementById('reportFilterClearBtn').addEventListener('click', () => {
  document.getElementById('reportFilterShow').value = '';
  document.getElementById('reportFilterFrom').value = '';
  document.getElementById('reportFilterTo').value = '';
  document.getElementById('reportFilterPaid').value = '';
  renderReports();
});

document.getElementById('reportDetailBody').addEventListener('click', (e) => {
  if (!e.target.matches('[data-view-receipt]')) return;
  e.preventDefault();
  viewReceipt(e.target.getAttribute('data-view-receipt'));
});

document.getElementById('reportDetailBody').addEventListener('change', (e) => {
  if (!e.target.matches('[data-view-receipt-select]')) return;
  const path = e.target.value;
  e.target.value = '';
  if (path) viewReceipt(path);
});

// window.print() + a print-only stylesheet (see @media print in style.css) — same approach as
// budget's own Print/PDF, rather than a separate PDF-generating library: the browser's own
// "Save as PDF" print destination already covers that.
document.getElementById('printReportBtn').addEventListener('click', () => {
  const showName = document.getElementById('reportFilterShow').selectedOptions[0]?.textContent || 'All shows';
  const from = document.getElementById('reportFilterFrom').value;
  const to = document.getElementById('reportFilterTo').value;
  const dateRange = (from || to) ? `${from ? formatDate(new Date(from)) : 'the start'} – ${to ? formatDate(new Date(to)) : 'now'}` : 'All dates';
  const paid = document.getElementById('reportFilterPaid').value;
  const paidLabel = paid === '1' ? 'Paid only' : paid === '0' ? 'Unpaid only' : 'Paid + Unpaid';
  document.getElementById('printReportMeta').textContent =
    `${showName} · ${dateRange} · ${paidLabel} · Generated ${formatDate(new Date())}`;
  window.print();
});

document.getElementById('exportReportBtn').addEventListener('click', () => {
  const rows = reportFilteredExpenses();
  if (!rows.length) { showToast('Nothing to export with the current filters', 'info'); return; }

  const wb = XLSX.utils.book_new();

  const byShow = byShowReport(rows).map(r => ({
    Show: r.name, Expenses: r.count, Total: r.total, Unpaid: r.unpaid, Paid: r.paid,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byShow), 'By Show');

  const byUser = byUserReport(rows).map(r => ({
    Name: r.name, Email: r.email, Expenses: r.count, Total: r.total, Unpaid: r.unpaid, Paid: r.paid,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byUser), 'By Submitter');

  const detail = rows.map(r => ({
    Show: r.showName || '',
    Description: r.description,
    Amount: Number(r.amount),
    Name: r.userName,
    Email: r.userEmail,
    Status: r.paid ? 'Paid' : 'Unpaid',
    'Paid At': r.paidAt?.toDate ? formatDate(r.paidAt.toDate()) : '',
    Submitted: r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), 'Detail');

  XLSX.writeFile(wb, `expenses-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
});

// ── Settings — notification emails ──────────────────────────────────────

let notifyEmails = [];

async function loadNotifySettings() {
  try {
    const doc = await db.collection('expenses_config').doc('settings').get();
    notifyEmails = doc.exists ? (doc.data().notifyEmails || []) : [];
    document.getElementById('fromEmailInput').value = doc.exists ? (doc.data().fromEmail || '') : '';
    document.getElementById('defaultLinkMessageInput').value = doc.exists ? (doc.data().defaultLinkMessage || '') : '';
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  renderNotifyEmailList();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

document.getElementById('checkStorageUsageBtn').addEventListener('click', async () => {
  const btn = document.getElementById('checkStorageUsageBtn');
  const resultEl = document.getElementById('storageUsageResult');
  btn.disabled = true;
  resultEl.textContent = 'Checking…';
  try {
    const result = await functionsRegion.httpsCallable('getStorageUsage')();
    const { totalBytes, fileCount } = result.data;
    resultEl.textContent = `${formatBytes(totalBytes)} used across ${fileCount} receipt file${fileCount === 1 ? '' : 's'}.`;
  } catch (err) {
    resultEl.textContent = '';
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('fromEmailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fromEmail = document.getElementById('fromEmailInput').value.trim();
  try {
    await db.collection('expenses_config').doc('settings').set({ fromEmail }, { merge: true });
    showToast('Saved', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('defaultLinkMessageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const defaultLinkMessage = document.getElementById('defaultLinkMessageInput').value.trim();
  try {
    await db.collection('expenses_config').doc('settings').set({ defaultLinkMessage }, { merge: true });
    showToast('Saved', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

function renderNotifyEmailList() {
  const el = document.getElementById('notifyEmailList');
  el.innerHTML = notifyEmails.map(email => `
    <div class="item-row">
      <div class="item-name">${escapeHtml(email)}</div>
      <div class="item-actions">
        <button class="icon-btn icon-btn-danger" data-remove-notify-email="${escapeHtml(email)}" title="Remove" aria-label="Remove">${ICON_TRASH}</button>
      </div>
    </div>
  `).join('') || '<p class="empty-state">No notification emails yet — add one above.</p>';
}

document.getElementById('addNotifyEmailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('newNotifyEmail');
  const email = input.value.trim();
  if (!email) return;
  try {
    await db.collection('expenses_config').doc('settings').set({
      notifyEmails: firebase.firestore.FieldValue.arrayUnion(email),
    }, { merge: true });
    input.value = '';
    showToast('Email added', 'success');
    await loadNotifySettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('notifyEmailList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-notify-email]'); // icon-btn's <svg> is the actual click target
  if (!btn) return;
  const email = btn.getAttribute('data-remove-notify-email');
  try {
    await db.collection('expenses_config').doc('settings').set({
      notifyEmails: firebase.firestore.FieldValue.arrayRemove(email),
    }, { merge: true });
    await loadNotifySettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Mark expenses as paid ────────────────────────────────────────────────
// Choose a person, tick which of their outstanding expenses to pay, one email covers the whole
// batch — replaces the old per-row "Paid" checkbox, which fired a separate email per expense
// (the same bug notifyExpensesSubmitted fixed on the submitting side).

function outstandingByPerson() {
  const map = new Map();
  for (const e of allExpenses) {
    if (e.paid) continue;
    if (!map.has(e.userEmail)) map.set(e.userEmail, { name: e.userName, email: e.userEmail, total: 0, expenses: [] });
    const entry = map.get(e.userEmail);
    entry.total += Number(e.amount);
    entry.expenses.push(e);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function closeMarkPaidModal() {
  document.getElementById('markPaidModal').style.display = 'none';
}

function updateMarkPaidTotal() {
  const person = outstandingByPerson().find(p => p.email === document.getElementById('markPaidPersonSelect').value);
  const submitBtn = document.getElementById('markPaidSubmitBtn');
  if (!person) { submitBtn.style.display = 'none'; return; }
  const checkedIds = [...document.querySelectorAll('[data-mark-paid-check]:checked')].map(cb => cb.getAttribute('data-mark-paid-check'));
  const total = person.expenses.filter(exp => checkedIds.includes(exp.id)).reduce((sum, exp) => sum + Number(exp.amount), 0);
  document.getElementById('markPaidTotalText').textContent = money(total);
  submitBtn.textContent = `Mark ${checkedIds.length} as paid`;
  submitBtn.disabled = checkedIds.length === 0;
}

document.getElementById('openMarkPaidBtn').addEventListener('click', () => {
  const people = outstandingByPerson();
  document.getElementById('markPaidPersonSelect').innerHTML = '<option value="">Choose a person…</option>' +
    people.map(p => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name)} (${money(p.total)})</option>`).join('');
  document.getElementById('markPaidExpenseList').innerHTML = '';
  document.getElementById('markPaidTotalRow').style.display = 'none';
  document.getElementById('markPaidSubmitBtn').style.display = 'none';
  document.getElementById('markPaidModal').style.display = 'flex';
});

document.getElementById('markPaidCloseBtn').addEventListener('click', closeMarkPaidModal);
document.getElementById('markPaidModal').addEventListener('click', (e) => {
  if (e.target.id === 'markPaidModal') closeMarkPaidModal();
});

document.getElementById('markPaidPersonSelect').addEventListener('change', (e) => {
  const listEl = document.getElementById('markPaidExpenseList');
  const totalRow = document.getElementById('markPaidTotalRow');
  const submitBtn = document.getElementById('markPaidSubmitBtn');
  const person = outstandingByPerson().find(p => p.email === e.target.value);
  if (!person) {
    listEl.innerHTML = '';
    totalRow.style.display = 'none';
    submitBtn.style.display = 'none';
    return;
  }
  listEl.innerHTML = person.expenses.map(exp => `
    <label class="item-row" style="cursor:pointer;margin-bottom:8px">
      <input type="checkbox" data-mark-paid-check="${exp.id}" checked>
      <div class="item-name" style="flex:1">${escapeHtml(exp.showName)}: ${escapeHtml(exp.description)}</div>
      <div>${money(exp.amount)}</div>
    </label>
  `).join('');
  totalRow.style.display = 'flex';
  submitBtn.style.display = 'block';
  updateMarkPaidTotal();
});

document.getElementById('markPaidExpenseList').addEventListener('change', (e) => {
  if (e.target.matches('[data-mark-paid-check]')) updateMarkPaidTotal();
});

document.getElementById('markPaidSubmitBtn').addEventListener('click', async () => {
  const btn = document.getElementById('markPaidSubmitBtn');
  const ids = [...document.querySelectorAll('[data-mark-paid-check]:checked')].map(cb => cb.getAttribute('data-mark-paid-check'));
  if (!ids.length) return;
  btn.disabled = true;
  try {
    for (const id of ids) {
      await db.collection('expenses').doc(id).update({ paid: true, paidAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    // One summary email for the whole batch — see notifyExpensesPaid.
    await functionsRegion.httpsCallable('notifyExpensesPaid')({ ids });
    showToast(`Marked ${ids.length} expense${ids.length === 1 ? '' : 's'} as paid`, 'success');
    closeMarkPaidModal();
    // The live listener in subscribeExpenses re-renders as soon as each write lands.
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Users (expenses-only) ────────────────────────────────────────────────
// A quick way for an expenses admin to onboard a player without going through the portal:
// creates an access.expenses-only login (createExpensesUser — expensesAdmin-scoped, can't grant
// anything broader), then offers the entry link to copy or email straight away. Broader access
// changes (Expenses admin, other apps, Manager) and managing existing accounts still live in
// the portal's Users screen only.

// Points at the portal root, not this app's own entry page — sign-in is unified there now, and
// it's what shows someone whatever tiles they actually have (just Expenses, for most of these).
const ENTRY_URL = new URL('../index.html', location.href).href;

// Shared by both "just created" (addUserForm submit) and "send an existing user their link
// again" (the All users list's per-row Send link button) — same modal, same fields either way.
function showSendLinkModal(name, email) {
  document.getElementById('newUserLinkName').textContent = name;
  document.getElementById('newUserLinkUrl').value = ENTRY_URL;
  // Pre-fill from Settings → Default link message (still editable per person before sending —
  // see that card's own note); this was previously always left blank.
  document.getElementById('newUserLinkMessage').value = document.getElementById('defaultLinkMessageInput').value;
  const modal = document.getElementById('newUserLinkModal');
  modal.dataset.email = email;
  modal.style.display = 'flex';
}

function closeSendLinkModal() {
  document.getElementById('newUserLinkModal').style.display = 'none';
}

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('addUserError');
  const btn = document.getElementById('addUserBtn');
  errorEl.textContent = '';
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value.trim();

  btn.disabled = true;
  try {
    await functionsRegion.httpsCallable('createExpensesUser')({ name, email, password });
    showSendLinkModal(name, email);
    document.getElementById('addUserForm').reset();
    showToast(`Account created for ${name} — pass on the temporary password`, 'success');
    await loadExpensesUsers();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// All users with any expenses-related access (listExpensesUsers — expensesAdmin-scoped, returns
// only what this screen needs). The "Expenses access" toggle here calls setExpensesUserAccess,
// which can only ever touch that one flag — granting Expenses admin (or any other app) stays a
// portal-only action, so it isn't offered here even as a toggle.
let expensesUsers = [];

async function loadExpensesUsers() {
  try {
    const result = await functionsRegion.httpsCallable('listExpensesUsers')();
    expensesUsers = result.data.users || [];
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  renderExpensesUserList();
}

function renderExpensesUserList() {
  const search = document.getElementById('expensesUserSearchInput').value.trim().toLowerCase();
  const rows = expensesUsers.filter(u => !search || u.name?.toLowerCase().includes(search) || u.email?.toLowerCase().includes(search));
  document.getElementById('expensesUserList').innerHTML = rows.map(u => `
    <div class="item-row" style="flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="item-name">${escapeHtml(u.name)}</div>
        <div class="item-sub">${escapeHtml(u.email)}${u.access.expensesAdmin ? ' · Expenses admin' : ''}</div>
      </div>
      <div class="item-actions">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px">
          <input type="checkbox" data-toggle-expenses="${u.id}" ${u.access.expenses ? 'checked' : ''}> Expenses access
        </label>
        <button type="button" class="btn btn-secondary btn-sm" data-view-user-expenses="${escapeHtml(u.email)}">View expenses</button>
        <button type="button" class="btn btn-secondary btn-sm" data-send-link="${u.id}">Send link</button>
      </div>
    </div>
  `).join('') || '<p class="empty-state">No users yet.</p>';
}
document.getElementById('expensesUserSearchInput').addEventListener('input', renderExpensesUserList);

document.getElementById('expensesUserList').addEventListener('change', async (e) => {
  const uid = e.target.getAttribute('data-toggle-expenses');
  if (!uid) return;
  const checked = e.target.checked;
  try {
    await functionsRegion.httpsCallable('setExpensesUserAccess')({ uid, value: checked });
    showToast('Updated', 'success');
    await loadExpensesUsers();
  } catch (err) {
    e.target.checked = !checked;
    showToast(err.message, 'error');
  }
});

document.getElementById('expensesUserList').addEventListener('click', (e) => {
  const uid = e.target.getAttribute('data-send-link');
  if (uid) {
    const user = expensesUsers.find(u => u.id === uid);
    if (user) showSendLinkModal(user.name, user.email);
    return;
  }
  const email = e.target.getAttribute('data-view-user-expenses');
  if (email) openUserExpenses(email);
});

// Jumps to the Expenses tab pre-filtered to just this person (every status, not just Unpaid,
// same reasoning as openShowExpenses above). filterUser matches name-or-email substring, and an
// email is always unique, so it's the safer of the two to filter on here.
function openUserExpenses(email) {
  document.getElementById('filterShow').value = '';
  document.getElementById('filterUser').value = email;
  document.getElementById('filterPaid').value = '';
  renderExpenseTable();
  activateTab('dashboard');
}

document.getElementById('newUserLinkCloseBtn').addEventListener('click', closeSendLinkModal);
document.getElementById('newUserLinkDoneBtn').addEventListener('click', closeSendLinkModal);
document.getElementById('newUserLinkModal').addEventListener('click', (e) => {
  if (e.target.id === 'newUserLinkModal') closeSendLinkModal();
});

document.getElementById('copyLinkBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('newUserLinkUrl').value);
    showToast('Link copied', 'success');
  } catch (err) {
    showToast('Could not copy — select and copy the link manually', 'error');
  }
});

document.getElementById('sendLinkEmailBtn').addEventListener('click', async () => {
  const btn = document.getElementById('sendLinkEmailBtn');
  const email = document.getElementById('newUserLinkModal').dataset.email;
  const message = document.getElementById('newUserLinkMessage').value.trim();
  btn.disabled = true;
  try {
    await functionsRegion.httpsCallable('sendUserLink')({ email, message });
    showToast('Link sent', 'success');
    closeSendLinkModal();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Service worker update banner ────────────────────────────────────────

function initServiceWorker() {
  // Still registered — needed for offline support and for the page to qualify as an
  // installable PWA — but its own install/update lifecycle no longer decides whether the
  // banner shows (see checkForUpdate). That lifecycle runs on its own schedule, separate from
  // the page's: index.html/app.js/version.js are always fetched fresh over the network
  // regardless of service worker state (network-first, both with and without one active), so
  // the version actually on screen can easily be newer than whatever the service worker has
  // gotten around to installing — showing "a new version is available" while the header
  // already reads the latest version, confusingly. Comparing the real version number instead
  // ties the banner to the same thing you can see on screen, not a second, looser proxy for it.
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
  } catch (err) {
    // Offline or the request failed — nothing meaningful to report either way.
  }
}

let updateBtnWired = false;

function showUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  banner.classList.add('visible');
  if (updateBtnWired) return; // updatefound can fire more than once; only wire the click once
  updateBtnWired = true;
  document.getElementById('updateBtn').addEventListener('click', async () => {
    banner.querySelector('span').textContent = 'Updating…';
    // Previously tried the "proper" skipWaiting/clients.claim()/controllerchange handoff —
    // that's now caused two separate bugs (a stale worker reference; then this button
    // reappearing in a loop even against a version held steady) and there's no way to step
    // through the browser's own service worker lifecycle to find a third. This is simpler and
    // leaves no lifecycle state to get stuck in: drop the service worker and its caches
    // entirely, then reload — the reload re-registers a fresh one from whatever's actually live.
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    } catch (err) {
      console.error(err);
    }
    // Once the service worker's gone, THIS reload is no longer covered by its own
    // cache-bypassing fetch strategy — it's a plain browser request, and GitHub Pages serves
    // this page with Cache-Control: max-age=600, so a plain reload() could still hand back
    // whatever the browser's own HTTP cache has sitting around. A cache-busting query string
    // forces a genuinely fresh request.
    window.location.href = window.location.pathname + '?v=' + Date.now();
  });
}

initServiceWorker();
