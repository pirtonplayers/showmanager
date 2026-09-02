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

// ── The shell ────────────────────────────────────────────────────────────
// One generalised menu strip + one generalised work area for the whole suite. Picking Dashboard
// or Users shows a native pane; picking an app shows (creating on first visit) an iframe onto
// that app's own existing page, left alive from then on so switching back is instant. The app's
// own header/sidebar are hidden inside the iframe (shared/embed.js) — this strip is the only
// nav visible once you're signed in, anywhere in showmanager.

let activeKey = 'dashboard'; // 'dashboard' | 'users' | an ACCESS_APPS[].key
const lastTab = {};          // ACCESS_APPS[].key -> last APP_SUBNAV tab id chosen for it
const frames = {};           // ACCESS_APPS[].key -> its <iframe>, created lazily

function activatePane(key) {
  document.querySelectorAll('.work-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + key));
  Object.entries(frames).forEach(([k, frame]) => frame.classList.toggle('active', k === key));
}

// expandedKeys tracks which app's sub-menu is shown open in the nav — independent of activeKey
// (which app's content is showing in the work area). Exclusive: opening a different app closes
// whichever other one was expanded. Clicking the already-active app's name again just toggles
// its own menu without switching the work area.
const expandedKeys = new Set();

function activateApp(key) {
  activeKey = key;
  expandedKeys.clear();
  if (key !== 'dashboard' && key !== 'users') expandedKeys.add(key);
  if (key === 'dashboard' || key === 'users') {
    activatePane(key);
    renderShellNav();
    return;
  }
  const app = ACCESS_APPS.find(a => a.key === key);
  if (!app) return;
  activatePane(null); // hides every native pane and every other iframe

  let frame = frames[key];
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'shell-frame';
    frame.title = app.label;
    frame.src = app.href;
    // Only postMessage the starting tab once this fresh iframe has actually loaded and had a
    // chance to register its own message listener (shared/embed.js) — an earlier message would
    // just be missed.
    frame.addEventListener('load', () => activateTab(key, lastTab[key] || APP_SUBNAV[key]?.[0]?.id));
    document.getElementById('workAreaFrames').appendChild(frame);
    frames[key] = frame;
  } else if (lastTab[key]) {
    activateTab(key, lastTab[key]);
  }
  frame.classList.add('active');
  renderShellNav();
}

function activateTab(key, tabId) {
  lastTab[key] = tabId;
  const tab = APP_SUBNAV[key]?.find(t => t.id === tabId);
  const frame = frames[key];
  if (tab && frame?.contentWindow) {
    frame.contentWindow.postMessage({ source: 'showmanager-shell', type: 'activateTab', selector: tab.selector }, '*');
  }
  if (key === activeKey) renderShellNav();
}

function renderShellNav() {
  if (!currentAccount) return;
  const apps = accessibleApps(currentAccount);
  let html = `<button class="tab-btn nav-app-btn${activeKey === 'dashboard' ? ' active' : ''}" data-pane="dashboard">Dashboard</button>`;
  if (currentAccount.isManager) {
    html += `<button class="tab-btn nav-app-btn${activeKey === 'users' ? ' active' : ''}" data-pane="users">Users</button>`;
  }
  html += '<div class="dropdown-divider"></div>';
  for (const app of apps) {
    // The app name highlights whenever its content is showing (activeKey), regardless of
    // whether its own sub-menu is currently expanded (expandedKeys) — those are separate, and
    // more than one app's menu can be open at once.
    const isActiveContent = app.key === activeKey;
    const isExpanded = expandedKeys.has(app.key);
    html += `<button class="tab-btn nav-app-btn${isActiveContent ? ' active' : ''}" data-app="${app.key}">${escapeHtml(app.label)}</button>`;
    if (isExpanded) {
      const tabs = APP_SUBNAV[app.key] || [];
      const current = lastTab[app.key] || tabs[0]?.id;
      html += '<div class="suite-current-section">' + tabs.map(t => `
        <button class="tab-btn${t.id === current ? ' active' : ''}" data-app="${app.key}" data-subtab="${t.id}">${escapeHtml(t.label)}</button>
      `).join('') + '</div>';
    }
  }
  html += '<div class="dropdown-divider"></div><button class="tab-btn signout-btn">Sign Out</button>';
  document.getElementById('shellNavSidebar').innerHTML = html;
  document.getElementById('shellNavDropdown').innerHTML = html;
}

function handleNavClick(e) {
  if (e.target.closest('.signout-btn')) { firebase.auth().signOut(); return; }
  const btn = e.target.closest('[data-pane],[data-app]');
  if (!btn) return;
  if (btn.dataset.pane) {
    activateApp(btn.dataset.pane);
  } else if (btn.dataset.subtab) {
    activateTab(btn.dataset.app, btn.dataset.subtab);
  } else if (btn.dataset.app === activeKey) {
    // Already showing this app's content — clicking its name again just toggles its own menu
    // open/closed, leaving the work area and every other app's menu exactly as they are.
    if (expandedKeys.has(btn.dataset.app)) expandedKeys.delete(btn.dataset.app);
    else expandedKeys.add(btn.dataset.app);
    renderShellNav();
  } else {
    // A different app — switch the work area to it. Its menu opens too (activateApp), but
    // nobody else's closes.
    activateApp(btn.dataset.app);
  }
  document.getElementById('shellNavDropdown').classList.remove('open');
}
document.getElementById('shellNavSidebar').addEventListener('click', handleNavClick);
document.getElementById('shellNavDropdown').addEventListener('click', handleNavClick);

document.getElementById('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('shellNavDropdown').classList.toggle('open');
});
document.addEventListener('click', () => { document.getElementById('shellNavDropdown').classList.remove('open'); });

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
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('changePasswordEmailText').textContent = user.email;

    if (data.mustChangePassword) {
      document.getElementById('adminApp').style.display = 'none';
      document.getElementById('changePasswordScreen').style.display = 'flex';
    } else {
      document.getElementById('changePasswordScreen').style.display = 'none';
      document.getElementById('adminApp').style.display = 'block';
      renderTiles(data);
      renderShellNav();
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
    // Drop every app iframe on sign-out — otherwise a different account signing in on the same
    // browser would (briefly, until each iframe's own auth listener catches up) still be sitting
    // in front of whatever the previous account had open.
    Object.values(frames).forEach(f => f.remove());
    Object.keys(frames).forEach(k => delete frames[k]);
    Object.keys(lastTab).forEach(k => delete lastTab[k]);
    activeKey = 'dashboard';
    expandedKeys.clear();
  }
});

// ── Dashboard tiles ──────────────────────────────────────────────────────

function renderTiles(data) {
  const apps = accessibleApps(data);
  // Buttons, not links — clicking activates the app in the shell's own work area (see
  // activateApp), never a page navigation.
  document.getElementById('tileGrid').innerHTML = apps.map(a => `
    <button class="app-tile" type="button" data-app="${a.key}">
      <span class="at-emoji">${TILE_META[a.key]?.emoji || '📄'}</span>
      <span class="at-name">${escapeHtml(a.label)}</span>
      <span class="at-desc">${escapeHtml(TILE_META[a.key]?.desc || '')}</span>
    </button>
  `).join('');
  document.getElementById('noAccessNote').style.display = apps.length ? 'none' : 'block';
}
document.getElementById('tileGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-app]');
  if (btn) activateApp(btn.dataset.app);
});

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
