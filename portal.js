'use strict';

const functionsRegion = firebase.app().functions('europe-west1');

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared .icon-btn glyph (Feather-style, matching the outline icons used elsewhere in the
// suite) — used in place of a text label for the row Delete action. (Copy link's icon is
// inlined directly in index.html's static markup, not rendered from here.)
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
  // <main> itself (not just which .work-pane is active inside it) has to hide when an app
  // iframe is showing instead — its own padding stuck around empty otherwise, a blank white
  // strip between the header and the iframe below it even with every pane inactive.
  document.getElementById('workArea').style.display = key ? '' : 'none';
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
  html += '<div class="dropdown-divider"></div><button class="tab-btn signout-btn">Close app</button>';
  document.getElementById('shellNavSidebar').innerHTML = html;
  document.getElementById('shellNavDropdown').innerHTML = html;
}

// Doesn't sign out — same as the expenses entry app's own Close app, staying signed in is the
// point, this is just "I'm done for now". window.close() only actually works in some contexts a
// PWA runs in (notably installed Android PWAs) — launched from the home screen rather than
// window.open()'d by script, most others (iOS Safari standalone included) just ignore it.
function closeApp() {
  window.close();
}

function handleNavClick(e) {
  if (e.target.closest('.signout-btn')) { closeApp(); return; }
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

// Manager stays its own checkbox (a different kind of thing — portal-level, manages every app
// and every user — not just "another app to pick"); the apps themselves are one checkbox each,
// same as before. (Only the *existing users list* below got a dropdown — one row per user, a
// checkbox per app there would be a wide, wrapping mess; a single new-user form has the room.)
function accessPickerHtml(idPrefix, access = {}) {
  return `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px">
      <input type="checkbox" id="${idPrefix}-isManager"> Manager (all apps, manages users)
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

// Which row's Permissions dropdown is open — tracked separately from the <details> elements
// themselves because renderUserList() below rebuilds the whole list (including on every
// checkbox change inside that same dropdown, since toggling one re-saves and reloads), which
// would otherwise silently collapse it back to closed on every single selection.
let openPermissionsUid = null;

function renderUserList() {
  const currentUid = firebase.auth().currentUser?.uid;
  const search = document.getElementById('userSearchInput').value.trim().toLowerCase();
  const rows = allUsers.filter(u => !search || u.name?.toLowerCase().includes(search) || u.email?.toLowerCase().includes(search));

  document.getElementById('userList').innerHTML = rows.map(u => {
    // Manager doesn't imply/require every app's access flag — it's just another permission, so
    // it lives in this same dropdown as a peer checkbox rather than a separate control.
    const selectedLabels = [
      ...(u.isManager ? ['Manager'] : []),
      ...ACCESS_APPS.filter(a => u.access?.[a.key]).map(a => a.label),
    ];
    const summary = selectedLabels.length ? selectedLabels.join(', ') : 'No permissions';
    const isSelf = u.id === currentUid;
    return `
    <div class="item-row" style="flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="item-name">${escapeHtml(u.name || u.email)}
          <button type="button" data-edit-name="${u.id}" title="Edit name" style="margin-left:4px;font-size:11px;font-weight:400;color:var(--text-muted);background:none;border:none;cursor:pointer;text-decoration:underline">Edit</button>
        </div>
        <div class="item-sub">${escapeHtml(u.email)}</div>
      </div>
      <div class="access-flags item-actions">
        <details class="access-dropdown" data-uid="${u.id}" ${openPermissionsUid === u.id ? 'open' : ''}>
          <summary title="${escapeHtml(summary)}">Permissions</summary>
          <div class="access-dropdown-menu">
            <label>
              <input type="checkbox" data-toggle="${u.id}:isManager" ${u.isManager ? 'checked' : ''} ${isSelf ? 'disabled title="You can\'t change your own Manager status"' : ''}> Manager
            </label>
            <div class="access-dropdown-divider"></div>
            ${ACCESS_APPS.map(a => `
              <label>
                <input type="checkbox" data-toggle="${u.id}:access.${a.key}" ${u.access?.[a.key] ? 'checked' : ''}> ${escapeHtml(a.label)}
              </label>
            `).join('')}
          </div>
        </details>
        <button class="btn btn-secondary btn-sm" data-send-link="${u.id}">Send link</button>
        <button class="icon-btn icon-btn-danger" data-delete-user="${u.id}" ${isSelf ? 'disabled title="You can\'t delete your own account this way"' : 'title="Delete" aria-label="Delete"'}>${ICON_TRASH}</button>
      </div>
    </div>
  `;
  }).join('') || '<p class="empty-state">No registered users yet.</p>';
}
document.getElementById('userSearchInput').addEventListener('input', renderUserList);

// Only one row's Permissions dropdown open at a time. 'toggle' doesn't bubble, so this has to
// be a capture-phase listener to catch it via delegation from a single spot on the container.
document.getElementById('userList').addEventListener('toggle', (e) => {
  if (!e.target.matches?.('.access-dropdown')) return;
  const uid = e.target.getAttribute('data-uid');
  if (e.target.open) {
    openPermissionsUid = uid;
    document.querySelectorAll('#userList .access-dropdown[open]').forEach(d => {
      if (d !== e.target) d.removeAttribute('open');
    });
  } else if (openPermissionsUid === uid) {
    openPermissionsUid = null;
  }
}, true);

// Closes it on a click anywhere outside — <details> has no such behaviour natively (only
// clicking its own <summary> again toggles it), and toggling a checkbox inside it re-renders
// the whole list (see openPermissionsUid above), which would otherwise leave nothing to close
// it except that same summary click.
document.addEventListener('click', (e) => {
  if (!openPermissionsUid || e.target.closest('.access-dropdown')) return;
  document.querySelectorAll('#userList .access-dropdown[open]').forEach(d => d.removeAttribute('open'));
  openPermissionsUid = null;
});

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('addUserError');
  const btn = document.getElementById('addUserBtn');
  errorEl.textContent = '';
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value.trim();
  const isManager = document.getElementById('newUser-isManager').checked;
  const access = readAccessPicker('newUser');

  btn.disabled = true;
  try {
    await functionsRegion.httpsCallable('createUser')({ name, email, password, isManager, access });
    document.getElementById('addUserForm').reset();
    document.getElementById('newUserAccessList').innerHTML = accessPickerHtml('newUser');
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
  const editId = e.target.getAttribute('data-edit-name');
  if (editId) {
    const user = allUsers.find(u => u.id === editId);
    const name = prompt('New name:', user?.name || '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === user?.name) return;
    try {
      await db.collection('users').doc(editId).update({ name: trimmed });
      showToast('Updated', 'success');
      await loadUsers();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

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
