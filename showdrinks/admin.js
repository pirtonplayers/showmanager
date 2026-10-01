'use strict';

// Shared .icon-btn glyphs (Feather-style, matching the outline icons used elsewhere in the
// suite) — used in place of a text label/emoji for common row actions and the Bar Tabs POS
// basket bar (ICON_TROLLEY — the same icon the customer app's own basket button uses).
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
const ICON_TROLLEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';

// ── Utilities ──────────────────────────────────────────────────────────────

window.togglePasswordVisibility = function(inputId, btn) {
  const input = document.getElementById(inputId);
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁' : '🙈';
  btn.title = showing ? 'Show password' : 'Hide password';
};

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-msg ${type}`;
  el.style.cursor = 'pointer';
  el.title = 'Click to dismiss';
  el.textContent = msg;
  el.addEventListener('click', () => el.remove());
  document.getElementById('toast').appendChild(el);
  // Errors stay until clicked; info/success auto-dismiss after 4s
  if (type !== 'error') setTimeout(() => el.remove(), 4000);
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fmtCurrency(n) {
  return '£' + Number(n).toFixed(2);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const DEFAULT_EMAIL_TEMPLATE_SUBJECT = 'Your ShowDrinks tab';
const DEFAULT_EMAIL_TEMPLATE_BODY =
  'Hi [name],\n\nYou have an outstanding drinks tab of [total]:\n[drinks]\n\nPlease settle up when you get a chance. Thanks!';

// ── Tab switching ──────────────────────────────────────────────────────────

// navTabId lets a panel with no nav entry of its own (the Show Editor "page", reached only from
// the Shows list) still highlight its parent's nav button instead of leaving none active.
function activateAdminTab(tabId, navTabId) {
  navTabId = navTabId || tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === navTabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');
  document.getElementById('mainMenuDropdown').classList.remove('open');
  document.body.classList.remove('menu-open');
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activateAdminTab(btn.dataset.tab);
    if (btn.dataset.tab === 'orders') loadOrders();
    if (btn.dataset.tab === 'tabs') loadShowTabs();
    if (btn.dataset.tab === 'tabmembers') loadTabMembersData();
    if (btn.dataset.tab === 'pos') loadPosGrids();
    if (btn.dataset.tab === 'show') renderShowsList();
    // .menu-sticky-header is display:none (0 height) whenever this isn't the active tab, so
    // whatever updateMenuTheadStickyTop() computed while loadMenuItems() ran at app init is
    // wrong until it's recomputed with the panel actually visible.
    if (btn.dataset.tab === 'menu') updateMenuTheadStickyTop();
  });
});

window.toggleMainMenu = function(e) {
  e.stopPropagation();
  const open = document.getElementById('mainMenuDropdown').classList.toggle('open');
  // See body.menu-open in style.css — a full-viewport tap target, so there's always somewhere
  // to tap to close this even when the menu itself runs taller than the screen on a phone.
  document.body.classList.toggle('menu-open', open);
};

document.addEventListener('click', () => {
  document.getElementById('mainMenuDropdown')?.classList.remove('open');
  document.body.classList.remove('menu-open');
});

// ── Show & Sessions ────────────────────────────────────────────────────────

const DEFAULT_SESSIONS = {
  before:   { name: 'Before Show', enabled: true },
  interval: { name: 'Interval',    enabled: true },
  after:    { name: 'After Show',  enabled: true },
};

let _shows = [];
let _selectedShowId = null;
// True while the editor is showing an in-progress "+ New Show" draft that hasn't been saved yet
// — no Firestore doc exists for it until Save Changes, so Delete/Set-as-Current (both of which
// need a real doc) stay hidden until then.
let _creatingNewShow = false;

async function loadShows() {
  try {
    const snap = await db.collection('showdrinks_shows').get();
    _shows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1);

    if (!_shows.find(s => s.id === _selectedShowId)) {
      const current = _shows.find(s => s.isCurrent);
      _selectedShowId = (current || _shows[0] || {}).id || null;
    }

    renderShowsList();
    renderShowEditor();
    updateHeaderShowName();
  } catch(e) {
    console.error(e);
    toast('Could not load shows – check Firebase config', 'error');
  }
}

function updateHeaderShowName() {
  const current = _shows.find(s => s.isCurrent);
  document.getElementById('headerShowName').textContent = current ? (current.name || 'Unnamed show') : 'No current show set';
}

function renderShowsList() {
  const el = document.getElementById('showsList');
  el.innerHTML = _shows.length ? _shows.map(s => `
    <div class="item-row">
      <span class="item-name">${escHtml(s.name || '(untitled show)')}${s.isCurrent ? ' <span class="badge badge-success">Current</span>' : ''}</span>
      <div class="item-actions">
        ${s.isCurrent ? '' : `<button class="btn btn-secondary btn-sm" onclick="setCurrentShow('${s.id}')">Set as current</button>`}
        <button class="btn btn-secondary btn-sm" onclick="selectShow('${s.id}')">Edit</button>
        <button class="icon-btn icon-btn-danger" onclick="deleteShow('${s.id}')" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
      </div>
    </div>`).join('') : '<p style="color:var(--text-muted);font-size:14px">No shows yet — add one to get started.</p>';
}

// Opens the Show Editor "page" for one show — reached only from here (its nav highlight is
// "show", the Shows list it came from — see activateAdminTab).
window.selectShow = function(id) {
  _selectedShowId = id;
  _creatingNewShow = false;
  renderShowEditor();
  activateAdminTab('showEditor', 'show');
};

window.backToShowsList = function() {
  _creatingNewShow = false; // abandons an unsaved draft, if that's where this was called from
  renderShowsList();
  activateAdminTab('show');
};

// id defaults to whichever show is open in the editor (the editor's own "Set as Current"
// button), but also takes an explicit id so the shows list's own per-row "Set as current"
// button can do this without first having to open that show in the editor.
window.setCurrentShow = async function(id) {
  const targetId = id || _selectedShowId;
  if (!targetId) return;
  try {
    const batch = db.batch();
    _shows.forEach(s => batch.update(db.collection('showdrinks_shows').doc(s.id), { isCurrent: s.id === targetId }));
    await batch.commit();
    _shows.forEach(s => { s.isCurrent = s.id === targetId; });
    renderShowsList();
    renderShowEditor();
    updateHeaderShowName();
    toast('Current show updated', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.deleteShow = async function(id) {
  const show = _shows.find(s => s.id === id);
  if (!confirm(`Delete show "${show?.name || 'this show'}"? This cannot be undone.`)) return;
  try {
    await db.collection('showdrinks_shows').doc(id).delete();
    _shows = _shows.filter(s => s.id !== id);
    if (_selectedShowId === id) _selectedShowId = (_shows[0] || {}).id || null;
    updateHeaderShowName();
    toast('Show deleted', 'info');
    // Deleting from the editor page (its own Delete button) leaves nothing there to keep editing
    // — back to the list. Deleting from the list's own row just re-renders that same list.
    if (document.getElementById('tab-showEditor').classList.contains('active')) backToShowsList();
    else renderShowsList();
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

// Opens the editor on a blank draft — nothing is written to Firestore until Save Changes, so
// there's nothing yet to set as current or delete (renderShowEditor hides both for this case).
document.getElementById('addShowBtn').addEventListener('click', () => {
  _selectedShowId = null;
  _creatingNewShow = true;
  renderShowEditor();
  activateAdminTab('showEditor', 'show');
  const nameInput = document.getElementById('showName');
  nameInput.focus();
});

document.getElementById('setCurrentShowBtn').addEventListener('click', () => setCurrentShow());
document.getElementById('deleteShowBtn').addEventListener('click', () => { if (_selectedShowId) deleteShow(_selectedShowId); });

function renderShowEditor() {
  const show = _creatingNewShow ? { name: '', sessions: DEFAULT_SESSIONS } : _shows.find(s => s.id === _selectedShowId);
  const wrap = document.getElementById('showEditorWrap');
  if (!show) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  document.getElementById('showName').value = show.name || '';

  const defaultLocSelect = document.getElementById('showDefaultLocation');
  defaultLocSelect.innerHTML = '<option value="">— none —</option>' +
    _locations.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('');
  defaultLocSelect.value = show.defaultLocationId || '';

  // Both need a real saved doc to act on — hidden until this draft has actually been saved once.
  const setCurBtn = document.getElementById('setCurrentShowBtn');
  const deleteBtn = document.getElementById('deleteShowBtn');
  setCurBtn.style.display = _creatingNewShow ? 'none' : '';
  deleteBtn.style.display = _creatingNewShow ? 'none' : '';
  setCurBtn.disabled = !!show.isCurrent;
  setCurBtn.textContent = show.isCurrent ? 'Current Show' : 'Set as Current';

  document.getElementById('showPaymentMode').value       = show.paymentMode || '';
  document.getElementById('showSumupMerchantCode').value = show.sumupMerchantCode || '';
  document.getElementById('showSumupApiKey').value        = show.sumupApiKey || '';
  document.getElementById('showOrderingMode').value       = show.orderingMode || '';
  document.getElementById('showTabOrderingMode').value    = show.tabOrderingMode || '';

  const sessions = show.sessions || {};
  ['before','interval','after'].forEach(id => {
    const d = sessions[id] || DEFAULT_SESSIONS[id];
    document.getElementById(`${id}Name`).value = d.name || '';
    document.getElementById(`${id}Enabled`).value = d.enabled !== false ? 'true' : 'false';
    document.getElementById(`${id}Cutoff`).value = d.cutoffTime || '';
    document.getElementById(`${id}BuyNow`).checked = d.buyNow === true;
  });
}

document.getElementById('saveShowBtn').addEventListener('click', async () => {
  const name = document.getElementById('showName').value.trim();
  if (!name) { toast('Enter a show name', 'error'); return; }

  const sessions = {};
  ['before','interval','after'].forEach(id => {
    sessions[id] = {
      name: document.getElementById(`${id}Name`).value.trim(),
      enabled: document.getElementById(`${id}Enabled`).value === 'true',
      // Blank = no cutoff — order.js's sessionCutoffPassed() treats a falsy cutoffTime that way.
      cutoffTime: document.getElementById(`${id}Cutoff`).value || '',
      buyNow: document.getElementById(`${id}BuyNow`).checked,
    };
  });

  const paymentMode       = document.getElementById('showPaymentMode').value;
  const sumupMerchantCode = document.getElementById('showSumupMerchantCode').value.trim();
  const sumupApiKey       = document.getElementById('showSumupApiKey').value.trim();
  const orderingMode      = document.getElementById('showOrderingMode').value;
  const tabOrderingMode   = document.getElementById('showTabOrderingMode').value;
  const defaultLocationId = document.getElementById('showDefaultLocation').value;
  const fields = { name, sessions, paymentMode, sumupMerchantCode, sumupApiKey, orderingMode, tabOrderingMode, defaultLocationId };

  try {
    if (_creatingNewShow) {
      const doc = { ...fields, isCurrent: _shows.length === 0, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
      const ref = await db.collection('showdrinks_shows').add(doc);
      _shows.push({ id: ref.id, ...doc });
      _selectedShowId = ref.id;
      _creatingNewShow = false;
      renderShowEditor(); // now shows Set as Current/Delete, since it's a real saved show
      toast('Show created', 'success');
    } else {
      if (!_selectedShowId) { toast('Add or select a show first', 'error'); return; }
      await db.collection('showdrinks_shows').doc(_selectedShowId).update(fields);
      const show = _shows.find(s => s.id === _selectedShowId);
      if (show) Object.assign(show, fields);
      toast('Show & sessions saved', 'success');
    }
    renderShowsList();
    updateHeaderShowName();
  } catch(e) {
    console.error(e);
    toast('Save failed – ' + e.message, 'error');
  }
});

// ── Menu Items (Price List) ──────────────────────────────────────────────────

let _allMenuItems        = [];
let _menuCategories      = [];
let _selectedMenuCat     = 'all';

// A name that doesn't start with a letter/digit (e.g. "*Chef's Special", "!86'd soon") sorts
// after every plain-named item in its category instead of wherever punctuation happens to fall
// in character-code order (usually first, ahead of "A") — used by loadMenuItems() below and
// order.js's own copy (renderListMenu), which can't share this since it's a separate script.
function startsWithSpecialChar(name) {
  return !/^[a-z0-9]/i.test(name || '');
}

async function loadMenuItems() {
  // Fetch all, sort client-side by category then name (special-char-prefixed names last)
  const snap = await db.collection('showdrinks_menuItems').get();
  _allMenuItems = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ca = (a.category || '').toLowerCase(), cb = (b.category || '').toLowerCase();
      if (ca !== cb) return ca < cb ? -1 : 1;
      const aSpecial = startsWithSpecialChar(a.name), bSpecial = startsWithSpecialChar(b.name);
      if (aSpecial !== bSpecial) return aSpecial ? 1 : -1;
      return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
    });

  _menuCategories = [...new Set(_allMenuItems.map(i => i.category).filter(Boolean))].sort();

  // Reset filter if category no longer exists
  if (_selectedMenuCat !== 'all' && !_menuCategories.includes(_selectedMenuCat)) {
    _selectedMenuCat = 'all';
  }

  const clearBtn = document.getElementById('clearAllMenuBtn');
  if (clearBtn) clearBtn.style.display = _allMenuItems.length ? '' : 'none';

  renderMenuCategoryBar();
  renderMenuTable();
}

function renderMenuCategoryBar() {
  const bar = document.getElementById('menuCategoryBar');
  if (!_menuCategories.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = ['all', ..._menuCategories].map(cat => `
    <button type="button" class="cat-btn ${cat === _selectedMenuCat ? 'active' : ''}"
            onclick="setMenuCat('${escHtml(cat)}')">
      ${cat === 'all' ? 'All' : escHtml(cat)}
    </button>`).join('');
  updateMenuTheadStickyTop();
}

// The table's own header row (Category/Name/.../Tab/POS) sticks below .menu-sticky-header (see
// .menu-grid-table th's position:sticky in style.css) — its "below" offset isn't a fixed number
// though, since the category bar above it shows/hides depending on whether any items have a
// category yet, changing .menu-sticky-header's own height. Recomputed instead of hardcoded:
// 60px admin-header (0 when embedded — see .embedded .admin-header in style.css) plus whatever
// .menu-sticky-header actually rendered at.
function updateMenuTheadStickyTop() {
  const header = document.querySelector('.menu-sticky-header');
  if (!header) return;
  const embedded = document.documentElement.classList.contains('embedded');
  document.documentElement.style.setProperty('--menu-thead-top', ((embedded ? 0 : 60) + header.offsetHeight) + 'px');
}
window.addEventListener('resize', updateMenuTheadStickyTop);

window.setMenuCat = function(cat) {
  _selectedMenuCat = cat;
  renderMenuCategoryBar();
  renderMenuTable();
};

// Header checkboxes (in the Tab/POS <th> cells themselves) filter the rows below by the same
// itemShowsOnTab()/itemShowsOnPos() checks the rows' own per-item checkboxes write to — checked
// = include, so unchecking both shows nothing (same as any other "all filters off" state) rather
// than falling back to unfiltered, since that's the more literal/predictable reading of two
// independent checkboxes.
document.getElementById('menuFilterTab').addEventListener('change', renderMenuTable);
document.getElementById('menuFilterPos').addEventListener('change', renderMenuTable);

function renderMenuTable() {
  const tbody = document.getElementById('menuTableBody');
  const filterTab = document.getElementById('menuFilterTab').checked;
  const filterPos = document.getElementById('menuFilterPos').checked;
  const items = _allMenuItems
    .filter(i => _selectedMenuCat === 'all' || i.category === _selectedMenuCat)
    .filter(i => (filterTab && itemShowsOnTab(i)) || (filterPos && itemShowsOnPos(i)));

  const emptyMsg = _allMenuItems.length
    ? 'No items match this filter.'
    : 'No items yet — + Add Item to get started.';
  tbody.innerHTML = items.length ? items.map(i => menuItemRow(i.id, i)).join('')
    : `<tr><td colspan="7" style="color:var(--text-muted);padding:20px;text-align:center">${emptyMsg}</td></tr>`;
}

function menuItemRow(id, item) {
  const onSale = item.onSale !== false;
  const showOnTab = itemShowsOnTab(item);
  const showOnPos = itemShowsOnPos(item);
  return `<tr id="mrow-${id}">
    <td>${escHtml(item.category || '—')}</td>
    <td>${escHtml(item.name || '')}</td>
    <td>${fmtCurrency(item.price || 0)}</td>
    <td style="text-align:center">
      <input type="checkbox" class="onsale-checkbox" ${onSale ? 'checked' : ''} onchange="toggleMenuItemOnSale('${id}', this)" title="On sale" aria-label="On sale">
    </td>
    <td style="text-align:center">
      <input type="checkbox" ${showOnTab ? 'checked' : ''} onchange="toggleMenuItemShowOn('${id}', 'showOnTab', this)" title="Show on Bar Tabs" aria-label="Show on Bar Tabs">
    </td>
    <td style="text-align:center">
      <input type="checkbox" ${showOnPos ? 'checked' : ''} onchange="toggleMenuItemShowOn('${id}', 'showOnPos', this)" title="Show on Customer POS" aria-label="Show on Customer POS">
    </td>
    <td style="text-align:center">
      <button type="button" class="icon-btn" onclick="openEditMenuItemModal('${id}')" title="Edit" aria-label="Edit">${ICON_EDIT}</button>
    </td>
  </tr>`;
}

// The On Sale checkbox edits straight from the table row — no need to open the modal just to
// flip this one field. Optimistic: the local cache updates immediately (Firestore write happens
// in the background) rather than waiting on the round-trip, which on a slow connection made every
// tap feel laggy for no reason — the checkbox itself already looks flipped the instant you tap it
// regardless, so the rest of the UI should catch up just as fast, not lag behind it.
window.toggleMenuItemOnSale = function(id, checkboxEl) {
  const onSale = checkboxEl.checked;
  // Keep the local cache in step — _allMenuItems only ever refreshes via loadMenuItems() (no live
  // listener here), so without this the checkbox's new state would get silently reverted the next
  // time something else re-renders the table from that stale cache.
  const item = _allMenuItems.find(i => i.id === id);
  if (item) item.onSale = onSale;
  db.collection('showdrinks_menuItems').doc(id).update({ onSale }).catch(e => {
    checkboxEl.checked = !onSale;
    if (item) item.onSale = !onSale;
    toast('Failed: ' + e.message, 'error');
  });
};

// The Tab/POS checkboxes edit straight from the table row too, same reasoning as On Sale above
// (optimistic — see its comment) plus: unchecking one hides the item from that side's POS grid
// (dimmed, like an off-sale item) and List mode (left out entirely) — see itemShowsOnTab()/
// itemShowsOnPos() and order.js's own itemShowsOnPos() (order.js is a separate script, so it
// can't just call this file's).
window.toggleMenuItemShowOn = function(id, field, checkboxEl) {
  const value = checkboxEl.checked;
  const item = _allMenuItems.find(i => i.id === id);
  if (item) item[field] = value;
  renderTabGrid();
  renderTabListMenu();
  db.collection('showdrinks_menuItems').doc(id).update({ [field]: value }).catch(e => {
    checkboxEl.checked = !value;
    if (item) item[field] = !value;
    renderTabGrid();
    renderTabListMenu();
    toast('Failed: ' + e.message, 'error');
  });
};

// Missing field (item created before this existed) defaults to true — shows everywhere. Also
// reads the old three-way 'visibility' field (both/bar/customer) this replaced, so items set to
// bar/customer-only under that short-lived scheme keep their setting instead of silently
// reverting to "both" the first time someone reloads the Price List tab.
function itemShowsOnTab(item) {
  if (!item) return true;
  if (item.showOnTab !== undefined) return item.showOnTab !== false;
  if (item.visibility) return item.visibility !== 'customer';
  return true;
}
function itemShowsOnPos(item) {
  if (!item) return true;
  if (item.showOnPos !== undefined) return item.showOnPos !== false;
  if (item.visibility) return item.visibility !== 'bar';
  return true;
}

// Prompt for a new category name; update a <select>'s options in place (used by the edit modal's
// Category field) and optionally run a callback with the new name once chosen.
function promptNewCategory(selectEl, afterCb) {
  const name = prompt('New category name:');
  if (!name || !name.trim()) { selectEl.value = ''; return; }
  const cat = name.trim();
  if (!_menuCategories.includes(cat)) { _menuCategories.push(cat); _menuCategories.sort(); }
  selectEl.innerHTML = `<option value="">— none —</option>` +
    _menuCategories.map(c => `<option value="${escHtml(c)}"${c === cat ? ' selected' : ''}>${escHtml(c)}</option>`).join('') +
    `<option value="__new__">+ Add new category…</option>`;
  selectEl.value = cat;
  if (afterCb) afterCb(cat);
}

window.openAddMenuItemModal = function() {
  openModal('Add Item', { type: 'menuItem', id: null, name: '', category: _selectedMenuCat !== 'all' ? _selectedMenuCat : '', price: 0, onSale: true, showOnTab: true, showOnPos: true, buyNow: false });
};

window.openEditMenuItemModal = function(id) {
  const item = _allMenuItems.find(i => i.id === id);
  if (!item) return;
  openModal('Edit Item', { type: 'menuItem', id, name: item.name, category: item.category || '', price: item.price || 0, onSale: item.onSale !== false, showOnTab: itemShowsOnTab(item), showOnPos: itemShowsOnPos(item), buyNow: item.buyNow === true });
};

document.getElementById('clearAllMenuBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL menu items?')) return;
  const snap = await db.collection('showdrinks_menuItems').get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  _allMenuItems = []; _menuCategories = []; _selectedMenuCat = 'all';
  loadMenuItems();
  toast('All items deleted', 'info');
});

window.deleteMenuItem = async function(id) {
  await db.collection('showdrinks_menuItems').doc(id).delete();
  _allMenuItems = _allMenuItems.filter(i => i.id !== id);
  _menuCategories = [...new Set(_allMenuItems.map(i => i.category).filter(Boolean))].sort();
  if (_selectedMenuCat !== 'all' && !_menuCategories.includes(_selectedMenuCat)) _selectedMenuCat = 'all';
  const clearBtn = document.getElementById('clearAllMenuBtn');
  if (clearBtn) clearBtn.style.display = _allMenuItems.length ? '' : 'none';
  renderMenuCategoryBar();
  renderMenuTable();
  toast('Item deleted', 'info');
};

// ── Locations ──────────────────────────────────────────────────────────────

async function loadLocations() {
  const snap = await db.collection('showdrinks_locations').orderBy('name').get();
  const list = document.getElementById('locationsList');
  if (snap.empty) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:14px">No locations yet.</p>';
    return;
  }
  list.innerHTML = snap.docs.map(d => {
    const loc = d.data();
    return `
      <div class="item-row">
        <span class="item-name">${escHtml(loc.name)}</span>
        <div class="item-actions">
          <button class="btn btn-secondary btn-sm" onclick="editLocation('${d.id}','${escHtml(loc.name)}')">Edit</button>
          <button class="icon-btn icon-btn-danger" onclick="deleteLocation('${d.id}')" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
        </div>
      </div>`;
  }).join('');
}

window.addLocation = function() {
  openModal('Add Location', { id: null, name: '', type: 'location' });
};

window.deleteLocation = async function(id) {
  if (!confirm('Delete this location?')) return;
  await db.collection('showdrinks_locations').doc(id).delete();
  loadLocations();
  toast('Location deleted', 'info');
};

window.editLocation = function(id, name) {
  openModal('Edit Location', { id, name, type: 'location' });
};

// ── Edit Modal ─────────────────────────────────────────────────────────────

let _modalCtx = null;

function openModal(title, ctx) {
  _modalCtx = ctx;
  document.getElementById('editModalTitle').textContent = title;
  document.getElementById('editName').value = ctx.name || '';

  const priceGroup      = document.getElementById('editPriceGroup');
  const catGroup        = document.getElementById('editCategoryGroup');
  const onSaleGroup     = document.getElementById('editOnSaleGroup');
  const visibilityGroup = document.getElementById('editVisibilityGroup');
  const buyNowGroup     = document.getElementById('editBuyNowGroup');
  const deleteBtn       = document.getElementById('editDeleteBtn');

  if (ctx.type === 'menuItem') {
    priceGroup.style.display = '';
    document.getElementById('editPrice').value = ctx.price || '';

    catGroup.style.display = '';
    const catSelect = document.getElementById('editCategory');
    catSelect.innerHTML = `<option value="">— none —</option>` +
      _menuCategories.map(c => `<option value="${escHtml(c)}"${c === ctx.category ? ' selected' : ''}>${escHtml(c)}</option>`).join('') +
      `<option value="__new__">+ Add new category…</option>`;
    catSelect.value = ctx.category || '';
    catSelect.onchange = () => { if (catSelect.value === '__new__') promptNewCategory(catSelect, null); };

    onSaleGroup.style.display = '';
    document.getElementById('editOnSale').checked = ctx.onSale !== false;

    visibilityGroup.style.display = '';
    buyNowGroup.style.display = '';
    document.getElementById('editBuyNow').checked = ctx.buyNow === true;
    document.getElementById('editShowOnTab').checked = ctx.showOnTab !== false;
    document.getElementById('editShowOnPos').checked = ctx.showOnPos !== false;

    deleteBtn.style.display = ctx.id ? '' : 'none';
  } else {
    priceGroup.style.display = 'none';
    catGroup.style.display = 'none';
    onSaleGroup.style.display = 'none';
    visibilityGroup.style.display = 'none';
    buyNowGroup.style.display = 'none';
    deleteBtn.style.display = 'none';
  }
  const modal = document.getElementById('editModal');
  modal.style.display = 'flex';
}

window.closeModal = function() {
  document.getElementById('editModal').style.display = 'none';
  _modalCtx = null;
};

document.getElementById('editSaveBtn').addEventListener('click', async () => {
  if (!_modalCtx) return;
  const name = document.getElementById('editName').value.trim();
  if (!name) { toast('Name required', 'error'); return; }

  try {
    if (_modalCtx.type === 'location') {
      if (_modalCtx.id) {
        await db.collection('showdrinks_locations').doc(_modalCtx.id).update({ name });
      } else {
        await db.collection('showdrinks_locations').add({ name, active: true });
      }
      loadLocations();
      closeModal();
    } else if (_modalCtx.type === 'menuItem') {
      const catSelect  = document.getElementById('editCategory');
      const category   = catSelect.value === '__new__' ? '' : catSelect.value;
      const price      = parseFloat(document.getElementById('editPrice').value) || 0;
      const onSale     = document.getElementById('editOnSale').checked;
      const showOnTab  = document.getElementById('editShowOnTab').checked;
      const showOnPos  = document.getElementById('editShowOnPos').checked;
      const buyNow     = document.getElementById('editBuyNow').checked;
      if (_modalCtx.id) {
        await db.collection('showdrinks_menuItems').doc(_modalCtx.id).update({ name, category, price, onSale, showOnTab, showOnPos, buyNow });
      } else {
        await db.collection('showdrinks_menuItems').add({
          name, category, price, onSale, showOnTab, showOnPos, buyNow, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      await loadMenuItems();
      closeModal();
    }
    toast('Saved', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

document.getElementById('editDeleteBtn').addEventListener('click', async () => {
  if (!_modalCtx || _modalCtx.type !== 'menuItem' || !_modalCtx.id) return;
  if (!confirm(`Delete "${_modalCtx.name}"?`)) return;
  await deleteMenuItem(_modalCtx.id);
  closeModal();
});

// Click outside modal to close
document.getElementById('editModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// ── Orders ─────────────────────────────────────────────────────────────────

let _locations = [];
let _ordersUnsubscribe = null;

async function loadLocationsCache() {
  const snap = await db.collection('showdrinks_locations').get();
  _locations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadOrders() {
  if (_ordersUnsubscribe) { _ordersUnsubscribe(); _ordersUnsubscribe = null; }
  await loadLocationsCache();

  const session = document.getElementById('filterSession').value;
  const status = document.getElementById('filterStatus').value;

  let query = db.collection('showdrinks_orders');
  if (session) query = query.where('sessionId', '==', session);
  query = query.orderBy('createdAt', 'asc');

  _ordersUnsubscribe = query.onSnapshot(snap => {
    let orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Auto-fill a freshly-placed order's collection point from the current show's default (Show
    // & Sessions' "Default Location") so staff don't have to hand-pick the same one for every
    // order — still overridable per order via the dropdown below. Scoped to snap.docChanges()'
    // 'added' entries only (not the whole `orders` list, which is every order this query has ever
    // matched) — orders have no showId to filter by, so re-scanning the full list on every
    // snapshot would keep retrying old/historical orders from past shows forever, and every
    // marginally-unrelated change firing this listener (marking some other order Ready, say)
    // would re-write every still-unlocated order all over again.
    const currentShow = _shows.find(s => s.isCurrent);
    if (currentShow?.defaultLocationId) {
      snap.docChanges().forEach(change => {
        if (change.type !== 'added') return;
        const o = { id: change.doc.id, ...change.doc.data() };
        if (!o.locationId) setOrderLocation(o.id, currentShow.defaultLocationId);
      });
    }

    // 'cancelled' isn't a prepStatus value — it's the separate `cancelled` flag a customer sets
    // themselves from the payment page (see order.js's cancelOrderBtn) — so it needs its own
    // branch rather than falling into the generic prepStatus-match case below.
    if (status === 'all') { /* no filter */ }
    else if (status === 'cancelled') orders = orders.filter(o => o.cancelled === true);
    else if (status === '') orders = orders.filter(o => o.prepStatus !== 'collected' && !o.cancelled);
    else orders = orders.filter(o => o.prepStatus === status && !o.cancelled);
    renderOrders(orders);
  }, err => {
    console.error('Firestore orders error:', err);
    const msg = err.code === 'failed-precondition'
      ? 'Index still building — check browser console for the index creation link, or wait ~1 min and refresh'
      : 'Error loading orders: ' + err.message;
    toast(msg, 'error');
  });
}

// Orders that have been actioned (ready/collected) collapse their items/location by default —
// nothing left to prepare, so the card only needs to show status/total at a glance — but stay
// expandable per-order via the header's chevron. _orderExpandedIds tracks the exceptions;
// _lastOrders lets the toggle re-render without waiting on the next snapshot.
let _orderExpandedIds = new Set();
let _lastOrders = [];

window.toggleOrderExpanded = function(id) {
  if (_orderExpandedIds.has(id)) _orderExpandedIds.delete(id); else _orderExpandedIds.add(id);
  renderOrders(_lastOrders);
};

function renderOrders(orders) {
  _lastOrders = orders;
  const container = document.getElementById('ordersContainer');
  const summary = document.getElementById('ordersSummary');

  // Cancelled orders are excluded from every stat below regardless of which filter produced this
  // list — they never got served (or, usually, paid), so counting them as "Orders"/"Pending" or
  // toward Revenue would overstate all four. The cards themselves still render for every order
  // passed in (including cancelled ones, under the Cancelled/All filters) — just not tallied here.
  const statsOrders = orders.filter(o => !o.cancelled);
  const total = statsOrders.length;
  const ready = statsOrders.filter(o => o.prepStatus === 'ready').length;
  const pending = total - ready;
  const totalRevenue = statsOrders.reduce((s, o) => s + (o.totalAmount || 0), 0);

  summary.innerHTML = `
    <div class="stat"><div class="snum">${total}</div><div class="slabel">Orders</div></div>
    <div class="stat"><div class="snum" style="color:var(--warning)">${pending}</div><div class="slabel">Pending</div></div>
    <div class="stat"><div class="snum" style="color:var(--success)">${ready}</div><div class="slabel">Ready</div></div>
    <div class="stat"><div class="snum">${fmtCurrency(totalRevenue)}</div><div class="slabel">Revenue</div></div>`;

  if (!orders.length) {
    container.innerHTML = '';
    return;
  }

  const locationOptions = _locations.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('');

  container.innerHTML = orders.map(o => {
    const isReady     = o.prepStatus === 'ready';
    const isCollected = o.prepStatus === 'collected';
    const isPaid      = o.paymentStatus === 'paid';
    const sessionLabel = o.sessionName || o.sessionId || '';
    const statusBadge = o.cancelled ? '<span class="badge badge-danger">Cancelled</span>'
      : isCollected ? '<span class="badge badge-primary">Collected</span>'
      : isReady ? '<span class="badge badge-success">Ready</span>'
      : '<span class="badge badge-warning">Pending</span>';
    // Payment for a "pay at bar" order isn't taken until the customer's at the counter, so it
    // can't be marked Collected until staff have actually taken payment and flagged it here —
    // SumUp orders normally flip to paid on their own (the redirect-back handler), but the same
    // Mark Paid button covers one that's stuck (e.g. the browser closed before returning).
    const markPaidBtn = `<button class="btn btn-primary btn-sm" onclick="markOrderPaid('${o.id}')">💰 Mark Paid</button>`;
    // A cancelled order (see order.js's cancelOrderBtn — the customer's own doing, from their
    // payment page) has nothing left to action: not paid, not prepared, not served.
    const actionBtns = o.cancelled ? '' : isCollected
      ? `<button class="btn btn-secondary btn-sm" onclick="markReady('${o.id}')">↩ Undo Collected</button>`
      : isReady
        ? `${isPaid ? `<button class="btn btn-primary btn-sm" onclick="markCollected('${o.id}')">✓ Collected</button>` : markPaidBtn}
           <button class="btn btn-secondary btn-sm" onclick="markPending('${o.id}')">↩ Pending</button>`
        : `<button class="btn btn-success btn-sm" onclick="markReady('${o.id}')">✓ Mark Ready</button>
           ${isPaid ? '' : markPaidBtn}`;

    // Ready/collected/cancelled orders have nothing left to prepare, so they collapse their
    // items/location by default — expandable per-order via the chevron below. Pending ones always
    // show in full.
    const actioned = isReady || isCollected || o.cancelled;
    const collapsed = actioned && !_orderExpandedIds.has(o.id);
    const toggleBtn = actioned
      ? `<button class="btn btn-secondary btn-sm" onclick="toggleOrderExpanded('${o.id}')" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▾' : '▴'}</button>`
      : '';

    return `
      <div class="order-card ${isReady ? 'prepared' : ''} ${isCollected || o.cancelled ? 'order-collected' : ''}" id="order-${o.id}">
        <div class="order-card-header">
          ${o.orderNumber ? `<span style="font-size:22px;font-weight:900;color:var(--primary);min-width:44px">#${o.orderNumber}</span>` : ''}
          <div class="order-customer">${escHtml(o.customerName)}</div>
          ${statusBadge}
          <span class="badge badge-primary">${escHtml(sessionLabel)}</span>
          <div class="order-total">${fmtCurrency(o.totalAmount || 0)}</div>
          ${toggleBtn}
        </div>
        ${collapsed ? '' : `
        <div class="order-items">
          ${(o.items || []).map(item => `
            <div class="order-item-row">
              <span class="qty">${item.quantity}×</span>
              <span class="iname">${escHtml(item.name)}</span>
              <span class="iprice">${fmtCurrency(item.price * item.quantity)}</span>
            </div>`).join('')}
        </div>
        <div class="order-card-footer-loc">
          <select class="form-control" style="max-width:200px" id="loc-${o.id}" onchange="setOrderLocation('${o.id}',this.value)">
            <option value="">Set location…</option>
            ${locationOptions}
          </select>
          ${o.locationId ? `<span class="badge badge-primary">📍 ${escHtml(o.locationName || '')}</span>` : ''}
        </div>`}
        <div class="order-card-footer">
          ${actionBtns}
          ${o.cancelled ? '' : `
          <span class="badge ${isPaid ? 'badge-success' : 'badge-warning'}" style="margin-left:auto">
            ${isPaid ? '✓ Paid' : (o.paymentMode === 'bar' ? '💵 Unpaid (pay at bar)' : '⏳ Awaiting payment')}
          </span>`}
        </div>
      </div>`;
  }).join('');

  // Restore current location selections
  orders.forEach(o => {
    const sel = document.getElementById(`loc-${o.id}`);
    if (sel && o.locationId) sel.value = o.locationId;
  });
}

window.markReady = async function(id) {
  try {
    await db.collection('showdrinks_orders').doc(id).update({
      prepStatus: 'ready',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Order marked as ready', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.markPending = async function(id) {
  try {
    await db.collection('showdrinks_orders').doc(id).update({
      prepStatus: 'pending',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Order marked as pending', 'info');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.markOrderPaid = async function(id) {
  try {
    await db.collection('showdrinks_orders').doc(id).update({
      paymentStatus: 'paid',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Order marked as paid', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.markCollected = async function(id) {
  // Defensive — the button that reaches this is already hidden until the order's paid (see
  // orderCard), but _lastOrders lets this double-check without another Firestore round trip.
  const order = _lastOrders.find(o => o.id === id);
  if (order && order.paymentStatus !== 'paid') { toast('Mark it paid first', 'error'); return; }
  try {
    await db.collection('showdrinks_orders').doc(id).update({
      prepStatus: 'collected',
      collectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Order marked as collected', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.setOrderLocation = async function(id, locationId) {
  if (!locationId) return;
  const loc = _locations.find(l => l.id === locationId);
  if (!loc) return;
  try {
    await db.collection('showdrinks_orders').doc(id).update({
      locationId,
      locationName: loc.name,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Location set', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

document.getElementById('refreshOrdersBtn').addEventListener('click', loadOrders);
document.getElementById('filterSession').addEventListener('change', loadOrders);
document.getElementById('filterStatus').addEventListener('change', loadOrders);

document.getElementById('clearAllOrdersBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL orders? This cannot be undone.')) return;
  try {
    let snap = await db.collection('showdrinks_orders').limit(500).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      snap = await db.collection('showdrinks_orders').limit(500).get();
    }
    toast('All orders deleted', 'info');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

// ── Settings & QR ──────────────────────────────────────────────────────────

let _systemSettings = {};

async function loadSettings() {
  try {
    const doc = await db.collection('showdrinks_config').doc('settings').get();
    _systemSettings = doc.exists ? doc.data() : {};
    const d = _systemSettings;
    document.getElementById('sumupMerchantCode').value = d.sumupMerchantCode || '';
    document.getElementById('sumupApiKey').value = d.sumupApiKey || '';
    document.getElementById('paymentMode').value = d.paymentMode || 'bar';
    document.getElementById('orderingMode').value = d.orderingMode || 'pos';
    document.getElementById('tabOrderingMode').value = d.tabOrderingMode || 'pos';
    document.getElementById('emailTemplateSubject').value = d.emailTemplateSubject || DEFAULT_EMAIL_TEMPLATE_SUBJECT;
    document.getElementById('emailTemplateBody').value = d.emailTemplateBody || DEFAULT_EMAIL_TEMPLATE_BODY;
    await (Object.keys(_posGrids).length ? Promise.resolve() : loadPosGrids());
    posRenderStartGridSelects();
    document.getElementById('orderingModeStartGrid').value = d.posStartGridId || 'root';
    document.getElementById('tabOrderingModeStartGrid').value = d.tabPosStartGridId || 'root';
    posToggleStartGridRows();
  } catch(e) {
    console.error(e);
  }
}

// Which grid a POS-mode screen opens on — grids are shared/global (not per-show), so this is a
// system-wide choice, not something a show can override the way it overrides POS vs List mode
// itself. Only shown/relevant while that screen's mode is 'pos'.
function posRenderStartGridSelects() {
  const options = '<option value="root">Main Menu (root)</option>' +
    _posGridOrder.filter(id => id !== 'root')
      .map(id => `<option value="${id}">${escHtml(_posGrids[id]?.name || id)}</option>`).join('');
  document.getElementById('orderingModeStartGrid').innerHTML = options;
  document.getElementById('tabOrderingModeStartGrid').innerHTML = options;
}

function posToggleStartGridRows() {
  document.getElementById('orderingModeStartGridRow').style.display =
    document.getElementById('orderingMode').value === 'pos' ? '' : 'none';
  document.getElementById('tabOrderingModeStartGridRow').style.display =
    document.getElementById('tabOrderingMode').value === 'pos' ? '' : 'none';
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const settings = {
    sumupMerchantCode: document.getElementById('sumupMerchantCode').value.trim(),
    sumupApiKey: document.getElementById('sumupApiKey').value.trim(),
    paymentMode: document.getElementById('paymentMode').value,
    orderingMode: document.getElementById('orderingMode').value,
    tabOrderingMode: document.getElementById('tabOrderingMode').value,
    posStartGridId: document.getElementById('orderingModeStartGrid').value || 'root',
    tabPosStartGridId: document.getElementById('tabOrderingModeStartGrid').value || 'root',
    emailTemplateSubject: document.getElementById('emailTemplateSubject').value.trim(),
    emailTemplateBody: document.getElementById('emailTemplateBody').value,
  };
  try {
    await db.collection('showdrinks_config').doc('settings').set(settings);
    _systemSettings = settings;
    toast('Settings saved', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

let _qrInstance = null;

// Loaded lazily on first actual use rather than a static <script> tag every admin.html page
// load — most visits never touch Settings & QR at all, so that was one more CDN round trip
// (its own DNS/TLS handshake to cdnjs.cloudflare.com, on top of gstatic's) sitting in the
// critical path of every single Bar Manager open for a feature most opens never use.
let _qrLibPromise = null;
function loadQrLib() {
  if (window.QRCode) return Promise.resolve();
  if (_qrLibPromise) return _qrLibPromise;
  _qrLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = resolve;
    s.onerror = () => { _qrLibPromise = null; reject(new Error('Could not load QR code library')); };
    document.head.appendChild(s);
  });
  return _qrLibPromise;
}

document.getElementById('generateQrBtn').addEventListener('click', async () => {
  try {
    await loadQrLib();
  } catch(e) {
    toast(e.message, 'error');
    return;
  }
  const baseUrl = window.location.origin + window.location.pathname.replace('admin.html', '');
  const orderUrl = baseUrl.replace(/\/$/, '') + '/index.html';
  document.getElementById('qrUrl').textContent = orderUrl;

  const container = document.getElementById('qrcode');
  container.innerHTML = '';
  _qrInstance = new QRCode(container, {
    text: orderUrl,
    width: 220,
    height: 220,
    correctLevel: QRCode.CorrectLevel.M,
  });

  document.getElementById('downloadQrBtn').style.display = '';
  document.getElementById('copyQrUrlBtn').style.display = '';
  toast('QR code generated', 'success');
});

document.getElementById('copyQrUrlBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('qrUrl').textContent);
    toast('Link copied', 'success');
  } catch(e) {
    toast('Could not copy — select and copy the link manually', 'error');
  }
});

document.getElementById('downloadQrBtn').addEventListener('click', () => {
  const canvas = document.querySelector('#qrcode canvas');
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = 'showdrinks-qr.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

// ── POS Layout ─────────────────────────────────────────────────────────────

const POS_COLORS = ['','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#6b7280','#0f172a'];
// Main grid is POS_MAIN_N cells (3 columns × however many rows that divides into — 5 rows of 3
// here); the rest sit in the smaller "extra" row below it (unaffected by this — see
// .pos-admin-extra/.pos-grid-extra's own grid-template-columns:repeat(6,1fr) in style.css, which
// stays fixed at 6 regardless of POS_N). Both order.js's own copy of this split (renderPosGrid)
// and every render function in this file need to agree on POS_MAIN_N/POS_N — there's no shared
// constants file between the two scripts, so if this ever changes again, update both.
const POS_MAIN_N = 15;
const POS_N = 21;

let _posGrids    = {};
let _posGridOrder = [];
let _posActiveId  = null;
let _posEditIdx   = null;
let _posCellColor = '';

function posEmptyGrid(name) {
  return { name, sticky: false, cells: Array(POS_N).fill(null).map(() =>
    ({ type:'empty', label:'', color:'', menuItemId:'', menuItemPrice:0, targetGridId:'' })) };
}

function posNormCells(cells) {
  const out = (cells || []).slice(0, POS_N);
  while (out.length < POS_N)
    out.push({ type:'empty', label:'', color:'', menuItemId:'', menuItemPrice:0, targetGridId:'' });
  return out;
}

function posIsLight(hex) {
  if (!hex || hex.length < 4) return true;
  const h = hex.length === 4
    ? '#'+hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3] : hex;
  const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
  return (r*299+g*587+b*114)/1000 > 128;
}

async function loadPosGrids() {
  try {
    const snap = await db.collection('showdrinks_posGrids').get();
    _posGrids = {};
    _posGridOrder = [];
    snap.docs.forEach(d => { _posGrids[d.id] = { id:d.id, ...d.data() }; _posGridOrder.push(d.id); });
    if (!_posGrids['root']) {
      const g = posEmptyGrid('Main Menu');
      await db.collection('showdrinks_posGrids').doc('root').set(g);
      _posGrids['root'] = { id:'root', ...g };
      _posGridOrder.unshift('root');
    }
    _posGridOrder = ['root', ..._posGridOrder.filter(id => id !== 'root')];
    posRenderMenuItems();
    posRenderGridList();
    posSelectGrid(_posActiveId && _posGrids[_posActiveId] ? _posActiveId : 'root');
  } catch(e) { toast('POS load failed: '+e.message,'error'); }
}

function posRenderMenuItems() {
  const filterEl = document.getElementById('posCatFilter');
  const el = document.getElementById('posMenuItems');
  if (!el) return;

  // Rebuild category options
  if (filterEl) {
    const cats = [...new Set(_allMenuItems.map(i => i.category).filter(Boolean))].sort();
    const cur = filterEl.value;
    filterEl.innerHTML = '<option value="">All categories</option>' +
      cats.map(c => `<option value="${escHtml(c)}"${c===cur?' selected':''}>${escHtml(c)}</option>`).join('');
  }

  const filterVal = filterEl?.value || '';
  const items = filterVal ? _allMenuItems.filter(i => i.category === filterVal) : _allMenuItems;
  el.innerHTML = items.length
    ? items.map(item =>
        `<div class="pos-drag-item" draggable="true"
              data-id="${item.id}" data-name="${escHtml(item.name)}" data-price="${item.price}"
              ondragstart="posDragStart(event)">
           <span>${escHtml(item.name)}</span>
           <span style="color:var(--text-muted);font-size:12px">${fmtCurrency(item.price)}</span>
         </div>`).join('')
    : '<p style="font-size:12px;color:var(--text-muted)">No items.</p>';
}

function posRenderCellItemOptions() {
  const filterVal = document.getElementById('posCellItemCatFilter')?.value || '';
  const sel = document.getElementById('posCellItemSel');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— select —</option>' +
    _allMenuItems.map(i => {
      const hide = filterVal && i.category !== filterVal;
      return `<option value="${i.id}"${hide ? ' hidden' : ''}>${escHtml(i.name)} ${fmtCurrency(i.price)}</option>`;
    }).join('');
  sel.value = current;
}

function posRenderGridList() {
  const el = document.getElementById('posGridList');
  if (!el) return;
  el.innerHTML = _posGridOrder.map(id => {
    const g = _posGrids[id]; if (!g) return '';
    const isActive = id === _posActiveId;
    return `<div class="pos-grid-list-item ${isActive?'active':''}" onclick="posSelectGrid('${id}')">
      <span>${escHtml(g.name)}${id==='root'?' <em style="font-size:10px;opacity:.6">(root)</em>':''}</span>
      ${id!=='root'?`<button onclick="event.stopPropagation();posDeleteGrid('${id}')"
        style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1;padding:0;color:${isActive?'rgba(255,255,255,.7)':'var(--text-muted)'}">×</button>`:''}
    </div>`;
  }).join('');
}

window.posSelectGrid = function(id) {
  _posActiveId = id; posRenderGridList(); posRenderEditor();
};

function posRenderEditor() {
  const grid = _posGrids[_posActiveId];
  const el = document.getElementById('posEditor');
  if (!grid) { el.innerHTML = '<p style="color:var(--text-muted)">Select a grid to edit</p>'; return; }
  const cells = posNormCells(grid.cells);
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <input class="form-control" id="posGridNameInput" value="${escHtml(grid.name)}"
             style="max-width:200px" placeholder="Grid name" oninput="posRenameGrid(this.value)">
      ${_posActiveId==='root'?'<span style="font-size:12px;color:var(--text-muted)">(root — entry point for customers)</span>':''}
      <label class="switch-label" style="margin-left:auto" title="Stay on this grid after adding an item, the same way a long-press already does — instead of jumping back to the root menu each time">
        <input type="checkbox" ${grid.sticky?'checked':''} onchange="posToggleSticky(this.checked)">
        <span class="switch"></span>
        <span>Sticky</span>
      </label>
    </div>
    <div class="pos-admin-grid">
      ${cells.slice(0,POS_MAIN_N).map((cell,i) => posRenderAdminCell(cell,i)).join('')}
    </div>
    <div class="pos-admin-grid pos-admin-extra">
      ${cells.slice(POS_MAIN_N).map((cell,i) => posRenderAdminCell(cell,POS_MAIN_N+i)).join('')}
    </div>`;
}

function posRenderAdminCell(cell, idx) {
  const isEmpty = !cell || cell.type==='empty';
  const bg = (!isEmpty && cell.color)
    ? `background:${cell.color};color:${posIsLight(cell.color)?'#1e293b':'#fff'};border-color:${cell.color};` : '';
  const icon = {item:'🛒',grid:'▶',back:'◀',finish:'✓',clear:'✕',plus:'＋',minus:'－',empty:''}[cell?.type||'empty'];
  const label = cell?.label || '';
  const price = cell?.type==='item' && cell?.menuItemPrice ? fmtCurrency(cell.menuItemPrice) : '';
  return `<div class="pos-admin-cell ${isEmpty?'':'filled'}" style="${bg}"
               ${!isEmpty?`draggable="true" ondragstart="posCellDragStart(event,${idx})"`:''}
               onclick="posOpenCell(${idx})"
               ondragover="event.preventDefault();this.classList.add('drag-over')"
               ondragleave="this.classList.remove('drag-over')"
               ondrop="posCellDrop(event,${idx})">
    ${!isEmpty?`<button class="pos-cell-clear" onclick="event.stopPropagation();posClearCellAt(${idx})" title="Clear">×</button>`:''}
    ${!isEmpty&&icon?`<span class="pos-cell-badge">${icon}</span>`:''}
    ${isEmpty
      ? '<span style="color:var(--border);font-size:28px;line-height:1">+</span>'
      : `<span class="pos-cell-lbl">${escHtml(label)}</span>${price?`<span class="pos-cell-prc">${price}</span>`:''}`}
  </div>`;
}

window.posDragStart = function(e) {
  e.dataTransfer.setData('posItem', JSON.stringify({
    id: e.currentTarget.dataset.id,
    name: e.currentTarget.dataset.name,
    price: parseFloat(e.currentTarget.dataset.price)
  }));
};

window.posCellDragStart = function(e, idx) {
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  const cell = posNormCells(grid.cells)[idx];
  e.dataTransfer.setData('posCell', JSON.stringify({ srcIdx: idx, cell }));
};

window.posCellDrop = function(e, idx) {
  e.currentTarget.classList.remove('drag-over');
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  const cells = posNormCells(grid.cells);

  const cellRaw = e.dataTransfer.getData('posCell');
  if (cellRaw) {
    try {
      const { srcIdx, cell: srcCell } = JSON.parse(cellRaw);
      if (srcIdx === idx) return;
      cells[idx] = { ...srcCell };
      cells[srcIdx] = { type:'empty', label:'', color:'', menuItemId:'', menuItemPrice:0, targetGridId:'' };
      grid.cells = cells; posRenderEditor();
    } catch{}
    return;
  }

  try {
    const item = JSON.parse(e.dataTransfer.getData('posItem'));
    if (!item?.id) return;
    cells[idx] = { type:'item', label:item.name, color:cells[idx]?.color||'',
                   menuItemId:item.id, menuItemPrice:item.price, targetGridId:'' };
    grid.cells = cells; posRenderEditor();
  } catch{}
};

window.posClearCellAt = function(idx) {
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  const cells = posNormCells(grid.cells);
  cells[idx] = { type:'empty', label:'', color:'', menuItemId:'', menuItemPrice:0, targetGridId:'' };
  grid.cells = cells; posRenderEditor();
};

window.posRenameGrid = function(name) {
  if (_posActiveId && _posGrids[_posActiveId]) {
    _posGrids[_posActiveId].name = name;
    posRenderGridList();
  }
};

// Sticky, like a grid name change, is only kept in memory here until "Save Layout" actually
// writes it — see posSaveBtn's own handler, which already needs updating whenever a new
// per-grid field like this is added.
window.posToggleSticky = function(sticky) {
  if (_posActiveId && _posGrids[_posActiveId]) {
    _posGrids[_posActiveId].sticky = sticky;
  }
};

window.posOpenCell = function(idx) {
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  _posEditIdx = idx;
  const cell = posNormCells(grid.cells)[idx];
  _posCellColor = cell.color || '';
  document.getElementById('posCellType').value = cell.type || 'empty';
  document.getElementById('posCellLabel').value = cell.label || '';

  // Category filter defaults to whatever category the already-assigned item (if any) belongs to
  // — so opening a cell that's already set doesn't hide its own item behind a different filter
  // the moment the modal opens.
  const currentItem = _allMenuItems.find(i => i.id === cell.menuItemId);
  const catFilterEl = document.getElementById('posCellItemCatFilter');
  const cats = [...new Set(_allMenuItems.map(i => i.category).filter(Boolean))].sort();
  catFilterEl.innerHTML = '<option value="">All categories</option>' +
    cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
  catFilterEl.value = currentItem?.category || '';
  posRenderCellItemOptions();
  document.getElementById('posCellItemSel').value = cell.menuItemId || '';

  document.getElementById('posCellGridSel').innerHTML =
    '<option value="">— select —</option>' +
    _posGridOrder.filter(id => id!==_posActiveId).map(id => {
      const g=_posGrids[id];
      return `<option value="${id}"${id===cell.targetGridId?' selected':''}>${escHtml(g?.name||id)}</option>`;
    }).join('');
  posRenderColorPicker();
  posUpdateCellForm();
  document.getElementById('posCellModal').style.display = 'flex';
};

function posRenderColorPicker() {
  const isCustom = _posCellColor && !POS_COLORS.includes(_posCellColor);
  document.getElementById('posCellColors').innerHTML = POS_COLORS.map(c =>
    `<div onclick="posPickColor('${c}')" title="${c||'None'}"
          style="width:28px;height:28px;border-radius:6px;cursor:pointer;flex-shrink:0;
                 background:${c||'var(--surface)'};
                 border:2px solid ${c===_posCellColor?'var(--primary)':(c?c:'var(--border)')};
                 display:flex;align-items:center;justify-content:center">
       ${!c?'<span style="font-size:12px;color:var(--text-muted)">✕</span>':''}
     </div>`).join('')
    // Full-range picker (any hex, not just the presets above) — native <input type="color">
    // opens the OS/browser's own color wheel. Shows whatever's currently picked when that's a
    // valid 6-digit hex (including a preset, so it doubles as a live preview either way), with
    // its own ring highlighted only when the current colour is genuinely custom — a preset stays
    // "selected" via its own swatch instead, rather than both looking picked at once.
    + `<input type="color" id="posCellColorCustom"
              value="${/^#[0-9a-f]{6}$/i.test(_posCellColor) ? _posCellColor : '#4f46e5'}"
              oninput="posPickColor(this.value)" title="Custom colour"
              style="width:28px;height:28px;border-radius:6px;cursor:pointer;flex-shrink:0;padding:0;
                     border:2px solid ${isCustom ? 'var(--primary)' : 'var(--border)'}">`;
}

window.posPickColor = function(c) { _posCellColor = c; posRenderColorPicker(); };

window.posUpdateCellForm = function() {
  const type = document.getElementById('posCellType').value;
  document.getElementById('posCellLabelRow').style.display = type==='empty' ? 'none' : '';
  document.getElementById('posCellItemRow').style.display  = type==='item'  ? '' : 'none';
  document.getElementById('posCellGridRow').style.display  = type==='grid'  ? '' : 'none';
};

window.posCellItemChange = function() {
  const item = _allMenuItems.find(i => i.id===document.getElementById('posCellItemSel').value);
  if (item) document.getElementById('posCellLabel').value = item.name;
};

window.posCloseCellModal = function() {
  document.getElementById('posCellModal').style.display = 'none'; _posEditIdx = null;
};

window.posClearCell = function() {
  if (_posEditIdx===null) return;
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  const cells = posNormCells(grid.cells);
  cells[_posEditIdx] = { type:'empty', label:'', color:'', menuItemId:'', menuItemPrice:0, targetGridId:'' };
  grid.cells = cells;
  posCloseCellModal(); posRenderEditor();
};

window.posSaveCellEdit = function() {
  if (_posEditIdx===null) return;
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  const type         = document.getElementById('posCellType').value;
  const label        = document.getElementById('posCellLabel').value.trim();
  const menuItemId   = document.getElementById('posCellItemSel').value;
  const targetGridId = document.getElementById('posCellGridSel').value;
  const menuItemPrice = type==='item' ? (_allMenuItems.find(i=>i.id===menuItemId)?.price||0) : 0;
  const cells = posNormCells(grid.cells);
  cells[_posEditIdx] = {
    type, label: label||(type==='back'?'Back':''), color:_posCellColor,
    menuItemId: type==='item'?menuItemId:'', menuItemPrice,
    targetGridId: type==='grid'?targetGridId:''
  };
  grid.cells = cells;
  posCloseCellModal(); posRenderEditor();
};

window.posDeleteGrid = async function(id) {
  if (id==='root') return;
  if (!confirm(`Delete grid "${_posGrids[id]?.name}"?`)) return;
  try {
    await db.collection('showdrinks_posGrids').doc(id).delete();
    delete _posGrids[id];
    _posGridOrder = _posGridOrder.filter(x => x!==id);
    if (_posActiveId===id) _posActiveId='root';
    posRenderGridList(); posRenderEditor();
    toast('Grid deleted','info');
  } catch(e) { toast('Failed: '+e.message,'error'); }
};

document.getElementById('posAddGridBtn').addEventListener('click', async () => {
  const name = prompt('New grid name:');
  if (!name?.trim()) return;
  try {
    const g = posEmptyGrid(name.trim());
    const ref = await db.collection('showdrinks_posGrids').add(g);
    _posGrids[ref.id] = { id:ref.id, ...g };
    _posGridOrder.push(ref.id);
    posSelectGrid(ref.id);
    toast('Grid added','success');
  } catch(e) { toast('Failed: '+e.message,'error'); }
});

document.getElementById('posSaveBtn').addEventListener('click', async () => {
  try {
    const batch = db.batch();
    Object.values(_posGrids).forEach(g => {
      batch.set(db.collection('showdrinks_posGrids').doc(g.id), { name:g.name, cells:g.cells||[], sticky:g.sticky===true });
    });
    await batch.commit();
    toast('POS layout saved','success');
  } catch(e) { toast('Failed: '+e.message,'error'); }
});

document.getElementById('posCellModal').addEventListener('click', function(e) {
  if (e.target===this) posCloseCellModal();
});

// ── POS Test Mode ───────────────────────────────────────────────────────────

let _testStack = [];
let _testBasket = {};

window.posOpenTest = function() {
  _testStack = ['root']; _testBasket = {};
  posRenderTestGrid(); posRenderTestBasket();
  document.getElementById('posTestModal').style.display = 'flex';
};

window.posCloseTest = function() {
  document.getElementById('posTestModal').style.display = 'none';
};

window.posResetTest = function() {
  _testStack = ['root']; _testBasket = {}; _testSelectedKey = null;
  posRenderTestGrid(); posRenderTestBasket();
};

function posRenderTestGrid() {
  const gridId = _testStack[_testStack.length - 1];
  const grid = _posGrids[gridId];
  const el = document.getElementById('testPosGrid');
  if (!el) return;
  if (!grid) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Grid not found.</p>'; return; }
  const cells = posNormCells(grid.cells);
  function cellBtn(cell, i) {
    if (!cell || cell.type === 'empty') return `<button class="pos-btn empty" disabled></button>`;
    const style = cell.color
      ? `background:${cell.color};color:${posIsLight(cell.color)?'#1e293b':'#fff'};border-color:${cell.color};` : '';
    const price = cell.type === 'item' && cell.menuItemPrice ? fmtCurrency(cell.menuItemPrice) : '';
    return `<button class="pos-btn" style="${style}" onclick="handlePosTestBtn(${i})">
      <span class="pb-lbl">${escHtml(cell.label || '')}</span>
      ${price ? `<span class="pb-price">${price}</span>` : ''}
    </button>`;
  }
  el.innerHTML =
    `<div class="pos-grid">${cells.slice(0,POS_MAIN_N).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${cells.slice(POS_MAIN_N).map((c,i) => cellBtn(c,POS_MAIN_N+i)).join('')}</div>`;
}

function posRenderTestBasket() {
  const el = document.getElementById('testBasket');
  if (!el) return;
  const items = Object.values(_testBasket);
  if (!items.length) { el.innerHTML = '<span style="color:var(--text-muted)">Basket empty</span>'; return; }
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  el.innerHTML = items.map(i =>
    `<div style="display:flex;justify-content:space-between">
       <span>${i.qty}× ${escHtml(i.name)}</span>
       <span>${fmtCurrency(i.price * i.qty)}</span>
     </div>`).join('') +
    `<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:4px;font-weight:700;display:flex;justify-content:space-between">
       <span>Total</span><span>${fmtCurrency(total)}</span>
     </div>`;
}

let _testSelectedKey = null;

window.handlePosTestBtn = function(idx) {
  const grid = _posGrids[_testStack[_testStack.length - 1]];
  if (!grid) return;
  const cell = posNormCells(grid.cells)[idx];
  if (!cell || cell.type === 'empty') return;
  if (cell.type === 'item') {
    const key = cell.label || cell.menuItemId;
    if (!_testBasket[key]) _testBasket[key] = { name: cell.label, price: cell.menuItemPrice || 0, qty: 0 };
    _testBasket[key].qty += 1;
    _testSelectedKey = key;
    // Test mode has no long-press to simulate, so Sticky (grid.sticky) is the only thing that
    // ever keeps it on the current grid here — same rule as the real Bar Tabs POS/customer grids.
    if (!grid.sticky) _testStack = ['root'];
    posRenderTestGrid(); posRenderTestBasket();
  } else if (cell.type === 'clear') {
    _testBasket = {}; _testSelectedKey = null; posRenderTestBasket();
  } else if (cell.type === 'plus') {
    if (!_testSelectedKey || !_testBasket[_testSelectedKey]) { toast('Select an item first', 'error'); return; }
    _testBasket[_testSelectedKey].qty += 1; posRenderTestBasket();
  } else if (cell.type === 'minus') {
    if (!_testSelectedKey || !_testBasket[_testSelectedKey]) { toast('Select an item first', 'error'); return; }
    _testBasket[_testSelectedKey].qty -= 1;
    if (_testBasket[_testSelectedKey].qty <= 0) { delete _testBasket[_testSelectedKey]; _testSelectedKey = null; }
    posRenderTestBasket();
  } else if (cell.type === 'grid') {
    if (cell.targetGridId && _posGrids[cell.targetGridId]) {
      _testStack.push(cell.targetGridId); posRenderTestGrid();
    }
  } else if (cell.type === 'back') {
    if (_testStack.length > 1) { _testStack.pop(); posRenderTestGrid(); }
    else toast('Back → would return to date/session screen', 'info');
  } else if (cell.type === 'finish') {
    const items = Object.values(_testBasket);
    if (!items.length) { toast('Add items first', 'error'); return; }
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    toast(`✓ Finish → review screen. Total: ${fmtCurrency(total)}`, 'success');
  }
};

document.getElementById('posTestModal').addEventListener('click', function(e) {
  if (e.target === this) posCloseTest();
});

// ── Show Tabs ────────────────────────────────────────────────────────────────

let _tabMembers          = [];   // [{id, name}]
let _tabOrders           = [];   // [{id, memberId, memberName, items, totalAmount, paid, createdAt}]
let _tabOrdersUnsubscribe = null;
let _tabSelectedMemberId = null;
let _tabStack            = ['root'];
let _tabBasket           = {};
let _tabSelectedKey      = null;
let _tabSelectedCategory = null;

// Its own POS Grid / Category List choice — Settings & QR → Ordering Method's "Bar Tabs POS
// screen" (optionally overridden per-show), independent of the customer ordering screen's own
// mode (same card/section, its own field: tabOrderingMode vs orderingMode).
function isPosMode() {
  const current = _shows.find(s => s.isCurrent);
  const mode = current?.tabOrderingMode || _systemSettings.tabOrderingMode || 'pos';
  return mode !== 'list';
}

// Settings & QR → Ordering Method's "Starting page" for Bar Tabs POS — falls back to root if
// unset or if the configured grid's since been deleted.
function tabPosStartGrid() {
  const id = _systemSettings.tabPosStartGridId;
  return id && _posGrids[id] ? id : 'root';
}

// Shared by both Bar Tabs pages (POS and Admin) — members + their running totals, and the live
// tabOrders listener renderTabMembersList() needs to compute those totals. Cached: skips the
// members re-fetch once loaded (this array is kept in sync locally whenever a member's added —
// see addOrSelectTabMember) and keeps the tabOrders listener subscribed across tab switches
// instead of tearing it down and resubscribing every time — re-opening either Bar Tabs page was
// paying for a full re-fetch + a fresh listener setup on every visit for no reason.
async function loadTabMembersData() {
  if (!_tabMembers.length) await loadTabMembers();
  if (!_tabOrdersUnsubscribe) {
    _tabOrdersUnsubscribe = db.collection('showdrinks_tabOrders').orderBy('createdAt', 'desc').onSnapshot(snap => {
      _tabOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderTabMembersList();
    }, e => toast('Could not load tabs: ' + e.message, 'error'));
  }
}

async function loadShowTabs() {
  // Independent fetches — run them together rather than one after the other.
  await Promise.all([
    Object.keys(_posGrids).length ? Promise.resolve() : loadPosGrids(),
    loadTabMembersData(),
  ]);
  // _tabStack starts out pointed at 'root' (its declaration runs before Settings & QR's
  // tabPosStartGridId is loaded) — now that it's loaded, and as long as nobody's mid-order,
  // correct it to whichever grid is actually configured as the starting page. Otherwise the
  // dimmed "no member selected yet" screen shows root instead of the configured start page.
  if (!_tabSelectedMemberId) _tabStack = [tabPosStartGrid()];
  renderTabOrderEntry();
  renderTabBasket();
}

// Shows whichever of the POS grid / category list the current ordering mode calls for. Either
// way, tapping the basket bar above (#tabBasket) commits the order to the member's tab — a POS
// grid's own "Finish" cell still works too, but nothing list-mode-specific is needed for it.
function renderTabOrderEntry() {
  const posMode = isPosMode();
  document.getElementById('tabPosGrid').style.display = posMode ? '' : 'none';
  document.getElementById('tabListArea').style.display = posMode ? 'none' : '';
  // #tabListCatBar now lives in the sticky header (a sibling of #tabListArea, not nested inside
  // it), so it needs its own explicit hide here for grid mode — renderTabListMenu() (list mode)
  // sets its own display based on category count.
  if (posMode) document.getElementById('tabListCatBar').style.display = 'none';
  // .tab-pos-buttons only gets its own bounded/internally-scrolling box (see .grid-mode in
  // style.css) in Grid mode, where it holds a fixed set of buttons. In List mode it needs to
  // flow naturally instead: the sticky header above it tracks the page's own scroll, not an
  // independent scrollbox's — so a long list scrolled inside its own separate box never moved
  // that header at all, which looked like "not sticky" even though the CSS said sticky.
  document.querySelector('.tab-pos-buttons').classList.toggle('grid-mode', posMode);
  if (posMode) renderTabGrid(); else renderTabListMenu();
}

async function loadTabMembers() {
  const snap = await db.collection('showdrinks_tabMembers').orderBy('name').get();
  _tabMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderTabMemberSelect();
  renderTabMembersList();
}

function renderTabMemberSelect() {
  const sel = document.getElementById('tabMemberSelect');
  sel.innerHTML = '<option value="">— choose a member —</option>' +
    '<option value="__add__">+ Add a member…</option>' +
    _tabMembers.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
  sel.value = _tabSelectedMemberId || '';
}

window.selectTabMember = function(id) {
  if (id === '__add__') {
    document.getElementById('tabMemberSelect').value = _tabSelectedMemberId || '';
    openAddTabMemberModal();
    return;
  }
  _tabSelectedMemberId = id || null;
  _tabStack = [tabPosStartGrid()]; _tabBasket = {}; _tabSelectedKey = null; _tabSelectedCategory = null;
  document.getElementById('tabMemberSelect').value = id || '';

  const posArea = document.getElementById('tabPosArea');
  const member = _tabMembers.find(m => m.id === _tabSelectedMemberId);
  posArea.classList.toggle('inactive', !member);
  renderTabOrderEntry();
  renderTabBasket();
  renderTabMembersList();
};

// Shared by the "Add Member" form (Members & Totals) and the "+ Add a member…" modal opened
// from the Show Tabs member picker — checks for a duplicate name first (case-insensitive) and
// just selects the existing member instead of creating a second one, otherwise creates the
// member, refreshes the dropdown/list, and selects the new member. Returns true once the caller
// can safely clear its inputs / close its modal.
// Iterative Levenshtein edit distance — the member list is small enough (cast/crew, not
// customers) that this plain-JS version is plenty fast; no need for a library.
function levenshteinDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0 (nothing alike) .. 1 (identical) — normalized so it's comparable across names of different
// lengths, unlike a raw edit-distance count.
function nameSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return maxLen ? 1 - levenshteinDistance(a, b) / maxLen : 1;
}

const FUZZY_NAME_MATCH_THRESHOLD = 0.75;

// Same first name *or* a close full-name spelling match, unioned into one list — either is
// reason enough to check before creating what might be a duplicate entry.
// The first-name check only fires when the typed name has no surname of its own — "John" should
// surface every existing John so whoever's typing can pick the right one, but "John Smith"
// shouldn't flag an existing "John Doe" just because they happen to share a first name; those
// are two different full names, not a probable duplicate, and the full-string fuzzy check below
// already covers a genuine near-miss like "John Smith" vs "Jon Smith".
function findSimilarMembers(name, candidates) {
  const nameLower = name.toLowerCase();
  const nameParts = nameLower.split(/\s+/);
  const matches = new Map();
  if (nameParts.length === 1) {
    candidates.forEach(m => {
      if (m.name.toLowerCase().split(/\s+/)[0] === nameParts[0]) matches.set(m.id, m);
    });
  }
  let closest = null, closestScore = 0;
  for (const m of candidates) {
    const score = nameSimilarity(nameLower, m.name.toLowerCase());
    if (score > closestScore) { closestScore = score; closest = m; }
  }
  if (closest && closestScore >= FUZZY_NAME_MATCH_THRESHOLD) matches.set(closest.id, closest);
  return [...matches.values()];
}

// Resolves to the matching member the user picked, or null for "someone new, add anyway"
// (tapping outside the modal counts as the same thing — there's no third "abort entirely" state
// here, same as the plain confirm() this replaced).
function askNameMatch(name, members) {
  return new Promise(resolve => {
    const modal = document.getElementById('nameMatchModal');
    document.getElementById('nameMatchIntro').textContent = members.length === 1
      ? `"${members[0].name}" is already on the list — is this the same person as "${name}"?`
      : `${members.length} people already on the list have a similar name to "${name}" — is it one of these, or someone new?`;
    document.getElementById('nameMatchList').innerHTML = members.map(m =>
      `<button type="button" class="btn btn-secondary btn-full" data-match-id="${m.id}">${escHtml(m.name)}</button>`
    ).join('');

    function cleanup(result) {
      modal.style.display = 'none';
      document.getElementById('nameMatchList').removeEventListener('click', onList);
      document.getElementById('nameMatchNewBtn').removeEventListener('click', onNew);
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    }
    function onList(e) {
      const btn = e.target.closest('[data-match-id]');
      if (!btn) return;
      cleanup(members.find(m => m.id === btn.dataset.matchId) || null);
    }
    function onNew() { cleanup(null); }
    function onBackdrop(e) { if (e.target === modal) cleanup(null); }

    document.getElementById('nameMatchList').addEventListener('click', onList);
    document.getElementById('nameMatchNewBtn').addEventListener('click', onNew);
    modal.addEventListener('click', onBackdrop);
    modal.style.display = 'flex';
  });
}

async function addOrSelectTabMember(rawName, rawEmail) {
  const name = rawName.trim();
  const email = rawEmail.trim();
  if (!name) { toast('Enter a member name', 'error'); return false; }
  const nameLower = name.toLowerCase();

  const dupe = _tabMembers.find(m => m.name.toLowerCase() === nameLower);
  if (dupe) {
    selectTabMember(dupe.id);
    toast(`"${dupe.name}" already exists — selected instead`, 'info');
    return true;
  }

  const similar = findSimilarMembers(name, _tabMembers);
  if (similar.length) {
    const chosen = await askNameMatch(name, similar);
    if (chosen) {
      selectTabMember(chosen.id);
      toast(`Using existing member "${chosen.name}"`, 'info');
      return true;
    }
    // null → confirmed someone new, fall through and create
  }

  const ref = await db.collection('showdrinks_tabMembers').add({
    name, email, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  _tabMembers.push({ id: ref.id, name, email });
  _tabMembers.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
  renderTabMemberSelect();
  selectTabMember(ref.id);
  toast('Member added', 'success');
  return true;
}

// ── Add/Edit member modal — one modal, two modes ────────────────────────────
// Opened from: Bar Tabs' "+ Add Member" button, a row's "✏ Edit", or the Bar Tabs POS
// member picker's "+ Add a member…" option. _editingTabMemberId null = adding, set = editing.

let _editingTabMemberId = null;

window.openAddTabMemberModal = function() {
  _editingTabMemberId = null;
  document.getElementById('tabMemberModalTitle').textContent = 'Add Member';
  document.getElementById('addTabMemberModalSaveBtn').textContent = 'Add';
  document.getElementById('newMemberModalName').value = '';
  document.getElementById('newMemberModalEmail').value = '';
  document.getElementById('addTabMemberModal').style.display = 'flex';
  document.getElementById('newMemberModalName').focus();
};

window.openEditTabMemberModal = function(id) {
  const member = _tabMembers.find(m => m.id === id);
  if (!member) return;
  _editingTabMemberId = id;
  document.getElementById('tabMemberModalTitle').textContent = 'Edit Member';
  document.getElementById('addTabMemberModalSaveBtn').textContent = 'Save Changes';
  document.getElementById('newMemberModalName').value = member.name || '';
  document.getElementById('newMemberModalEmail').value = member.email || '';
  document.getElementById('addTabMemberModal').style.display = 'flex';
  document.getElementById('newMemberModalName').focus();
};

window.closeAddTabMemberModal = function() {
  document.getElementById('addTabMemberModal').style.display = 'none';
  _editingTabMemberId = null;
};

document.getElementById('addTabMemberModalSaveBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('newMemberModalName');
  const emailInput = document.getElementById('newMemberModalEmail');
  try {
    const ok = _editingTabMemberId
      ? await updateTabMember(_editingTabMemberId, nameInput.value, emailInput.value)
      : await addOrSelectTabMember(nameInput.value, emailInput.value);
    if (ok) closeAddTabMemberModal();
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

document.getElementById('addTabMemberModal').addEventListener('click', function(e) {
  if (e.target === this) closeAddTabMemberModal();
});

// Same duplicate-name safety net as adding (see addOrSelectTabMember), minus the member's own
// current name (so saving with no name change, or just fixing a typo, doesn't flag itself).
async function updateTabMember(id, rawName, rawEmail) {
  const name = rawName.trim();
  const email = rawEmail.trim();
  if (!name) { toast('Enter a member name', 'error'); return false; }
  const nameLower = name.toLowerCase();
  const others = _tabMembers.filter(m => m.id !== id);

  const dupe = others.find(m => m.name.toLowerCase() === nameLower);
  if (dupe) { toast(`"${dupe.name}" already uses that name`, 'error'); return false; }

  // Same first name as, or a close spelling match to, one or more other members — not a "pick
  // which one this actually is" choice like adding gets (this is a rename, not a merge), just a
  // heads-up before proceeding.
  const similar = findSimilarMembers(name, others);
  if (similar.length) {
    const names = similar.map(m => `"${m.name}"`).join(', ');
    if (!confirm(`This is similar to ${similar.length === 1 ? 'an existing member' : 'existing members'}, ${names} — rename to "${name}" anyway?`)) return false;
  }

  try {
    await db.collection('showdrinks_tabMembers').doc(id).update({ name, email });
    const member = _tabMembers.find(m => m.id === id);
    if (member) { member.name = name; member.email = email; }
    _tabMembers.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    renderTabMemberSelect();
    renderTabMembersList();
    toast('Member updated', 'success');
    return true;
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
    return false;
  }
}

function renderTabGrid() {
  const gridId = _tabStack[_tabStack.length - 1];
  const grid = _posGrids[gridId];
  const el = document.getElementById('tabPosGrid');
  if (!el) return;
  if (!grid) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">POS layout not set up yet — configure it in POS Layout.</p>'; return; }
  const cells = posNormCells(grid.cells);
  function cellBtn(cell, i) {
    if (!cell || cell.type === 'empty') return `<button class="pos-btn empty" disabled></button>`;
    const style = cell.color
      ? `background:${cell.color};color:${posIsLight(cell.color)?'#1e293b':'#fff'};border-color:${cell.color};` : '';
    const price = cell.type === 'item' && cell.menuItemPrice ? fmtCurrency(cell.menuItemPrice) : '';
    // Live lookup (the cell itself only stores a denormalized label/price) — off-sale (or, same
    // treatment, customer-only) items are dimmed and untappable, but the button stays put; the
    // grid's own layout is meaningful and shared with the customer ordering screen's POS grid.
    const liveItem = cell.type === 'item' ? _allMenuItems.find(mi => mi.id === cell.menuItemId) : null;
    const offSale = !!(liveItem && (liveItem.onSale === false || !itemShowsOnTab(liveItem)));
    // Same key handleTabPosBtn uses to add this cell to the basket.
    const hasQty = cell.type === 'item' && !offSale && _tabBasket[cell.label || cell.menuItemId]?.qty > 0;
    return `<button class="pos-btn${hasQty ? ' has-qty' : ''}${offSale ? ' unavailable' : ''}" style="${style}" data-idx="${i}" ${offSale ? 'disabled' : ''}>
      <span class="pb-lbl">${escHtml(cell.label || '')}</span>
      ${price ? `<span class="pb-price">${price}</span>` : ''}
    </button>`;
  }
  el.innerHTML =
    `<div class="pos-grid">${cells.slice(0,POS_MAIN_N).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${cells.slice(POS_MAIN_N).map((c,i) => cellBtn(c,POS_MAIN_N+i)).join('')}</div>`;
}

// Category List alternative to the POS grid above — every menu item grouped under its category,
// each with a +/- stepper straight into the member's basket. Same "All" + per-category chips
// pattern as the customer ordering screen's list mode.
function renderTabListMenu() {
  const el = document.getElementById('tabListMenu');
  const barEl = document.getElementById('tabListCatBar');
  if (!el) return;
  const onSaleItems = _allMenuItems.filter(item => item.onSale !== false && itemShowsOnTab(item));
  if (!onSaleItems.length) {
    barEl.style.display = 'none';
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No menu items yet.</p>';
    return;
  }
  const groups = {};
  const catOrder = [];
  onSaleItems.forEach(item => { // already sorted category-then-name by loadMenuItems()
    const cat = item.category || 'Other';
    if (!groups[cat]) { groups[cat] = []; catOrder.push(cat); }
    groups[cat].push(item);
  });

  // No "All" chip, and nothing shown until a category is tapped — every pill fits on screen at
  // once now (see #tabListCatBar's flex-wrap:wrap in style.css), so there's no need for an
  // "everything at once" fallback the way a horizontally-scrolling bar needed one.
  // An extra ORDER_CHIP pill appears once there's something in this member's basket, showing
  // whatever's in it with a +/− stepper and a delete — same list, just reusing the pill-per-view
  // pattern instead of a separate screen for "what have I actually got so far".
  const tabBasketCount = Object.values(_tabBasket).reduce((s, i) => s + i.qty, 0);
  const hasOrder = tabBasketCount > 0;
  const validSelections = hasOrder ? [...catOrder, ORDER_CHIP] : catOrder;
  const selected = _tabSelectedCategory && validSelections.includes(_tabSelectedCategory)
    ? _tabSelectedCategory : null;
  _tabSelectedCategory = selected;

  barEl.style.display = (catOrder.length || hasOrder) ? 'flex' : 'none';
  barEl.innerHTML =
    catOrder.map(cat => `
    <button type="button" class="cat-btn ${cat === selected ? 'active' : ''}"
            onclick="selectTabListCat('${encodeURIComponent(cat)}')">${escHtml(cat)}</button>`).join('') +
    (hasOrder ? `<button type="button" class="cat-btn order-chip ${selected === ORDER_CHIP ? 'active' : ''}"
            onclick="selectTabListCat('${encodeURIComponent(ORDER_CHIP)}')">Order (${tabBasketCount})</button>` : '');

  if (selected === ORDER_CHIP) {
    el.innerHTML = tabBasketListHtml();
    return;
  }
  el.innerHTML = selected
    ? `<div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 6px">${escHtml(selected)}</div>
       <div class="menu-grid">${groups[selected].map(tabListItemHtml).join('')}</div>`
    : '<p style="color:var(--text-muted);font-size:13px">Choose a category above.</p>';
}

// Sentinel _tabSelectedCategory value for the Order chip above — distinct from any real category
// name (menu categories are free-text, but none of them can equal this).
const ORDER_CHIP = '__order__';

// The Order chip's own view: every basket line with a full +/− stepper and a delete, unlike the
// category cards above (tap-to-add, trash-to-clear-to-zero) — this is the one place you can walk
// a quantity down one at a time instead of clearing it outright.
function tabBasketListHtml() {
  const entries = Object.entries(_tabBasket);
  if (!entries.length) {
    return '<p style="color:var(--text-muted);font-size:13px">Nothing added yet.</p>';
  }
  const total = entries.reduce((s, [, i]) => s + i.price * i.qty, 0);
  const rows = entries.map(([key, i]) => `
    <div class="menu-item-card has-qty">
      <span class="mic-name">${escHtml(i.name)}</span>
      <span class="mic-price">${fmtCurrency(i.price * i.qty)}</span>
      <div class="qty-control">
        <button onclick="tabListDecBasketItem('${encodeURIComponent(key)}')" title="Remove one">−</button>
        <span class="qty-num">${i.qty}</span>
        <button onclick="tabListIncBasketItem('${encodeURIComponent(key)}')" title="Add one">+</button>
        <button class="qty-danger" onclick="tabListDeleteBasketItem('${encodeURIComponent(key)}')" title="Delete">🗑</button>
      </div>
    </div>`).join('');
  return `<div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 6px">Order</div>
    <div class="menu-grid">${rows}</div>
    <div class="order-total-line"><span>Total</span><span>${fmtCurrency(total)}</span></div>`;
}

window.tabListIncBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!_tabBasket[key]) return;
  _tabBasket[key].qty += 1;
  renderTabListMenu();
  renderTabBasket();
};

window.tabListDecBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!_tabBasket[key]) return;
  _tabBasket[key].qty -= 1;
  if (_tabBasket[key].qty <= 0) delete _tabBasket[key];
  renderTabListMenu();
  renderTabBasket();
};

window.tabListDeleteBasketItem = function(encodedKey) {
  delete _tabBasket[decodeURIComponent(encodedKey)];
  renderTabListMenu();
  renderTabBasket();
};

// Tap the card to add one; once it holds any, a delete button clears it back to 0 rather than
// stepping down one at a time — there's no separate +/− pair (same pattern as the customer
// ordering screen's list mode).
function tabListItemHtml(item) {
  const qty = _tabBasket[item.name]?.qty || 0;
  return `<div class="menu-item-card${qty > 0 ? ' has-qty' : ''}" onclick="tabListIncItem('${item.id}')">
    <span class="mic-name">${escHtml(item.name)}</span>
    <span class="mic-price">${fmtCurrency(item.price)}</span>
    ${qty > 0 ? `<div class="qty-control">
      <span class="qty-num">${qty}×</span>
      <button onclick="event.stopPropagation();tabListRemoveItem('${item.id}')" title="Remove">🗑</button>
    </div>` : ''}
  </div>`;
}

window.selectTabListCat = function(encodedCat) {
  _tabSelectedCategory = decodeURIComponent(encodedCat);
  renderTabListMenu();
};

window.tabListIncItem = function(menuItemId) {
  if (!_tabSelectedMemberId) return; // list stays visible but inactive until a member is picked — matches handleTabPosBtn
  const item = _allMenuItems.find(i => i.id === menuItemId);
  if (!item) return;
  const key = item.name;
  if (!_tabBasket[key]) _tabBasket[key] = { name: item.name, price: item.price, qty: 0 };
  _tabBasket[key].qty += 1;
  renderTabListMenu();
  renderTabBasket();
};

window.tabListRemoveItem = function(menuItemId) {
  const item = _allMenuItems.find(i => i.id === menuItemId);
  if (!item) return;
  delete _tabBasket[item.name];
  renderTabListMenu();
  renderTabBasket();
};

// Long-press (500ms+) on an item cell adds it without jumping back to the root menu, so several
// from the same category can be added in a row; a normal tap still returns to the root menu each
// time (the existing/expected behaviour) — see the isLongPress branch inside handleTabPosBtn.
// Same helper as the entry app's order.js — kept duplicated rather than shared since these two
// pages don't otherwise share any script.
function wirePosLongPress(container, onPress) {
  if (!container) return;
  const LONG_PRESS_MS = 500;
  container.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.pos-btn[data-idx]');
    if (btn) btn.dataset.pressStart = Date.now();
  });
  container.addEventListener('pointerup', (e) => {
    const btn = e.target.closest('.pos-btn[data-idx]');
    if (!btn || !btn.dataset.pressStart) return;
    const isLongPress = (Date.now() - Number(btn.dataset.pressStart)) >= LONG_PRESS_MS;
    delete btn.dataset.pressStart;
    onPress(Number(btn.dataset.idx), isLongPress);
  });
  // pointerleave doesn't bubble, so capture it at the container to still catch it per-button —
  // cancels the press if a finger/cursor drags off the button (e.g. scrolling) before release.
  container.addEventListener('pointerleave', (e) => {
    const btn = e.target.closest?.('.pos-btn[data-idx]');
    if (btn) delete btn.dataset.pressStart;
  }, true);
  container.addEventListener('pointercancel', (e) => {
    const btn = e.target.closest?.('.pos-btn[data-idx]');
    if (btn) delete btn.dataset.pressStart;
  });
}

// Itemized as it builds up, same as the POS Layout Test preview's own basket (posRenderTestBasket)
// — capped height/scrollable rather than left to grow unbounded, since this sits in the sticky
// header above the grid.
function renderTabBasket() {
  const el = document.getElementById('tabBasket');
  if (!el) return;
  const items = Object.values(_tabBasket);
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const itemsHtml = items.length
    ? `<div class="tab-basket-items">${items.map(i =>
        `<div class="tab-basket-item-row">
           <span>${i.qty}× ${escHtml(i.name)}</span>
           <span>${fmtCurrency(i.price * i.qty)}</span>
         </div>`).join('')}</div>`
    : '';
  el.innerHTML = itemsHtml + `
    <span class="tab-basket-row">
      <span class="tab-basket-icon">${ICON_TROLLEY}</span>
      <span class="tab-basket-total">${fmtCurrency(total)}</span>
    </span>
    <span class="tab-basket-caption">Tap to review &amp; add to tab</span>`;
}

window.handleTabPosBtn = function(idx, isLongPress) {
  if (!_tabSelectedMemberId) return; // grid stays visible but inactive until a member is picked
  const grid = _posGrids[_tabStack[_tabStack.length - 1]];
  if (!grid) return;
  const cell = posNormCells(grid.cells)[idx];
  if (!cell || cell.type === 'empty') return;
  if (cell.type === 'item') {
    const liveItem = _allMenuItems.find(mi => mi.id === cell.menuItemId);
    if (liveItem && (liveItem.onSale === false || !itemShowsOnTab(liveItem))) return; // shouldn't be reachable — button is disabled — but no error pill either way
    const key = cell.label || cell.menuItemId;
    if (!_tabBasket[key]) _tabBasket[key] = { name: cell.label, price: cell.menuItemPrice || 0, qty: 0 };
    _tabBasket[key].qty += 1;
    _tabSelectedKey = key;
    // Long press stays on this grid (adding several from the same category in a row) — so does a
    // plain tap, on a grid marked Sticky in POS Layout (grid.sticky). Otherwise a normal tap still
    // jumps back to the root menu, same as before.
    if (!isLongPress && !grid.sticky) _tabStack = [tabPosStartGrid()];
    renderTabGrid(); renderTabBasket();
  } else if (cell.type === 'clear') {
    _tabBasket = {}; _tabSelectedKey = null; renderTabGrid(); renderTabBasket();
  } else if (cell.type === 'plus') {
    if (!_tabSelectedKey || !_tabBasket[_tabSelectedKey]) return;
    _tabBasket[_tabSelectedKey].qty += 1; renderTabGrid(); renderTabBasket();
  } else if (cell.type === 'minus') {
    if (!_tabSelectedKey || !_tabBasket[_tabSelectedKey]) return;
    _tabBasket[_tabSelectedKey].qty -= 1;
    if (_tabBasket[_tabSelectedKey].qty <= 0) { delete _tabBasket[_tabSelectedKey]; _tabSelectedKey = null; }
    renderTabGrid(); renderTabBasket();
  } else if (cell.type === 'grid') {
    if (cell.targetGridId && _posGrids[cell.targetGridId]) {
      _tabStack.push(cell.targetGridId); renderTabGrid();
    }
  } else if (cell.type === 'back') {
    if (_tabStack.length > 1) { _tabStack.pop(); renderTabGrid(); }
  } else if (cell.type === 'finish') {
    commitTabOrder();
  }
};

// #tabPosGrid is a static container (never itself replaced, only its children on each render),
// so this delegation is wired once here rather than re-attached on every renderTabGrid() call.
wirePosLongPress(document.getElementById('tabPosGrid'), handleTabPosBtn);

async function commitTabOrder() {
  // No error pill here — the button itself is disabled (see openTabBasketReview) until a member
  // is selected and the basket total is > 0, so this is just a defensive no-op, not a user-facing case.
  const items = Object.values(_tabBasket).map(i => ({ name: i.name, price: i.price, quantity: i.qty }));
  const totalAmount = items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (!_tabSelectedMemberId || !items.length || totalAmount <= 0) return;
  const member = _tabMembers.find(m => m.id === _tabSelectedMemberId);
  try {
    await db.collection('showdrinks_tabOrders').add({
      memberId: _tabSelectedMemberId,
      memberName: member?.name || '',
      items, totalAmount, paid: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    _tabBasket = {}; _tabSelectedKey = null; _tabStack = [tabPosStartGrid()];
    renderTabOrderEntry(); renderTabBasket();
    closeTabBasketReview();
    // A lightweight auto-dismissing pill rather than a modal needing an "OK" tap — this is a
    // fast-paced POS screen, not somewhere worth stopping to confirm.
    toast(`Added ${fmtCurrency(totalAmount)} to ${member?.name || 'member'}'s tab`);
    selectTabMember(null); // back to a clean dropdown for the next customer
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

// ── Basket review modal (tap the basket bar) ────────────────────────────────

// Same +/−/delete pattern as the customer app's own "Order (n)" chip (basketListHtml in
// order.js) — reused here so the review modal isn't just a read-only summary; a bartender can
// walk a quantity down, bump it back up, or drop an item entirely before committing to the tab.
function renderTabBasketReviewItems() {
  const items = Object.entries(_tabBasket);
  const el = document.getElementById('tabBasketReviewItems');
  el.innerHTML = items.length
    ? items.map(([key, i]) => `
      <div class="menu-item-card has-qty">
        <span class="mic-name">${escHtml(i.name)}</span>
        <span class="mic-price">${fmtCurrency(i.price * i.qty)}</span>
        <div class="qty-control">
          <button onclick="tabDecBasketItem('${encodeURIComponent(key)}')" title="Remove one">−</button>
          <span class="qty-num">${i.qty}</span>
          <button onclick="tabIncBasketItem('${encodeURIComponent(key)}')" title="Add one">+</button>
          <button class="qty-danger" onclick="tabRemoveBasketItem('${encodeURIComponent(key)}')" title="Delete">🗑</button>
        </div>
      </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:14px">No drinks added yet.</p>';
  const total = items.reduce((s, [, i]) => s + i.price * i.qty, 0);
  document.getElementById('tabBasketReviewTotal').textContent = fmtCurrency(total);
  // Disabled rather than tappable-then-errored — no member selected, or nothing to charge.
  document.getElementById('tabCommitBtn').disabled = !_tabSelectedMemberId || total <= 0;
}

window.tabIncBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!_tabBasket[key]) return;
  _tabBasket[key].qty += 1;
  renderTabBasketReviewItems(); renderTabBasket(); renderTabGrid();
};

window.tabDecBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!_tabBasket[key]) return;
  _tabBasket[key].qty -= 1;
  if (_tabBasket[key].qty <= 0) { delete _tabBasket[key]; if (_tabSelectedKey === key) _tabSelectedKey = null; }
  renderTabBasketReviewItems(); renderTabBasket(); renderTabGrid();
};

window.tabRemoveBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  delete _tabBasket[key];
  if (_tabSelectedKey === key) _tabSelectedKey = null;
  renderTabBasketReviewItems(); renderTabBasket(); renderTabGrid();
};

window.openTabBasketReview = function() {
  renderTabBasketReviewItems();
  document.getElementById('tabBasketReviewModal').style.display = 'flex';
};

window.closeTabBasketReview = function() {
  document.getElementById('tabBasketReviewModal').style.display = 'none';
};

document.getElementById('tabBasketReviewModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeTabBasketReview();
});

let _tabExpandedMemberId = null;

function fmtDateTime(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  const d = ts.toDate();
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${dd} ${mon} ${h}:${m}${ampm}`;
}

// Whether Members & Totals shows everyone or just members who currently owe money — the "Show
// all" switch in its header.
let _tabShowAllMembers = false;

function renderTabMembersList() {
  const el = document.getElementById('tabMembersList');
  if (!_tabMembers.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">No tab members yet.</p>'; return; }

  const rows = _tabMembers.map(m => {
    const orders = _tabOrders.filter(o => o.memberId === m.id);
    const total  = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
    const unpaid = orders.filter(o => !o.paid).reduce((s, o) => s + (o.totalAmount || 0), 0);
    return { m, orders, total, unpaid };
  }).filter(r => _tabShowAllMembers || r.unpaid > 0);

  if (!rows.length) {
    el.innerHTML = `<p style="color:var(--text-muted);font-size:14px">${_tabShowAllMembers ? 'No tab members yet.' : 'Nobody currently owes anything.'}</p>`;
    return;
  }

  el.innerHTML = rows.map(({ m, orders, total, unpaid }) => {
    const expanded = _tabExpandedMemberId === m.id;
    const isActive = _tabSelectedMemberId === m.id;
    const menuOpen = _openMemberRowMenuId === m.id;
    const ordersHtml = expanded ? orders.map(o => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border);font-size:13px">
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${fmtDateTime(o.createdAt)}</div>
          ${(o.items || []).map(i => `${i.quantity}× ${escHtml(i.name)}`).join(', ')}
          <span style="color:var(--text-muted)">${o.paid ? '· paid' : '· unpaid'}</span>
        </div>
        <div style="font-weight:700">${fmtCurrency(o.totalAmount || 0)}</div>
      </div>`).join('') || '<p style="font-size:13px;color:var(--text-muted);padding:8px 0">No drinks recorded yet.</p>'
      : '';

    return `
      <div class="item-row tab-member-row ${isActive ? 'active' : ''}" style="flex-direction:column;align-items:stretch;gap:8px"
           onclick="selectTabMember('${m.id}')">
        <div style="display:flex;align-items:center;gap:12px;width:100%">
          <span class="item-name">${escHtml(m.name)}</span>
          <span style="font-size:13px;color:var(--text-muted)">Total ${fmtCurrency(total)}</span>
          ${unpaid > 0
            ? `<span class="badge badge-warning">Owes ${fmtCurrency(unpaid)}</span>`
            : `<span class="badge badge-success">Settled</span>`}
          <span style="margin-left:auto"></span>
          <details class="row-menu" data-mid="${m.id}" ${menuOpen ? 'open' : ''} onclick="event.stopPropagation()">
            <summary title="More actions">⋯</summary>
            <div class="row-menu-list">
              <button class="btn btn-secondary btn-sm" onclick="openEditTabMemberModal('${m.id}')">✏ Edit</button>
              ${m.email ? `<button class="btn btn-secondary btn-sm" onclick="sendMemberEmail('${m.id}')">✉ Email</button>` : ''}
              <button class="btn btn-danger btn-sm" onclick="deleteTabMember('${m.id}')">🗑 Delete</button>
            </div>
          </details>
        </div>
        <div style="font-size:12px;color:var(--text-muted)">${m.email ? `✉ ${escHtml(m.email)}` : 'No email on file'}</div>
        <div class="item-actions" onclick="event.stopPropagation()">
          <button class="btn btn-secondary btn-sm" onclick="toggleTabMemberOrders('${m.id}')">${expanded ? 'Hide' : 'View'} Orders</button>
          ${unpaid > 0 && !_tabsOnlyMode ? `<button class="btn btn-primary btn-sm" onclick="markMemberPaid('${m.id}')">Mark Paid</button>` : ''}
        </div>
        ${ordersHtml}
      </div>`;
  }).join('');
}

document.getElementById('tabShowAllMembersToggle').addEventListener('change', (e) => {
  _tabShowAllMembers = e.target.checked;
  renderTabMembersList();
});

// Per-row "⋯" menu (<details>) — same open-tracking/close-on-outside-click pattern as the
// portal's Users permissions dropdown: a capture-phase 'toggle' listener on the stable list
// container survives renderTabMembersList() replacing its children, and _openMemberRowMenuId
// (restored into the `open` attribute above) keeps whichever menu was open across a re-render
// instead of every render silently closing it.
let _openMemberRowMenuId = null;

document.getElementById('tabMembersList').addEventListener('toggle', (e) => {
  if (!e.target.matches?.('.row-menu')) return;
  const mid = e.target.getAttribute('data-mid');
  if (e.target.open) {
    _openMemberRowMenuId = mid;
    document.querySelectorAll('#tabMembersList .row-menu[open]').forEach(d => {
      if (d !== e.target) d.removeAttribute('open');
    });
  } else if (_openMemberRowMenuId === mid) {
    _openMemberRowMenuId = null;
  }
}, true);

document.addEventListener('click', (e) => {
  if (!_openMemberRowMenuId || e.target.closest('.row-menu')) return;
  document.querySelectorAll('#tabMembersList .row-menu[open]').forEach(d => d.removeAttribute('open'));
  _openMemberRowMenuId = null;
});

window.toggleTabMemberOrders = function(id) {
  _tabExpandedMemberId = _tabExpandedMemberId === id ? null : id;
  renderTabMembersList();
};

window.markMemberPaid = async function(id) {
  const unpaidOrders = _tabOrders.filter(o => o.memberId === id && !o.paid);
  if (!unpaidOrders.length) return;
  try {
    const batch = db.batch();
    unpaidOrders.forEach(o => batch.update(db.collection('showdrinks_tabOrders').doc(o.id), {
      paid: true, paidAt: firebase.firestore.FieldValue.serverTimestamp(),
    }));
    await batch.commit();
    toast('Marked as paid', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.deleteTabMember = async function(id) {
  const member = _tabMembers.find(m => m.id === id);
  if (_tabOrders.some(o => o.memberId === id && !o.paid)) {
    toast('Mark their tab as paid before removing them', 'error');
    return;
  }
  if (!confirm(`Remove "${member?.name || 'this member'}" from the tab list? Their order history is kept.`)) return;
  try {
    await db.collection('showdrinks_tabMembers').doc(id).delete();
    _tabMembers = _tabMembers.filter(m => m.id !== id);
    if (_tabSelectedMemberId === id) selectTabMember(null);
    renderTabMemberSelect();
    renderTabMembersList();
    toast('Member removed', 'info');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

function buildMemberEmailPayload(member) {
  const unpaidOrders = _tabOrders.filter(o => o.memberId === member.id && !o.paid);
  const itemTotals = {};
  unpaidOrders.forEach(o => (o.items || []).forEach(i => {
    itemTotals[i.name] = (itemTotals[i.name] || 0) + i.quantity;
  }));
  const drinks = Object.entries(itemTotals).map(([name, qty]) => `${qty}x ${name}`).join('\n');
  const total = fmtCurrency(unpaidOrders.reduce((s, o) => s + (o.totalAmount || 0), 0));

  const fill = tpl => tpl
    .replace(/\[name\]/g, member.name)
    .replace(/\[drinks\]/g, drinks)
    .replace(/\[total\]/g, total);

  return {
    to: member.email,
    subject: fill(_systemSettings.emailTemplateSubject || DEFAULT_EMAIL_TEMPLATE_SUBJECT),
    body: fill(_systemSettings.emailTemplateBody || DEFAULT_EMAIL_TEMPLATE_BODY),
  };
}

// Cloud Functions are deployed to europe-west1 (merged functions/index.js, same region every
// other showmanager app uses) — the default us-central1 client 404s a call to a function that
// isn't deployed there.
const sendMemberEmailFn = firebase.app().functions('europe-west1').httpsCallable('sendMemberEmail');

window.sendMemberEmail = async function(id) {
  const member = _tabMembers.find(m => m.id === id);
  if (!member || !member.email) { toast('This member has no email address', 'error'); return; }

  const hasUnpaid = _tabOrders.some(o => o.memberId === id && !o.paid);
  if (!hasUnpaid) { toast('Nothing unpaid to email about', 'info'); return; }

  try {
    await sendMemberEmailFn(buildMemberEmailPayload(member));
    toast(`Email sent to ${member.name}`, 'success');
  } catch(e) {
    toast('Failed to send: ' + e.message, 'error');
  }
};

window.emailAllOwingMembers = async function() {
  const owing = _tabMembers.filter(m => _tabOrders.some(o => o.memberId === m.id && !o.paid));
  const withEmail = owing.filter(m => m.email);
  const withoutEmail = owing.length - withEmail.length;

  if (!withEmail.length) {
    toast(withoutEmail ? `${withoutEmail} member(s) owe money but have no email on file` : 'No outstanding balances to email', 'info');
    return;
  }

  const extra = withoutEmail ? ` ${withoutEmail} more owe money but have no email on file.` : '';
  const ok = confirm(`Send ${withEmail.length} email${withEmail.length !== 1 ? 's' : ''} (one per member who owes money)?${extra}`);
  if (!ok) return;

  document.getElementById('tabsMenuDropdown').classList.remove('open');
  toast(`Sending ${withEmail.length} email${withEmail.length !== 1 ? 's' : ''}…`, 'info');

  let sent = 0, failed = 0;
  for (const m of withEmail) {
    try {
      await sendMemberEmailFn(buildMemberEmailPayload(m));
      sent++;
    } catch(e) {
      failed++;
    }
  }
  toast(`Sent ${sent} email${sent !== 1 ? 's' : ''}${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'success');
};

window.toggleTabsMenu = function(e) {
  e.stopPropagation();
  document.getElementById('tabsMenuDropdown').classList.toggle('open');
};

document.addEventListener('click', () => {
  document.getElementById('tabsMenuDropdown')?.classList.remove('open');
});

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

document.getElementById('exportTabSalesBtn').addEventListener('click', () => {
  if (!_tabOrders.length) { toast('No sales to export yet', 'error'); return; }

  const header = ['Date', 'Member', 'Items', 'Total', 'Paid'];
  const sorted = [..._tabOrders].sort((a, b) => {
    const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return at - bt;
  });
  const rows = sorted.map(o => [
    fmtDateTime(o.createdAt),
    o.memberName || '',
    (o.items || []).map(i => `${i.quantity}x ${i.name}`).join('; '),
    (o.totalAmount || 0).toFixed(2),
    o.paid ? 'Yes' : 'No',
  ]);
  const csv = [header, ...rows].map(r => r.map(csvField).join(',')).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `showdrinks-tab-sales-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});

async function deleteAllDocs(collectionName) {
  let snap = await db.collection(collectionName).limit(500).get();
  while (!snap.empty) {
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    snap = await db.collection(collectionName).limit(500).get();
  }
}

document.getElementById('clearAllTabsBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL tab sales history? Member names are kept. This cannot be undone.')) return;
  try {
    await deleteAllDocs('showdrinks_tabOrders');
    _tabOrders = []; _tabExpandedMemberId = null;
    renderTabMembersList();
    toast('All tab sales cleared', 'info');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

// ── Auth ───────────────────────────────────────────────────────────────────

let _appInitialized = false;

// Restricted view: a "Bar Tabs POS"-only account (access.showdrinksTabsPos, not full
// access.showdrinksAdmin) — or anyone landing via the portal's dedicated Tabs POS tile
// (?view=tabs), which always opens this focused single-screen view even for a full admin — sees
// only the Bar Tabs POS panel, with the rest of Bar Manager's menu hidden (see
// body.tabs-only-mode in style.css). Set once auth resolves, read by init() below.
let _tabsOnlyMode = false;

// Shared login (shared/auth.js): the same users/{uid} doc used by every app in showmanager.
// isManager, access.showdrinksAdmin or access.showdrinksTabsPos gets in; anyone else signed in
// but lacking every one of those flags is bounced back out with an explanation rather than
// landing on a blank admin screen.
firebase.auth().onAuthStateChanged(async user => {
  const loginScreen = document.getElementById('loginScreen');
  const adminApp = document.getElementById('adminApp');
  const errEl = document.getElementById('loginError');
  if (user) {
    const account = await checkAccess(user.uid).catch(() => null);
    const hasFullAdmin = !!(account && (account.isManager === true || account.access?.showdrinksAdmin === true));
    const hasTabsPos = hasFullAdmin || !!(account && account.access?.showdrinksTabsPos === true);
    if (!hasTabsPos) {
      await firebase.auth().signOut();
      errEl.textContent = 'This account does not have ShowDrinks admin access — ask a manager to grant it from the showmanager portal.';
      errEl.style.display = '';
      document.getElementById('authGate').style.display = 'none';
      return;
    }
    _tabsOnlyMode = !hasFullAdmin || new URLSearchParams(location.search).get('view') === 'tabs';
    document.body.classList.toggle('tabs-only-mode', _tabsOnlyMode);
    if (!_tabsOnlyMode) mountSuiteNav(account, 'showdrinksAdmin', '../');
    loginScreen.style.display = 'none';
    adminApp.style.display = '';
    document.getElementById('authGate').style.display = 'none';
    if (!_appInitialized) {
      _appInitialized = true;
      await init();
      if (_tabsOnlyMode) { activateAdminTab('tabs'); loadShowTabs(); }
    }
  } else {
    adminApp.style.display = 'none';
    loginScreen.style.display = 'flex';
    document.getElementById('authGate').style.display = 'none';
  }
});

document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Enter your email and password'; errEl.style.display = ''; return; }
  try {
    await firebase.auth().signInWithEmailAndPassword(email, password);
    document.getElementById('loginPassword').value = '';
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginSubmitBtn').click();
});

document.getElementById('forgotPasswordLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) { toast('Enter your email above first', 'error'); return; }
  try {
    await firebase.auth().sendPasswordResetEmail(email);
    toast('Password reset email sent', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

document.getElementById('signOutBtn').addEventListener('click', () => firebase.auth().signOut());
document.getElementById('sidebarSignOutBtn').addEventListener('click', () => firebase.auth().signOut());

async function changePasswordPrompt() {
  const newPassword = prompt('Enter your new password (min 6 characters):');
  if (!newPassword) return;
  if (newPassword.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
  try {
    await firebase.auth().currentUser.updatePassword(newPassword);
    toast('Password updated', 'success');
  } catch(e) {
    toast('Failed: ' + e.message + ' — you may need to sign out and back in first', 'error');
  }
}
document.getElementById('changePasswordBtn').addEventListener('click', changePasswordPrompt);
document.getElementById('sidebarChangePasswordBtn').addEventListener('click', changePasswordPrompt);

// Desktop sidebar collapse — same pattern as expenses/budget's own admin sidebars.
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
function applySidebarState(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
}
applySidebarState(localStorage.getItem('showdrinks_sidebar_collapsed') === '1');
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarState(collapsed);
  localStorage.setItem('showdrinks_sidebar_collapsed', collapsed ? '1' : '0');
});

// Admin accounts are now provisioned from the showmanager portal's Users screen (grants the
// showdrinksAdmin access flag on the shared users/{uid} doc) — not here. See admin.html's
// Settings & QR tab.

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  if (typeof APP_VERSION !== 'undefined') {
    document.getElementById('headerVersion').textContent = 'v' + APP_VERSION;
  }
  try {
    // loadOrders() included since Orders is the default tab now — otherwise it'd sit empty
    // until the user clicked away and back (every other tab's own data only loads on click).
    // Both loadLocations() and loadOrders() (which itself reads locations, to fill in each
    // order's collection point) touch showdrinks_locations — showdrinksAdmin-only in
    // firestore.rules — so a tabs-only account (no showdrinksAdmin) would have Promise.all
    // reject on that permission-denied read and never reach the tabs screen at all. Neither is
    // needed for Bar Tabs POS anyway, so skip both in that restricted view.
    const loads = [loadShows(), loadMenuItems(), loadSettings()];
    if (!_tabsOnlyMode) loads.push(loadLocations(), loadOrders());
    await Promise.all(loads);
  } catch(e) {
    document.getElementById('headerShowName').textContent = 'Firebase not configured';
    toast('Firebase not configured – edit firebase-config.js', 'error');
  }
}
