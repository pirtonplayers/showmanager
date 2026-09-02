'use strict';

const functionsRegion = firebase.app().functions('europe-west1');

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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

// Tile metadata for the dashboard — ACCESS_APPS (shared/auth.js) gives the key/label/href every
// app agrees on; this just adds the emoji/description for the portal's own display.
const TILE_META = {
  expenses:        { emoji: '🧾', desc: 'Submit a show expense for reimbursement.' },
  expensesAdmin:   { emoji: '💷', desc: 'Review, pay and report on submitted expenses.' },
  showdrinksAdmin: { emoji: '🍹', desc: 'Manage shows, menu, orders and Show Tabs.' },
  budget:          { emoji: '📊', desc: 'Plan and track show budgets.' },
};

// ── Tabs / menu / sidebar (same pattern as every other admin.html) ─────────

function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => { switchTab(btn.dataset.tab); document.getElementById('mainMenuDropdown').style.display = 'none'; });
});

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
applySidebarState(localStorage.getItem('portal_sidebar_collapsed') === '1');
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarState(collapsed);
  localStorage.setItem('portal_sidebar_collapsed', collapsed ? '1' : '0');
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

let currentAccount = null;
let dashboardInitialized = false;

// No app-specific access key required to reach the portal itself — every provisioned account
// (any access flag, or isManager) can sign in here to see what it has and, if a manager, manage
// everyone else's access.
firebase.auth().onAuthStateChanged(async user => {
  if (user) {
    const data = await checkAccess(user.uid).catch(() => null);
    if (!data) {
      await firebase.auth().signOut();
      document.getElementById('loginError').textContent = 'This account is not set up — ask a manager to create it.';
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('authGate').style.display = 'none';
      return;
    }
    currentAccount = data;
    mountSuiteNav(data, null, '');
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('changePasswordEmailText').textContent = user.email;

    if (data.mustChangePassword) {
      document.getElementById('adminApp').style.display = 'none';
      document.getElementById('changePasswordScreen').style.display = 'flex';
    } else {
      document.getElementById('changePasswordScreen').style.display = 'none';
      document.getElementById('adminApp').style.display = 'block';
      document.getElementById('usersNavBtn').style.display = data.isManager ? '' : 'none';
      document.getElementById('usersNavBtnSidebar').style.display = data.isManager ? '' : 'none';
      renderTiles(data);
      if (!dashboardInitialized) {
        dashboardInitialized = true;
        document.getElementById('headerVersion').textContent = typeof APP_VERSION !== 'undefined' ? `v${APP_VERSION}` : '';
        if (data.isManager) await loadUsers();
      }
    }
  } else {
    currentAccount = null;
    dashboardInitialized = false;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('changePasswordScreen').style.display = 'none';
    document.getElementById('adminApp').style.display = 'none';
    document.getElementById('changePasswordForm').reset();
    document.getElementById('authGate').style.display = 'none';
  }
});

// ── Dashboard tiles ──────────────────────────────────────────────────────

function renderTiles(data) {
  const apps = ACCESS_APPS.filter(a => data.isManager || data.access?.[a.key]);
  document.getElementById('tileGrid').innerHTML = apps.map(a => `
    <a class="app-tile" href="${a.href}">
      <span class="at-emoji">${TILE_META[a.key]?.emoji || '📄'}</span>
      <span class="at-name">${escapeHtml(a.label)}</span>
      <span class="at-desc">${escapeHtml(TILE_META[a.key]?.desc || '')}</span>
    </a>
  `).join('');
  document.getElementById('noAccessNote').style.display = apps.length ? 'none' : 'block';
}

// ── Users (isManager only) ──────────────────────────────────────────────

let allUsers = [];

function accessCheckboxesHtml(idPrefix, access = {}) {
  return `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:6px">
      <input type="checkbox" id="${idPrefix}-isManager"> Manager (all apps, manages users)
    </label>
    ${ACCESS_APPS.map(a => `
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:6px">
        <input type="checkbox" id="${idPrefix}-${a.key}" ${access[a.key] ? 'checked' : ''}> ${escapeHtml(a.label)}
      </label>
    `).join('')}`;
}

document.getElementById('newUserAccessList').innerHTML = accessCheckboxesHtml('newUser');

async function loadUsers() {
  try {
    const snap = await db.collection('users').get();
    allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  renderUserList();
}

function renderUserList() {
  const currentUid = firebase.auth().currentUser?.uid;
  const search = document.getElementById('userSearchInput').value.trim().toLowerCase();
  const rows = allUsers.filter(u => !search || u.name?.toLowerCase().includes(search) || u.email?.toLowerCase().includes(search));

  document.getElementById('userList').innerHTML = rows.map(u => `
    <div class="item-row" style="flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="item-name">${escapeHtml(u.name || u.email)}</div>
        <div class="item-sub">${escapeHtml(u.email)}</div>
      </div>
      <div class="access-flags item-actions">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px">
          <input type="checkbox" data-toggle="${u.id}:isManager" ${u.isManager ? 'checked' : ''} ${u.id === currentUid ? 'disabled title="You can\'t change your own Manager status"' : ''}> Manager
        </label>
        ${ACCESS_APPS.map(a => `
          <label style="display:flex;align-items:center;gap:5px;font-size:12px">
            <input type="checkbox" data-toggle="${u.id}:access.${a.key}" ${u.access?.[a.key] ? 'checked' : ''} ${u.isManager ? 'disabled title="Managers already have every app"' : ''}> ${escapeHtml(a.label)}
          </label>
        `).join('')}
        <button class="btn btn-danger btn-sm" data-delete-user="${u.id}" ${u.id === currentUid ? 'disabled title="You can\'t delete your own account this way"' : ''}>Delete</button>
      </div>
    </div>
  `).join('') || '<p class="empty-state">No registered users yet.</p>';
}
document.getElementById('userSearchInput').addEventListener('input', renderUserList);

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('addUserError');
  const btn = document.getElementById('addUserBtn');
  errorEl.textContent = '';
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value.trim();
  const isManager = document.getElementById('newUser-isManager').checked;
  const access = {};
  ACCESS_APPS.forEach(a => { access[a.key] = document.getElementById(`newUser-${a.key}`).checked; });

  btn.disabled = true;
  try {
    await functionsRegion.httpsCallable('createUser')({ name, email, password, isManager, access });
    document.getElementById('addUserForm').reset();
    document.getElementById('newUserAccessList').innerHTML = accessCheckboxesHtml('newUser');
    showToast(`Account created for ${name} — pass on the temporary password`, 'success');
    await loadUsers();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('resyncClaimsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('resyncClaimsBtn');
  btn.disabled = true;
  try {
    const result = await functionsRegion.httpsCallable('resyncExpensesAdminClaims')();
    showToast(`Synced ${result.data.updated} account(s) — anyone freshly affected needs to sign out and back in to pick it up.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('userList').addEventListener('change', async (e) => {
  const key = e.target.getAttribute('data-toggle');
  if (!key) return;
  const [id, field] = key.split(':');
  const checked = e.target.checked;
  try {
    if (field === 'isManager') {
      const user = allUsers.find(u => u.id === id);
      const verb = checked ? 'give Manager access to' : 'remove Manager access from';
      if (!confirm(`Are you sure you want to ${verb} ${user?.name || user?.email}? Manager can manage every app and every user.`)) {
        e.target.checked = !checked;
        return;
      }
      await db.collection('users').doc(id).update({ isManager: checked });
    } else {
      await db.collection('users').doc(id).update({ [field]: checked });
    }
    showToast('Updated', 'success');
    await loadUsers();
  } catch (err) {
    e.target.checked = !checked;
    showToast(err.message, 'error');
  }
});

document.getElementById('userList').addEventListener('click', async (e) => {
  if (!e.target.matches('[data-delete-user]')) return;
  const id = e.target.getAttribute('data-delete-user');
  const user = allUsers.find(u => u.id === id);
  if (!confirm(`Permanently delete ${user?.name || user?.email}? They'll lose their login to every app. Their past expenses/orders are kept.`)) return;
  e.target.disabled = true;
  try {
    await functionsRegion.httpsCallable('deleteUser')({ uid: id });
    showToast('User deleted', 'success');
    await loadUsers();
  } catch (err) {
    e.target.disabled = false;
    showToast(err.message, 'error');
  }
});

// ── Service worker update banner (same pattern as every other app) ─────────

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
