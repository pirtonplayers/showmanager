const storage = firebase.storage();
// Cloud Functions are deployed to europe-west1 — the default region is us-central1, so this
// has to be requested explicitly or callable functions 404.
const functionsRegion = firebase.app().functions('europe-west1');

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
  const menu = document.getElementById('mainMenuDropdown');
  menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
});
document.addEventListener('click', () => { document.getElementById('mainMenuDropdown').style.display = 'none'; });

// The nav buttons exist twice — once in the mobile dropdown, once in the desktop sidebar —
// sharing the same data-tab values, so switching via either keeps both in sync.
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById('mainMenuDropdown').style.display = 'none';
  });
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
        <button class="btn btn-danger btn-sm" data-delete-show="${s.id}">Remove</button>
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

document.getElementById('showList').addEventListener('click', async (e) => {
  if (!e.target.matches('[data-delete-show]')) return;
  // Expenses keep their own copy of the show's name, so removing a show never
  // breaks how past expenses display — it just drops out of the entry form.
  if (!confirm('Remove this show? Expenses already recorded against it are unaffected.')) return;
  const id = e.target.getAttribute('data-delete-show');
  try {
    await db.collection('expenses_shows').doc(id).delete();
    showToast('Show removed', 'success');
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

function renderExpenseTable() {
  const rows = filteredExpenses();
  const tbody = document.getElementById('expenseTableBody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.showName || '—')}</td>
      <td>${escapeHtml(r.description)}</td>
      <td>${escapeHtml(r.userName)}<br><span class="muted">${escapeHtml(r.userEmail)}</span></td>
      <td>${receiptLinksHtml(r)}</td>
      <td>${r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : ''}</td>
      <td class="amount-cell">${money(r.amount)}</td>
      <td><span class="badge ${r.paid ? 'badge-success' : 'badge-warning'}">${r.paid ? 'Paid' : 'Unpaid'}</span></td>
      <td><button class="btn btn-danger btn-sm" data-delete-expense="${r.id}">Delete</button></td>
    </tr>
  `).join('') || `<tr><td colspan="8" class="empty-state">No expenses match these filters.</td></tr>`;
}

['filterShow', 'filterUser', 'filterPaid'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderExpenseTable);
  document.getElementById(id).addEventListener('change', renderExpenseTable);
});

document.getElementById('expenseTableBody').addEventListener('change', (e) => {
  if (!e.target.matches('[data-view-receipt-select]')) return;
  const path = e.target.value;
  e.target.value = '';
  if (path) viewReceipt(path);
});

document.getElementById('expenseTableBody').addEventListener('click', async (e) => {
  if (e.target.matches('[data-delete-expense]')) {
    if (!confirm('Delete this expense? This cannot be undone.')) return;
    const id = e.target.getAttribute('data-delete-expense');
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
      <td>${r.count}</td>
      <td class="amount-cell">${money(r.total)}</td>
      <td class="amount-cell">${money(r.unpaid)}</td>
      <td class="amount-cell">${money(r.paid)}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="empty-state">No expenses match these filters.</td></tr>`;

  document.getElementById('reportByUserBody').innerHTML = byUserReport(rows).map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.email)}</td>
      <td>${r.count}</td>
      <td class="amount-cell">${money(r.total)}</td>
      <td class="amount-cell">${money(r.unpaid)}</td>
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
      <td class="amount-cell">${money(r.amount)}</td>
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
        <button class="btn btn-danger btn-sm" data-remove-notify-email="${escapeHtml(email)}">Remove</button>
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
  if (!e.target.matches('[data-remove-notify-email]')) return;
  const email = e.target.getAttribute('data-remove-notify-email');
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

// Users (add/delete, Approved/Manager/app-access toggles, "sync permissions", send-link) are
// now managed from the showmanager portal's Users screen — see admin.html's Settings tab.

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
