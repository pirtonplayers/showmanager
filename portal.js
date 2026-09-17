'use strict';

const functionsRegion = firebase.app().functions('europe-west1');

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared .icon-btn glyphs (Feather-style, matching the outline icons used elsewhere in the
// suite) — used in place of a text label for a row's Edit/Delete actions. (Copy link's icon is
// inlined directly in index.html's static markup, not rendered from here.)
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
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
  expenses:          { emoji: '🧾', desc: 'Submit a show expense for reimbursement.' },
  expensesAdmin:     { emoji: '💷', desc: 'Review, pay and report on submitted expenses.' },
  showdrinksAdmin:   { emoji: '🍹', desc: 'Manage shows, menu, orders and Show Tabs.' },
  showdrinksTabsPos: { emoji: '🍺', desc: 'Take orders against a cast/crew member\'s tab.' },
  budget:            { emoji: '📊', desc: 'Plan and track show budgets.' },
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
// Whether each app's iframe has fired its own 'load' event at least once — tracked separately
// from lastTab because an app with no APP_SUBNAV entries (e.g. showdrinksTabsPos, a single-screen
// view with no sub-tabs) never gets a truthy lastTab[key], which used to be what "ready" meant;
// that left activateApp() showing the loading overlay every time with nothing left to hide it,
// since a preloaded iframe that already finished loading won't fire 'load' again.
const loadedFrames = new Set(); // ACCESS_APPS[].key

function activatePane(key) {
  // <main> itself (not just which .work-pane is active inside it) has to hide when an app
  // iframe is showing instead — its own padding stuck around empty otherwise, a blank white
  // strip between the header and the iframe below it even with every pane inactive.
  document.getElementById('workArea').style.display = key ? '' : 'none';
  document.querySelectorAll('.work-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + key));
  Object.entries(frames).forEach(([k, frame]) => frame.classList.toggle('active', k === key));
}

// Gives whichever app is currently active a chance to say "not yet" before the shell switches
// away from it — e.g. expenses' own staged-but-unsubmitted list, which lives only in that
// iframe's memory and would otherwise be lost with no warning (its own beforeunload only covers
// closing/refreshing the whole tab, not switching to a different app in here). Same-origin
// iframes let this just call straight into the iframe's own window — no postMessage round trip
// needed. Any app can opt in by defining window.hasUnsavedChanges() on itself; apps that don't
// (or aren't even loaded yet) are simply always safe to leave.
//
// A hard block, not a "leave anyway?" confirm — an unsubmitted expense (say) must not be
// leavable by mis-tapping through a dialog. Wired into every escape route out of the shell: the
// tile grid, nav menu, Home button, Switch user, and the header's Pirton Players website link.
function canLeaveActiveApp() {
  const check = frames[activeKey]?.contentWindow?.hasUnsavedChanges;
  if (typeof check !== 'function') return true;
  let unsaved = false;
  try { unsaved = !!check(); } catch { /* treat as safe to leave if the check itself errors */ }
  // A plain fire-and-forget show — the block itself doesn't wait on the user dismissing this,
  // it's already decided (unlike a confirm(), there's no choice to make here).
  if (unsaved) document.getElementById('unsavedWorkModal').style.display = 'flex';
  return !unsaved;
}

// Creates (and starts loading) an app's iframe if it doesn't exist yet, without touching
// activeKey/panes/nav — shared by activateApp (on-demand, the first time someone opens an app)
// and preloadApps (proactive, right after sign-in, for every app the account can reach) so the
// same iframe just happens to already be loading by the time someone actually clicks its tile.
function ensureFrame(key) {
  let frame = frames[key];
  if (frame) return frame;
  const app = ACCESS_APPS.find(a => a.key === key);
  if (!app) return null;
  frame = document.createElement('iframe');
  frame.className = 'shell-frame';
  frame.title = app.label;
  frame.src = app.href;
  // Only postMessage the starting tab once this fresh iframe has actually loaded and had a
  // chance to register its own message listener (shared/embed.js) — an earlier message would
  // just be missed. Only hides the loading overlay if we're still looking at this app when it
  // finishes — a preloaded app's own 'load' event can fire long after the user's moved on.
  frame.addEventListener('load', () => {
    loadedFrames.add(key);
    activateTab(key, lastTab[key] || APP_SUBNAV[key]?.[0]?.id);
    if (key === activeKey) hideAppLoadingOverlay();
  });
  document.getElementById('workAreaFrames').appendChild(frame);
  frames[key] = frame;
  return frame;
}

function showAppLoadingOverlay(label) {
  document.getElementById('appLoadingMessage').textContent = `Loading ${label}…`;
  document.getElementById('appLoadingOverlay').classList.add('active');
}
function hideAppLoadingOverlay() {
  document.getElementById('appLoadingOverlay').classList.remove('active');
}

// Fired once, right after sign-in — starts every accessible app's iframe loading in the
// background (dashboard stays responsive immediately) so opening one later, most of the time,
// finds it already warm instead of paying its full cold-start cost right when it's wanted.
function preloadApps() {
  if (!currentAccount) return;
  accessibleApps(currentAccount).forEach(a => ensureFrame(a.key));
}

function activateApp(key) {
  if (key !== activeKey && !canLeaveActiveApp()) return;
  activeKey = key;
  if (key === 'dashboard' || key === 'users') {
    activatePane(key);
    renderShellNav();
    hideAppLoadingOverlay();
    return;
  }
  const app = ACCESS_APPS.find(a => a.key === key);
  if (!app) return;
  activatePane(null); // hides every native pane and every other iframe

  const alreadyReady = loadedFrames.has(key);
  const frame = ensureFrame(key);
  if (!frame) return;
  if (alreadyReady) {
    if (lastTab[key]) activateTab(key, lastTab[key]);
    hideAppLoadingOverlay();
  } else {
    showAppLoadingOverlay(app.label);
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

// Two very different menus depending on where you are, not one big list mixing both:
// - At Dashboard/Users ("the showmanager menu"): just Users (if manager) and Switch user — the
//   Dashboard's own tile grid is how you reach an app, not this menu.
// - Inside a specific app: only that app's own tabs (APP_SUBNAV[activeKey]) — nothing else.
// The header's Home button (not this menu) is how you always get back to Dashboard from inside
// an app, so there's no "Dashboard" entry to duplicate that here either.
function renderShellNav() {
  if (!currentAccount) return;
  let html;
  if (activeKey === 'dashboard' || activeKey === 'users') {
    html = '';
    if (currentAccount.isManager) {
      html += `<button class="tab-btn nav-app-btn${activeKey === 'users' ? ' active' : ''}" data-pane="users">Users</button>`;
      html += '<div class="dropdown-divider"></div>';
    }
    html += `<button type="button" class="tab-btn nav-app-btn" data-action="switch-user">Switch user</button>`;
  } else {
    const tabs = APP_SUBNAV[activeKey] || [];
    const current = lastTab[activeKey] || tabs[0]?.id;
    html = tabs.map(t => `
      <button class="tab-btn${t.id === current ? ' active' : ''}" data-app="${activeKey}" data-subtab="${t.id}">${escapeHtml(t.label)}</button>
    `).join('');
  }
  document.getElementById('shellNavSidebar').innerHTML = html;
  document.getElementById('shellNavDropdown').innerHTML = html;
}

function handleNavClick(e) {
  if (e.target.closest('[data-action="switch-user"]')) {
    if (canLeaveActiveApp() && confirm('Sign out and switch to a different login?')) firebase.auth().signOut();
  } else {
    const btn = e.target.closest('[data-pane],[data-subtab]');
    if (!btn) return;
    if (btn.dataset.pane) activateApp(btn.dataset.pane);
    // A subtab click doesn't leave the app's iframe (it's the same document, just telling it to
    // show a different one of its own screens) — but it does navigate the view away from
    // whatever's currently showing there, which is exactly what canLeaveActiveApp() exists to
    // guard, same as leaving the app entirely.
    else if (canLeaveActiveApp()) activateTab(btn.dataset.app, btn.dataset.subtab);
  }
  document.getElementById('shellNavDropdown').classList.remove('open');
}
document.getElementById('shellNavSidebar').addEventListener('click', handleNavClick);
document.getElementById('shellNavDropdown').addEventListener('click', handleNavClick);

document.getElementById('homeBtn').addEventListener('click', () => activateApp('dashboard'));

// Opens in a new tab (this one keeps running either way), but blocked the same as every other
// escape route while there's unsaved work — see canLeaveActiveApp.
document.getElementById('pirtonPlayersLink').addEventListener('click', (e) => {
  if (!canLeaveActiveApp()) e.preventDefault();
});

document.getElementById('unsavedWorkModalOkBtn').addEventListener('click', () => {
  document.getElementById('unsavedWorkModal').style.display = 'none';
});
document.getElementById('unsavedWorkModal').addEventListener('click', (e) => {
  if (e.target.id === 'unsavedWorkModal') document.getElementById('unsavedWorkModal').style.display = 'none';
});

document.getElementById('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = document.getElementById('shellNavDropdown').classList.toggle('open');
  // See body.menu-open in style.css — a full-viewport tap target, so there's always somewhere
  // to tap to close this even when the menu itself runs taller than the screen on a phone.
  document.body.classList.toggle('menu-open', open);
});
document.addEventListener('click', () => {
  document.getElementById('shellNavDropdown').classList.remove('open');
  document.body.classList.remove('menu-open');
});

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
      preloadApps();
      if (!dashboardInitialized) {
        dashboardInitialized = true;
        document.getElementById('headerVersion').textContent = typeof APP_VERSION !== 'undefined' ? `v${APP_VERSION}` : '';
        if (data.isManager) { await loadPortalSettings(); await loadUsers(); }
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

// Manager stays its own checkbox (a different kind of thing — portal-level, manages every app
// and every user — not just "another app to pick"); the apps themselves are one checkbox each.
// disableManagerTitle guards against self-demotion when this same picker is reused to edit your
// own account (see openEditUserModal) — pass a tooltip explaining why to disable it, or '' to
// leave it enabled (adding a user, or editing someone else).
function accessPickerHtml(idPrefix, access = {}, disableManagerTitle = '') {
  return `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px">
      <input type="checkbox" id="${idPrefix}-isManager" ${access.isManager ? 'checked' : ''} ${disableManagerTitle ? `disabled title="${escapeHtml(disableManagerTitle)}"` : ''}> Manager (all apps, manages users)
    </label>
    <div style="display:flex;flex-wrap:wrap;gap:14px">
      ${ACCESS_APPS.map(a => `
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="checkbox" class="${idPrefix}-app-cb" value="${a.key}" ${access[a.key] ? 'checked' : ''}> ${escapeHtml(a.label)}
        </label>
      `).join('')}
    </div>`;
}

function readAccessPicker(idPrefix) {
  const access = {};
  document.querySelectorAll(`.${idPrefix}-app-cb`).forEach(cb => { access[cb.value] = cb.checked; });
  return access;
}

document.getElementById('newUserAccessList').innerHTML = accessPickerHtml('newUser');

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

  document.getElementById('userList').innerHTML = rows.map(u => {
    const isSelf = u.id === currentUid;
    return `
    <div class="item-row" style="flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="item-name">${escapeHtml(u.name || u.email)}</div>
        <div class="item-sub">${escapeHtml(u.email)}</div>
      </div>
      <div class="item-actions">
        <button class="btn btn-secondary btn-sm" data-send-link="${u.id}">Send link</button>
        <button class="icon-btn" data-edit-user="${u.id}" title="Edit" aria-label="Edit">${ICON_EDIT}</button>
        <button class="icon-btn icon-btn-danger" data-delete-user="${u.id}" ${isSelf ? 'disabled title="You can\'t delete your own account this way"' : 'title="Delete" aria-label="Delete"'}>${ICON_TRASH}</button>
      </div>
    </div>
  `;
  }).join('') || '<p class="empty-state">No registered users yet.</p>';
}
document.getElementById('userSearchInput').addEventListener('input', renderUserList);

// One modal, two modes — _editingUserId null means "add", set means "edit that user". Reused
// rather than a separate edit form since the fields (name, email, access picker) are the same;
// only the temp password (meaningless once the Firebase Auth account already exists) and the
// submit action differ.
let _editingUserId = null;

function openAddUserModal() {
  _editingUserId = null;
  document.getElementById('userModalTitle').textContent = 'Add a user';
  document.getElementById('addUserBtn').textContent = '+ Add user';
  document.getElementById('addUserForm').reset();
  document.getElementById('newUserCreateOnlyFields').style.display = '';
  resetMemberPicker();
  document.getElementById('newUserAccessList').innerHTML = accessPickerHtml('newUser');
  document.getElementById('addUserError').textContent = '';
  document.getElementById('addUserModal').style.display = 'flex';
  loadMemberDirectory();
}

function openEditUserModal(id) {
  const user = allUsers.find(u => u.id === id);
  if (!user) return;
  const isSelf = user.id === firebase.auth().currentUser?.uid;
  _editingUserId = id;
  document.getElementById('userModalTitle').textContent = 'Edit user';
  document.getElementById('addUserBtn').textContent = 'Save changes';
  document.getElementById('addUserForm').reset();
  document.getElementById('newUserName').value = user.name || '';
  document.getElementById('newUserEmail').value = user.email || '';
  document.getElementById('newUserCreateOnlyFields').style.display = 'none';
  // Editing an existing user is always direct Name/Email — the member picker only applies when
  // creating (see resetMemberPicker/applyMemberPick below).
  document.getElementById('newUserMemberPickRow').style.display = 'none';
  document.getElementById('newUserNameRow').style.display = '';
  document.getElementById('newUserEmailRow').style.display = '';
  document.getElementById('newUserAccessList').innerHTML = accessPickerHtml('newUser',
    { ...user.access, isManager: user.isManager },
    isSelf ? "You can't change your own Manager status" : '');
  document.getElementById('addUserError').textContent = '';
  document.getElementById('addUserModal').style.display = 'flex';
}

// ── Member picker (Add user only) — same members list Bar Tabs POS uses ────────────────────

let _memberDirectory = null; // null = not loaded yet; [] is a valid "loaded, empty" state

async function loadMemberDirectory() {
  if (_memberDirectory) { renderMemberPickerOptions(); return; }
  try {
    const snap = await db.collection('showdrinks_tabMembers').orderBy('name').get();
    _memberDirectory = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMemberPickerOptions();
  } catch (err) {
    showToast('Could not load members: ' + err.message, 'error');
  }
}

function renderMemberPickerOptions() {
  const sel = document.getElementById('newUserMemberSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— choose —</option>' +
    (_memberDirectory || []).map(m =>
      `<option value="${m.id}">${escapeHtml(m.name)}${m.email ? ` (${escapeHtml(m.email)})` : ''}</option>`).join('');
  sel.value = cur;
}

function resetMemberPicker() {
  document.getElementById('newUserMemberPickRow').style.display = '';
  document.getElementById('newUserNameRow').style.display = 'none';
  document.getElementById('newUserEmailRow').style.display = 'none';
  document.getElementById('newUserMemberSelect').value = '';
}

document.getElementById('newUserMemberSelect').addEventListener('change', () => {
  const member = (_memberDirectory || []).find(m => m.id === document.getElementById('newUserMemberSelect').value);
  if (!member) return;
  document.getElementById('newUserName').value = member.name || '';
  document.getElementById('newUserEmail').value = member.email || '';
});

document.getElementById('newUserManualEntryLink').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('newUserMemberPickRow').style.display = 'none';
  document.getElementById('newUserNameRow').style.display = '';
  document.getElementById('newUserEmailRow').style.display = '';
  document.getElementById('newUserName').value = '';
  document.getElementById('newUserEmail').value = '';
  document.getElementById('newUserName').focus();
});

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('addUserError');
  const btn = document.getElementById('addUserBtn');
  errorEl.textContent = '';
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const isManager = document.getElementById('newUser-isManager').checked;
  const access = readAccessPicker('newUser');
  if (!name) { errorEl.textContent = 'Enter a name.'; return; }
  if (!email) { errorEl.textContent = 'Enter an email.'; return; }

  btn.disabled = true;
  try {
    if (_editingUserId) {
      const user = allUsers.find(u => u.id === _editingUserId);
      if (isManager !== !!user?.isManager) {
        const verb = isManager ? 'give Manager access to' : 'remove Manager access from';
        if (!confirm(`Are you sure you want to ${verb} ${user?.name || user?.email}? Manager can manage every app and every user.`)) {
          btn.disabled = false;
          return;
        }
      }
      await functionsRegion.httpsCallable('updateUserProfile')({ uid: _editingUserId, name, email, isManager, access });
      document.getElementById('addUserModal').style.display = 'none';
      showToast('Updated', 'success');
    } else {
      const password = document.getElementById('newUserPassword').value.trim();
      if (!password || password.length < 6) { errorEl.textContent = 'Enter a temporary password (6+ characters).'; btn.disabled = false; return; }
      await functionsRegion.httpsCallable('createUser')({ name, email, password, isManager, access });
      document.getElementById('addUserModal').style.display = 'none';
      showToast(`Account created for ${name} — pass on the temporary password`, 'success');
    }
    await loadUsers();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('openAddUserBtn').addEventListener('click', openAddUserModal);
document.getElementById('addUserModalCloseBtn').addEventListener('click', () => {
  document.getElementById('addUserModal').style.display = 'none';
});
document.getElementById('addUserModal').addEventListener('click', (e) => {
  if (e.target.id === 'addUserModal') document.getElementById('addUserModal').style.display = 'none';
});

document.getElementById('openDefaultLinkMessageBtn').addEventListener('click', () => {
  document.getElementById('defaultLinkMessageModal').style.display = 'flex';
});
document.getElementById('defaultLinkMessageCloseBtn').addEventListener('click', () => {
  document.getElementById('defaultLinkMessageModal').style.display = 'none';
});
document.getElementById('defaultLinkMessageModal').addEventListener('click', (e) => {
  if (e.target.id === 'defaultLinkMessageModal') document.getElementById('defaultLinkMessageModal').style.display = 'none';
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

// ── Import Members (CSV) — writes to showdrinks_tabMembers, the one shared members list also
// used by Bar Tabs POS and the Add user modal's Member picker above. Moved here from Bar
// Manager's own Bar Tabs page since importing members is a whole-suite user-management action,
// not a Bar Tabs-specific one.

// RFC4180-ish parser (handles quoted fields with embedded commas/quotes/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore — \n (below) ends the row for both \n and \r\n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

const IMPORT_NAME_HEADERS = ['name', 'full name', 'fullname', 'member name', 'member'];
const IMPORT_EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'emailaddress'];

function findCsvColumn(header, candidates) {
  return header.findIndex(h => candidates.includes(h.trim().toLowerCase()));
}

let _importMembersRows = [];

document.getElementById('importMembersBtn').addEventListener('click', () => {
  document.getElementById('importMembersFile').click();
});

document.getElementById('importMembersFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // clear so picking the same file again still fires 'change'
  if (!file) return;
  try {
    const rows = parseCsv(await file.text());
    if (!rows.length) { showToast('CSV file is empty', 'error'); return; }

    const header = rows[0];
    const nameIdx = findCsvColumn(header, IMPORT_NAME_HEADERS);
    const emailIdx = findCsvColumn(header, IMPORT_EMAIL_HEADERS);
    if (nameIdx === -1) { showToast('No "Name" column found in that CSV', 'error'); return; }

    if (!_memberDirectory) await loadMemberDirectory();
    const existingLower = new Set((_memberDirectory || []).map(m => m.name.toLowerCase()));
    const seen = new Set();
    const parsed = [];
    for (const r of rows.slice(1)) {
      const name = (r[nameIdx] || '').trim();
      if (!name) continue;
      const email = emailIdx !== -1 ? (r[emailIdx] || '').trim() : '';
      const nameLower = name.toLowerCase();
      const status = existingLower.has(nameLower) || seen.has(nameLower) ? 'existing' : 'new';
      if (status === 'new') seen.add(nameLower);
      parsed.push({ name, email, status });
    }
    if (!parsed.length) { showToast('No rows with a name found in that CSV', 'error'); return; }
    openImportMembersModal(parsed);
  } catch (err) {
    showToast('Failed to read file: ' + err.message, 'error');
  }
});

function openImportMembersModal(rows) {
  _importMembersRows = rows;
  const newCount = rows.filter(r => r.status === 'new').length;
  const skipCount = rows.length - newCount;
  document.getElementById('importMembersSummary').textContent =
    `${newCount} new member${newCount === 1 ? '' : 's'} will be added` +
    (skipCount ? `, ${skipCount} skipped — already on the list` : '') + '.';
  document.getElementById('importMembersList').innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:8px;background:${r.status === 'new' ? 'var(--bg)' : 'transparent'};opacity:${r.status === 'new' ? '1' : '.55'}">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        <strong>${escapeHtml(r.name)}</strong>${r.email ? ` <span style="color:var(--text-muted)">· ${escapeHtml(r.email)}</span>` : ''}
      </span>
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">${r.status === 'new' ? 'New' : 'Already on list'}</span>
    </div>
  `).join('');
  const confirmBtn = document.getElementById('importMembersConfirmBtn');
  confirmBtn.disabled = newCount === 0;
  confirmBtn.textContent = newCount ? `Import ${newCount} Member${newCount === 1 ? '' : 's'}` : 'Nothing to import';
  document.getElementById('importMembersModal').style.display = 'flex';
}

function closeImportMembersModal() {
  document.getElementById('importMembersModal').style.display = 'none';
  _importMembersRows = [];
}

document.getElementById('importMembersModalCloseBtn').addEventListener('click', closeImportMembersModal);
document.getElementById('importMembersCancelBtn').addEventListener('click', closeImportMembersModal);
document.getElementById('importMembersModal').addEventListener('click', (e) => {
  if (e.target.id === 'importMembersModal') closeImportMembersModal();
});

document.getElementById('importMembersConfirmBtn').addEventListener('click', async () => {
  const newRows = _importMembersRows.filter(r => r.status === 'new');
  if (!newRows.length) return;
  const btn = document.getElementById('importMembersConfirmBtn');
  btn.disabled = true;
  try {
    for (let i = 0; i < newRows.length; i += 500) { // Firestore batches cap at 500 writes
      const batch = db.batch();
      newRows.slice(i, i + 500).forEach(r => {
        batch.set(db.collection('showdrinks_tabMembers').doc(), {
          name: r.name, email: r.email, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
    }
    _memberDirectory = null; // force a fresh fetch next time the picker/import needs it
    showToast(`Imported ${newRows.length} member${newRows.length === 1 ? '' : 's'}`, 'success');
    closeImportMembersModal();
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
    btn.disabled = false;
  }
});

document.getElementById('userList').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-user]'); // icon-btn's <svg> is the actual click target
  if (editBtn) { openEditUserModal(editBtn.getAttribute('data-edit-user')); return; }

  const linkId = e.target.getAttribute('data-send-link');
  if (linkId) {
    const user = allUsers.find(u => u.id === linkId);
    if (user) showUserLinkModal(user.name || user.email, user.email);
    return;
  }

  const deleteBtn = e.target.closest('[data-delete-user]'); // icon-btn's <svg> is the actual click target
  if (!deleteBtn) return;
  const id = deleteBtn.getAttribute('data-delete-user');
  const user = allUsers.find(u => u.id === id);
  if (!confirm(`Permanently delete ${user?.name || user?.email}? They'll lose their login to every app. Their past expenses/orders are kept.`)) return;
  deleteBtn.disabled = true;
  try {
    await functionsRegion.httpsCallable('deleteUser')({ uid: id });
    showToast('User deleted', 'success');
    await loadUsers();
  } catch (err) {
    deleteBtn.disabled = false;
    showToast(err.message, 'error');
  }
});

// ── Send link (portal's own — separate from expenses admin's own Users → Send link) ────────

const PORTAL_ENTRY_URL = new URL('index.html', location.href).href;

function showUserLinkModal(name, email) {
  document.getElementById('userLinkName').textContent = name;
  document.getElementById('userLinkUrl').value = PORTAL_ENTRY_URL;
  document.getElementById('userLinkMessage').value = document.getElementById('defaultLinkMessageInput').value;
  document.getElementById('userLinkModal').dataset.email = email;
  document.getElementById('userLinkModal').style.display = 'flex';
}

function closeUserLinkModal() {
  document.getElementById('userLinkModal').style.display = 'none';
}

document.getElementById('userLinkCloseBtn').addEventListener('click', closeUserLinkModal);
document.getElementById('userLinkDoneBtn').addEventListener('click', closeUserLinkModal);
document.getElementById('userLinkModal').addEventListener('click', (e) => {
  if (e.target.id === 'userLinkModal') closeUserLinkModal();
});

document.getElementById('copyUserLinkBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('userLinkUrl').value);
    showToast('Link copied', 'success');
  } catch (err) {
    showToast('Could not copy — select and copy the link manually', 'error');
  }
});

document.getElementById('sendUserLinkEmailBtn').addEventListener('click', async () => {
  const btn = document.getElementById('sendUserLinkEmailBtn');
  const email = document.getElementById('userLinkModal').dataset.email;
  const message = document.getElementById('userLinkMessage').value.trim();
  btn.disabled = true;
  try {
    await functionsRegion.httpsCallable('sendPortalUserLink')({ email, message });
    showToast('Link sent', 'success');
    closeUserLinkModal();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Default link message (portal_config/settings — separate from expenses admin's own) ─────

async function loadPortalSettings() {
  try {
    const doc = await db.collection('portal_config').doc('settings').get();
    document.getElementById('defaultLinkMessageInput').value = doc.exists ? (doc.data().defaultLinkMessage || '') : '';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('defaultLinkMessageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const defaultLinkMessage = document.getElementById('defaultLinkMessageInput').value.trim();
  try {
    await db.collection('portal_config').doc('settings').set({ defaultLinkMessage }, { merge: true });
    document.getElementById('defaultLinkMessageModal').style.display = 'none';
    showToast('Saved', 'success');
  } catch (err) {
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
    const res = await fetch('shared/version.js?_=' + Date.now(), { cache: 'no-store' });
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
