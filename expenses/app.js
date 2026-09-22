const storage = firebase.storage();
// Cloud Functions are deployed to europe-west1 — the default region is us-central1, so this
// has to be requested explicitly or callable functions 404.
const functionsRegion = firebase.app().functions('europe-west1');

// ── State ────────────────────────────────────────────────────────────────

const state = { name: '', email: '' };

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

function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');

  // Two entirely separate containers: #authScreen (a plain centered card, matching
  // admin.html's own login screen) for login/forgot/change-password, and the app chrome
  // (hero/sidebar/content) for the two signed-in screens.
  const loggedInScreen = screenId === 'screenMain' || screenId === 'screenExpenses';
  document.getElementById('authScreen').style.display = loggedInScreen ? 'none' : 'flex';
  document.querySelector('.pwa-hero').style.display = loggedInScreen ? '' : 'none';
  document.querySelector('.pwa-content').style.display = loggedInScreen ? '' : 'none';
  document.getElementById('heroMenuWrap').style.display = loggedInScreen ? '' : 'none';
  document.getElementById('mainMenuDropdown').classList.remove('open');
  document.body.classList.remove('menu-open');
  document.getElementById('pwaSidebar').style.display = loggedInScreen ? '' : 'none';
  document.getElementById('pwaSidebarToggleBtn').style.display = loggedInScreen ? '' : 'none';
  document.querySelector('.pwa-content').classList.toggle('with-sidebar', loggedInScreen);
  // The nav buttons exist twice — once in the mobile dropdown, once in the desktop sidebar —
  // sharing the same data-screen values, so switching via either keeps both in sync.
  document.querySelectorAll('.tab-btn[data-screen]')
    .forEach(b => b.classList.toggle('active', b.dataset.screen === screenId));
}

// ── Menu ─────────────────────────────────────────────────────────────────
// Hamburger in the hero, shown only once signed in (see goTo) — switches between the New
// expense screen and the Expenses list screen.

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

document.querySelectorAll('.tab-btn[data-screen]').forEach(btn => {
  btn.addEventListener('click', () => {
    goTo(btn.dataset.screen);
  });
});

// Desktop sidebar collapse — same mechanism as admin.html's, own localStorage key so the two
// apps' collapsed/expanded state don't affect each other.
const pwaSidebarToggleBtn = document.getElementById('pwaSidebarToggleBtn');
function applyPwaSidebarState(collapsed) {
  document.body.classList.toggle('pwa-sidebar-collapsed', collapsed);
  pwaSidebarToggleBtn.textContent = collapsed ? '›' : '‹';
}
applyPwaSidebarState(localStorage.getItem('expenses_pwa_sidebar_collapsed') === '1');
pwaSidebarToggleBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('pwa-sidebar-collapsed');
  applyPwaSidebarState(collapsed);
  localStorage.setItem('expenses_pwa_sidebar_collapsed', collapsed ? '1' : '0');
});

// ── Auth ─────────────────────────────────────────────────────────────────
// No self-registration: a manager creates every login (admin.html -> Users), giving the
// player a temporary password. mustChangePassword on their users/{uid} doc then forces them
// through screenChangePassword before they can do anything else.

document.getElementById('togglePasswordBtn').addEventListener('click', (e) => {
  const input = document.getElementById('loginPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.style.opacity = input.type === 'text' ? '1' : '';
});

document.getElementById('showForgotLink').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value;
  goTo('screenForgot');
});
document.getElementById('showLoginFromForgotLink').addEventListener('click', (e) => { e.preventDefault(); goTo('screenLogin'); });

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  try {
    await firebase.auth().signInWithEmailAndPassword(email, password);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('forgotStatus');
  statusEl.style.color = '';
  const email = document.getElementById('forgotEmail').value.trim();
  try {
    await firebase.auth().sendPasswordResetEmail(email);
    statusEl.textContent = 'Check your email for a reset link.';
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = err.message;
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
    // The live listener in handleUser picks this up and moves on to screenMain by itself.
  } catch (err) {
    errorEl.textContent = err.code === 'auth/requires-recent-login'
      ? 'Please sign out and sign in again, then retry.'
      : err.message;
  }
});

document.getElementById('changePasswordSignOutBtn').addEventListener('click', () => firebase.auth().signOut());

let userDocUnsub = null;

function handleUser(user) {
  if (userDocUnsub) { userDocUnsub(); userDocUnsub = null; }

  if (user) {
    state.name = user.displayName || user.email;
    state.email = user.email;
    document.getElementById('changePasswordEmailText').textContent = state.email;

    // Live listener, not a one-off get: so the screen flips to the main app the moment
    // mustChangePassword clears, with no refresh needed.
    userDocUnsub = db.collection('users').doc(user.uid).onSnapshot(doc => {
      const data = doc.data();
      // No doc at all (e.g. the account was deleted) fails closed the same as still needing
      // to change the password — either way they shouldn't land in the main app.
      if (!data || data.mustChangePassword) {
        goTo('screenChangePassword');
      } else {
        // Their name comes from the users/{uid} doc, not Auth's own displayName (which is
        // often blank — e.g. any account created by hand in the Firebase Console rather than
        // via admin.html's "Add a user").
        state.name = data.name || user.displayName || user.email;
        goTo('screenMain');
        subscribeMyExpenses();
      }
      document.getElementById('authGate').style.display = 'none';
    }, err => {
      console.error(err);
      goTo('screenChangePassword');
      document.getElementById('authGate').style.display = 'none';
    });
  } else {
    if (myExpensesUnsub) { myExpensesUnsub(); myExpensesUnsub = null; }
    state.name = '';
    state.email = '';
    document.getElementById('loginForm').reset();
    document.getElementById('changePasswordForm').reset();
    goTo('screenLogin');
    document.getElementById('authGate').style.display = 'none';
  }
}

firebase.auth().onAuthStateChanged(handleUser);

// ── Shows ────────────────────────────────────────────────────────────────

async function loadShows() {
  const select = document.getElementById('showSelect');
  try {
    const snap = await db.collection('expenses_shows').get();
    const shows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.active)
      .sort((a, b) => (b.showDate || '').localeCompare(a.showDate || ''));

    if (!shows.length) {
      select.innerHTML = '<option value="">No shows available — contact the manager</option>';
      return;
    }
    select.innerHTML = '<option value="">— Select show —</option>' + shows.map(s =>
      `<option value="${s.id}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}${s.showDate ? ' — ' + s.showDate : ''}</option>`
    ).join('');
  } catch (err) {
    select.innerHTML = '<option value="">Could not load shows</option>';
    console.error(err);
  }
}

// ── My expenses ──────────────────────────────────────────────────────────

let myExpensesCache = [];
let myExpensesUnsub = null;

// Live listener, not a one-off get: a manager marking something paid shows up here
// immediately — no manual reload needed.
function subscribeMyExpenses() {
  if (myExpensesUnsub) { myExpensesUnsub(); myExpensesUnsub = null; }
  const list = document.getElementById('myExpenses');
  if (!state.email) return;
  myExpensesUnsub = db.collection('expenses').where('userEmail', '==', state.email).onSnapshot(snap => {
    myExpensesCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderMyExpenses();
    renderMyUnpaidTotal();
  }, err => {
    list.innerHTML = '<p class="empty-state">Could not load your expenses.</p>';
    console.error(err);
  });
}

function renderMyUnpaidTotal() {
  const el = document.getElementById('myUnpaidTotalText');
  if (!el) return;
  const unpaid = myExpensesCache.filter(r => !r.paid).reduce((sum, r) => sum + Number(r.amount), 0);
  el.textContent = money(unpaid);
}

function renderMyExpenses() {
  const list = document.getElementById('myExpenses');
  const showAll = document.getElementById('showAllExpensesToggle').checked;
  const rows = showAll ? myExpensesCache : myExpensesCache.filter(r => !r.paid);

  if (!rows.length) {
    list.innerHTML = `<p class="empty-state">${showAll ? 'No expenses submitted yet.' : 'No unpaid expenses.'}</p>`;
    return;
  }
  list.innerHTML = rows.map(r => `
    <div class="past-expense-card ${r.paid ? 'paid' : ''}" data-expense-detail="${r.id}">
      <div class="pec-info">
        <div class="pec-desc">${escapeHtml(r.description)}</div>
        <div class="pec-detail">${r.referenceNumber ? `Ref #${r.referenceNumber} · ` : ''}${escapeHtml(r.showName)} · ${r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : ''}</div>
      </div>
      <div class="pec-right">
        <div class="pec-amount">${money(r.amount)}</div>
        <span class="badge ${r.paid ? 'badge-success' : 'badge-warning'}">${r.paid ? 'Paid' : 'Unpaid'}</span>
      </div>
    </div>
  `).join('');
}

document.getElementById('showAllExpensesToggle').addEventListener('change', (e) => {
  document.getElementById('showAllExpensesText').textContent = e.target.checked ? 'All' : 'Unpaid only';
  renderMyExpenses();
});

// ── Expense detail modal ────────────────────────────────────────────────
// receiptPaths is the current (possibly-multiple) field; receiptPath is the older single-file
// one still sitting on any expense submitted before this became an array.
function receiptPathsOf(r) {
  return r.receiptPaths || (r.receiptPath ? [r.receiptPath] : []);
}

function closeExpenseDetail() {
  document.getElementById('expenseDetailModal').style.display = 'none';
  _detailExpenseId = null;
}
document.getElementById('expenseDetailCloseBtn').addEventListener('click', closeExpenseDetail);
document.getElementById('expenseDetailModal').addEventListener('click', (e) => {
  if (e.target.id === 'expenseDetailModal') closeExpenseDetail();
});

// Which expense the detail modal is currently showing — the "Add a receipt photo" input lives
// outside #expenseDetailBody (so it isn't torn down/rebuilt every time this reopens) and needs to
// know which doc to attach the upload to.
let _detailExpenseId = null;

async function openExpenseDetail(id) {
  const r = myExpensesCache.find(x => x.id === id);
  if (!r) return;
  _detailExpenseId = id;

  const body = document.getElementById('expenseDetailBody');
  body.innerHTML = `
    ${r.referenceNumber ? `<div class="detail-row"><span class="dr-label">Reference</span><span class="dr-value">#${r.referenceNumber}</span></div>` : ''}
    <div class="detail-row"><span class="dr-label">Show</span><span class="dr-value">${escapeHtml(r.showName || '—')}</span></div>
    <div class="detail-row"><span class="dr-label">Description</span><span class="dr-value">${escapeHtml(r.description)}</span></div>
    <div class="detail-row"><span class="dr-label">Amount</span><span class="dr-value">${money(r.amount)}</span></div>
    <div class="detail-row"><span class="dr-label">Date</span><span class="dr-value">${r.createdAt?.toDate ? formatDate(r.createdAt.toDate()) : '—'}</span></div>
    <div class="detail-row"><span class="dr-label">Status</span><span class="dr-value"><span class="badge ${r.paid ? 'badge-success' : 'badge-warning'}">${r.paid ? 'Paid' : 'Unpaid'}</span></span></div>
  `;
  document.getElementById('detailReceiptInput').value = '';
  document.getElementById('detailReceiptStatus').textContent = '';
  document.getElementById('expenseDetailModal').style.display = 'flex';

  const paths = receiptPathsOf(r);
  for (const path of paths) {
    try {
      const url = await storage.ref(path).getDownloadURL();
      const img = document.createElement('img');
      img.className = 'receipt-thumb';
      img.src = url;
      img.alt = 'Receipt photo';
      img.addEventListener('click', () => window.open(url, '_blank'));
      body.appendChild(img);
    } catch (err) {
      console.error(err);
    }
  }
}

document.getElementById('myExpenses').addEventListener('click', (e) => {
  const card = e.target.closest('[data-expense-detail]');
  if (card) openExpenseDetail(card.getAttribute('data-expense-detail'));
});

// Adding (not replacing) a receipt photo to an *already-submitted* expense — e.g. a receipt
// forgotten at submission time, or a second one for the same claim. Firestore rules only let the
// submitter touch receiptPaths on their own doc (see firestore.rules), nothing else — amount,
// description, paid status etc. stay locked to expensesAdmin regardless.
document.getElementById('detailReceiptInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  const id = _detailExpenseId;
  if (!files.length || !id) return;
  const statusEl = document.getElementById('detailReceiptStatus');
  statusEl.textContent = 'Uploading…';
  try {
    const newPaths = [];
    for (const file of files) {
      const blob = await compressReceiptImage(file);
      const compressed = blob !== file;
      const ext = compressed ? 'jpg' : (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `receipts/${firebase.auth().currentUser.uid}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await storage.ref(path).put(blob, compressed ? { contentType: 'image/jpeg' } : undefined);
      newPaths.push(path);
    }
    await db.collection('expenses').doc(id).update({
      receiptPaths: firebase.firestore.FieldValue.arrayUnion(...newPaths),
    });
    statusEl.textContent = '';
    e.target.value = '';
    // myExpensesCache updates via the live listener, but not necessarily before this runs —
    // re-render straight from the doc that was just written to rather than racing it.
    const doc = await db.collection('expenses').doc(id).get();
    if (doc.exists) {
      const idx = myExpensesCache.findIndex(x => x.id === id);
      const updated = { id, ...doc.data() };
      if (idx >= 0) myExpensesCache[idx] = updated; else myExpensesCache.push(updated);
      openExpenseDetail(id);
    }
  } catch (err) {
    statusEl.textContent = 'Could not upload: ' + err.message;
  }
});

// ── Receipt compression ─────────────────────────────────────────────────
// A receipt just needs to be readable, not print-quality — a straight-off-the-camera phone
// photo is routinely several MB for no real benefit here, so every upload gets resized/
// re-encoded as a JPEG capped at RECEIPT_MAX_DIMENSION on its longest side first. Falls back to
// uploading the original file untouched if anything about that goes wrong (unsupported format,
// browser quirk, etc.) rather than blocking the submission over it.

const RECEIPT_MAX_DIMENSION = 1000;
const RECEIPT_JPEG_QUALITY = 0.45;

function compressReceiptImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, RECEIPT_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', RECEIPT_JPEG_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
    img.src = objectUrl;
  });
}

// ── Add to list / Submit all ────────────────────────────────────────────
// "+ Add to list" stages an expense locally (receipts uploaded right away, so a mistake caught
// before Submit all can still be cleaned up from Storage) rather than writing it to Firestore
// immediately — lets several be built up and sent together in one go instead of one at a time.

let pendingExpenses = [];
let editingPendingId = null; // id of the pending item currently loaded into the form, or null
let editingRemovedReceiptPaths = []; // its receipts marked for removal, not yet actually deleted
let newReceiptFiles = []; // File objects picked in receiptInput but not yet uploaded/submitted
// Remembered across the whole session (not persisted) so adding several expenses in a row for
// the same show doesn't mean re-picking it every single time — set once a show's actually been
// used on a successful add, not just whatever's sitting in the dropdown mid-edit.
let lastSelectedShowId = '';

// The showmanager portal shell checks this (see canLeaveActiveApp in portal.js) before switching
// away to a different app/Home/Users — same-origin iframes let it just call this directly,
// no postMessage needed. Named generically so any app can opt into the same convention.
// Covers both: expenses already staged (pendingExpenses) *and* a fresh "Add expense" form
// that's been typed into but not even added to that list yet — editingPendingId is only set
// when the modal's open to edit an *existing* pending item, which pendingExpenses already covers.
window.hasUnsavedChanges = () => {
  if (pendingExpenses.length > 0) return true;
  const modal = document.getElementById('expenseModal');
  if (modal.style.display !== 'none' && editingPendingId === null) {
    const desc = document.getElementById('descInput').value.trim();
    const amount = document.getElementById('amountInput').value.trim();
    if (desc || amount || newReceiptFiles.length) return true;
  }
  return false;
};

// Closing the tab/refreshing with expenses staged-but-not-submitted would lose them (they only
// exist in pendingExpenses until Submit all actually writes them) — the browser's own generic
// confirm dialog lets the user cancel and stay. This part only covers an actual page unload
// (tab close/refresh/typing a new URL) — switching tabs/apps within the showmanager shell itself
// doesn't unload this iframe at all, that's what hasUnsavedChanges above is for.
window.addEventListener('beforeunload', (e) => {
  if (!pendingExpenses.length) return;
  e.preventDefault();
  e.returnValue = ''; // required by Chrome; the message itself is browser-controlled, not this string
});

// Shared full-size view every receipt thumbnail opens into (new-file preview, pending list,
// editing view) — same modal, each just brings its own onDelete for what "delete" actually
// means in that context (splice a not-yet-uploaded file / delete from Storage right away /
// defer the delete until Update item is clicked).
function openReceiptModal(src, onDelete) {
  document.getElementById('receiptViewImg').src = src;
  document.getElementById('receiptViewModal').style.display = 'flex';
  document.getElementById('receiptViewDeleteBtn').onclick = () => {
    if (!confirm('Delete this receipt photo?')) return;
    onDelete();
    closeReceiptModal();
  };
}
function closeReceiptModal() {
  document.getElementById('receiptViewModal').style.display = 'none';
  document.getElementById('receiptViewImg').src = '';
}
document.getElementById('receiptViewCloseBtn').addEventListener('click', closeReceiptModal);
document.getElementById('receiptViewModal').addEventListener('click', (e) => {
  if (e.target.id === 'receiptViewModal') closeReceiptModal();
});

// Fetches path's download URL and swaps it into an already-on-screen <img> (which starts with
// no src — see callers) — the actual clickable "picture" a receipt is viewed through, both in
// the pending list and the editing view's own thumbnails below. Not fetched inline into the
// list's own template string: getDownloadURL() is a network round-trip, and building the whole
// list's HTML can't wait on every receipt's URL before showing anything.
async function loadReceiptThumb(img, path, onDelete) {
  try {
    const url = await storage.ref(path).getDownloadURL();
    img.src = url;
    img.addEventListener('click', () => openReceiptModal(url, onDelete));
  } catch (err) {
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', style: 'font-size:12px', textContent: 'Receipt unavailable' }));
  }
}

function renderPendingList() {
  const section = document.getElementById('pendingSection');
  const list = document.getElementById('pendingList');
  if (!pendingExpenses.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  const total = pendingExpenses.reduce((sum, p) => sum + p.amount, 0);
  document.getElementById('submitAllBtn').textContent = `Submit all (${money(total)})`;
  list.innerHTML = pendingExpenses.map(p => `
    <div class="pending-item">
      <div class="pec-info">
        <div class="pec-desc">${escapeHtml(p.description)}</div>
        <div class="pec-detail">${escapeHtml(p.showName)}</div>
        ${p.receiptPaths.length ? `<div class="receipt-thumbs" data-pending-thumbs="${p.id}"></div>` : ''}
      </div>
      <div class="pec-right">
        <div class="pec-amount">${money(p.amount)}</div>
        <div style="display:flex;gap:6px">
          <button type="button" class="icon-btn" data-edit-pending="${p.id}" title="Edit" aria-label="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button type="button" class="icon-btn icon-btn-danger" data-remove-pending="${p.id}" title="Remove" aria-label="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>
  `).join('');

  pendingExpenses.forEach(p => {
    if (!p.receiptPaths.length) return;
    const container = list.querySelector(`[data-pending-thumbs="${p.id}"]`);
    p.receiptPaths.forEach(path => {
      const img = document.createElement('img');
      img.className = 'receipt-thumb-sm';
      img.alt = 'Receipt photo';
      container.appendChild(img);
      // Deletes for real, right away — this item isn't open for editing, there's no "Update
      // item"/Cancel step here to defer it to.
      loadReceiptThumb(img, path, async () => {
        try { await storage.ref(path).delete(); } catch (err) { /* already gone, fine */ }
        p.receiptPaths = p.receiptPaths.filter(rp => rp !== path);
        renderPendingList();
      });
    });
  });
}

// The one form, in a modal, for both adding a new expense (id omitted — #addExpenseBtn) and
// editing an already-staged one (id given — a pending item's own Edit): empty vs. pre-filled is
// the only difference, same fields, same submit handler either way.
function openExpenseModal(id) {
  const p = id ? pendingExpenses.find(x => x.id === id) : null;
  editingPendingId = p ? id : null;
  editingRemovedReceiptPaths = [];
  newReceiptFiles = [];
  document.getElementById('expenseForm').reset();
  document.getElementById('formStatus').textContent = '';
  document.getElementById('expenseModalTitle').textContent = p ? 'Edit expense' : 'Add expense';
  document.getElementById('submitBtn').textContent = p ? 'Save changes' : '+ Add to list';
  if (p) {
    document.getElementById('showSelect').value = p.showId;
    document.getElementById('descInput').value = p.description;
    document.getElementById('amountInput').value = p.amount;
  } else if (lastSelectedShowId) {
    document.getElementById('showSelect').value = lastSelectedShowId;
  }
  renderNewReceiptPreview();
  renderEditingExistingReceipts();
  document.getElementById('expenseModal').style.display = 'flex';
}
function closeExpenseModal() {
  document.getElementById('expenseModal').style.display = 'none';
}
document.getElementById('addExpenseBtn').addEventListener('click', () => openExpenseModal());
document.getElementById('expenseModalCloseBtn').addEventListener('click', closeExpenseModal);
document.getElementById('expenseModal').addEventListener('click', (e) => {
  if (e.target.id === 'expenseModal') closeExpenseModal();
});

function renderEditingExistingReceipts() {
  const el = document.getElementById('editingExistingReceipts');
  const remaining = pendingExpenses.find(x => x.id === editingPendingId)?.receiptPaths.filter(rp => !editingRemovedReceiptPaths.includes(rp)) || [];
  if (!remaining.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  el.innerHTML = remaining
    .map(rp => `<img class="receipt-thumb-sm" alt="Receipt photo" data-existing-thumb="${escapeHtml(rp)}">`)
    .join('');
  el.querySelectorAll('[data-existing-thumb]').forEach(img => {
    const rp = img.getAttribute('data-existing-thumb');
    // Deferred, not deleted from Storage here — the same as the old text-badge version, just
    // recorded so the eventual Update item / Cancel decides whether it actually happens.
    loadReceiptThumb(img, rp, () => {
      editingRemovedReceiptPaths.push(rp);
      renderEditingExistingReceipts();
    });
  });
}

// Local-only preview of files just picked, before they're uploaded anywhere — object URLs
// rather than a Storage round-trip, since there's nothing to fetch yet. Deleting one here just
// drops it from newReceiptFiles; nothing's been written anywhere for it to undo.
function renderNewReceiptPreview() {
  const el = document.getElementById('newReceiptPreview');
  el.innerHTML = '';
  newReceiptFiles.forEach((file) => {
    const url = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.className = 'receipt-thumb-sm';
    img.alt = 'Receipt photo';
    img.src = url;
    // Filtered out by reference, not index — an index captured here would go stale for every
    // thumbnail after whichever one actually gets deleted.
    img.addEventListener('click', () => openReceiptModal(url, () => {
      URL.revokeObjectURL(url);
      newReceiptFiles = newReceiptFiles.filter(f => f !== file);
      syncReceiptInput();
      renderNewReceiptPreview();
    }));
    el.appendChild(img);
  });
}
// The native <input type="file"> itself keeps whatever was last actually chosen through its own
// picker — deleting one via the thumbnail above only ever touched newReceiptFiles, so the input
// (and whatever text a browser shows next to it, e.g. "3 files") never noticed. DataTransfer is
// the only way to hand a file input a FileList it didn't get from the OS picker.
function syncReceiptInput() {
  const dt = new DataTransfer();
  newReceiptFiles.forEach(f => dt.items.add(f));
  document.getElementById('receiptInput').files = dt.files;
}
document.getElementById('receiptInput').addEventListener('change', (e) => {
  newReceiptFiles = Array.from(e.target.files || []);
  renderNewReceiptPreview();
});

// Just clears the form's own fields/state — closing the modal (or not) is up to the caller.
function resetExpenseForm() {
  editingPendingId = null;
  editingRemovedReceiptPaths = [];
  newReceiptFiles = [];
  document.getElementById('editingExistingReceipts').style.display = 'none';
  document.getElementById('editingExistingReceipts').innerHTML = '';
  document.getElementById('expenseForm').reset(); // clears receiptInput, but doesn't fire 'change' — renderNewReceiptPreview() below has to be called explicitly
  renderNewReceiptPreview();
}

document.getElementById('pendingList').addEventListener('click', (e) => {
  // .closest(), not .matches() — each icon-btn's actual click target is often its inner <svg>.
  // The receipt thumbnails themselves (data-pending-thumbs) have their own click handler wired
  // in loadReceiptThumb() as each one loads, not delegated here.
  const editBtn = e.target.closest('[data-edit-pending]');
  if (editBtn) {
    openExpenseModal(editBtn.getAttribute('data-edit-pending'));
    return;
  }
  const removeBtn = e.target.closest('[data-remove-pending]');
  if (!removeBtn) return;
  const id = removeBtn.getAttribute('data-remove-pending');
  const idx = pendingExpenses.findIndex(p => p.id === id);
  if (idx === -1) return;
  if (!confirm(`Remove "${pendingExpenses[idx].description}" from the list?`)) return;
  const [removed] = pendingExpenses.splice(idx, 1);
  removed.receiptPaths.forEach(p => storage.ref(p).delete().catch(() => {}));
  if (editingPendingId === id) closeExpenseModal();
  renderPendingList();
});

document.getElementById('expenseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('formStatus');
  const submitBtn = document.getElementById('submitBtn');
  const showSelect = document.getElementById('showSelect');
  const showId = showSelect.value;
  const showName = showSelect.selectedOptions[0]?.dataset.name || '';
  const description = document.getElementById('descInput').value.trim();
  const amount = Number(document.getElementById('amountInput').value);
  const files = newReceiptFiles;

  if (!showId) { statusEl.textContent = 'Please select a show.'; return; }
  if (!description) { statusEl.textContent = 'Please describe the expense.'; return; }
  if (!Number.isFinite(amount) || amount <= 0) { statusEl.textContent = 'Please enter a valid amount.'; return; }
  // A receipt is mandatory — newly-picked files count, and so does whatever's already attached
  // when editing a pending item (minus anything marked for removal) — only actually missing
  // when both of those are empty.
  const existingReceiptCount = editingPendingId
    ? (pendingExpenses.find(x => x.id === editingPendingId)?.receiptPaths.filter(rp => !editingRemovedReceiptPaths.includes(rp)).length || 0)
    : 0;
  if (!files.length && !existingReceiptCount) { statusEl.textContent = 'Please attach at least one receipt photo.'; return; }
  lastSelectedShowId = showId;

  const wasEditing = editingPendingId;
  submitBtn.disabled = true;
  statusEl.textContent = wasEditing ? 'Updating…' : 'Adding…';

  // New photos only — files picked here are in addition to whatever's already attached (shown
  // above the picker while editing), not a replacement for them.
  const newReceiptPaths = [];
  try {
    for (const file of files) {
      const blob = await compressReceiptImage(file);
      const compressed = blob !== file;
      const ext = compressed ? 'jpg' : (file.name.split('.').pop() || 'jpg').toLowerCase();
      // Path is receipts/{own uid}/... — storage.rules only lets an account read/write its own
      // uid folder (or a manager read any of them), so this has to be the uid, not anything
      // derived from the email.
      const path = `receipts/${firebase.auth().currentUser.uid}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await storage.ref(path).put(blob, compressed ? { contentType: 'image/jpeg' } : undefined);
      newReceiptPaths.push(path);
    }

    const p = wasEditing && pendingExpenses.find(x => x.id === wasEditing);
    if (p) {
      editingRemovedReceiptPaths.forEach(rp => storage.ref(rp).delete().catch(() => {}));
      p.showId = showId;
      p.showName = showName;
      p.description = description;
      p.amount = amount;
      p.receiptPaths = p.receiptPaths.filter(rp => !editingRemovedReceiptPaths.includes(rp)).concat(newReceiptPaths);
    } else {
      // Also the fallback if wasEditing was set but that item's gone (submitted/removed from
      // under it) — add it as new rather than silently dropping it.
      pendingExpenses.push({ id: crypto.randomUUID(), showId, showName, description, amount, receiptPaths: newReceiptPaths });
    }
    resetExpenseForm();
    closeExpenseModal();
    renderPendingList();

    statusEl.textContent = '';
    showToast(wasEditing ? 'Item updated' : 'Added to list', 'success');
  } catch (err) {
    console.error(err);
    newReceiptPaths.forEach(p => storage.ref(p).delete().catch(() => {}));
    statusEl.textContent = '';
    showToast(err.message || 'Could not save expense', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('submitAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('submitAllBtn');
  btn.disabled = true;
  const failed = [];
  const submittedIds = [];
  for (const p of pendingExpenses) {
    try {
      // A short, sequential reference number (independent of the doc's own id) — same
      // shared-counter-in-a-transaction pattern as showdrinks' orderNumber — so a player or
      // treasurer can quote "expense #123" instead of a Firestore doc id.
      const counterRef = db.collection('expenses_counters').doc('global');
      const ref = db.collection('expenses').doc();
      let referenceNumber;
      await db.runTransaction(async t => {
        const cDoc = await t.get(counterRef);
        referenceNumber = (cDoc.exists ? (cDoc.data().next || 0) : 0) + 1;
        t.set(counterRef, { next: referenceNumber }, { merge: true });
        t.set(ref, {
          showId: p.showId,
          showName: p.showName,
          description: p.description,
          amount: p.amount,
          userName: state.name,
          userEmail: state.email,
          receiptPaths: p.receiptPaths,
          referenceNumber,
          paid: false,
          paidAt: null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      submittedIds.push(ref.id);
    } catch (err) {
      console.error(err);
      failed.push(p);
    }
  }
  pendingExpenses = failed;
  // Submit all doesn't go through the form's own submit handler, so nothing else clears
  // editingPendingId — left set, the form would silently misbehave on the very next "+ Add to
  // list": it'd try to update an item that's just been submitted and no longer exists, instead
  // of adding a new one.
  resetExpenseForm();
  renderPendingList();
  btn.disabled = false;
  showToast(
    failed.length ? `${failed.length} expense${failed.length === 1 ? '' : 's'} failed to submit — still in the list, try again.` : 'Submitted — thank you!',
    failed.length ? 'error' : 'success'
  );
  // One summary email covering the whole batch, not one per expense — managers don't need a
  // separate email for each line of a multi-expense submission.
  if (submittedIds.length) {
    functionsRegion.httpsCallable('notifyExpensesSubmitted')({ ids: submittedIds }).catch(err => console.error(err));
  }
  // The live listener in subscribeMyExpenses picks each of these up as soon as its write lands.
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
    const res = await fetch('../shared/version.js?_=' + Date.now(), { cache: 'no-store' });
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

// ── Bootstrap ────────────────────────────────────────────────────────────

initServiceWorker();
document.getElementById('appVersion').textContent = typeof APP_VERSION !== 'undefined' ? `v${APP_VERSION}` : '';
loadShows();
