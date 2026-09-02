'use strict';

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

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'orders') loadOrders();
    if (btn.dataset.tab === 'tabs') loadShowTabs();
    if (btn.dataset.tab === 'pos') loadPosGrids();
    document.getElementById('mainMenuDropdown').style.display = 'none';
  });
});

window.toggleMainMenu = function(e) {
  e.stopPropagation();
  const menu = document.getElementById('mainMenuDropdown');
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
};

document.addEventListener('click', () => {
  const menu = document.getElementById('mainMenuDropdown');
  if (menu) menu.style.display = 'none';
});

// ── Show & Sessions ────────────────────────────────────────────────────────

const DEFAULT_SESSIONS = {
  before:   { name: 'Before Show', enabled: true },
  interval: { name: 'Interval',    enabled: true },
  after:    { name: 'After Show',  enabled: true },
};

let _shows = [];
let _selectedShowId = null;
let showDates = [];

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
        <button class="btn btn-secondary btn-sm" onclick="selectShow('${s.id}')">${s.id === _selectedShowId ? 'Editing' : 'Edit'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteShow('${s.id}')">Delete</button>
      </div>
    </div>`).join('') : '<p style="color:var(--text-muted);font-size:14px">No shows yet — add one to get started.</p>';
}

window.selectShow = function(id) {
  _selectedShowId = id;
  renderShowsList();
  renderShowEditor();
};

window.setCurrentShow = async function() {
  if (!_selectedShowId) return;
  try {
    const batch = db.batch();
    _shows.forEach(s => batch.update(db.collection('showdrinks_shows').doc(s.id), { isCurrent: s.id === _selectedShowId }));
    await batch.commit();
    _shows.forEach(s => { s.isCurrent = s.id === _selectedShowId; });
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
    renderShowsList();
    renderShowEditor();
    updateHeaderShowName();
    toast('Show deleted', 'info');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

document.getElementById('addShowBtn').addEventListener('click', async () => {
  const name = prompt('New show name:');
  if (!name || !name.trim()) return;
  try {
    const doc = {
      name: name.trim(),
      dates: [],
      isCurrent: _shows.length === 0,
      sessions: DEFAULT_SESSIONS,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('showdrinks_shows').add(doc);
    _shows.push({ id: ref.id, ...doc, isCurrent: doc.isCurrent });
    _selectedShowId = ref.id;
    renderShowsList();
    renderShowEditor();
    updateHeaderShowName();
    toast('Show added', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

document.getElementById('setCurrentShowBtn').addEventListener('click', setCurrentShow);
document.getElementById('deleteShowBtn').addEventListener('click', () => { if (_selectedShowId) deleteShow(_selectedShowId); });

function renderShowEditor() {
  const show = _shows.find(s => s.id === _selectedShowId);
  const wrap = document.getElementById('showEditorWrap');
  if (!show) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  document.getElementById('showName').value = show.name || '';
  showDates = show.dates || [];
  renderDates();

  const setCurBtn = document.getElementById('setCurrentShowBtn');
  setCurBtn.disabled = !!show.isCurrent;
  setCurBtn.textContent = show.isCurrent ? 'Current Show' : 'Set as Current';

  document.getElementById('showPaymentMode').value       = show.paymentMode || '';
  document.getElementById('showSumupMerchantCode').value = show.sumupMerchantCode || '';
  document.getElementById('showSumupApiKey').value        = show.sumupApiKey || '';

  const sessions = show.sessions || {};
  ['before','interval','after'].forEach(id => {
    const d = sessions[id] || DEFAULT_SESSIONS[id];
    document.getElementById(`${id}Name`).value = d.name || '';
    document.getElementById(`${id}Enabled`).value = d.enabled !== false ? 'true' : 'false';
  });
}

function renderDates() {
  const el = document.getElementById('datesList');
  el.innerHTML = showDates.length
    ? showDates.map(d => `
        <span class="date-chip">
          ${fmtDate(d)}
          <button onclick="removeDate('${d}')" title="Remove">×</button>
        </span>`).join('')
    : '<span style="color:var(--text-muted);font-size:13px">No dates added yet</span>';
}

window.removeDate = function(d) {
  showDates = showDates.filter(x => x !== d);
  renderDates();
};

document.getElementById('addDateBtn').addEventListener('click', () => {
  const val = document.getElementById('newDateInput').value;
  if (!val) return;
  if (showDates.includes(val)) { toast('Date already added', 'error'); return; }
  showDates.push(val);
  showDates.sort();
  renderDates();
  document.getElementById('newDateInput').value = '';
});

document.getElementById('saveShowBtn').addEventListener('click', async () => {
  if (!_selectedShowId) { toast('Add or select a show first', 'error'); return; }
  const name = document.getElementById('showName').value.trim();
  if (!name) { toast('Enter a show name', 'error'); return; }

  const sessions = {};
  ['before','interval','after'].forEach(id => {
    sessions[id] = {
      name: document.getElementById(`${id}Name`).value.trim(),
      enabled: document.getElementById(`${id}Enabled`).value === 'true',
    };
  });

  const paymentMode       = document.getElementById('showPaymentMode').value;
  const sumupMerchantCode = document.getElementById('showSumupMerchantCode').value.trim();
  const sumupApiKey       = document.getElementById('showSumupApiKey').value.trim();

  try {
    await db.collection('showdrinks_shows').doc(_selectedShowId).update({
      name, dates: showDates, sessions, paymentMode, sumupMerchantCode, sumupApiKey,
    });
    const show = _shows.find(s => s.id === _selectedShowId);
    if (show) { Object.assign(show, { name, dates: showDates, sessions, paymentMode, sumupMerchantCode, sumupApiKey }); }
    renderShowsList();
    updateHeaderShowName();
    populateDateFilter();
    toast('Show & sessions saved', 'success');
  } catch(e) {
    console.error(e);
    toast('Save failed – ' + e.message, 'error');
  }
});

// ── Menu Items ─────────────────────────────────────────────────────────────

let _allMenuItems        = [];
let _menuCategories      = [];
let _selectedMenuCat     = 'all';

async function loadMenuItems() {
  // Fetch all, sort client-side by category then name
  const snap = await db.collection('showdrinks_menuItems').get();
  _allMenuItems = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ca = (a.category || '').toLowerCase(), cb = (b.category || '').toLowerCase();
      if (ca !== cb) return ca < cb ? -1 : 1;
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
  if (!_menuCategories.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = ['all', ..._menuCategories].map(cat => `
    <button class="cat-filter-btn ${cat === _selectedMenuCat ? 'active' : ''}"
            onclick="setMenuCat('${escHtml(cat)}')">
      ${cat === 'all' ? 'All' : escHtml(cat)}
    </button>`).join('');
}

window.setMenuCat = function(cat) {
  _selectedMenuCat = cat;
  renderMenuCategoryBar();
  renderMenuTable();
};

function renderMenuTable() {
  const tbody = document.getElementById('menuTableBody');
  const items = _selectedMenuCat === 'all'
    ? _allMenuItems
    : _allMenuItems.filter(i => i.category === _selectedMenuCat);

  const defaultCat = _selectedMenuCat === 'all' ? '' : _selectedMenuCat;
  tbody.innerHTML = items.map(i => menuItemRow(i.id, i)).join('') + newItemRow(defaultCat);
}

function categorySelectHtml(selected, onchangeJs) {
  const opts = `<option value="">— none —</option>` +
    _menuCategories.map(c =>
      `<option value="${escHtml(c)}"${c === selected ? ' selected' : ''}>${escHtml(c)}</option>`
    ).join('') +
    `<option value="__new__">+ Add new category…</option>`;
  return `<select class="grid-input" onchange="${onchangeJs}">${opts}</select>`;
}

function menuItemRow(id, item) {
  const name  = escHtml(item.name || '');
  const price = Number(item.price || 0).toFixed(2);
  return `<tr id="mrow-${id}">
    <td>${categorySelectHtml(item.category || '', `handleCatChange('${id}',this)`)}</td>
    <td><input class="grid-input" value="${name}" placeholder="Item name"
               onblur="saveMenuField('${id}','name',this.value.trim())"></td>
    <td><input class="grid-input price-input" type="number" value="${price}" min="0" step="0.50"
               onblur="saveMenuField('${id}','price',parseFloat(this.value)||0)"></td>
    <td style="text-align:center">
      <button class="grid-del-btn" title="Delete" onclick="deleteMenuItem('${id}')">×</button>
    </td>
  </tr>`;
}

function newItemRow(defaultCat) {
  return `<tr id="newItemRow" class="new-item-row">
    <td>${categorySelectHtml(defaultCat, 'handleNewCatChange(this)')}</td>
    <td><input class="grid-input" id="newItemName" placeholder="New item name…"
               onblur="autoCreateItem(event)"></td>
    <td><input class="grid-input price-input" type="number" id="newItemPrice"
               placeholder="0.00" min="0" step="0.50" onblur="autoCreateItem(event)"></td>
    <td></td>
  </tr>`;
}

// Prompt for a new category name; update select and optionally save to a doc
function promptNewCategory(selectEl, afterCb) {
  const name = prompt('New category name:');
  if (!name || !name.trim()) { selectEl.value = ''; return; }
  const cat = name.trim();
  if (!_menuCategories.includes(cat)) { _menuCategories.push(cat); _menuCategories.sort(); }
  // Rebuild the select options in place
  selectEl.innerHTML = `<option value="">— none —</option>` +
    _menuCategories.map(c => `<option value="${escHtml(c)}"${c === cat ? ' selected' : ''}>${escHtml(c)}</option>`).join('') +
    `<option value="__new__">+ Add new category…</option>`;
  selectEl.value = cat;
  if (afterCb) afterCb(cat);
}

window.handleCatChange = async function(id, selectEl) {
  if (selectEl.value === '__new__') {
    promptNewCategory(selectEl, async cat => {
      await saveMenuField(id, 'category', cat);
      await loadMenuItems();
    });
  } else {
    await saveMenuField(id, 'category', selectEl.value);
    // If filtering by category and this item moved out, reload
    if (_selectedMenuCat !== 'all') await loadMenuItems();
  }
};

window.handleNewCatChange = function(selectEl) {
  if (selectEl.value === '__new__') promptNewCategory(selectEl, null);
};

window.autoCreateItem = async function(e) {
  if (e && e.relatedTarget && e.relatedTarget.closest('#newItemRow')) return;
  const nameEl  = document.getElementById('newItemName');
  const priceEl = document.getElementById('newItemPrice');
  const catSel  = document.querySelector('#newItemRow select');
  if (!nameEl) return;
  const name = nameEl.value.trim();
  if (!name) return;
  const cat   = (catSel?.value === '__new__' || !catSel?.value) ? '' : catSel.value;
  const price = parseFloat(priceEl?.value) || 0;
  try {
    await db.collection('showdrinks_menuItems').add({
      category: cat, name, price, available: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await loadMenuItems();
    document.getElementById('newItemName')?.focus();
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.saveMenuField = async function(id, field, value) {
  try {
    await db.collection('showdrinks_menuItems').doc(id).update({ [field]: value });
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
  }
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
          <button class="btn btn-danger btn-sm" onclick="deleteLocation('${d.id}')">Delete</button>
        </div>
      </div>`;
  }).join('');
}

document.getElementById('addLocationBtn').addEventListener('click', async () => {
  const name = document.getElementById('locationName').value.trim();
  if (!name) { toast('Enter a location name', 'error'); return; }
  try {
    await db.collection('showdrinks_locations').add({ name, active: true });
    document.getElementById('locationName').value = '';
    loadLocations();
    toast('Location added', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

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
  const priceGroup = document.getElementById('editPriceGroup');
  if (ctx.type === 'menuItem') {
    priceGroup.style.display = '';
    document.getElementById('editPrice').value = ctx.price || '';
  } else {
    priceGroup.style.display = 'none';
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
      await db.collection('showdrinks_locations').doc(_modalCtx.id).update({ name });
      loadLocations();
      closeModal();
    }
    toast('Saved', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
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

async function populateDateFilter() {
  const snap = await db.collection('showdrinks_shows').where('isCurrent', '==', true).limit(1).get();
  const dates = snap.empty ? [] : (snap.docs[0].data().dates || []);
  const sel = document.getElementById('filterDate');
  const current = sel.value;
  sel.innerHTML = '<option value="">All dates</option>' +
    dates.map(d => `<option value="${d}">${fmtDate(d)}</option>`).join('');
  if (current) sel.value = current;
}

async function loadOrders() {
  if (_ordersUnsubscribe) { _ordersUnsubscribe(); _ordersUnsubscribe = null; }
  await loadLocationsCache();
  await populateDateFilter();

  const date = document.getElementById('filterDate').value;
  const session = document.getElementById('filterSession').value;
  const status = document.getElementById('filterStatus').value;

  let query = db.collection('showdrinks_orders');
  if (date)    query = query.where('showDate',  '==', date);
  if (session) query = query.where('sessionId', '==', session);
  query = query.orderBy('createdAt', 'asc');

  _ordersUnsubscribe = query.onSnapshot(snap => {
    let orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (status === 'all') { /* no filter */ }
    else if (status === '') orders = orders.filter(o => o.prepStatus !== 'collected');
    else orders = orders.filter(o => o.prepStatus === status);
    renderOrders(orders);
  }, err => {
    console.error('Firestore orders error:', err);
    const msg = err.code === 'failed-precondition'
      ? 'Index still building — check browser console for the index creation link, or wait ~1 min and refresh'
      : 'Error loading orders: ' + err.message;
    toast(msg, 'error');
  });
}

function renderOrders(orders) {
  const container = document.getElementById('ordersContainer');
  const summary = document.getElementById('ordersSummary');

  const total = orders.length;
  const ready = orders.filter(o => o.prepStatus === 'ready').length;
  const pending = total - ready;
  const totalRevenue = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);

  summary.innerHTML = `
    <div class="summary-card"><div class="snum">${total}</div><div class="slabel">Total Orders</div></div>
    <div class="summary-card"><div class="snum" style="color:var(--warning)">${pending}</div><div class="slabel">Pending</div></div>
    <div class="summary-card"><div class="snum" style="color:var(--success)">${ready}</div><div class="slabel">Ready</div></div>
    <div class="summary-card"><div class="snum">${fmtCurrency(totalRevenue)}</div><div class="slabel">Revenue</div></div>`;

  if (!orders.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:14px">No orders found for this filter.</p>';
    return;
  }

  const locationOptions = _locations.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('');

  container.innerHTML = orders.map(o => {
    const isReady     = o.prepStatus === 'ready';
    const isCollected = o.prepStatus === 'collected';
    const sessionLabel = o.sessionName || o.sessionId || '';
    const statusBadge = isCollected ? '<span class="badge badge-primary">Collected</span>'
      : isReady ? '<span class="badge badge-success">Ready</span>'
      : '<span class="badge badge-warning">Pending</span>';
    const actionBtns = isCollected
      ? `<button class="btn btn-secondary btn-sm" onclick="markReady('${o.id}')">↩ Undo Collected</button>`
      : isReady
        ? `<button class="btn btn-primary btn-sm" onclick="markCollected('${o.id}')">✓ Collected</button>
           <button class="btn btn-secondary btn-sm" onclick="markPending('${o.id}')">↩ Pending</button>`
        : `<button class="btn btn-success btn-sm" onclick="markReady('${o.id}')">✓ Mark Ready</button>`;
    return `
      <div class="order-card ${isReady ? 'prepared' : ''} ${isCollected ? 'order-collected' : ''}" id="order-${o.id}">
        <div class="order-card-header">
          ${o.orderNumber ? `<span style="font-size:22px;font-weight:900;color:var(--primary);min-width:44px">#${o.orderNumber}</span>` : ''}
          <div class="order-customer">${escHtml(o.customerName)}</div>
          ${statusBadge}
          <span class="badge badge-primary">${escHtml(sessionLabel)}</span>
          <span style="font-size:12px;color:var(--text-muted)">${fmtDate(o.showDate)}</span>
          <div class="order-total">${fmtCurrency(o.totalAmount || 0)}</div>
        </div>
        <div class="order-items">
          ${(o.items || []).map(item => `
            <div class="order-item-row">
              <span class="qty">${item.quantity}×</span>
              <span class="iname">${escHtml(item.name)}</span>
              <span class="iprice">${fmtCurrency(item.price * item.quantity)}</span>
            </div>`).join('')}
        </div>
        <div class="order-card-footer">
          <select class="form-control" style="max-width:200px" id="loc-${o.id}" onchange="setOrderLocation('${o.id}',this.value)">
            <option value="">Set location…</option>
            ${locationOptions}
          </select>
          ${o.locationId ? `<span class="badge badge-primary">📍 ${escHtml(o.locationName || '')}</span>` : ''}
          ${actionBtns}
          <span style="font-size:12px;color:var(--text-muted);margin-left:auto">
            ${o.paymentMode === 'bar' ? '💵 Pay at bar' : '💳 Paid online'}
          </span>
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

window.markCollected = async function(id) {
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
document.getElementById('filterDate').addEventListener('change', loadOrders);
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
    document.getElementById('siteUrl').value = d.siteUrl || '';
    document.getElementById('sumupMerchantCode').value = d.sumupMerchantCode || '';
    document.getElementById('sumupApiKey').value = d.sumupApiKey || '';
    document.getElementById('paymentMode').value = d.paymentMode || 'bar';
    document.getElementById('emailTemplateSubject').value = d.emailTemplateSubject || DEFAULT_EMAIL_TEMPLATE_SUBJECT;
    document.getElementById('emailTemplateBody').value = d.emailTemplateBody || DEFAULT_EMAIL_TEMPLATE_BODY;
  } catch(e) {
    console.error(e);
  }
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const settings = {
    siteUrl: document.getElementById('siteUrl').value.trim(),
    sumupMerchantCode: document.getElementById('sumupMerchantCode').value.trim(),
    sumupApiKey: document.getElementById('sumupApiKey').value.trim(),
    paymentMode: document.getElementById('paymentMode').value,
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

document.getElementById('generateQrBtn').addEventListener('click', () => {
  const baseUrl = document.getElementById('siteUrl').value.trim() || window.location.origin + window.location.pathname.replace('admin.html', '');
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
  toast('QR code generated', 'success');
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
const POS_N = 18;

let _posGrids    = {};
let _posGridOrder = [];
let _posActiveId  = null;
let _posEditIdx   = null;
let _posCellColor = '';

function posEmptyGrid(name) {
  return { name, cells: Array(POS_N).fill(null).map(() =>
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
    </div>
    <div class="pos-admin-grid">
      ${cells.slice(0,12).map((cell,i) => posRenderAdminCell(cell,i)).join('')}
    </div>
    <div class="pos-admin-grid pos-admin-extra">
      ${cells.slice(12).map((cell,i) => posRenderAdminCell(cell,12+i)).join('')}
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

window.posOpenCell = function(idx) {
  const grid = _posGrids[_posActiveId]; if (!grid) return;
  _posEditIdx = idx;
  const cell = posNormCells(grid.cells)[idx];
  _posCellColor = cell.color || '';
  document.getElementById('posCellType').value = cell.type || 'empty';
  document.getElementById('posCellLabel').value = cell.label || '';
  document.getElementById('posCellItemSel').innerHTML =
    '<option value="">— select —</option>' +
    _allMenuItems.map(i => `<option value="${i.id}"${i.id===cell.menuItemId?' selected':''}>${escHtml(i.name)} ${fmtCurrency(i.price)}</option>`).join('');
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
  document.getElementById('posCellColors').innerHTML = POS_COLORS.map(c =>
    `<div onclick="posPickColor('${c}')" title="${c||'None'}"
          style="width:28px;height:28px;border-radius:6px;cursor:pointer;flex-shrink:0;
                 background:${c||'var(--surface)'};
                 border:2px solid ${c===_posCellColor?'var(--primary)':(c?c:'var(--border)')};
                 display:flex;align-items:center;justify-content:center">
       ${!c?'<span style="font-size:12px;color:var(--text-muted)">✕</span>':''}
     </div>`).join('');
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
      batch.set(db.collection('showdrinks_posGrids').doc(g.id), { name:g.name, cells:g.cells||[] });
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
    `<div class="pos-grid">${cells.slice(0,12).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${cells.slice(12).map((c,i) => cellBtn(c,12+i)).join('')}</div>`;
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
    _testStack = ['root']; posRenderTestGrid(); posRenderTestBasket();
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

window.selectTabsSubtab = function(name) {
  document.querySelectorAll('#tabSubNav .cat-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.subtab === name));
  document.getElementById('subtab-pos').style.display     = name === 'pos'     ? '' : 'none';
  document.getElementById('subtab-members').style.display = name === 'members' ? '' : 'none';
};

async function loadShowTabs() {
  if (!Object.keys(_posGrids).length) await loadPosGrids();
  await loadTabMembers();
  if (_tabOrdersUnsubscribe) { _tabOrdersUnsubscribe(); _tabOrdersUnsubscribe = null; }
  _tabOrdersUnsubscribe = db.collection('showdrinks_tabOrders').orderBy('createdAt', 'desc').onSnapshot(snap => {
    _tabOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTabMembersList();
  }, e => toast('Could not load tabs: ' + e.message, 'error'));
  renderTabGrid();
  renderTabBasket();
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
    _tabMembers.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
  sel.value = _tabSelectedMemberId || '';
}

window.selectTabMember = function(id) {
  _tabSelectedMemberId = id || null;
  _tabStack = ['root']; _tabBasket = {}; _tabSelectedKey = null;
  document.getElementById('tabMemberSelect').value = id || '';

  const posArea = document.getElementById('tabPosArea');
  const member = _tabMembers.find(m => m.id === _tabSelectedMemberId);
  if (member) {
    posArea.style.display = '';
    renderTabGrid();
    renderTabBasket();
    selectTabsSubtab('pos');
  } else {
    posArea.style.display = 'none';
  }
  renderTabMembersList();
};

document.getElementById('addTabMemberBtn').addEventListener('click', async () => {
  const input = document.getElementById('newTabMemberName');
  const emailInput = document.getElementById('newTabMemberEmail');
  const name = input.value.trim();
  const email = emailInput.value.trim();
  if (!name) { toast('Enter a member name', 'error'); return; }
  const dupe = _tabMembers.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (dupe) { selectTabMember(dupe.id); input.value = ''; emailInput.value = ''; return; }
  try {
    const ref = await db.collection('showdrinks_tabMembers').add({
      name, email, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    _tabMembers.push({ id: ref.id, name, email });
    _tabMembers.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    renderTabMemberSelect();
    selectTabMember(ref.id);
    input.value = ''; emailInput.value = '';
    toast('Member added', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
});

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
    return `<button class="pos-btn" style="${style}" onclick="handleTabPosBtn(${i})">
      <span class="pb-lbl">${escHtml(cell.label || '')}</span>
      ${price ? `<span class="pb-price">${price}</span>` : ''}
    </button>`;
  }
  el.innerHTML =
    `<div class="pos-grid">${cells.slice(0,12).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${cells.slice(12).map((c,i) => cellBtn(c,12+i)).join('')}</div>`;
}

function renderTabBasket() {
  const el = document.getElementById('tabBasket');
  if (!el) return;
  const items = Object.values(_tabBasket);
  if (!items.length) { el.innerHTML = '<span style="color:var(--text-muted)">No drinks added yet</span>'; return; }
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

window.handleTabPosBtn = function(idx) {
  const grid = _posGrids[_tabStack[_tabStack.length - 1]];
  if (!grid) return;
  const cell = posNormCells(grid.cells)[idx];
  if (!cell || cell.type === 'empty') return;
  if (cell.type === 'item') {
    const key = cell.label || cell.menuItemId;
    if (!_tabBasket[key]) _tabBasket[key] = { name: cell.label, price: cell.menuItemPrice || 0, qty: 0 };
    _tabBasket[key].qty += 1;
    _tabSelectedKey = key;
    _tabStack = ['root']; renderTabGrid(); renderTabBasket();
  } else if (cell.type === 'clear') {
    _tabBasket = {}; _tabSelectedKey = null; renderTabBasket();
  } else if (cell.type === 'plus') {
    if (!_tabSelectedKey || !_tabBasket[_tabSelectedKey]) { toast('Select an item first', 'error'); return; }
    _tabBasket[_tabSelectedKey].qty += 1; renderTabBasket();
  } else if (cell.type === 'minus') {
    if (!_tabSelectedKey || !_tabBasket[_tabSelectedKey]) { toast('Select an item first', 'error'); return; }
    _tabBasket[_tabSelectedKey].qty -= 1;
    if (_tabBasket[_tabSelectedKey].qty <= 0) { delete _tabBasket[_tabSelectedKey]; _tabSelectedKey = null; }
    renderTabBasket();
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

async function commitTabOrder() {
  if (!_tabSelectedMemberId) { toast('Select a member first', 'error'); return; }
  const items = Object.values(_tabBasket).map(i => ({ name: i.name, price: i.price, quantity: i.qty }));
  if (!items.length) { toast('Add at least one drink', 'error'); return; }
  const totalAmount = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const member = _tabMembers.find(m => m.id === _tabSelectedMemberId);
  try {
    await db.collection('showdrinks_tabOrders').add({
      memberId: _tabSelectedMemberId,
      memberName: member?.name || '',
      items, totalAmount, paid: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    _tabBasket = {}; _tabSelectedKey = null; _tabStack = ['root'];
    renderTabGrid(); renderTabBasket();
    toast('Added to tab', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

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

function renderTabMembersList() {
  const el = document.getElementById('tabMembersList');
  if (!_tabMembers.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">No tab members yet.</p>'; return; }

  el.innerHTML = _tabMembers.map(m => {
    const orders  = _tabOrders.filter(o => o.memberId === m.id);
    const total   = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
    const unpaid  = orders.filter(o => !o.paid).reduce((s, o) => s + (o.totalAmount || 0), 0);
    const expanded = _tabExpandedMemberId === m.id;
    const isActive = _tabSelectedMemberId === m.id;
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
        <button class="card-corner-btn" title="Delete" onclick="event.stopPropagation();deleteTabMember('${m.id}')">×</button>
        <div style="display:flex;align-items:center;gap:12px;width:100%;padding-right:24px">
          <span class="item-name">${escHtml(m.name)}</span>
          <span style="font-size:13px;color:var(--text-muted)">Total ${fmtCurrency(total)}</span>
          ${unpaid > 0
            ? `<span class="badge badge-warning">Owes ${fmtCurrency(unpaid)}</span>`
            : `<span class="badge badge-success">Settled</span>`}
        </div>
        <div style="font-size:12px;color:var(--text-muted)" onclick="event.stopPropagation();promptEditMemberEmail('${m.id}')">
          ${m.email ? `✉ ${escHtml(m.email)}` : '+ Add email'}
        </div>
        <div class="item-actions" onclick="event.stopPropagation()">
          <button class="btn btn-secondary btn-sm" onclick="toggleTabMemberOrders('${m.id}')">${expanded ? 'Hide' : 'View'} Orders</button>
          ${unpaid > 0 ? `<button class="btn btn-primary btn-sm" onclick="markMemberPaid('${m.id}')">Mark Paid</button>` : ''}
          ${m.email ? `<button class="btn btn-secondary btn-sm" onclick="sendMemberEmail('${m.id}')">✉ Email</button>` : ''}
        </div>
        ${ordersHtml}
      </div>`;
  }).join('');
}

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

window.promptEditMemberEmail = async function(id) {
  const member = _tabMembers.find(m => m.id === id);
  if (!member) return;
  const email = prompt(`Email address for ${member.name}:`, member.email || '');
  if (email === null) return;
  try {
    await db.collection('showdrinks_tabMembers').doc(id).update({ email: email.trim() });
    member.email = email.trim();
    renderTabMembersList();
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

  document.getElementById('tabsMenuDropdown').style.display = 'none';
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
  const menu = document.getElementById('tabsMenuDropdown');
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
};

document.addEventListener('click', () => {
  const menu = document.getElementById('tabsMenuDropdown');
  if (menu) menu.style.display = 'none';
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

// Shared login (shared/auth.js): the same users/{uid} doc used by every app in showmanager.
// isManager or access.showdrinksAdmin gets in; anyone else signed in but lacking that flag is
// bounced back out with an explanation rather than landing on a blank admin screen.
firebase.auth().onAuthStateChanged(async user => {
  const loginScreen = document.getElementById('loginScreen');
  const adminApp = document.getElementById('adminApp');
  const errEl = document.getElementById('loginError');
  if (user) {
    const allowed = await checkAccess(user.uid, 'showdrinksAdmin').catch(() => null);
    if (!allowed) {
      await firebase.auth().signOut();
      errEl.textContent = 'This account does not have ShowDrinks admin access — ask a manager to grant it from the showmanager portal.';
      errEl.style.display = '';
      document.getElementById('authGate').style.display = 'none';
      return;
    }
    mountSuiteNav(allowed, 'showdrinksAdmin', '../');
    loginScreen.style.display = 'none';
    adminApp.style.display = '';
    document.getElementById('authGate').style.display = 'none';
    if (!_appInitialized) { _appInitialized = true; init(); }
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
    await Promise.all([loadShows(), loadMenuItems(), loadLocations(), loadSettings()]);
  } catch(e) {
    document.getElementById('headerShowName').textContent = 'Firebase not configured';
    toast('Firebase not configured – edit firebase-config.js', 'error');
  }
}
