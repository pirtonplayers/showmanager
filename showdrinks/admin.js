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
  const text = document.createElement('span');
  text.textContent = msg;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.append(text, close);
  document.getElementById('toast').appendChild(el);
  // Every toast (errors too) clears itself after 3s; × dismisses it sooner.
  setTimeout(() => el.remove(), 3000);
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
    if (btn.dataset.tab === 'stock') loadStockTab();
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

// SumUp credentials live in showdrinks_secrets (admin-only), NOT on the publicly readable show doc.
// This fills each show's sumupMerchantCode/sumupApiKey from there for the editor, and one-time
// migrates any still sitting on the show doc itself (written before secrets existed) across.
async function attachShowSecrets(shows) {
  for (const show of shows) {
    try {
      const ref = db.collection('showdrinks_secrets').doc('show_' + show.id);
      if (show.sumupMerchantCode !== undefined || show.sumupApiKey !== undefined) {
        const legacy = { sumupMerchantCode: show.sumupMerchantCode || '', sumupApiKey: show.sumupApiKey || '' };
        if (legacy.sumupMerchantCode || legacy.sumupApiKey) await ref.set(legacy, { merge: true });
        await db.collection('showdrinks_shows').doc(show.id).update({
          sumupMerchantCode: firebase.firestore.FieldValue.delete(),
          sumupApiKey: firebase.firestore.FieldValue.delete(),
        });
        Object.assign(show, legacy);
      } else {
        const snap = await ref.get();
        const d = snap.exists ? snap.data() : {};
        show.sumupMerchantCode = d.sumupMerchantCode || '';
        show.sumupApiKey = d.sumupApiKey || '';
      }
    } catch(e) { console.error('show secrets', e); }
  }
}

async function loadShows() {
  try {
    const snap = await db.collection('showdrinks_shows').get();
    _shows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1);
    await attachShowSecrets(_shows);

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
    db.collection('showdrinks_secrets').doc('show_' + id).delete().catch(() => {});
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
    // Category select: every price list category, plus the session's current one if it has since gone.
    const sessCat = d.category || (d.buyNow ? 'Buy Now' : '');
    const catSel = document.getElementById(`${id}Category`);
    const cats = [..._menuCategories];
    if (sessCat && !cats.includes(sessCat)) cats.push(sessCat);
    catSel.innerHTML = '<option value="">— none —</option>' + cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}${isBuyNowCategoryName(c) ? ' (Buy Now)' : ''}</option>`).join('');
    catSel.value = sessCat;
    document.getElementById(`${id}ConfirmMsg`).value = d.confirmationMessage || '';
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
      category: document.getElementById(`${id}Category`).value,
      confirmationMessage: document.getElementById(`${id}ConfirmMsg`).value.trim(),
    };
  });

  const paymentMode       = document.getElementById('showPaymentMode').value;
  const sumupMerchantCode = document.getElementById('showSumupMerchantCode').value.trim();
  const sumupApiKey       = document.getElementById('showSumupApiKey').value.trim();
  const orderingMode      = document.getElementById('showOrderingMode').value;
  const tabOrderingMode   = document.getElementById('showTabOrderingMode').value;
  const defaultLocationId = document.getElementById('showDefaultLocation').value;
  const fields = { name, sessions, paymentMode, orderingMode, tabOrderingMode, defaultLocationId };
  const secrets = { sumupMerchantCode, sumupApiKey };

  try {
    if (_creatingNewShow) {
      const doc = { ...fields, isCurrent: _shows.length === 0, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
      const ref = await db.collection('showdrinks_shows').add(doc);
      await db.collection('showdrinks_secrets').doc('show_' + ref.id).set(secrets);
      _shows.push({ id: ref.id, ...doc, ...secrets });
      _selectedShowId = ref.id;
      _creatingNewShow = false;
      renderShowEditor(); // now shows Set as Current/Delete, since it's a real saved show
      toast('Show created', 'success');
    } else {
      if (!_selectedShowId) { toast('Add or select a show first', 'error'); return; }
      await db.collection('showdrinks_shows').doc(_selectedShowId).update(fields);
      await db.collection('showdrinks_secrets').doc('show_' + _selectedShowId).set(secrets);
      const show = _shows.find(s => s.id === _selectedShowId);
      if (show) Object.assign(show, fields, secrets);
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
  await loadBuyNowCats();
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

function renderMenuTable() {
  const tbody = document.getElementById('menuTableBody');
  const filterTab = document.getElementById('menuFilterTab').checked;
  const items = _allMenuItems
    .filter(i => _selectedMenuCat === 'all' || i.category === _selectedMenuCat)
    .filter(i => filterTab || !itemShowsOnTab(i));   // every item is listed; unticking Tab only hides the ones shown on Bar Tabs

  const emptyMsg = _allMenuItems.length
    ? 'No items match this filter.'
    : 'No items yet — + Add Item to get started.';
  tbody.innerHTML = items.length ? items.map(i => menuItemRow(i.id, i)).join('')
    : `<tr><td colspan="7" style="color:var(--text-muted);padding:20px;text-align:center">${emptyMsg}</td></tr>`;
}

function menuItemRow(id, item) {
  const onSale = item.onSale !== false;
  const showOnTab = itemShowsOnTab(item);
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
      <input type="checkbox" ${item.stk !== false ? 'checked' : ''} onchange="toggleMenuItemShowOn('${id}', 'stk', this)" title="Stock take item" aria-label="Stock take item">
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

// ── Price List ⋯ menu: print / CSV ───────────────────────────────────────────

window.toggleMenuActions = function(e) {
  e.stopPropagation();
  document.getElementById('menuActionsDropdown').classList.toggle('open');
};
document.addEventListener('click', () => {
  document.getElementById('menuActionsDropdown')?.classList.remove('open');
});

window.openPrintMenuModal = function() {
  document.getElementById('printMenuModal').style.display = 'flex';
};
window.closePrintMenuModal = function() {
  document.getElementById('printMenuModal').style.display = 'none';
};

window.exportMenuCsv = function() {
  if (!_allMenuItems.length) { toast('No items to export', 'error'); return; }
  const header = ['Category', 'Name', 'Price', 'On Sale', 'Bar Tabs', 'Customer POS'];
  const rows = _allMenuItems.map(i => [
    i.category || '', i.name || '', Number(i.price || 0).toFixed(2),
    i.onSale !== false ? 'Yes' : 'No', itemShowsOnTab(i) ? 'Yes' : 'No', itemShowsOnPos(i) ? 'Yes' : 'No',
  ]);
  const csv = [header, ...rows].map(r => r.map(csvField).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `showdrinks-price-list-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
};

// Builds a standalone, print-styled page in a hidden iframe (no popup to get blocked) and prints
// it — A4, large clean type, items with dotted leaders to the price, so it can go straight up
// behind the bar.
// The filtered/ordered content shared by Print and Save as PDF: [{ title, items }] sections (a
// single untitled one for the alphabetical layout), or null (with a toast) if nothing matches.
function priceListSections() {
  const onlySale = document.getElementById('printOnSale').checked;
  const onlyTab  = document.getElementById('printOnTab').checked;
  const onlyPos  = document.getElementById('printOnPos').checked;
  const includeBuyNow = document.getElementById('printBuyNow').checked;
  const layout   = document.querySelector('input[name="printLayout"]:checked').value;

  const items = _allMenuItems.filter(i =>
    (!onlySale || i.onSale !== false) && (!onlyTab || itemShowsOnTab(i)) && (!onlyPos || itemShowsOnPos(i)) &&
    (includeBuyNow || !isBuyNowCategoryName(i.category)));
  if (!items.length) { toast('No items match those filters', 'error'); return null; }

  const byName = (a, b) => {
    const as = startsWithSpecialChar(a.name), bs = startsWithSpecialChar(b.name);
    if (as !== bs) return as ? 1 : -1;
    return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
  };
  if (layout === 'alpha') return [{ title: '', items: [...items].sort(byName) }];
  const groups = {};
  items.forEach(i => { (groups[i.category || 'Other'] = groups[i.category || 'Other'] || []).push(i); });
  return Object.keys(groups).sort((a, b) => {
    if (a === 'Other') return 1; if (b === 'Other') return -1;
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  }).map(cat => ({ title: cat, items: groups[cat].sort(byName) }));
}

let _jsPdfPromise = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve();
  if (_jsPdfPromise) return _jsPdfPromise;
  _jsPdfPromise = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    sc.onload = resolve;
    sc.onerror = () => { _jsPdfPromise = null; reject(new Error('Could not load the PDF library')); };
    document.head.appendChild(sc);
  });
  return _jsPdfPromise;
}

// Draws the price list into `doc` (A4, two columns, dotted leaders) at text scale `sc` (1 = normal)
// and returns how many pages it took. Run once on a throwaway doc per candidate scale when "fit to
// one page" is on, then for real at the first scale that comes out as a single page.
function drawPriceListPdf(doc, sections, showName, sc) {
  const W = 595.28, H = 841.89, M = 45, GAP = 28;
  const colW = (W - 2 * M - GAP) / 2;

  doc.setFont('times', 'bold'); doc.setFontSize(26);
  doc.text(showName.toUpperCase(), W / 2, M + 24, { align: 'center' });
  doc.setFont('times', 'normal'); doc.setFontSize(11); doc.setTextColor(90);
  doc.text('BAR PRICE LIST', W / 2, M + 42, { align: 'center', charSpace: 2 });
  doc.setTextColor(26);
  doc.setLineWidth(1.2); doc.line(M, M + 52, W - M, M + 52);
  doc.setLineWidth(0.5); doc.line(M, M + 56, W - M, M + 56);

  const TOP1 = M + 80, TOP = M, BOTTOM = H - M, LINE = 21 * sc, HEAD = 30 * sc;
  let col = 0, y = TOP1;
  const x = () => M + col * (colW + GAP);
  const advance = () => {
    col++;
    if (col > 1) { doc.addPage(); col = 0; y = TOP; } else { y = doc.getNumberOfPages() === 1 ? TOP1 : TOP; }
  };
  const ensure = (h) => { if (y + h > BOTTOM) advance(); };
  sections.forEach(sec => {
    // Keep a whole category in one column when it can fit in one at all; only a category taller
    // than a column gets split across columns/pages.
    const secH = (sec.title ? HEAD : 0) + sec.items.length * LINE;
    if (secH <= BOTTOM - TOP1 && y + secH > BOTTOM) advance();
    if (sec.title) {
      ensure(HEAD + LINE * 2);
      doc.setFont('times', 'bold'); doc.setFontSize(14 * sc);
      doc.text(sec.title.toUpperCase(), x(), y + 14 * sc, { charSpace: sc });
      doc.setLineWidth(0.7); doc.line(x(), y + 19 * sc, x() + colW, y + 19 * sc);
      y += HEAD;
    }
    sec.items.forEach(i => {
      ensure(LINE);
      const price = fmtCurrency(i.price || 0);
      doc.setFont('times', 'bold'); doc.setFontSize(13 * sc);
      const pw = doc.getTextWidth(price);
      doc.setFont('times', 'normal');
      let name = i.name || '';
      const maxName = colW - pw - 14;
      while (name.length > 1 && doc.getTextWidth(name) > maxName) name = name.slice(0, -1);
      if (name !== (i.name || '')) name = name.trimEnd() + '...';
      doc.text(name, x(), y + 12 * sc);
      doc.setFont('times', 'bold');
      doc.text(price, x() + colW, y + 12 * sc, { align: 'right' });
      const nw = doc.getTextWidth(name);
      doc.setLineDashPattern([1, 2.5], 0); doc.setLineWidth(0.5); doc.setDrawColor(130);
      doc.line(x() + nw + 4, y + 11 * sc, x() + colW - pw - 4, y + 11 * sc);
      doc.setLineDashPattern([], 0); doc.setDrawColor(0);
      y += LINE;
    });
    y += 12 * sc;
  });
  return doc.getNumberOfPages();
}

window.savePriceListPdf = async function() {
  const sections = priceListSections();
  if (!sections) return;
  // Open the tab straight away (inside the click, so it isn't popup-blocked) and point it at the
  // PDF once it's built — the browser's own viewer shows it, with its own Save/Print buttons.
  const win = window.open('', '_blank');
  try { await loadJsPdf(); } catch(e) { if (win) win.close(); toast(e.message, 'error'); return; }
  const { jsPDF } = window.jspdf;
  const showName = document.getElementById('headerShowName').textContent || 'Price List';

  let sc = 1;
  if (document.getElementById('printFitOnePage').checked) {
    // Shrink the text a step at a time until the whole list lands on a single page.
    while (sc > 0.3 && drawPriceListPdf(new jsPDF({ unit: 'pt', format: 'a4' }), sections, showName, sc) > 1) sc -= 0.02;
  }
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  drawPriceListPdf(doc, sections, showName, sc);

  const fileName = `price-list-${new Date().toISOString().slice(0, 10)}.pdf`;
  if (win) {
    win.location.href = URL.createObjectURL(doc.output('blob'));
  } else {
    doc.save(fileName); // popups blocked — fall back to a plain download
  }
  closePrintMenuModal();
};

window.printPriceList = function() {
  const sections = priceListSections();
  if (!sections) return;
  const row = i => `<div class="item"><span class="n">${escHtml(i.name || '')}</span><span class="dots"></span><span class="p">${fmtCurrency(i.price || 0)}</span></div>`;
  const body = sections.map(sec =>
    `<div class="group">${sec.title ? `<h2>${escHtml(sec.title)}</h2>` : ''}${sec.items.map(row).join('')}</div>`).join('');

  const showName = document.getElementById('headerShowName').textContent || 'Price List';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Price List</title><style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; }
    header { text-align: center; border-bottom: 3px double #1a1a1a; padding-bottom: 10px; margin-bottom: 18px; }
    header h1 { font-size: 34px; margin: 0; letter-spacing: .04em; text-transform: uppercase; }
    header p { margin: 4px 0 0; font-size: 14px; letter-spacing: .2em; text-transform: uppercase; color: #555; }
    .cols { column-count: 2; column-gap: 14mm; }
    .group { break-inside: avoid; margin-bottom: 16px; }
    .group h2 { font-size: calc(18px * var(--s, 1)); text-transform: uppercase; letter-spacing: .12em; border-bottom: 1px solid #1a1a1a; padding-bottom: 3px; margin: 0 0 calc(6px * var(--s, 1)); }
    .item { display: flex; align-items: baseline; gap: 6px; font-size: calc(16px * var(--s, 1)); padding: calc(3px * var(--s, 1)) 0; break-inside: avoid; }
    .item .dots { flex: 1; border-bottom: 1px dotted #888; transform: translateY(-3px); }
    .item .p { font-weight: bold; white-space: nowrap; }
  </style></head><body>
    <header><h1>${escHtml(showName)}</h1><p>Bar Price List</p></header>
    <div class="cols">${body}</div>
  </body></html>`;

  closePrintMenuModal();
  const frame = document.createElement('iframe');
  // Laid out off-screen at the printable A4 width (178mm) so the fit-to-page measuring below is real.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:673px;height:1200px;border:0';
  document.body.appendChild(frame);
  const fit = document.getElementById('printFitOnePage').checked;
  frame.onload = () => {
    if (fit) {
      // Printable height of A4 less the 16mm @page margins, at 96dpi — shrink the list's text a
      // step at a time until the whole sheet fits on one page.
      const pageH = (297 - 32) / 25.4 * 96;
      const root = frame.contentDocument.body; // body (not documentElement) so the iframe's own height doesn't count
      let k = 1;
      while (k > 0.3 && root.offsetHeight > pageH) { k -= 0.03; frame.contentDocument.body.style.setProperty('--s', k); }
    }
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  };
  frame.srcdoc = html;
};

window.openAddMenuItemModal = function(over) {
  openModal('Add Item', { type: 'menuItem', id: null, name: '', category: _selectedMenuCat !== 'all' ? _selectedMenuCat : '', price: 0, onSale: true, showOnTab: true, showOnPos: true, stk: true, frac: false, image: '', ...(over && over.type === undefined ? over : {}) });
};

window.openEditMenuItemModal = function(id) {
  const item = _allMenuItems.find(i => i.id === id);
  if (!item) return;
  openModal('Edit Item', { type: 'menuItem', id, name: item.name, category: item.category || '', price: item.price || 0, onSale: item.onSale !== false, showOnTab: itemShowsOnTab(item), showOnPos: itemShowsOnPos(item), stk: item.stk !== false, frac: item.frac === true, image: item.image || '' });
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
let _modalImage = ''; // resized data-URL for the item being edited (Buy Now items only)

// Photo is shrunk to a small JPEG and stored right on the item doc — no Storage upload needed, and
// the customer page already loads every menu item up front.
function resizeImageToDataUrl(file, maxDim = 400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}
function refreshModalImage() {
  const prev = document.getElementById('editImagePreview');
  prev.src = _modalImage || '';
  prev.style.display = _modalImage ? 'block' : 'none';
  document.getElementById('editImageClear').style.display = _modalImage ? '' : 'none';
}
// Categories marked Buy Now (showdrinks_config/categories.buyNow). Until the list has ever been
// saved, the old convention applies: the category named "Buy Now".
let _buyNowCats = null;   // Set of lower-cased names, or null = never saved
function isBuyNowCategoryName(c) {
  const k = (c || '').trim().toLowerCase();
  return k !== '' && (_buyNowCats ? _buyNowCats.has(k) : k === 'buy now');
}

async function loadBuyNowCats() {
  try {
    const d = await db.collection('showdrinks_config').doc('categories').get();
    _buyNowCats = d.exists ? new Set((d.data().buyNow || []).map(x => String(x).trim().toLowerCase())) : null;
  } catch (e) { /* keep whatever we had */ }
}

window.openBuyNowCats = function() {
  const list = document.getElementById('buyNowCatsList');
  list.innerHTML = _menuCategories.length ? _menuCategories.map(c => `
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;padding:6px 0">
      <input type="checkbox" class="bn-cat" value="${escHtml(c)}" ${isBuyNowCategoryName(c) ? 'checked' : ''}> ${escHtml(c)}
    </label>`).join('') : '<p style="color:var(--text-muted)">No categories yet.</p>';
  document.getElementById('buyNowCatsModal').style.display = 'flex';
};

window.closeBuyNowCats = function() { document.getElementById('buyNowCatsModal').style.display = 'none'; };

window.saveBuyNowCats = async function() {
  const names = [...document.querySelectorAll('#buyNowCatsList .bn-cat:checked')].map(c => c.value);
  try {
    await db.collection('showdrinks_config').doc('categories').set({ buyNow: names }, { merge: true });
    _buyNowCats = new Set(names.map(n => n.trim().toLowerCase()));
    closeBuyNowCats();
    toast('Saved', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};
document.getElementById('editImageFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { _modalImage = await resizeImageToDataUrl(f); refreshModalImage(); }
  catch(err) { toast(err.message, 'error'); }
  e.target.value = '';
});
document.getElementById('editImageClear').addEventListener('click', () => { _modalImage = ''; refreshModalImage(); });

function openModal(title, ctx) {
  _modalCtx = ctx;
  document.getElementById('editModalTitle').textContent = title;
  document.getElementById('editName').value = ctx.name || '';

  const priceGroup      = document.getElementById('editPriceGroup');
  const catGroup        = document.getElementById('editCategoryGroup');
  const visibilityGroup = document.getElementById('editVisibilityGroup');
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
    const imageGroup = document.getElementById('editImageGroup');
    const syncImageGroup = () => { imageGroup.style.display = isBuyNowCategoryName(catSelect.value) ? '' : 'none'; };
    _modalImage = ctx.image || ''; refreshModalImage(); syncImageGroup();
    catSelect.onchange = () => {
      if (catSelect.value === '__new__') promptNewCategory(catSelect, null);
      syncImageGroup();
    };


    visibilityGroup.style.display = '';
    document.getElementById('editShowOnTab').checked = ctx.showOnTab !== false;
    document.getElementById('editShowOnPos').checked = ctx.showOnPos !== false;
    document.getElementById('editStk').checked = ctx.stk !== false;
    document.getElementById('editFrac').checked = ctx.frac === true;
    // Cost / Min stock / Restock level live in showdrinks_stock/{id} (not on the public menu item).
    const fillStock = st => {
      document.getElementById('editCost').value = st.costPrice ?? '';
      document.getElementById('editMinStock').value = st.minStock ?? '';
      document.getElementById('editRestockTo').value = st.restockTo ?? '';
    };
    fillStock(ctx.id ? (_stock[ctx.id] || {}) : {});
    if (ctx.id && !_stock[ctx.id]) {
      db.collection('showdrinks_stock').doc(ctx.id).get().then(d => {
        if (d.exists) { _stock[ctx.id] = d.data(); if (_modalCtx && _modalCtx.id === ctx.id) fillStock(d.data()); }
      }).catch(() => {});
    }

    deleteBtn.style.display = ctx.id ? '' : 'none';
  } else {
    priceGroup.style.display = 'none';
    catGroup.style.display = 'none';
    document.getElementById('editImageGroup').style.display = 'none';
    visibilityGroup.style.display = 'none';
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
  // Item names are what a basket is keyed on, so two items can't share one.
  if (_modalCtx.type === 'menuItem' && _allMenuItems.some(i => i.id !== _modalCtx.id && (i.name || '').trim().toLowerCase() === name.toLowerCase())) {
    toast(`An item called "${name}" already exists`, 'error');
    return;
  }

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
      const showOnTab  = document.getElementById('editShowOnTab').checked;
      const showOnPos  = document.getElementById('editShowOnPos').checked;
      const stk        = document.getElementById('editStk').checked;
      // On sale simply means "offered on at least one of the two channels".
      const onSale     = showOnTab || showOnPos;
      const frac       = document.getElementById('editFrac').checked;
      const image      = isBuyNowCategoryName(category) ? _modalImage : '';
      const numOrNull = id => { const v = document.getElementById(id).value; return v === '' ? null : Math.max(0, Number(v) || 0); };
      const costPrice = numOrNull('editCost');
      const minStock  = numOrNull('editMinStock');
      let restockTo   = numOrNull('editRestockTo');
      if (restockTo !== null && minStock !== null && restockTo < minStock) restockTo = minStock;   // reorder level is never below Min
      let itemId = _modalCtx.id;
      if (itemId) {
        await db.collection('showdrinks_menuItems').doc(itemId).update({ name, category, price, onSale, showOnTab, showOnPos, stk, frac, image });
      } else {
        const ref = await db.collection('showdrinks_menuItems').add({
          name, category, price, onSale, showOnTab, showOnPos, stk, frac, image, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        itemId = ref.id;
      }
      const stockFields = { costPrice, minStock, restockTo };
      await db.collection('showdrinks_stock').doc(itemId).set(stockFields, { merge: true });
      _stock[itemId] = { ..._stock[itemId], ...stockFields };
      await loadMenuItems();
      if (document.getElementById('tab-stock').classList.contains('active')) renderStockTab();
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
    // Cancel sits next to Mark Paid — for an unpaid order whose customer never came back (e.g.
    // abandoned SumUp checkout) and so never got to cancel it themselves.
    const markPaidBtn = `<button class="btn btn-primary btn-sm" onclick="markOrderPaid('${o.id}')">💰 Mark Paid</button>
      <button class="btn btn-danger btn-sm" onclick="cancelUnpaidOrder('${o.id}')">✕ Cancel Order</button>`;
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
              <span class="qty">×${item.quantity}</span>
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
            ${isPaid ? (o.testPayment ? '🧪 Paid (test)' : '✓ Paid') : (o.paymentMode === 'bar' ? '💵 Unpaid (pay at bar)' : '⏳ Awaiting payment')}
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
    const ref = db.collection('showdrinks_orders').doc(id);
    const upd = { paymentStatus: 'paid', updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    // A buy-now order is handed over on the spot, so paying for it is also collecting it.
    if ((await ref.get()).data()?.buyNow) Object.assign(upd, { prepStatus: 'collected', collectedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await ref.update(upd);
    toast('Order marked as paid', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.cancelUnpaidOrder = async function(id) {
  if (!confirm('Cancel this unpaid order?')) return;
  try {
    await db.collection('showdrinks_orders').doc(id).update({
      cancelled: true,
      cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Order cancelled', 'info');
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
    // Credentials come from showdrinks_secrets; migrate any still on the public settings doc.
    const secretRef = db.collection('showdrinks_secrets').doc('system');
    if (_systemSettings.sumupMerchantCode !== undefined || _systemSettings.sumupApiKey !== undefined) {
      const legacy = { sumupMerchantCode: _systemSettings.sumupMerchantCode || '', sumupApiKey: _systemSettings.sumupApiKey || '' };
      if (legacy.sumupMerchantCode || legacy.sumupApiKey) await secretRef.set(legacy, { merge: true });
      await db.collection('showdrinks_config').doc('settings').update({
        sumupMerchantCode: firebase.firestore.FieldValue.delete(),
        sumupApiKey: firebase.firestore.FieldValue.delete(),
      });
      delete _systemSettings.sumupMerchantCode; delete _systemSettings.sumupApiKey;
    }
    const secretSnap = await secretRef.get();
    const d = { ..._systemSettings, ...(secretSnap.exists ? secretSnap.data() : {}) };
    document.getElementById('sumupMerchantCode').value = d.sumupMerchantCode || '';
    document.getElementById('sumupApiKey').value = d.sumupApiKey || '';
    document.getElementById('paymentMode').value = d.paymentMode || 'bar';
    document.getElementById('qrAccessCode').value = d.qrAccessCode || '';
    document.getElementById('qrValidUntil').value = d.qrValidUntil || '';
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
    paymentMode: document.getElementById('paymentMode').value,
    orderingMode: document.getElementById('orderingMode').value,
    tabOrderingMode: document.getElementById('tabOrderingMode').value,
    posStartGridId: document.getElementById('orderingModeStartGrid').value || 'root',
    tabPosStartGridId: document.getElementById('tabOrderingModeStartGrid').value || 'root',
    emailTemplateSubject: document.getElementById('emailTemplateSubject').value.trim(),
    emailTemplateBody: document.getElementById('emailTemplateBody').value,
    qrAccessCode: document.getElementById('qrAccessCode').value.trim(),
    qrValidUntil: document.getElementById('qrValidUntil').value || '',
  };
  try {
    await db.collection('showdrinks_secrets').doc('system').set({
      sumupMerchantCode: document.getElementById('sumupMerchantCode').value.trim(),
      sumupApiKey: document.getElementById('sumupApiKey').value.trim(),
    });
    await db.collection('showdrinks_config').doc('settings').set(settings);
    _systemSettings = settings;
    toast('Settings saved', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

document.getElementById('newQrCodeBtn').addEventListener('click', () => {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  document.getElementById('qrAccessCode').value = Array.from(bytes, b => chars[b % chars.length]).join('');
  toast('New code made — Save Settings, then Generate QR Code', 'info');
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
  const code = document.getElementById('qrAccessCode').value.trim();
  const orderUrl = baseUrl.replace(/\/$/, '') + '/index.html' + (code ? '?k=' + encodeURIComponent(code) : '');
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
       <span>×${i.qty} ${escHtml(i.name)}</span>
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
      <span class="qty-num">×${qty}</span>
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
           <span>×${i.qty} ${escHtml(i.name)}</span>
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
          ${(o.items || []).map(i => `×${i.quantity} ${escHtml(i.name)}`).join(', ')}
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
  const drinks = Object.entries(itemTotals).map(([name, qty]) => `x${qty} ${name}`).join('\n');
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
    (o.items || []).map(i => `x${i.quantity} ${i.name}`).join('; '),
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

// ── Stock Take ───────────────────────────────────────────────────────────────
// Stock figures live in showdrinks_stock/{menuItemId} (NOT on the menu item itself —
// showdrinks_menuItems is publicly readable, and cost prices shouldn't be): { costPrice, minStock,
// base, added }. `base` is the figure counted at the last stock take, `added` is everything
// received since. Usage at the next take = base + added − counted, so topping up mid-event never
// inflates (or hides) what was sold: 5 in stock, +10 delivered, 8 counted → 5 + 10 − 8 = 7 used.
// Finishing a take stores a snapshot in showdrinks_stockTakes (usage/cost/restock report) and
// rolls every counted item forward: base = counted, added = 0. Items left uncounted keep their
// old base/added, so their usage simply spans two takes.
// Organisations (showdrinks_orgs): each holds its own share of every item, kept as
// showdrinks_stock/{id}.org = { orgId: qty }. Total stock (base + added) is the sum of the shares.
// Opening stock for an org sets that org's share; a delivery adds to the chosen org's share; a stock
// take for an org counts the physical total, the fall since the last take is that org's usage and
// comes off its share (so a share can go negative = what that org owes the stock). Stock from before
// organisations existed is simply "unassigned" (total minus the shares). With no organisations
// defined everything behaves as before.
let _orgs        = [];
const ORG_LAST_KEY = 'showdrinks_last_org';
function orgName(id) { return _orgs.find(o => o.id === id)?.name || ''; }
function orgQtyOf(s, id) { const v = s && s.org ? s.org[id] : undefined; return typeof v === 'number' ? v : 0; }
// Deliveries to an org since the last stock take (reset by every take).
function orgAddedOf(s, id) { const v = s && s.orgAdded ? s.orgAdded[id] : undefined; return typeof v === 'number' ? v : 0; }
function orgOptionsHtml(sel) { return _orgs.map(o => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${escHtml(o.name)}</option>`).join(''); }
function lastOrg() {
  let v = '';
  try { v = localStorage.getItem(ORG_LAST_KEY) || ''; } catch (e) {}
  return _orgs.some(o => o.id === v) ? v : (_orgs[0]?.id || '');
}
function rememberOrg(id) { try { localStorage.setItem(ORG_LAST_KEY, id); } catch (e) {} }

// Asks which organisation: resolves to its id, '' when none are defined, null if cancelled.
let _orgPickResolve = null;
// `msg` (optional) is a warning shown in the same dialog; with no organisations it falls back to a confirm().
function pickOrg(title, msg) {
  if (!_orgs.length) return Promise.resolve(msg && !confirm(msg) ? null : '');
  document.getElementById('orgPickTitle').textContent = title;
  const m = document.getElementById('orgPickMsg');
  m.textContent = msg || ''; m.style.display = msg ? '' : 'none';
  document.getElementById('orgPickSelect').innerHTML = orgOptionsHtml(lastOrg());
  document.getElementById('orgPickModal').style.display = 'flex';
  return new Promise(res => { _orgPickResolve = res; });
}
window.orgPickDone = function(ok) {
  document.getElementById('orgPickModal').style.display = 'none';
  const v = ok ? document.getElementById('orgPickSelect').value : null;
  if (v) rememberOrg(v);
  const r = _orgPickResolve; _orgPickResolve = null;
  if (r) r(v);
};

function sortOrgs() { _orgs.sort((a, b) => a.name.localeCompare(b.name)); }
function renderOrgsList() {
  document.getElementById('orgsList').innerHTML = _orgs.length ? _orgs.map(o => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1">${escHtml(o.name)}</span>
      <button class="btn btn-secondary btn-sm" onclick="renameOrg('${o.id}')">Rename</button>
      <button class="btn btn-danger btn-sm" onclick="deleteOrg('${o.id}')">Delete</button>
    </div>`).join('') : '<p style="color:var(--text-muted);margin:0">No organisations yet.</p>';
}
window.openOrgs = function() { renderOrgsList(); document.getElementById('orgsModal').style.display = 'flex'; };
window.closeOrgs = function() { document.getElementById('orgsModal').style.display = 'none'; renderStockTab(); };
window.addOrg = async function() {
  const inp = document.getElementById('orgNewName');
  const name = inp.value.trim();
  if (!name) return;
  if (_orgs.some(o => o.name.toLowerCase() === name.toLowerCase())) { toast(`"${name}" already exists`, 'error'); return; }
  try {
    const ref = await db.collection('showdrinks_orgs').add({ name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    _orgs.push({ id: ref.id, name }); sortOrgs();
    inp.value = '';
    renderOrgsList();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};
window.renameOrg = async function(id) {
  const o = _orgs.find(x => x.id === id); if (!o) return;
  const name = (prompt('Organisation name:', o.name) || '').trim();
  if (!name || name === o.name) return;
  if (_orgs.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) { toast(`"${name}" already exists`, 'error'); return; }
  try {
    await db.collection('showdrinks_orgs').doc(id).update({ name });
    o.name = name; sortOrgs();
    renderOrgsList();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};
window.deleteOrg = async function(id) {
  const o = _orgs.find(x => x.id === id); if (!o) return;
  if (Object.values(_stock).some(s => Math.abs(orgQtyOf(s, id)) > 0.001)) { toast(`${o.name} still holds stock (or owes some) - it can't be deleted`, 'error'); return; }
  if (!confirm(`Delete "${o.name}"?`)) return;
  try {
    await db.collection('showdrinks_orgs').doc(id).delete();
    _orgs = _orgs.filter(x => x.id !== id);
    renderOrgsList();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};

// Stock tracking screen: one line per organisation (plus Unassigned) and a Total line, each with
// the value of stock held. Click a line to expand its ledger (paged); click a ledger line for
// that stock take / restock. The Total ledger covers all stock; an organisation's covers its
// own opening stock, usage and restocks. Values at cost; negative = owed to the stock.
let _orgCurrent = {};
let _trackOpen = null;    // key of the expanded line: an org id, '' (unassigned) or 'all'
let _trackPage = 0;

function trackPageSize() { return Math.max(5, Math.floor((window.innerHeight * 0.65) / 44)); }

// Ledger for one line, newest first: [{ date, name, sub, val, bal, click }].
function trackLedger(key, current) {
  const ms = x => x.createdAt?.toMillis ? x.createdAt.toMillis() : (x.createdAt?.toDate ? x.createdAt.toDate().getTime() : 0);
  const all = key === 'all';
  const money = v => (v >= 0 ? '+' : '-') + fmtCurrency(Math.abs(v));
  const ev = [];
  _stockTakes.forEach(t => {
    const lines = t.lines || [];
    if (t.cleared) { ev.push({ t: ms(t), kind: 'clear', date: stockTakeDate(t), name: t.eventName || 'Stock cleared', click: `openStockTake('${t.id}')` }); return; }
    if (!all && (t.orgId || '') !== key) return;
    if (all) {
      // Whatever the take did to the total: (after - before) at cost, before = last count + additions since.
      const delta = lines.reduce((n, l) => n + (((typeof l.newTotal === 'number' ? l.newTotal : l.counted) || 0) - ((l.opening || 0) + (l.added || 0))) * (l.costPrice || 0), 0);
      ev.push({ t: ms(t), kind: t.opening ? 'open' : 'take', date: stockTakeDate(t), name: t.eventName || 'Stock take', sub: t.orgName || '', delta, val: t.opening ? null : 'usage ' + fmtCurrency(stockTakeValues(t).used), click: `openStockTake('${t.id}')` });
    } else if (t.opening) {
      const amt = lines.reduce((n, l) => n + (l.counted || 0) * (l.costPrice || 0), 0);
      ev.push({ t: ms(t), kind: 'set', date: stockTakeDate(t), name: t.eventName || 'Opening stock', amt, click: `openStockTake('${t.id}')` });
    } else {
      const amt = lines.reduce((n, l) => n + (l.usedCost || 0), 0);
      ev.push({ t: ms(t), kind: 'use', date: stockTakeDate(t), name: t.eventName || 'Stock take', delta: -amt, val: 'usage ' + fmtCurrency(amt), click: `openStockTake('${t.id}')` });
    }
  });
  _deliveries.filter(d => all || (d.orgId || '') === key).forEach(d => {
    const its = d.items || [];
    ev.push({ t: ms(d), kind: 'add', date: stockTakeDate(d), name: 'Restock: ' + (its.length === 1 ? its[0].name : its.length + ' items'), sub: all ? (d.orgName || 'Unallocated') : '',
      delta: its.reduce((n, i) => n + i.qty * (i.cost || 0), 0), click: `openDelivery('${d.id}')` });
  });
  ev.sort((a, b) => a.t - b.t);
  let bal = 0;
  const rows = ev.map(e => {
    let val;
    if (e.kind === 'clear') { e.delta = -bal; bal = 0; val = 'reset to ' + fmtCurrency(0); }
    else if (e.kind === 'set') { e.delta = e.amt - bal; bal = e.amt; val = fmtCurrency(e.amt); }
    else { bal += e.delta; val = e.val || money(e.delta); }
    return { date: e.date, name: e.name, sub: e.sub || '', val, bal, click: e.click };
  }).reverse();
  // Anything the log can't explain (changes made before restocks were recorded, edits elsewhere).
  if (Math.abs(current - bal) > 0.005) rows.unshift({ date: '', name: 'Other adjustments (not itemised)', sub: '', val: money(current - bal), bal: current, click: '' });
  return rows;
}

function renderOrgSummary() {
  const box = document.getElementById('stockOrgSummary');
  if (!box) return;
  const cur = {}; let unassigned = 0, total = 0;
  _allMenuItems.filter(i => stockIsTracked(i.id)).forEach(i => {
    const s = _stock[i.id] || {};
    const c = typeof s.costPrice === 'number' ? s.costPrice : 0;
    const oh = stockOnHand(s) ?? (s.added || 0);
    let assigned = 0;
    _orgs.forEach(o => { const q = orgQtyOf(s, o.id); assigned += q; cur[o.id] = (cur[o.id] || 0) + q * c; });
    unassigned += (oh - assigned) * c; total += oh * c;
  });
  _orgCurrent = cur;
  const lines = _orgs.map(o => ({ key: o.id, name: o.name, v: cur[o.id] || 0 }));
  if (_orgs.length && Math.abs(unassigned) > 0.005) lines.push({ key: '', name: 'Unassigned', v: unassigned });
  lines.push({ key: 'all', name: 'Total stock', v: total, bold: true });
  if (!lines.some(l => l.key === _trackOpen)) _trackOpen = null;
  const money = v => v < -0.005 ? `<span style="color:#dc2626">${fmtCurrency(v)} owed</span>` : fmtCurrency(v);
  const neg = v => v < -0.005 ? ' style="color:#dc2626"' : '';
  const td = 'style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:13px"';
  const rowsHtml = lines.map(l => {
    const open = _trackOpen === l.key;
    const nm = (open ? '▾ ' : '▸ ') + escHtml(l.name);
    let html = `<tr style="cursor:pointer" onclick="toggleTrack('${l.key}')"><td>${l.bold ? '<b>' + nm + '</b>' : nm}</td><td style="text-align:right">${l.bold ? '<b>' + money(l.v) + '</b>' : money(l.v)}</td></tr>`;
    if (open) {
      const led = trackLedger(l.key, l.v);
      const size = trackPageSize();
      const pages = Math.max(1, Math.ceil(led.length / size));
      _trackPage = Math.min(Math.max(0, _trackPage), pages - 1);
      const slice = led.slice(_trackPage * size, (_trackPage + 1) * size);
      html += `<tr><td colspan="2" style="padding:0;background:rgba(0,0,0,.025)"><table class="menu-grid-table" style="width:100%"><thead><tr><th>Date</th><th>Event</th><th style="text-align:right">Value</th><th style="text-align:right">Balance</th></tr></thead><tbody>
        ${slice.length ? slice.map(r => `<tr ${r.click ? `style="cursor:pointer" onclick="${r.click}"` : ''}><td ${td.replace('font-size:13px', 'font-size:13px;white-space:nowrap;min-width:130px')}>${escHtml(r.date)}</td><td ${td}><div class="stmt-clip" style="max-width:200px">${escHtml(r.name)}</div>${r.sub ? `<span style="font-size:11px;color:var(--text-muted)">${escHtml(r.sub)}</span>` : ''}</td><td ${td} align="right">${r.val}</td><td ${td} align="right"><b${neg(r.bal)}>${fmtCurrency(r.bal)}</b></td></tr>`).join('') : `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">Nothing recorded yet.</td></tr>`}
        </tbody></table>
        ${pages > 1 ? `<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px"><button class="btn btn-secondary btn-sm" ${_trackPage === 0 ? 'disabled' : ''} onclick="trackPage(-1)">‹ Newer</button><span style="font-size:13px">Page ${_trackPage + 1} of ${pages}</span><button class="btn btn-secondary btn-sm" ${_trackPage >= pages - 1 ? 'disabled' : ''} onclick="trackPage(1)">Older ›</button></div>` : ''}
      </td></tr>`;
    }
    return html;
  }).join('');
  box.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="card-body menu-table-scroll" style="padding:0">
    <table class="menu-grid-table"><thead><tr><th>Organisation</th><th style="text-align:right">Current stock value</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p style="font-size:11px;color:var(--text-muted);margin:0;padding:6px 12px 10px">At cost. Tap a line to see its history; tap a history line for the details. Red = owed to the stock.</p></div>`;
}
window.toggleTrack = function(key) { _trackOpen = _trackOpen === key ? null : key; _trackPage = 0; renderOrgSummary(); };
window.trackPage = function(d) { _trackPage += d; renderOrgSummary(); };
window.addEventListener('resize', () => { if (_trackOpen !== null && _stockView === 'reports') renderOrgSummary(); });

// One restock: who it was for and every item in it.
window.openDelivery = function(id) {
  const d = _deliveries.find(x => x.id === id); if (!d) return;
  const its = d.items || [];
  const val = its.reduce((n, i) => n + i.qty * (i.cost || 0), 0);
  showStatementModal('Restock - ' + stockTakeDate(d), ['Item', 'Qty', 'Cost each', 'Value'], [1, 2, 2, 2],
    its.map(i => [escHtml(i.name), (i.qty > 0 ? '+' : '') + fmtQty(i.qty), typeof i.cost === 'number' ? fmtCurrency(i.cost) : '—', typeof i.cost === 'number' ? fmtCurrency(i.qty * i.cost) : '—']),
    ['Total', `<b>${fmtCurrency(val)}</b>`],
    `Organisation: ${d.orgName ? escHtml(d.orgName) : '<span style="color:#dc2626">Unallocated</span>'}`);
};

function showStatementModal(title, cols, align, rows, total, intro, opts) {
  _stmt = { title, cols, align, rows, total, intro: intro || '', page: 0, nowrap: [], clip: [], ...(opts || {}) };
  document.getElementById('orgStatementTitle').textContent = title;
  document.getElementById('orgStatementModal').style.display = 'flex';
  renderStatementPage();
}

// Statement shown newest first, split into pages that fit the screen.
let _stmt = { title: '', cols: [], align: [], rows: [], total: null, intro: '', page: 0, nowrap: [], clip: [] };
function stmtPageSize() {
  // modal body ≈ 90% of the height minus header, footer, table head, total row and pager.
  return Math.max(4, Math.floor((window.innerHeight * 0.9 - 250) / 38));
}
function renderStatementPage() {
  const size = stmtPageSize();
  const pages = Math.max(1, Math.ceil(_stmt.rows.length / size));
  _stmt.page = Math.min(Math.max(0, _stmt.page), pages - 1);
  const slice = _stmt.rows.slice(_stmt.page * size, (_stmt.page + 1) * size);
  const td = 'style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:13px"';
  const al = i => _stmt.align[i] === 2 ? ' align="right"' : '';
  const t = _stmt.total;
  document.getElementById('orgStatementBody').innerHTML = (_stmt.intro ? `<p style="margin:0;padding:8px 10px;font-size:13px">${_stmt.intro}</p>` : '') + `<table class="menu-grid-table"><thead><tr>${_stmt.cols.map((c, i) => `<th${_stmt.align[i] === 2 ? ' style="text-align:right"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>
    ${t ? `<tr><td ${td} colspan="${_stmt.cols.length - 1}"><b>${t[0]}</b></td><td ${td} align="right">${t[1]}</td></tr>` : ''}
    ${slice.length ? slice.map(r => `<tr>${r.map((c, i) => `<td ${_stmt.nowrap.includes(i) ? td.replace('font-size:13px', 'font-size:13px;white-space:nowrap;min-width:130px') : td}${al(i)}>${_stmt.clip.includes(i) ? `<div class="stmt-clip" title="${c.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}" onclick="this.classList.toggle('open')">${c}</div>` : c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${_stmt.cols.length}" style="padding:20px;text-align:center;color:var(--text-muted)">Nothing recorded yet.</td></tr>`}
    </tbody></table>`;
  const nav = document.getElementById('orgStatementPager');
  nav.style.display = pages > 1 ? 'flex' : 'none';
  document.getElementById('orgStatementPageLabel').textContent = `Page ${_stmt.page + 1} of ${pages}`;
  document.getElementById('orgStatementPrev').disabled = _stmt.page === 0;
  document.getElementById('orgStatementNext').disabled = _stmt.page >= pages - 1;
}
// Plain-text / print versions of whatever the statement modal is showing (all pages).
function stmtPlain(c) { return new DOMParser().parseFromString(c, 'text/html').body.textContent; }
window.printStatement = function() {
  const th = 'style="text-align:left;padding:4px 8px;border-bottom:2px solid #ccc;font-size:12px"';
  const td = 'style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px"';
  const t = _stmt.total;
  printHtml(`<!doctype html><title>${escHtml(_stmt.title)}</title><body style="font-family:sans-serif;padding:16px"><h2>${escHtml(_stmt.title)}</h2>${_stmt.intro ? `<p>${_stmt.intro}</p>` : ''}
    <table style="border-collapse:collapse;width:100%"><tr>${_stmt.cols.map((c, i) => `<th ${th.replace('left', _stmt.align[i] === 2 ? 'right' : 'left')}>${c}</th>`).join('')}</tr>
    ${t ? `<tr><td ${td} colspan="${_stmt.cols.length - 1}"><b>${t[0]}</b></td><td ${td} align="right">${t[1]}</td></tr>` : ''}
    ${_stmt.rows.map(r => `<tr>${r.map((c, i) => `<td ${td}${_stmt.align[i] === 2 ? ' align="right"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</table></body>`);
};
window.emailStatement = function() {
  const t = _stmt.total;
  const lines = [_stmt.title, ''];
  if (_stmt.intro) lines.push(stmtPlain(_stmt.intro), '');
  if (t) lines.push(`${stmtPlain(t[0])}: ${stmtPlain(t[1])}`, '');
  _stmt.rows.forEach(r => lines.push(r.map(stmtPlain).join('  |  ')));
  location.href = 'mailto:?subject=' + encodeURIComponent(_stmt.title) + '&body=' + encodeURIComponent(lines.join(String.fromCharCode(10)));
};
window.stmtPage = function(d) { _stmt.page += d; renderStatementPage(); };
window.addEventListener('resize', () => {
  if (document.getElementById('orgStatementModal').style.display === 'flex') renderStatementPage();
});
window.closeOrgStatement = function() { document.getElementById('orgStatementModal').style.display = 'none'; };

let _deliveries  = [];   // showdrinks_deliveries: every stock addition, newest first
let _stock       = {};
let _stockTakes  = [];
let _stockCat    = null;
let _stockCounts = {};   // itemId -> number — the in-progress count, kept in localStorage too
let _stockView   = 'count';
let _stockReportId = null;
let _restockIds  = null;   // item ids shown on the Restock page (null = recompute on next render)
const STOCK_DRAFT_KEY = 'showdrinks_stock_draft';
const STOCK_SESSION_KEY = 'showdrinks_stock_session';
let _stockUsedOnly = false;   // report option: only list items that had usage
let _stockPending = null;   // results of a finished count awaiting the user's confirmation
let _stockOpening = false;   // true while the take in progress is an opening-stock entry (no usage)
let _stockTaking = null;   // event name while a stock take is in progress, else null
let _stockOrg = '';   // organisation id the take in progress is for ('' = none defined)
try { _stockTaking = localStorage.getItem(STOCK_SESSION_KEY) || null; _stockOpening = localStorage.getItem(STOCK_SESSION_KEY + '_opening') === '1'; } catch (e) { _stockTaking = null; }
try { _stockOrg = localStorage.getItem(STOCK_SESSION_KEY + '_org') || ''; } catch (e) { _stockOrg = ''; }
function saveStockSession() {
  try {
    if (_stockTaking) localStorage.setItem(STOCK_SESSION_KEY, _stockTaking); else localStorage.removeItem(STOCK_SESSION_KEY);
    if (_stockTaking && _stockOpening) localStorage.setItem(STOCK_SESSION_KEY + '_opening', '1'); else localStorage.removeItem(STOCK_SESSION_KEY + '_opening');
    if (_stockTaking && _stockOrg) localStorage.setItem(STOCK_SESSION_KEY + '_org', _stockOrg); else localStorage.removeItem(STOCK_SESSION_KEY + '_org');
  } catch (e) {}
}

try { _stockCounts = JSON.parse(localStorage.getItem(STOCK_DRAFT_KEY) || '{}') || {}; } catch (e) { _stockCounts = {}; }
function saveStockDraft() {
  try { localStorage.setItem(STOCK_DRAFT_KEY, JSON.stringify(_stockCounts)); } catch (e) {}
}

async function loadStockTab() {
  try {
    // Independent queries: one failing (e.g. deliveries) must not blank the organisations, or
    // additions would be saved with no organisation.
    const results = await Promise.allSettled([
      db.collection('showdrinks_stock').get({ source: 'server' }),
      db.collection('showdrinks_stockTakes').orderBy('createdAt', 'desc').limit(200).get({ source: 'server' }),
      db.collection('showdrinks_orgs').get({ source: 'server' }),
      db.collection('showdrinks_deliveries').orderBy('createdAt', 'desc').limit(300).get({ source: 'server' }),
    ]);
    const [stockR, takesR, orgR, delR] = results;
    if (delR.status === 'fulfilled') _deliveries = delR.value.docs.map(d => ({ id: d.id, ...d.data() }));
    if (orgR.status === 'fulfilled') { _orgs = orgR.value.docs.map(d => ({ id: d.id, name: d.data().name || '' })); sortOrgs(); }
    if (stockR.status === 'fulfilled') { _stock = {}; stockR.value.docs.forEach(d => { _stock[d.id] = d.data(); }); }
    if (takesR.status === 'fulfilled') _stockTakes = takesR.value.docs.map(d => ({ id: d.id, ...d.data() }));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) toast('Could not load some stock data: ' + failed.reason.message, 'error');
  } catch (e) {
    toast('Could not load stock: ' + e.message, 'error');
  }
  if (!_stockReportId && _stockTakes.length) _stockReportId = _stockTakes[0].id;
  _restockIds = null;
  renderStockTab();
}

window.setStockView = function(v) {
  _stockView = v;
  if (v === 'restock') {
    // Re-read stock from the server each time the Restock page is opened, so the suggested
    // quantities reflect current stock rather than whatever was loaded earlier.
    _restockIds = null;
    renderStockTab();
    loadStockTab();
    return;
  }
  renderStockTab();
};
window.setStockCat  = function(c) { _stockCat = c; renderStockTab(); };

// Level a restock tops an item up to: restockTo if set, never below minStock.
function stockRestockLevel(s) {
  const min = typeof s.minStock === 'number' ? s.minStock : null;
  if (min === null) return null;
  return Math.max(min, typeof s.restockTo === 'number' ? s.restockTo : 0);
}

function stockOnHand(s) {
  return s && typeof s.base === 'number' ? s.base + (s.added || 0) : null;
}

// Quantities as whole units plus ¼ ½ ¾ (bottles are counted in quarters): 2.5 → "2½", 0.25 → "¼".
function fmtQty(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  let whole = Math.floor(a + 1e-9);
  let f = Math.round((a - whole) * 4) / 4;
  if (f >= 1) { whole += 1; f = 0; }
  if (Math.abs(a - whole - f) > 0.001) return sign + String(Math.round(a * 100) / 100);
  const glyph = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[f] || '';
  return sign + ((whole || !glyph) ? whole : '') + glyph;
}

// No previous count yet → no on-hand figure, but still show anything added so a tap gives feedback.
function stockOnHandLabel(s) {
  const oh = stockOnHand(s);
  if (oh !== null) return fmtQty(oh);
  return s && s.added ? (s.added > 0 ? '+' : '') + fmtQty(s.added) : '—';
}

function renderStockTab() {
  document.getElementById('stockCountView').style.display   = _stockView === 'count' ? '' : 'none';
  document.querySelectorAll('.stock-menu-view').forEach(b => b.classList.toggle('active', b.dataset.view === _stockView));
  const rep = _stockView === 'reports';
  document.getElementById('stockReportsView').style.display = rep ? '' : 'none';
  document.getElementById('stockRestockView').style.display = _stockView === 'restock' ? '' : 'none';
  renderStockCount();   // also keeps the ⋯ menu's Start/Finish/Cancel items current on every view
  if (rep) renderOrgSummary();
  else if (_stockView === 'restock') renderStockRestock();
}

function updateStockCountSummary() {
  document.getElementById('stockCountSummary').textContent = _stockTaking ? _stockTaking + (_stockOrg ? ' · ' + orgName(_stockOrg) : '') : '';
}

// "Non-zero only" checkbox on the Stock view: hides items with nothing on hand. Never applied
// while a count is in progress, so a zero-stock item can still be counted.
function stockPassesNonZero(i) {
  if (_stockTaking || !document.getElementById('stockNonZero')?.checked) return true;
  return (stockOnHand(_stock[i.id] || {}) || 0) !== 0;
}

// "Stk" flag (menu item `stk`, set on the Price List item edit screen): only flagged items are part
// of stock takes, the printed stock list and the restock picker. Defaults to true.
function stockIsTracked(id) { return _allMenuItems.find(i => i.id === id)?.stk !== false; }

function renderStockCount() {
  // Only stock take (Stk) items appear on the Stock view, and so only their categories.
  const showNonStock = !_stockTaking && !!document.getElementById('stockShowNonStock')?.checked;
  const tracked = _allMenuItems.filter(i => showNonStock || i.stk !== false);
  const cats = [...new Set(tracked.map(i => i.category || ''))].sort();
  if (!cats.length) cats.push('');
  if (_stockCat === null || (_stockCat !== 'all' && !cats.includes(_stockCat))) _stockCat = cats[0];
  document.getElementById('stockCategoryBar').innerHTML = ['all', ...cats].map(c => `
    <button type="button" class="cat-btn ${c === _stockCat ? 'active' : ''}" onclick="setStockCat('${escHtml(c)}')">${c === 'all' ? 'All' : escHtml(c || 'Uncategorised')}</button>`).join('');

  const items = _allMenuItems.filter(i => _stockCat === 'all' || (i.category || '') === _stockCat).filter(stockPassesNonZero)
    .filter(i => showNonStock || i.stk !== false);
  const rowHtml = i => {
    const s = _stock[i.id] || {};
    const pencil = `<td class="col-edit" style="text-align:center"><button type="button" class="icon-btn" onclick="openEditMenuItemModal('${i.id}')" title="Edit" aria-label="Edit">${ICON_EDIT}</button></td>`;
    if (i.stk === false) {
      // Not a stock item: shown only so it can be edited (e.g. to tick Stk) - no stock fields.
      return `<tr style="opacity:.8"><td>${escHtml(i.name || '')}${_stockCat === 'all' ? `<br><span style="color:var(--text-muted);font-size:10px">${escHtml(i.category || '')}</span>` : ''}</td><td class="col-edit" colspan="5"></td>${pencil}</tr>`;
    }
    return `<tr>
      <td>${escHtml(i.name || '')}${_stockCat === 'all' ? `<br><span style="color:var(--text-muted);font-size:10px">${escHtml(i.category || '')}</span>` : ''}</td>
      <td class="col-edit"><input type="number" min="0" step="0.01" class="stock-input" value="${s.costPrice ?? ''}" onchange="saveStockField('${i.id}','costPrice',this.value)" aria-label="Cost price"></td>
      <td class="col-edit"><input type="number" min="0" step="any" class="stock-input" value="${s.minStock ?? ''}" onchange="saveStockField('${i.id}','minStock',this.value)" aria-label="Minimum stock"></td>
      <td class="col-edit"><input type="number" min="0" step="any" class="stock-input" id="stockRestockTo-${i.id}" value="${s.restockTo ?? ''}" placeholder="${s.minStock ?? ''}" onchange="saveStockField('${i.id}','restockTo',this.value)" aria-label="Restock up to"></td>
      <td class="col-edit" style="text-align:center" id="stockOh-${i.id}">${stockOnHandLabel(s)}</td>
      <td class="col-edit" style="text-align:center"><button type="button" class="btn btn-secondary btn-sm" onclick="openStockAdjust('${i.id}')">Add</button></td>
      ${stockCountCell(i)}
      ${pencil}
    </tr>`;
  };
  const stockRows = items.filter(i => i.stk !== false);
  const nonStockRows = items.filter(i => i.stk === false);
  document.getElementById('stockTableBody').innerHTML = items.length
    ? stockRows.map(rowHtml).join('')
      + (nonStockRows.length ? `<tr><td colspan="7" style="font-weight:700;padding-top:16px">Non stock items</td></tr>` + nonStockRows.map(rowHtml).join('') : '')
    : '<tr><td colspan="7" style="color:var(--text-muted);padding:20px;text-align:center">No items in this category.</td></tr>';
  const counting = !!_stockTaking;
  document.getElementById('stockNonZeroLabel').style.display = counting ? 'none' : 'flex';
  document.getElementById('stockNonStockLabel').style.display = counting ? 'none' : 'flex';
  document.getElementById('stockHeader').classList.toggle('stock-taking', counting);
  document.getElementById('stockTitle').textContent = counting ? 'Stock take in progress' : 'Stock';
  document.getElementById('stockTable').classList.toggle('counting', counting);
  document.getElementById('stockStartBtn').style.display = counting ? 'none' : '';
  document.getElementById('stockOpeningBtn').style.display = counting ? 'none' : '';
  document.getElementById('stockFinishBtn').style.display = counting ? '' : 'none';
  document.getElementById('stockCancelBtn').style.display = counting ? '' : 'none';
  updateStockCountSummary();
}

// Event name comes from a dropdown of all shows (current one preselected), or "Other" to type one.
window.startStockTake = function() {
  if (_stockView !== 'count') setStockView('count');
  document.getElementById('stockEventName').value = '';
  document.getElementById('stockEventOrgWrap').style.display = _orgs.length ? '' : 'none';
  document.getElementById('stockEventOrg').innerHTML = orgOptionsHtml(lastOrg());
  document.getElementById('stockEventModal').style.display = 'flex';
};

// Opening stock: the same count screen, saved as a stock take called "Opening stock" that sets
// every counted item's starting figure but records no usage (nothing to compare against).
window.startOpeningStock = async function() {
  const org = await pickOrg('Opening stock for which organisation?');
  if (org === null) return;
  if (_stockView !== 'count') setStockView('count');
  _stockOpening = true;
  _stockOrg = org;
  _stockCounts = {}; saveStockDraft();   // counts default to that organisation's current share
  _stockTaking = 'Opening stock';
  saveStockSession();
  renderStockCount();
};

window.closeStockEvent = function() { document.getElementById('stockEventModal').style.display = 'none'; };

window.confirmStockEvent = function() {
  const name = document.getElementById('stockEventName').value.trim();
  if (!name) { toast('A stock take needs an event name', 'error'); return; }
  const org = _orgs.length ? document.getElementById('stockEventOrg').value : '';
  if (_orgs.length && !org) { toast('Pick an organisation', 'error'); return; }
  if (org) rememberOrg(org);
  closeStockEvent();
  _stockOpening = false;
  _stockOrg = org;
  _stockTaking = name;
  saveStockSession();
  renderStockCount();
};

// Restock level (`restockTo`) is what a restock tops an item up to: it starts out equal to Min
// (blank = follow Min) and may be set higher, never lower. Raising Min past it drags it up too.
window.saveStockField = async function(id, field, raw) {
  let v = raw === '' ? null : Number(raw);
  if (v !== null && (!isFinite(v) || v < 0)) { toast('Enter a number, 0 or more', 'error'); return; }
  const patch = {};
  const cur = _stock[id] || {};
  if (field === 'restockTo' && v !== null && v < (cur.minStock || 0)) {
    v = cur.minStock;
    toast('Restock level can’t be lower than the minimum', 'error');
  }
  patch[field] = v;
  if (field === 'minStock' && typeof cur.restockTo === 'number' && (v || 0) > cur.restockTo) patch.restockTo = v;
  _stock[id] = { ...cur, ...patch };
  if (field === 'restockTo' || patch.restockTo !== undefined) {
    const el = document.getElementById('stockRestockTo-' + id);
    if (el) { el.value = _stock[id].restockTo ?? ''; el.placeholder = _stock[id].minStock ?? ''; }
  }
  try { await db.collection('showdrinks_stock').doc(id).set(patch, { merge: true }); }
  catch (e) { toast('Failed: ' + e.message, 'error'); }
};

// A count starts at what should be on the shelf (last count + deliveries since, 0 if never
// counted). An empty box counts as 0, so whatever was there is treated as used.
function stockCountFor(id) {
  if (id in _stockCounts) return _stockCounts[id];
  if (_stockOpening && _stockOrg) return orgQtyOf(_stock[id], _stockOrg);   // opening stock counts one organisation's share
  return stockOnHand(_stock[id] || {}) ?? 0;
}

// Count box(es) for one item. Fraction items (`frac` on the menu item) get whole units plus a
// ¼ ½ ¾ selector; the stored count is simply whole + fraction (e.g. 2.5).
function stockCountCell(i) {
  const id = i.id, v = stockCountFor(id);
  const minus = `<button type="button" class="btn btn-secondary btn-sm stock-step" onclick="stepStockCount('${id}',-1)" aria-label="Minus one">−</button>`;
  const plus = `<button type="button" class="btn btn-secondary btn-sm stock-step" onclick="stepStockCount('${id}',1)" aria-label="Plus one">+</button>`;
  if (i.frac) {
    let whole = Math.floor(v + 1e-9), f = Math.round((v - whole) * 4) / 4;
    if (f >= 1) { whole += 1; f = 0; }
    const opts = [0, 0.25, 0.5, 0.75].map(x => `<option value="${x}" ${x === f ? 'selected' : ''}>${x === 0 ? '0' : fmtQty(x)}</option>`).join('');
    return `<td class="col-count" style="white-space:nowrap">${minus}<input type="number" min="0" step="1" class="stock-input" id="stockCount-${id}" value="${whole}" oninput="setStockCountFrac('${id}')" style="width:46px" aria-label="Whole units">${plus}<select class="stock-input" id="stockFrac-${id}" onchange="setStockCountFrac('${id}')" style="width:56px" aria-label="Fraction">${opts}</select></td>`;
  }
  return `<td class="col-count" style="white-space:nowrap">${minus}<input type="number" min="0" step="1" class="stock-input" id="stockCount-${id}" value="${v}" oninput="setStockCount('${id}',this.value)" style="width:56px" aria-label="Counted">${plus}</td>`;
}

window.setStockCountFrac = function(id) {
  const whole = Math.max(0, parseInt(document.getElementById('stockCount-' + id).value, 10) || 0);
  const f = parseFloat(document.getElementById('stockFrac-' + id).value) || 0;
  _stockCounts[id] = whole + f;
  saveStockDraft();
};

window.setStockCount = function(id, raw) {
  _stockCounts[id] = raw === '' ? 0 : Math.max(0, Number(raw) || 0);
  saveStockDraft();
};

window.stepStockCount = function(id, d) {
  const v = Math.max(0, stockCountFor(id) + d);
  _stockCounts[id] = v;
  saveStockDraft();
  const el = document.getElementById('stockCount-' + id);
  const fr = document.getElementById('stockFrac-' + id);
  if (fr) {
    const whole = Math.floor(v + 1e-9);
    if (el) el.value = whole;
    fr.value = String(Math.round((v - whole) * 4) / 4);
  } else if (el) el.value = v;
};

// Deliveries/top-ups (+) or write-offs (−) at any time — goes in `added`, which the usage sum
// subtracts back out, so neither counts as sales. Done in a modal (− [n] +, OK / Cancel) so a
// whole delivery is one entry and nothing is written until OK.
let _stockAdjustId = null;
let _stockAdjustStep = 1;

window.openStockAdjust = function(id) {
  const item = _allMenuItems.find(i => i.id === id);
  _stockAdjustId = id;
  _stockAdjustStep = item?.frac ? 0.25 : 1;
  document.getElementById('stockAdjustName').textContent = item?.name || '';
  document.getElementById('stockAdjustQty').value = 0;
  document.getElementById('stockAdjustOrgWrap').style.display = _orgs.length ? '' : 'none';
  document.getElementById('stockAdjustOrg').innerHTML = orgOptionsHtml(lastOrg());
  document.getElementById('stockAdjustModal').style.display = 'flex';
};

window.stepStockAdjust = function(d) {
  const el = document.getElementById('stockAdjustQty');
  el.value = (parseFloat(el.value) || 0) + d * _stockAdjustStep;
};

window.closeStockAdjust = function() {
  document.getElementById('stockAdjustModal').style.display = 'none';
  _stockAdjustId = null;
};

window.confirmStockAdjust = async function() {
  const id = _stockAdjustId;
  const delta = Math.round((parseFloat(document.getElementById('stockAdjustQty').value) || 0) * 4) / 4;
  if (!id) return;
  if (!delta) { toast('Use + or − to enter a quantity first', 'error'); return; }
  const org = _orgs.length ? document.getElementById('stockAdjustOrg').value : '';
  if (_orgs.length && !org) { toast('Pick an organisation', 'error'); return; }
  try {
    const FV = firebase.firestore.FieldValue;
    await db.collection('showdrinks_stock').doc(id).set({ added: FV.increment(delta), ...(org ? { org: { [org]: FV.increment(delta) }, orgAdded: { [org]: FV.increment(delta) } } : {}) }, { merge: true });
    if (org) rememberOrg(org);
    const itm = _allMenuItems.find(i => i.id === id);
    await logDelivery(org, [{ itemId: id, name: itm?.name || '', qty: delta, cost: typeof (_stock[id] || {}).costPrice === 'number' ? _stock[id].costPrice : null }]);
    const cur = _stock[id] || {};
    _stock[id] = { ...cur, added: (cur.added || 0) + delta, ...(org ? { org: { ...(cur.org || {}), [org]: orgQtyOf(cur, org) + delta }, orgAdded: { ...(cur.orgAdded || {}), [org]: orgAddedOf(cur, org) + delta } } : {}) };
    const cell = document.getElementById('stockOh-' + id);
    if (cell) cell.textContent = stockOnHandLabel(_stock[id]);
    closeStockAdjust();
    toast(`Stock ${delta > 0 ? 'added' : 'removed'}: ${fmtQty(Math.abs(delta))}`, 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};

// Same Add Item screen as the Price List (Stk ticked by default), opened on the category being
// viewed; the Stock list refreshes when it's saved (see the save handler in the item modal).
window.addStockItem = function() {
  const prev = _selectedMenuCat;
  _selectedMenuCat = _stockCat && _stockCat !== 'all' ? _stockCat : 'all';
  // Items added from the Stock page start as stock-only: not sold anywhere until you tick a channel.
  openAddMenuItemModal({ showOnTab: false, showOnPos: false, onSale: false, stk: true });
  _selectedMenuCat = prev;
};

window.toggleStockActions = function(e) {
  e.stopPropagation();
  document.getElementById('stockActionsDropdown').classList.toggle('open');
};
document.addEventListener('click', () => {
  document.getElementById('stockActionsDropdown')?.classList.remove('open');
});

// Zeroes every item's stock figures (counted base, deliveries since, restock quantity) and drops
// any in-progress count. Cost, Min and Restock level are item settings and stay; old stock takes
// (showdrinks_stockTakes) are never touched.
window.clearAllStock = async function() {
  const msg = 'Reset all stock to 0? This zeroes every item stock, deliveries and restock quantity, and cancels any stock take in progress. Cost, Min and Restock level settings and previous stock takes are kept. A "Stock cleared" line is added to Reports (delete it, if it is the latest, to undo).';
  if (!confirm(msg)) return;
  try {
    const FV = firebase.firestore.FieldValue;
    // The report line keeps each item's previous figures so deleting it (when it is the latest
    // entry) puts everything back — see deleteLatestStockTake.
    const lines = _allMenuItems.map(it => {
      const st = _stock[it.id] || {};
      return {
        itemId: it.id, name: it.name || '', category: it.category || '',
        opening: typeof st.base === 'number' ? st.base : null, added: st.added || 0, counted: 0, used: null,
        costPrice: typeof st.costPrice === 'number' ? st.costPrice : null, usedCost: null,
        ...(typeof st.restock === 'number' ? { prevRestock: st.restock } : {}),
        ...(st.org && Object.keys(st.org).length ? { prevOrg: st.org } : {}),
        ...(st.orgAdded && Object.keys(st.orgAdded).length ? { prevOrgAdded: st.orgAdded } : {}),
      };
    });
    await db.collection('showdrinks_stockTakes').add({ createdAt: FV.serverTimestamp(), eventName: 'Stock cleared', cleared: true, lines });
    for (let i = 0; i < _allMenuItems.length; i += 400) {
      const batch = db.batch();
      _allMenuItems.slice(i, i + 400).forEach(it => batch.set(db.collection('showdrinks_stock').doc(it.id), { base: 0, added: 0, restock: FV.delete(), org: FV.delete(), orgAdded: FV.delete() }, { merge: true }));
      await batch.commit();
    }
    _stockCounts = {}; saveStockDraft();
    _stockOpening = false; _stockOrg = '';
    _stockTaking = null; saveStockSession();
    _stockView = 'reports';
    await loadStockTab();
    toast('All stock reset to 0', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};
// Stock prints (stock list, restock list, stock take report) open the document in a new window and
// print it. The window closes itself once the print dialog is dismissed (printed or cancelled) and
// also has a Back button, so there's always a way back to the app (in an installed app that new
// window has no browser chrome to close it with).
function printHtml(html) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print', 'error'); return; }
  const bar = '<style>@media print{.np{display:none}}</style>' +
    '<div class="np" style="margin-bottom:12px"><button onclick="window.close()" style="font-size:16px;padding:8px 14px">← Back to app</button> ' +
    '<button onclick="window.print()" style="font-size:16px;padding:8px 14px">Print</button></div>' +
    '<script>window.addEventListener("afterprint", function () { window.close(); });<' + '/script>';
  w.document.write(html.replace(/<body([^>]*)>/, '<body$1>' + bar));
  w.document.close(); w.focus(); w.print();
}

// Printable count sheet: every item by category with its current figures and a blank box to
// write the count in.
window.printStockList = function() {
  if (!_allMenuItems.length) { toast('No items to print', 'error'); return; }
  const th = 'style="text-align:left;padding:4px 6px;border-bottom:2px solid #999;font-size:12px"';
  const td = 'style="padding:5px 6px;border-bottom:1px solid #ddd;font-size:13px"';
  const dash = v => v === null || v === undefined ? '—' : v;
  let total = 0, lastCat = null;
  const rows = _allMenuItems.filter(stockPassesNonZero).filter(i => stockIsTracked(i.id)).map(i => {
    const s = _stock[i.id] || {};
    const oh = stockOnHand(s);
    const lvl = stockRestockLevel(s);
    if (oh !== null && typeof s.costPrice === 'number') total += oh * s.costPrice;
    const head = (i.category || '') !== lastCat
      ? `<tr><td colspan="7" style="padding:10px 6px 3px;font-weight:700;font-size:13px;background:#f3f3f3">${escHtml(i.category || 'Uncategorised')}</td></tr>` : '';
    lastCat = i.category || '';
    return head + `<tr><td ${td}>${escHtml(i.name || '')}</td><td ${td}>${typeof s.costPrice === 'number' ? fmtCurrency(s.costPrice) : '—'}</td><td ${td}>${dash(s.minStock)}</td><td ${td}>${dash(lvl)}</td><td ${td}>${fmtQty(oh)}</td><td ${td}>${(s.restock || 0) || ''}</td><td ${td} style="width:70px;border:1px solid #999"></td></tr>`;
  }).join('');
  printHtml(`<!doctype html><title>Stock list</title><body style="font-family:sans-serif;padding:16px"><h2>Stock list — ${new Date().toLocaleDateString('en-GB')}</h2>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}>Item</th><th ${th}>Cost</th><th ${th}>Min</th><th ${th}>Restock level</th><th ${th}>On hand</th><th ${th}>To order</th><th ${th}>Counted</th></tr>${rows}</table>
    <p style="font-size:13px"><b>Value of stock on hand:</b> ${fmtCurrency(total)}</p></body>`);
};

window.cancelStockTake = function() {
  if (!confirm('Cancel this stock take? Counts entered so far will be discarded.')) return;
  _stockCounts = {}; saveStockDraft();
  _stockOpening = false; _stockOrg = '';
  _stockTaking = null; saveStockSession();
  renderStockCount();
};

function renderStockFinishBody() {
  if (!_stockPending) return;
  const { eventName, lines, orgName: oName } = _stockPending;
  const uncounted = 0;
  const v = stockTakeValues({ lines });
  document.getElementById('stockFinishTitle').textContent = eventName;
  document.getElementById('stockFinishBody').innerHTML =
    `<p style="margin:0 0 10px;font-size:13px"><b>Stock value:</b> ${fmtCurrency(v.stock)} &nbsp; <b>Used value:</b> ${fmtCurrency(v.used)}</p>` +
    stockReportHtml({ lines, orgName: oName });
}

window.setStockUsedOnly = function(on) {
  _stockUsedOnly = !!on;
  document.querySelectorAll('.stock-used-only').forEach(c => { c.checked = _stockUsedOnly; });
  renderStockFinishBody();
  renderStockReportModal();
};

window.finishStockTake = async function() {
  const ids = _allMenuItems.filter(i => stockIsTracked(i.id)).map(i => i.id);   // every item is counted; one left empty counts as 0
  const uncounted = 0;

  const eventName = _stockTaking;
  if (!eventName) { toast('Start a stock take first', 'error'); return; }

  const lines = ids.map(id => {
    const item = _allMenuItems.find(i => i.id === id);
    const s = _stock[id] || {};
    const counted = stockCountFor(id);
    const hasBase = typeof s.base === 'number';
    const opening = hasBase ? s.base : null;
    const added = s.added || 0;
    const used = hasBase && !_stockOpening ? opening + added - counted : null;
    // Opening stock for an organisation counts only that organisation's share: the total becomes
    // (old total - its old share + the new count).
    const orgOpen = _stockOpening && !!_stockOrg;
    const prevOrgQty = orgOpen && s.org && typeof s.org[_stockOrg] === 'number' ? s.org[_stockOrg] : null;
    const newTotal = orgOpen ? Math.round(((hasBase ? opening + added : added) - (prevOrgQty || 0) + counted) * 100) / 100 : counted;
    const cost = typeof s.costPrice === 'number' ? s.costPrice : null;
    const min = typeof s.minStock === 'number' ? s.minStock : null;
    return {
      itemId: id, name: item.name || '', category: item.category || '',
      opening, added, counted, used, costPrice: cost,
      ...(orgOpen ? { prevOrgQty, newTotal } : {}),
      ...(s.orgAdded && Object.keys(s.orgAdded).length ? { prevOrgAdded: s.orgAdded } : {}),
      usedCost: used !== null && cost !== null ? Math.round(used * cost * 100) / 100 : null,
      minStock: min,
      restockTo: stockRestockLevel(s),
      reorder: min !== null && counted < min ? stockRestockLevel(s) - counted : 0,
    };
  });

  // Nothing is saved yet: show the results and let the user confirm (or go back and keep counting).
  _stockPending = { eventName, lines, ids, orgId: _stockOrg, orgName: orgName(_stockOrg) };
  renderStockFinishBody();
  document.getElementById('stockFinishModal').style.display = 'flex';
};

window.closeStockFinish = function() {
  document.getElementById('stockFinishModal').style.display = 'none';
};

window.confirmStockFinish = async function() {
  const { eventName, lines, ids, orgId, orgName: oName } = _stockPending || {};
  if (!lines) return;
  try {
    const batch = db.batch();
    const takeRef = db.collection('showdrinks_stockTakes').doc();
    batch.set(takeRef, { createdAt: firebase.firestore.FieldValue.serverTimestamp(), eventName, ...(_stockOpening ? { opening: true } : {}), ...(orgId ? { orgId, orgName: oName } : {}), lines });
    // The Restock list is worked out from current stock, so drop any hand-set quantity (restock)
    // and let it recalculate from the new counts.
    ids.forEach(id => {
      const l = lines.find(x => x.itemId === id);
      // The organisation's share: set outright by opening stock; otherwise it pays for what was used
      // (and may go negative = owes the stock).
      const orgPatch = !orgId ? {}
        : _stockOpening ? { org: { [orgId]: l.counted } }
        : l.used !== null ? { org: { [orgId]: firebase.firestore.FieldValue.increment(-l.used) } } : {};
      batch.set(db.collection('showdrinks_stock').doc(id),
        { base: l.newTotal ?? l.counted, added: 0, restock: firebase.firestore.FieldValue.delete(), orgAdded: firebase.firestore.FieldValue.delete(), ...orgPatch }, { merge: true });
    });
    await batch.commit();
    closeStockFinish();
    _stockPending = null;
    _stockCounts = {}; saveStockDraft();
    _stockOpening = false; _stockOrg = '';
    _stockTaking = null; saveStockSession();
    _stockReportId = takeRef.id;
    _stockView = 'reports';
    await loadStockTab();
    openStockTake(takeRef.id);
    toast('Stock take saved', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};

function stockTakeDate(t) {
  const d = t.createdAt?.toDate ? t.createdAt.toDate() : new Date();
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function stockTakeLabel(t) { return `${t.eventName || 'Stock take'} — ${stockTakeDate(t)}`; }

window.renameStockTake = async function() {
  const t = currentStockTake(); if (!t) return;
  const name = (prompt('Event name for this stock take:', t.eventName || '') || '').trim();
  if (!name) return;
  try {
    await db.collection('showdrinks_stockTakes').doc(t.id).update({ eventName: name });
    t.eventName = name;
    renderStockReportModal();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};

function currentStockTake() { return _stockTakes.find(t => t.id === _stockReportId) || null; }

function stockReportHtml(t) {
  if (t.cleared) return '<p style="margin:0;font-size:14px">All stock was reset to 0.</p>';
  const orgLine = t.orgName ? `<p style="margin:0 0 8px;font-size:13px"><b>Organisation:</b> ${escHtml(t.orgName)}</p>` : '';
  const lines = (t.lines || []).slice().sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
  const shown = _stockUsedOnly ? lines.filter(l => (l.used || 0) !== 0) : lines;
  const dash = v => v === null || v === undefined ? '—' : v;
  const total = lines.reduce((s, l) => s + (l.usedCost || 0), 0);
  const noBase = lines.some(l => l.used === null);
  const th = 'style="text-align:left;padding:4px 8px;border-bottom:2px solid #ccc;font-size:12px"';
  const td = 'style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px"';
  return `${orgLine}
    <h3 style="margin:0 0 6px">${t.opening ? 'Opening stock' : 'Usage since previous stock take'}</h3>
    <table style="border-collapse:collapse;width:100%">
      <tr><th ${th}>Category</th><th ${th}>Item</th><th ${th}>Opening</th><th ${th}>Added</th><th ${th}>Counted</th><th ${th}>Used</th><th ${th}>Cost each</th><th ${th}>Cost used</th></tr>
      ${shown.map(l => `<tr><td ${td}>${escHtml(l.category)}</td><td ${td}>${escHtml(l.name)}</td><td ${td}>${fmtQty(l.opening)}</td><td ${td}>${fmtQty(l.added || 0)}</td><td ${td}>${fmtQty(l.counted)}</td><td ${td}><b>${fmtQty(l.used)}</b></td><td ${td}>${l.costPrice === null ? '—' : fmtCurrency(l.costPrice)}</td><td ${td}>${l.usedCost === null ? '—' : fmtCurrency(l.usedCost)}</td></tr>`).join('')}
      <tr><td ${td} colspan="7"><b>Total cost of stock used</b></td><td ${td}><b>${fmtCurrency(total)}</b></td></tr>
    </table>
    ${noBase ? '<p style="font-size:12px;color:#777">— = no previous count recorded for that item, so this take sets its starting figure.</p>' : ''}`;
}

// Stock value = what was counted at the take × cost price; used value = the cost of what was used.
function stockTakeValues(t) {
  const lines = t.lines || [];
  return {
    stock: lines.reduce((n, l) => n + (l.counted || 0) * (l.costPrice || 0), 0),
    used: lines.reduce((n, l) => n + (l.usedCost || 0), 0),
  };
}

// Every addition to stock, newest first: restock received, or a + / − from the Add button.
async function logDelivery(orgId, items) {
  try {
    const org = orgId ? { orgId, orgName: orgName(orgId) } : {};
    const ref = await db.collection('showdrinks_deliveries').add({ createdAt: firebase.firestore.FieldValue.serverTimestamp(), ...org, items });
    // Show it straight away (the list is otherwise only loaded when the Stock tab opens).
    _deliveries.unshift({ id: ref.id, createdAt: firebase.firestore.Timestamp.now(), ...org, items });
    renderOrgSummary();
  } catch (e) { toast('Stock updated but the restock was not logged: ' + e.message, 'error'); }
}

// The all-stock ledger: stock takes (incl. opening stock and clears) and restocks in date order
// with a running balance of stock value at cost, newest first. Same idea as an organisation's
// statement, for all stock.
window.openStockTake = function(id) {
  _stockReportId = id;
  renderStockReportModal();
  document.getElementById('stockReportModal').style.display = 'flex';
};

window.closeStockReport = function() {
  document.getElementById('stockReportModal').style.display = 'none';
};

function renderStockReportModal() {
  const t = currentStockTake(); if (!t) return;
  document.getElementById('stockReportTitle').textContent = stockTakeLabel(t);
  document.getElementById('stockDeleteBtn').style.display = t.id === _stockTakes[0]?.id ? '' : 'none';
  document.getElementById('stockReportBody').innerHTML = stockReportHtml(t);
}

// Only the latest take can be deleted, and doing so rolls the stock back: every item it counted
// goes back to its previous count (base) and gets that take's deliveries put back into `added`,
// on top of anything added since — so deleting a take made by mistake loses nothing.
window.deleteLatestStockTake = async function() {
  const t = currentStockTake();
  if (!t || t.id !== _stockTakes[0]?.id) { toast('Only the latest stock take can be deleted', 'error'); return; }
  if (!confirm(`Delete the stock take "${t.eventName || 'Stock take'}"?
Item figures go back to how they were before it was finished.`)) return;
  try {
    const FV = firebase.firestore.FieldValue;
    const batch = db.batch();
    (t.lines || []).forEach(l => {
      batch.set(db.collection('showdrinks_stock').doc(l.itemId), {
        base: typeof l.opening === 'number' ? l.opening : FV.delete(),
        added: FV.increment(l.added || 0),
        ...(typeof l.prevRestock === 'number' ? { restock: l.prevRestock } : {}),
        ...(l.prevOrgAdded ? { orgAdded: Object.fromEntries(Object.entries(l.prevOrgAdded).map(([k, v]) => [k, FV.increment(v)])) } : {}),
        // Organisation shares go back too: a clear restores them all, opening stock restores that
        // organisation's old share, a normal take gives back the usage it charged.
        ...(t.cleared ? { org: l.prevOrg || FV.delete() }
          : t.opening && t.orgId ? { org: { [t.orgId]: typeof l.prevOrgQty === 'number' ? l.prevOrgQty : FV.delete() } }
          : t.orgId && typeof l.used === 'number' ? { org: { [t.orgId]: FV.increment(l.used) } } : {}),
      }, { merge: true });
    });
    const takeRef = db.collection('showdrinks_stockTakes').doc(t.id);
    batch.delete(takeRef);
    await batch.commit();
    // Read it back from the server so a delete that didn't really happen is reported, not hidden.
    const still = await takeRef.get({ source: 'server' });
    if (still.exists) { toast('Delete did not go through — the stock take is still on the server', 'error'); return; }
    _stockReportId = null;
    closeStockReport();
    await loadStockTab();
    toast('Stock take deleted', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};


// ── Restock list ─────────────────────────────────────────────────────────────
// showdrinks_stock/{id}.restock = how many to order. Filled automatically by Finish stock take
// (items counted below Min) and editable by hand here. "Receive restock" turns the quantities
// into deliveries (`added`) and zeroes them.
// Suggested quantity comes from CURRENT stock (last count + deliveries since), not from the last
// stock take: items below Min are topped up to the Restock level. `restock` on the stock doc is a
// hand-set override (the +/- and Add item controls); receiving a restock or finishing a stock take
// removes it so the suggestion takes over again.
function suggestedRestock(id) {
  const s = _stock[id] || {};
  if (typeof s.minStock !== 'number') return 0;
  const now = stockOnHand(s) ?? 0;
  return now < s.minStock ? Math.max(0, Math.ceil(stockRestockLevel(s) - now)) : 0;   // ordered in whole units
}

function restockQty(id) {
  const o = (_stock[id] || {}).restock;
  return typeof o === 'number' ? Math.max(0, o) : suggestedRestock(id);
}

function renderStockRestock() {
  if (!_restockIds) _restockIds = new Set(_allMenuItems.filter(i => stockIsTracked(i.id) && restockQty(i.id) > 0).map(i => i.id));
  const items = _allMenuItems.filter(i => _restockIds.has(i.id));
  document.getElementById('stockRestockBody').innerHTML = items.length ? items.map(i => {
    const st = _stock[i.id] || {};
    const cost = st.costPrice;
    const nowQty = stockOnHand(st);
    return `<tr>
      <td>${escHtml(i.name || '')}<br><span style="color:var(--text-muted);font-size:11px">Now ${fmtQty(nowQty)} · Min ${st.minStock ?? '—'}<br>Restock level ${stockRestockLevel(st) ?? '—'}</span><br><span style="color:var(--text-muted);font-size:10px">${escHtml(i.category || '')}${typeof cost === 'number' ? ' · ' + fmtCurrency(cost) + ' each' : ''}</span></td>
      <td style="white-space:nowrap;text-align:right">
        <button type="button" class="btn btn-secondary btn-sm stock-step" onclick="stepRestock('${i.id}',-1)" aria-label="Minus one">−</button>
        <input type="number" min="0" step="1" class="stock-input" id="restockQty-${i.id}" value="${restockQty(i.id)}" onchange="setRestock('${i.id}',this.value)" style="width:64px;text-align:center" aria-label="Quantity to order">
        <button type="button" class="btn btn-secondary btn-sm stock-step" onclick="stepRestock('${i.id}',1)" aria-label="Plus one">+</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="2" style="color:var(--text-muted);padding:20px;text-align:center">Nothing to restock. Items counted below their minimum appear here automatically, or use + Add item.</td></tr>';
}

// Drops every hand-set quantity (including ones left over from older versions, which stored
// shortfalls at stock take time) so the list is worked out again from current stock.
window.recalcRestock = async function() {
  const ids = Object.keys(_stock).filter(id => typeof _stock[id].restock === 'number');
  if (ids.length && !confirm('Recalculate the restock list from current stock? Quantities you set by hand will be replaced.')) return;
  try {
    const FV = firebase.firestore.FieldValue;
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db.batch();
      ids.slice(i, i + 400).forEach(id => batch.set(db.collection('showdrinks_stock').doc(id), { restock: FV.delete() }, { merge: true }));
      await batch.commit();
    }
    ids.forEach(id => { delete _stock[id].restock; });
    _restockIds = null;
    renderStockRestock();
    toast('Restock list recalculated', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};

window.setRestock = async function(id, raw) {
  const v = Math.max(0, Math.round(Number(raw)) || 0);
  _stock[id] = { ..._stock[id], restock: v };
  const el = document.getElementById('restockQty-' + id);
  if (el) el.value = v;
  try { await db.collection('showdrinks_stock').doc(id).set({ restock: v }, { merge: true }); }
  catch (e) { toast('Failed: ' + e.message, 'error'); }
};

window.stepRestock = function(id, d) { setRestock(id, restockQty(id) + d); };

window.openRestockAdd = function() {
  const byCat = {};
  _allMenuItems.filter(i => stockIsTracked(i.id)).forEach(i => { (byCat[i.category || 'Uncategorised'] ||= []).push(i); });
  document.getElementById('restockAddItem').innerHTML = Object.keys(byCat).map(c =>
    `<optgroup label="${escHtml(c)}">${byCat[c].map(i => `<option value="${i.id}">${escHtml(i.name || '')}</option>`).join('')}</optgroup>`).join('');
  document.getElementById('restockAddQty').value = 1;
  document.getElementById('restockAddModal').style.display = 'flex';
};

window.closeRestockAdd = function() { document.getElementById('restockAddModal').style.display = 'none'; };

window.confirmRestockAdd = async function() {
  const id = document.getElementById('restockAddItem').value;
  const qty = Math.round(Number(document.getElementById('restockAddQty').value));
  if (!id || !(qty > 0)) { toast('Pick an item and a quantity above 0', 'error'); return; }
  if (!_restockIds) _restockIds = new Set();
  _restockIds.add(id);
  closeRestockAdd();
  await setRestock(id, restockQty(id) + qty);
  renderStockRestock();
};

window.printRestock = function() {
  const rows = _allMenuItems.filter(i => stockIsTracked(i.id) && restockQty(i.id) > 0);
  if (!rows.length) { toast('Nothing on the restock list', 'error'); return; }
  let total = 0;
  const td = 'style="padding:4px 8px;border-bottom:1px solid #ddd;font-size:14px"';
  const body = rows.map(i => {
    const q = restockQty(i.id), c = (_stock[i.id] || {}).costPrice;
    if (typeof c === 'number') total += q * c;
    return `<tr><td ${td}>${escHtml(i.category || '')}</td><td ${td}>${escHtml(i.name || '')}</td><td ${td}><b>${q}</b></td><td ${td}>${typeof c === 'number' ? fmtCurrency(q * c) : '—'}</td></tr>`;
  }).join('');
  printHtml(`<!doctype html><title>Restock list</title><body style="font-family:sans-serif;padding:16px"><h2>Restock list — ${new Date().toLocaleDateString('en-GB')}</h2>
    <table style="border-collapse:collapse;width:100%"><tr><th style="text-align:left">Category</th><th style="text-align:left">Item</th><th style="text-align:left">Order</th><th style="text-align:left">Est. cost</th></tr>${body}
    <tr><td ${td} colspan="3"><b>Estimated total</b></td><td ${td}><b>${fmtCurrency(total)}</b></td></tr></table></body>`);
};

window.receiveRestock = async function() {
  const rows = _allMenuItems.filter(i => stockIsTracked(i.id) && restockQty(i.id) > 0);
  if (!rows.length) { toast('Nothing on the restock list', 'error'); return; }
  const org = await pickOrg('Receive restock', `Add ${rows.length} item(s) to stock as deliveries and clear the restock list? This cannot be undone from here. Which organisation is the delivery for?`);
  if (org === null) return;
  try {
    const FV = firebase.firestore.FieldValue;
    const batch = db.batch();
    const qty = {};
    rows.forEach(i => { qty[i.id] = restockQty(i.id); });
    rows.forEach(i => batch.set(db.collection('showdrinks_stock').doc(i.id), { added: FV.increment(qty[i.id]), restock: FV.delete(), ...(org ? { org: { [org]: FV.increment(qty[i.id]) }, orgAdded: { [org]: FV.increment(qty[i.id]) } } : {}) }, { merge: true }));
    await batch.commit();
    await logDelivery(org, rows.map(i => ({ itemId: i.id, name: i.name || '', qty: qty[i.id], cost: typeof (_stock[i.id] || {}).costPrice === 'number' ? _stock[i.id].costPrice : null })));
    rows.forEach(i => {
      const st = { ..._stock[i.id], added: ((_stock[i.id] || {}).added || 0) + qty[i.id] };
      if (org) { st.org = { ...(st.org || {}), [org]: orgQtyOf(_stock[i.id], org) + qty[i.id] }; st.orgAdded = { ...(st.orgAdded || {}), [org]: orgAddedOf(_stock[i.id], org) + qty[i.id] }; }
      delete st.restock;
      _stock[i.id] = st;
    });
    _restockIds = null;
    renderStockRestock();
    toast('Restock added to stock', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
};

window.printStockReport = function() {
  const t = currentStockTake(); if (!t) return;
  printHtml(`<!doctype html><title>Stock take ${escHtml(stockTakeLabel(t))}</title><body style="font-family:sans-serif;padding:16px"><h2>Stock take — ${escHtml(stockTakeLabel(t))}</h2>${stockReportHtml(t)}</body>`);
};

window.exportStockCsv = function() {
  const t = currentStockTake(); if (!t) return;
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Category', 'Item', 'Opening', 'Added', 'Counted', 'Used', 'Cost each', 'Cost used', 'Minimum', 'Order at least']];
  (t.lines || []).filter(l => !_stockUsedOnly || (l.used || 0) !== 0).forEach(l => rows.push([l.category, l.name, l.opening, l.added, l.counted, l.used, l.costPrice, l.usedCost, l.minStock, l.reorder]));
  const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'stock-take-' + (t.eventName || 'event').replace(/[^\w-]+/g, '_') + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

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
