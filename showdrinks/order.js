'use strict';

// SumUp checkout creation/verification both have to happen server-side (the merchant's API key
// can never reach this unauthenticated public page) — see functions/index.js's
// createSumupCheckout/verifySumupPayment.
const createSumupCheckoutFn = firebase.app().functions('europe-west1').httpsCallable('createSumupCheckout');
const verifySumupPaymentFn  = firebase.app().functions('europe-west1').httpsCallable('verifySumupPayment');

// ── localStorage ───────────────────────────────────────────────────────────

const LS_NAME           = 'showdrinks_name';
const LS_ORDERS         = 'showdrinks_orders';
const LS_SHOW_ALL_ORDERS = 'showdrinks_showAllOrders';

function getSavedName()  { return localStorage.getItem(LS_NAME) || ''; }
function saveName(n)     { localStorage.setItem(LS_NAME, n); }

function getShowAllOrders()   { return localStorage.getItem(LS_SHOW_ALL_ORDERS) === '1'; }
function saveShowAllOrders(v) { localStorage.setItem(LS_SHOW_ALL_ORDERS, v ? '1' : '0'); }

function getSavedOrders() {
  try { return JSON.parse(localStorage.getItem(LS_ORDERS) || '[]'); } catch { return []; }
}
function saveOrderLocally(o) {
  const list = getSavedOrders().filter(x => x.id !== o.id);
  list.unshift({ id: o.id, orderNumber: o.orderNumber || null, customerName: o.customerName,
                 showDate: o.showDate, sessionName: o.sessionName, totalAmount: o.totalAmount });
  localStorage.setItem(LS_ORDERS, JSON.stringify(list.slice(0, 30)));
}

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  step: 0,
  customerName: '',
  showDate: '', sessionId: '', sessionName: '',
  basket: {},          // name → { name, price, quantity }
  selectedCategory: null,
  orderId: null, orderNumber: null,
  editingOrderId: null, editingOrderStatus: null, editingOrderNumber: null, editingOrderPaymentStatus: null,
  currentStatusOrderId: null,
  showConfig: null, sessions: null, menuItems: [], settings: null,
  statusUnsubscribe: null,
  homeOrderUnsubscribes: [],
  posGrids: {}, posGridStack: [],
  selectedBasketKey: null,
};

// ── Utilities ──────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-msg ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const mn = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${mn[parseInt(m)]} ${y}`;
}

function fmtCurrency(n) { return '£' + Number(n).toFixed(2); }

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// One overall status made of two independent fields: an order can't be Ready/Collected until
// it's paid. A pay-at-bar order stays "Unpaid" until admin.js's Mark Paid; a SumUp order stays
// "Unpaid" until verifySumupPaymentFn (called on the redirect-back from checkout) confirms the
// REAL status with SumUp and marks it — never assumed paid just because the customer's browser
// came back.
function orderStage(o) {
  if (o.prepStatus === 'collected') return 'collected';
  if (o.prepStatus === 'ready') return 'ready';
  if (o.paymentStatus !== 'paid') return 'unpaid';
  return 'paid';
}
const ORDER_STAGE_LABEL = { unpaid: 'Unpaid', paid: 'Paid', ready: 'Ready', collected: 'Collected' };
const ORDER_STAGE_BADGE = { unpaid: 'badge-danger', paid: 'badge-warning', ready: 'badge-success', collected: 'badge-primary' };

function basketTotal() {
  return Object.values(state.basket).reduce((s, i) => s + i.price * i.quantity, 0);
}
function basketCount() {
  return Object.values(state.basket).reduce((s, i) => s + i.quantity, 0);
}

// Ordering screen has two interchangeable layouts, picked in Admin → Settings & QR: the
// staff-configured POS button grid (default), or a plain list of every item grouped by category.
function isPosMode() { return (state.settings && state.settings.orderingMode) !== 'list'; }

// ── Navigation ─────────────────────────────────────────────────────────────

const body = document.querySelector('.pwa-body');

function goTo(step) {
  document.getElementById('screen' + state.step).classList.remove('active');
  state.step = step;
  document.getElementById('screen' + step).classList.add('active');
  // Compact hero on all non-home screens
  body.classList.toggle('sub-screen', step !== 0);
  body.classList.toggle('pos-screen', step === 1 && isPosMode());
  body.classList.toggle('list-screen', step === 1 && !isPosMode());
  updateBottomBar();
  window.scrollTo(0, 0);
}

function updateBottomBar() {
  const bar  = document.getElementById('bottomBar');
  const next = document.getElementById('nextBtn');
  const back = document.getElementById('backBtn');
  if (state.step === 0 || state.step === 3) { bar.style.display = 'none'; return; }
  if (state.step === 2) {
    bar.style.display = 'flex';
    if (state.editingOrderId) {
      back.textContent = '← Close';
      next.style.display = '';
      next.textContent = 'Order Status →';
      next.disabled = false;
    } else {
      back.textContent = '← Amend';
      next.style.display = 'none';
    }
    return;
  }
  if (state.step === 1 && !state.editingOrderId) {
    // POS grid mode: its own "Finish" cell drives navigation, so the bottom bar stays hidden.
    if (isPosMode()) { bar.style.display = 'none'; return; }
    // List mode: the basket total/trolley live in the header instead (see updateHeroBasket) and
    // the trolley is how you get to Review, so the bottom bar here is just Cancel.
    bar.style.display = 'flex';
    next.style.display = 'none';
    back.textContent = '← Cancel';
    return;
  }
  next.style.display = '';
  bar.style.display = 'flex';
  if (state.step === 1) {
    back.textContent = '← Cancel';
    const isEditable = state.editingOrderStatus === 'pending';
    next.textContent = isEditable ? 'Save Changes' : 'View Status →';
    next.disabled = false;
  } else {
    back.textContent = '← Back';
    next.textContent = 'Next →';
    next.disabled = false;
  }
}

document.getElementById('backBtn').addEventListener('click', () => {
  if (state.step === 1 && state.posGridStack.length > 1) {
    state.posGridStack.pop(); renderPosGrid(); return;
  }
  if (state.step === 2 && state.editingOrderId) {
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null;
    state.basket = {};
    goTo(0); renderHomeScreen();
  } else if (state.step === 1 && state.editingOrderId) {
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null;
    state.basket = {};
    goTo(0); renderHomeScreen();
  } else if (state.step > 0) {
    goTo(state.step - 1);
  }
});

document.getElementById('nextBtn').addEventListener('click', async () => {
  if (state.step === 2 && state.editingOrderId) {
    goTo(3); subscribeToOrderStatus(state.editingOrderId); return;
  }
  if (state.step === 1 && state.editingOrderId) {
    // Reaching step 1 (POS grid / category list) with a new, non-editing order never shows this
    // button — POS uses its grid's own "Finish" cell and list mode uses the header trolley
    // (goToListBasket) instead, both going straight to Review themselves.
    if (state.editingOrderStatus !== 'pending') {
      goTo(3); subscribeToOrderStatus(state.editingOrderId);
    } else {
      await saveOrderEdits();
    }
  }
});

// ── Screen 0: Home ─────────────────────────────────────────────────────────

function getAvailableSessions() {
  const sessions = state.sessions || {};
  return ['before','interval','after'].map(id => {
    const s = sessions[id] || {};
    if (!s.enabled) return null;
    return { id, name: s.name || id };
  }).filter(Boolean);
}

function sessionButtonsHtml() {
  const items = getAvailableSessions();
  if (!items.length) return '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">No sessions available.</p>';
  return '<div class="session-btn-grid">' + items.map(s => `
    <button class="selector-btn" onclick="startSessionOrder('${s.id}','${escHtml(s.name)}')">
      ${escHtml(s.name)}
    </button>`).join('') + '</div>';
}

async function renderHomeScreen() {
  const homeContent = document.getElementById('homeContent');
  const savedName   = getSavedName();

  // Stop watching whatever orders a previous render was subscribed to — renderHomeScreen() runs
  // again every time you land back here, so without this each visit would pile up another set
  // of listeners on top of the last.
  state.homeOrderUnsubscribes.forEach(unsub => unsub());
  state.homeOrderUnsubscribes = [];

  if (!savedName) { renderNameForm(homeContent); return; }

  state.customerName = savedName;
  const allSaved = getSavedOrders();

  const sessionBtnsHtml = sessionButtonsHtml();

  homeContent.innerHTML = buildWelcomeCard(savedName) + sessionBtnsHtml +
    '<div id="ordersListSection" style="text-align:center;padding:12px 0;color:var(--text-muted);font-size:13px">Loading orders…</div>';

  // Attached once, to this render's own #ordersListSection element — renderOrdersList() below
  // only ever replaces that element's children, never the element itself, so this keeps working
  // across every re-render it triggers (a fresh listener on a fresh element next visit here).
  document.getElementById('ordersListSection').addEventListener('change', (e) => {
    if (e.target.id !== 'showAllOrdersToggle') return;
    saveShowAllOrders(e.target.checked);
    renderOrdersList();
  });

  // Keyed by order id so each onSnapshot below can update just its own order in place, then
  // re-render the whole (short) list — simplest way to keep it sorted/consistent.
  const byId = {};

  function renderOrdersList() {
    const section = document.getElementById('ordersListSection');
    if (!section) return; // navigated off the home screen since this fired
    if (!allSaved.length) {
      section.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">No orders yet.</p>';
      return;
    }
    const showAll = getShowAllOrders();
    const enriched = allSaved.map(o => byId[o.id]).filter(Boolean)
      .filter(o => showAll || o.prepStatus !== 'collected')
      .sort((a, b) => (b.orderNumber || 0) - (a.orderNumber || 0));
    const header = `<div class="section-label" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <span>Your orders</span>
      <label class="switch-label">
        <input type="checkbox" id="showAllOrdersToggle" ${showAll ? 'checked' : ''}>
        <span class="switch"></span>
        <span>All</span>
      </label>
    </div>`;
    section.innerHTML = header + (enriched.length
      ? enriched.map(orderCard).join('')
      : showAll ? `<p style="font-size:13px;color:var(--text-muted)">No orders yet.</p>` : '');
  }

  const docs = await Promise.all(
    allSaved.map(o => db.collection('showdrinks_orders').doc(o.id).get().catch(() => null))
  );
  docs.forEach((doc, i) => {
    if (doc && doc.exists) byId[doc.id] = { ...allSaved[i], ...doc.data(), id: doc.id };
  });
  renderOrdersList();

  // Live-update from here on — e.g. when the bar marks an order ready — without needing a
  // manual page refresh. This is exactly the screen someone waiting on a drink is looking at.
  allSaved.forEach(o => {
    const unsub = db.collection('showdrinks_orders').doc(o.id).onSnapshot(snap => {
      if (!snap.exists) return;
      byId[o.id] = { ...o, ...snap.data(), id: o.id };
      renderOrdersList();
    }, () => {}); // permission/offline errors here just mean this one order stops updating live
    state.homeOrderUnsubscribes.push(unsub);
  });
}

function buildWelcomeCard(name) {
  return `<div class="welcome-card">
    <span class="wc-emoji">👋</span>
    <div class="wc-name">Hi, ${escHtml(name)}!</div>
    <button class="btn btn-secondary btn-sm" onclick="changeName()">Not you?</button>
  </div>`;
}

function orderCard(o) {
  const isReady     = o.prepStatus === 'ready';
  const isCollected = o.prepStatus === 'collected';
  const numLabel = o.orderNumber ? `<span style="font-weight:900;color:var(--primary)">#${o.orderNumber}</span> · ` : '';

  // Ready orders expand right here — no need to tap through to the status screen just to see
  // where to collect from and confirm collection.
  if (isReady) {
    const readyLine = o.locationName ? `Ready to collect from <strong>${escHtml(o.locationName)}</strong>` : 'Ready to collect';
    return `<div class="past-order-card ready ready-expanded">
      <div class="past-order-info" onclick="viewOrder('${o.id}')">
        <div class="poi-session">${numLabel}${escHtml(o.sessionName || '')}</div>
        <div class="poi-total">${fmtCurrency(o.totalAmount)}</div>
      </div>
      <div class="poi-ready-line">${readyLine}</div>
      <button class="btn btn-success btn-full" onclick="collectOrderInline('${o.id}')">✓ I've collected my drinks</button>
    </div>`;
  }

  const stage = orderStage(o);
  const statusLabel = ORDER_STAGE_LABEL[stage];
  const badgeCls = ORDER_STAGE_BADGE[stage];
  return `<div class="past-order-card ${isCollected ? 'collected' : ''}"
              onclick="viewOrder('${o.id}')">
    <div class="past-order-info">
      <div class="poi-session">${numLabel}${escHtml(o.sessionName || '')}</div>
      <div class="poi-detail">${fmtDate(o.showDate)}</div>
    </div>
    <div class="poi-right">
      <span class="badge ${badgeCls}">${statusLabel}</span>
      <div class="poi-total">${fmtCurrency(o.totalAmount)}</div>
    </div>
  </div>`;
}

function renderNameForm(container) {
  container.innerHTML = `
    <div class="name-input-wrap">
      <div style="text-align:center;margin-bottom:20px">
        <div class="pwa-section-title">Welcome!</div>
        <p style="color:var(--text-muted);font-size:14px;margin-top:4px">Enter your name to get started.</p>
      </div>
      <div class="form-group">
        <label for="customerName">Your Name</label>
        <input type="text" id="customerName" class="form-control big-input"
               placeholder="First &amp; last name" autocomplete="name" autocapitalize="words">
      </div>
      <button class="btn btn-primary btn-full btn-lg"
              style="height:52px;border-radius:12px;margin-top:8px"
              onclick="submitName()">Continue →</button>
    </div>`;
  setTimeout(() => {
    const el = document.getElementById('customerName');
    if (el) { el.focus(); el.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); }); }
  }, 0);
}

// Global onclick handlers ──────────────────────────────────────────────────

window.submitName = function() {
  const input = document.getElementById('customerName');
  const name  = input ? input.value.trim() : '';
  if (!name) { toast('Please enter your name', 'error'); return; }
  state.customerName = name;
  saveName(name);
  renderHomeScreen();
};

window.changeName = function() {
  localStorage.removeItem(LS_NAME); state.customerName = ''; renderHomeScreen();
};

window.startSessionOrder = function(id, name) {
  state.showDate = today(); state.sessionId = id; state.sessionName = name; state.basket = {};
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null;
  state.selectedCategory = null;
  goTo(1); renderMenu();
};

window.viewOrder = async function(orderId) {
  try {
    const doc = await db.collection('showdrinks_orders').doc(orderId).get();
    if (!doc.exists) { toast('Order not found', 'error'); return; }
    const order = { id: doc.id, ...doc.data() };
    state.currentStatusOrderId = orderId;
    // Load order into the edit/view screen (screen 2)
    state.editingOrderId            = orderId;
    state.editingOrderStatus        = order.prepStatus;
    state.editingOrderNumber        = order.orderNumber || null;
    state.editingOrderPaymentStatus = order.paymentStatus;
    state.showDate    = order.showDate;
    state.sessionId   = order.sessionId;
    state.sessionName = order.sessionName;
    // Build basket from saved items (key = item name)
    state.basket = {};
    (order.items || []).forEach(item => {
      state.basket[item.name] = { name: item.name, price: item.price, quantity: item.quantity };
    });
    state.selectedCategory = null;
    goTo(2); renderReview();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
};

// ── Screen 1: Order / Edit ─────────────────────────────────────────────────

function renderMenu() {
  const statusTag = state.editingOrderId
    ? ` · ${state.editingOrderStatus === 'ready' ? '✅ Ready' : state.editingOrderStatus === 'collected' ? '🎉 Collected' : 'Pending'}`
    : '';
  const numTag = state.editingOrderNumber ? `#${state.editingOrderNumber} · ` : '';
  document.title = `${numTag}${state.sessionName}${statusTag}`;
  const posGridEl = document.getElementById('posGrid');
  const listMenuEl = document.getElementById('listMenu');
  const listCatBarEl = document.getElementById('listCatBar');
  if (isPosMode()) {
    listMenuEl.style.display = 'none';
    listCatBarEl.style.display = 'none';
    posGridEl.style.display = '';
    state.posGridStack = ['root'];
    renderPosGrid();
  } else {
    posGridEl.style.display = 'none';
    listMenuEl.style.display = '';
    renderListMenu();
  }
  renderOrderGrid();
}

function posIsLight(hex) {
  if (!hex || hex.length < 4) return true;
  const h = hex.length === 4 ? '#'+hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3] : hex;
  const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
  return (r*299+g*587+b*114)/1000 > 128;
}

// Missing field (item created before this existed) defaults to true — shows everywhere. Also
// reads the old three-way 'visibility' field (both/bar/customer) this replaced, so items set to
// bar/customer-only under that short-lived scheme keep their setting. admin.js's Bar Tabs
// POS/List has its own mirror-image itemShowsOnTab() (order.js is a separate script).
function itemShowsOnPos(item) {
  if (!item) return true;
  if (item.showOnPos !== undefined) return item.showOnPos !== false;
  if (item.visibility) return item.visibility !== 'bar';
  return true;
}

function renderPosGrid() {
  const gridId = state.posGridStack[state.posGridStack.length - 1];
  const grid = state.posGrids[gridId];
  const el = document.getElementById('posGrid');
  if (!el) return;
  if (!grid) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:12px">POS layout not set up yet — configure it in Admin → POS Layout.</p>';
    return;
  }
  const all = (grid.cells || []).slice(0, 18);
  while (all.length < 18) all.push({ type: 'empty' });
  function cellBtn(cell, i) {
    if (!cell || cell.type === 'empty') return `<button class="pos-btn empty" disabled></button>`;
    const style = cell.color
      ? `background:${cell.color};color:${posIsLight(cell.color)?'#1e293b':'#fff'};border-color:${cell.color};` : '';
    const price = cell.type === 'item' && cell.menuItemPrice ? fmtCurrency(cell.menuItemPrice) : '';
    const menuItem = cell.type === 'item' ? state.menuItems.find(mi => mi.id === cell.menuItemId) : null;
    // Off-sale (or, same treatment, bar-only): dimmed and untappable, but still shown (a
    // staff-placed grid button shouldn't just vanish — the layout itself is meaningful/memorised,
    // and this same layout is shared with the admin's Bar Tabs POS grid).
    const offSale = !!(menuItem && (menuItem.onSale === false || !itemShowsOnPos(menuItem)));
    const hasQty = !!(menuItem && !offSale && state.basket[menuItem.name]?.quantity > 0);
    // Finish: disabled rather than tappable-then-errored when there's nothing in the basket yet.
    const finishDisabled = cell.type === 'finish' && basketCount() === 0;
    const disabled = offSale || finishDisabled;
    return `<button class="pos-btn${hasQty ? ' has-qty' : ''}${disabled ? ' unavailable' : ''}" style="${style}" data-idx="${i}" ${disabled ? 'disabled' : ''}>
      <span class="pb-lbl">${escHtml(cell.label || '')}</span>
      ${price ? `<span class="pb-price">${price}</span>` : ''}
    </button>`;
  }
  el.innerHTML =
    `<div class="pos-grid">${all.slice(0,12).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${all.slice(12).map((c,i) => cellBtn(c,12+i)).join('')}</div>`;
}

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

window.handlePosBtn = function(idx, isLongPress) {
  const gridId = state.posGridStack[state.posGridStack.length - 1];
  const grid = state.posGrids[gridId];
  if (!grid) return;
  const cell = (grid.cells || [])[idx];
  if (!cell || cell.type === 'empty') return;
  if (cell.type === 'item') {
    const menuItem = state.menuItems.find(i => i.id === cell.menuItemId);
    if (!menuItem || menuItem.onSale === false || !itemShowsOnPos(menuItem)) return; // shouldn't be reachable — button is disabled — but no error pill either way
    const key = menuItem.name;
    if (!state.basket[key]) state.basket[key] = { name: menuItem.name, price: menuItem.price, quantity: 0 };
    state.basket[key].quantity += 1;
    state.selectedBasketKey = key;
    // Long press: stay on this grid (adding several from the same category in a row). A normal
    // tap still jumps back to the root menu, same as before.
    if (!isLongPress) state.posGridStack = ['root'];
    renderPosGrid();
    renderOrderGrid();
    updateBottomBar();
  } else if (cell.type === 'clear') {
    if (!confirm('Clear all items?')) return;
    state.basket = {}; state.selectedBasketKey = null;
    renderPosGrid(); renderOrderGrid(); updateBottomBar();
  } else if (cell.type === 'plus') {
    const key = state.selectedBasketKey;
    if (!key || !state.basket[key]) return;
    state.basket[key].quantity += 1;
    renderPosGrid(); renderOrderGrid(); updateBottomBar();
  } else if (cell.type === 'minus') {
    const key = state.selectedBasketKey;
    if (!key || !state.basket[key]) return;
    state.basket[key].quantity -= 1;
    if (state.basket[key].quantity <= 0) { delete state.basket[key]; state.selectedBasketKey = null; }
    renderPosGrid(); renderOrderGrid(); updateBottomBar();
  } else if (cell.type === 'grid') {
    if (cell.targetGridId && state.posGrids[cell.targetGridId]) {
      state.posGridStack.push(cell.targetGridId);
      renderPosGrid();
    }
  } else if (cell.type === 'back') {
    if (state.posGridStack.length > 1) {
      state.posGridStack.pop(); renderPosGrid();
    } else {
      goTo(0); renderHomeScreen();
    }
  } else if (cell.type === 'finish') {
    if (basketCount() === 0) return; // shouldn't be reachable — button is disabled — but no error pill either way
    goTo(2); renderReview();
  }
};

// #posGrid is a static container (never itself replaced, only its children on each render), so
// this delegation is wired once here rather than re-attached on every renderPosGrid() call.
wirePosLongPress(document.getElementById('posGrid'), handlePosBtn);

function renderOrderGrid() {
  const pane  = document.getElementById('orderGridPane');

  // List mode already shows each item with its own +/- stepper, so this itemized pane would just
  // repeat that — its job (running total + a way to reach Review) lives in the header instead.
  if (!isPosMode()) {
    pane.style.display = 'none';
    updateHeroBasket();
    return;
  }
  pane.style.display = '';

  const entries = Object.entries(state.basket);

  if (!entries.length) {
    state.selectedBasketKey = null;
    pane.innerHTML = '<div class="og-empty">Your order is empty — tap items below to add</div>';
    return;
  }

  pane.innerHTML = `<div class="og-rows">` +
    entries.map(([key, i]) => {
      const enc = encodeURIComponent(key);
      const sel = key === state.selectedBasketKey;
      return `<div class="og-row ${sel ? 'selected' : ''}" onclick="selectBasketItem('${enc}')">
        <span class="og-qty">${i.quantity}×</span>
        <span>${escHtml(i.name)}</span>
        <span class="og-price">${fmtCurrency(i.price * i.quantity)}</span>
        <button class="og-trash" onclick="event.stopPropagation();removeFromBasket('${enc}')" title="Remove">🗑</button>
      </div>`;
    }).join('') +
    `</div>
     <div class="og-total"><span>Total</span><span>${fmtCurrency(basketTotal())}</span></div>`;
}

window.selectBasketItem = function(encodedKey) {
  state.selectedBasketKey = decodeURIComponent(encodedKey);
  renderOrderGrid();
};

// List mode's basket lives in the header: running total centered, trolley top-right. The trolley
// is the only way to reach Review in this mode (the bottom bar there is just Cancel).
function updateHeroBasket() {
  const totalEl = document.getElementById('heroBasketTotal');
  if (!totalEl) return;
  totalEl.textContent = fmtCurrency(basketTotal());
  const btn = document.getElementById('heroBasketBtn');
  if (btn) btn.disabled = basketCount() === 0;
}

window.goToListBasket = function() {
  if (basketCount() === 0) return; // shouldn't be reachable — button is disabled — but no error pill either way
  goTo(2); renderReview();
};

// ── Screen 1: Category List mode (alternate to the POS grid) ────────────────
// Every menu item, grouped under its category heading, with a price and a +/- stepper — no POS
// layout to configure, just whatever's in the Price List.

function renderListMenu() {
  const el = document.getElementById('listMenu');
  const barEl = document.getElementById('listCatBar');
  if (!el) return;
  const onSaleItems = state.menuItems.filter(item => item.onSale !== false && itemShowsOnPos(item));
  if (!onSaleItems.length) {
    barEl.style.display = 'none';
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:12px">No menu items yet.</p>';
    return;
  }
  const groups = {};
  const catOrder = [];
  onSaleItems
    .slice()
    .sort((a, b) => {
      const ca = (a.category || '').toLowerCase(), cb = (b.category || '').toLowerCase();
      if (ca !== cb) return ca < cb ? -1 : 1;
      // A name that doesn't start with a letter/digit (e.g. "*Chef's Special") sorts after every
      // plain-named item in its category instead of wherever punctuation happens to fall in
      // character-code order (usually first) — admin.js has its own copy of this same check
      // (startsWithSpecialChar), separate scripts so nothing to share it through.
      const aSpecial = !/^[a-z0-9]/i.test(a.name || ''), bSpecial = !/^[a-z0-9]/i.test(b.name || '');
      if (aSpecial !== bSpecial) return aSpecial ? 1 : -1;
      return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
    })
    .forEach(item => {
      const cat = item.category || 'Other';
      if (!groups[cat]) { groups[cat] = []; catOrder.push(cat); }
      groups[cat].push(item);
    });

  // No "All" chip, and nothing shown until a category is tapped — every pill fits on screen at
  // once now (see #listCatBar's flex-wrap:wrap in style.css), so there's no need for an
  // "everything at once" fallback the way a horizontally-scrolling bar needed one.
  // An extra ORDER_CHIP pill appears once there's something in the basket, showing whatever's in
  // it with a +/− stepper and a delete — same list, just reusing the pill-per-view pattern instead
  // of a separate screen for "what have I actually got so far".
  const hasOrder = basketCount() > 0;
  const validSelections = hasOrder ? [...catOrder, ORDER_CHIP] : catOrder;
  const selected = state.selectedCategory && validSelections.includes(state.selectedCategory)
    ? state.selectedCategory : null;
  state.selectedCategory = selected;

  barEl.style.display = (catOrder.length || hasOrder) ? 'flex' : 'none';
  barEl.innerHTML =
    catOrder.map(cat => `
    <button type="button" class="cat-btn ${cat === selected ? 'active' : ''}"
            onclick="selectListCat('${encodeURIComponent(cat)}')">${escHtml(cat)}</button>`).join('') +
    (hasOrder ? `<button type="button" class="cat-btn order-chip ${selected === ORDER_CHIP ? 'active' : ''}"
            onclick="selectListCat('${encodeURIComponent(ORDER_CHIP)}')">Order (${basketCount()})</button>` : '');

  if (selected === ORDER_CHIP) {
    el.innerHTML = basketListHtml();
    return;
  }
  el.innerHTML = selected
    ? `<div class="section-label">${escHtml(selected)}</div>
       <div class="menu-grid">${groups[selected].map(listMenuItemHtml).join('')}</div>`
    : '<p style="color:var(--text-muted);font-size:13px;padding:12px">Choose a category above.</p>';
}

// Sentinel selectedCategory value for the Order chip above — distinct from any real category name
// (menu categories are free-text, but none of them can equal this).
const ORDER_CHIP = '__order__';

// The Order chip's own view: every basket line with a full +/− stepper and a delete, unlike the
// category cards above (tap-to-add, trash-to-clear-to-zero) — this is the one place you can walk
// a quantity down one at a time instead of clearing it outright.
function basketListHtml() {
  const entries = Object.entries(state.basket);
  if (!entries.length) {
    return '<p style="color:var(--text-muted);font-size:13px;padding:12px">Your order is empty.</p>';
  }
  const rows = entries.map(([key, i]) => `
    <div class="menu-item-card has-qty">
      <span class="mic-name">${escHtml(i.name)}</span>
      <span class="mic-price">${fmtCurrency(i.price * i.quantity)}</span>
      <div class="qty-control">
        <button onclick="listDecBasketItem('${encodeURIComponent(key)}')" title="Remove one">−</button>
        <span class="qty-num">${i.quantity}</span>
        <button onclick="listIncBasketItem('${encodeURIComponent(key)}')" title="Add one">+</button>
        <button class="qty-danger" onclick="removeFromBasket('${encodeURIComponent(key)}')" title="Delete">🗑</button>
      </div>
    </div>`).join('');
  return `<div class="section-label">Order</div>
    <div class="menu-grid">${rows}</div>
    <div class="order-total-line"><span>Total</span><span>${fmtCurrency(basketTotal())}</span></div>`;
}

window.listIncBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!state.basket[key]) return;
  state.basket[key].quantity += 1;
  renderListMenu();
  renderOrderGrid();
  updateBottomBar();
};

window.listDecBasketItem = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!state.basket[key]) return;
  state.basket[key].quantity -= 1;
  if (state.basket[key].quantity <= 0) delete state.basket[key];
  renderListMenu();
  renderOrderGrid();
  updateBottomBar();
};

window.selectListCat = function(encodedCat) {
  state.selectedCategory = decodeURIComponent(encodedCat);
  renderListMenu();
  document.querySelector('.pwa-content')?.scrollTo({ top: 0, behavior: 'smooth' });
};

// Tap the card to add one; once it holds any, a delete button clears it back to 0 rather than
// stepping down one at a time — there's no separate +/− pair.
function listMenuItemHtml(item) {
  const qty = state.basket[item.name]?.quantity || 0;
  return `<div class="menu-item-card${qty > 0 ? ' has-qty' : ''}" onclick="listIncItem('${item.id}')">
    <span class="mic-name">${escHtml(item.name)}</span>
    <span class="mic-price">${fmtCurrency(item.price)}</span>
    ${qty > 0 ? `<div class="qty-control">
      <span class="qty-num">${qty}×</span>
      <button onclick="event.stopPropagation();removeFromBasket('${encodeURIComponent(item.name)}')" title="Remove">🗑</button>
    </div>` : ''}
  </div>`;
}

window.listIncItem = function(menuItemId) {
  const item = state.menuItems.find(i => i.id === menuItemId);
  if (!item) return;
  const key = item.name;
  if (!state.basket[key]) state.basket[key] = { name: item.name, price: item.price, quantity: 0 };
  state.basket[key].quantity += 1;
  renderListMenu();
  renderOrderGrid();
  updateBottomBar();
};

window.removeFromBasket = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  delete state.basket[key];
  renderOrderGrid();
  if (!isPosMode()) renderListMenu(); // keep its qty steppers in sync with the trashed row
  updateBottomBar();
};

async function saveOrderEdits() {
  if (!state.editingOrderId) return;
  const next = document.getElementById('nextBtn');
  next.disabled = true; next.textContent = 'Saving…';
  try {
    const items = Object.values(state.basket).map(i => ({ name: i.name, price: i.price, quantity: i.quantity }));
    await db.collection('showdrinks_orders').doc(state.editingOrderId).update({
      items, totalAmount: basketTotal(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    saveOrderLocally({ id: state.editingOrderId, orderNumber: state.editingOrderNumber,
      customerName: state.customerName, showDate: state.showDate,
      sessionName: state.sessionName, totalAmount: basketTotal() });
    toast('Order updated', 'success');
    state.currentStatusOrderId = state.editingOrderId;
    const doc = await db.collection('showdrinks_orders').doc(state.editingOrderId).get();
    if (doc.exists) showOrderStatus({ id: doc.id, ...doc.data() });
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null;
    goTo(3);
    subscribeToOrderStatus(state.currentStatusOrderId);
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
    next.disabled = false; next.textContent = 'Save Changes';
  }
}

// ── Screen 2: Review & Pay ─────────────────────────────────────────────────

function renderReview() {
  document.getElementById('reviewName').textContent    = state.customerName;
  document.getElementById('reviewDate').textContent    = fmtDate(state.showDate);
  document.getElementById('reviewSession').textContent = state.sessionName;
  const items = Object.values(state.basket);
  document.getElementById('reviewItems').innerHTML = items.map(i => `
    <div class="order-summary-row">
      <span class="osq">${i.quantity}×</span>
      <span class="osn">${escHtml(i.name)}</span>
      <span class="osp">${fmtCurrency(i.price * i.quantity)}</span>
    </div>`).join('');
  document.getElementById('reviewTotal').textContent = fmtCurrency(basketTotal());
  const viewing = !!state.editingOrderId;
  // Viewing an already-placed order that hasn't been paid yet still gets the payment section,
  // showing whatever methods the show currently allows (same state.settings.paymentMode a fresh
  // order uses) — not just whichever method was originally picked. A paid/ready/collected order
  // has nothing left to pay, so stays hidden same as before.
  const viewingUnpaid = viewing && state.editingOrderPaymentStatus !== 'paid';
  document.getElementById('paymentSection').style.display = (!viewing || viewingUnpaid) ? '' : 'none';
  const statusEl = document.getElementById('reviewStatus');
  if (viewing) {
    const s = state.editingOrderStatus;
    const num = state.editingOrderNumber ? `Order #${state.editingOrderNumber} · ` : '';
    const label = s === 'ready' ? '✅ Ready to collect' : s === 'collected' ? '🎉 Collected' : 'Being prepared';
    statusEl.innerHTML = `<div class="review-status-row">${num}${label}</div>`;
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
  if (!viewing || viewingUnpaid) {
    const mode = state.settings?.paymentMode || 'bar';
    const showBar   = mode === 'bar'   || mode === 'both';
    const showSumup = mode === 'sumup' || mode === 'both';
    document.getElementById('payAtBarSection').style.display   = showBar ? '' : 'none';
    document.getElementById('sumupSection').style.display      = showSumup ? '' : 'none';
    // Only makes sense as a choice between two visible options, not layout filler above a lone
    // section — "both" is the only mode where it ever shows.
    document.getElementById('paymentOrDivider').style.display  = mode === 'both' ? '' : 'none';

    const barBtn = document.getElementById('payAtBarBtn');
    barBtn.disabled = false;
    barBtn.textContent = viewing ? "I'll Pay at the Bar" : 'Confirm Order (Pay at Bar)';
    const onlineBtn = document.getElementById('payOnlineBtn');
    onlineBtn.disabled = false;
    onlineBtn.textContent = '💳 Pay Online with SumUp';
  }
}

document.getElementById('payAtBarBtn').addEventListener('click', () => {
  if (state.editingOrderId) confirmPayAtBarForExistingOrder(); else placeOrder('bar');
});
document.getElementById('payOnlineBtn').addEventListener('click', () => {
  if (state.editingOrderId) payOnlineForExistingOrder();
  else placeOrder('sumup').then(() => { if (state.orderId) initiateSumupPayment(); });
});

// The two handlers below back the payment section when VIEWING an already-placed unpaid order
// (reached by tapping it on Home) rather than placing a new one — nothing gets created, an
// existing order's paymentMode is updated to match whichever button was tapped (it may differ
// from what was originally chosen, e.g. switching from bar to online) before acting on it.

async function confirmPayAtBarForExistingOrder() {
  const orderId = state.editingOrderId;
  const btn = document.getElementById('payAtBarBtn');
  btn.disabled = true;
  try {
    await db.collection('showdrinks_orders').doc(orderId).update({
      paymentMode: 'bar', updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    const doc = await db.collection('showdrinks_orders').doc(orderId).get();
    if (!doc.exists) throw new Error('Order not found');
    showOrderStatus({ id: doc.id, ...doc.data() });
    goTo(3);
    subscribeToOrderStatus(orderId);
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
  }
}

async function payOnlineForExistingOrder() {
  const orderId = state.editingOrderId;
  try {
    await db.collection('showdrinks_orders').doc(orderId).update({
      paymentMode: 'sumup', updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
    return;
  }
  await initiateSumupPayment(orderId, 'payOnlineBtn');
}

async function placeOrder(paymentMode) {
  const btn = paymentMode === 'bar' ? document.getElementById('payAtBarBtn') : document.getElementById('payOnlineBtn');
  btn.disabled = true; btn.textContent = 'Placing order…';

  const order = {
    customerName: state.customerName,
    showDate:     state.showDate,
    sessionId:    state.sessionId,
    sessionName:  state.sessionName,
    items: Object.values(state.basket).map(i => ({ name: i.name, price: i.price, quantity: i.quantity })),
    totalAmount:  basketTotal(),
    paymentMode,
    paymentStatus: paymentMode === 'bar' ? 'pending' : 'awaiting',
    prepStatus:   'pending',
    locationId: '', locationName: '',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  const doPlace = async () => {
    const counterRef = db.collection('showdrinks_counters').doc('global');
    const orderRef   = db.collection('showdrinks_orders').doc();
    let orderNumber;
    await db.runTransaction(async t => {
      const cDoc = await t.get(counterRef);
      orderNumber = (cDoc.exists ? (cDoc.data().next || 0) : 0) + 1;
      t.set(counterRef, { next: orderNumber }, { merge: true });
      t.set(orderRef, { ...order, orderNumber });
    });
    return { orderRef, orderNumber };
  };

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Request timed out – please try again')), 15000)
  );

  try {
    const { orderRef, orderNumber } = await Promise.race([doPlace(), timeout]);

    state.orderId              = orderRef.id;
    state.currentStatusOrderId = orderRef.id;
    state.orderNumber          = orderNumber;
    saveOrderLocally({ ...order, id: orderRef.id, orderNumber });

    if (paymentMode === 'bar') {
      showOrderStatus({ ...order, id: orderRef.id, orderNumber });
      goTo(3);
      subscribeToOrderStatus(orderRef.id);
    }
  } catch(e) {
    toast('Failed to place order: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = paymentMode === 'bar' ? 'Confirm Order (Pay at Bar)' : '💳 Pay Online with SumUp';
  }
}

// Asks the server to create a real SumUp Hosted Checkout, then sends the browser there. Merchant
// code/API key resolution (show override → system default) all happens inside
// createSumupCheckoutFn — this page never sees either. Two callers: straight after placing a new
// order (orderId defaults to state.orderId, btnId to the Review screen's own button), and a
// retry from the Status screen for an order that came back unpaid — see retrySumupPayment below,
// which passes both explicitly since state.orderId isn't the right one there.
async function initiateSumupPayment(orderId = state.orderId, btnId = 'payOnlineBtn') {
  const btn = document.getElementById(btnId);
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting to SumUp…'; }
  try {
    const result = await createSumupCheckoutFn({ orderId });
    const url = result.data?.hostedCheckoutUrl;
    if (!url) throw new Error('No checkout link returned');
    window.location.href = url;
  } catch(e) {
    console.error(e);
    toast(e.message || 'Could not start SumUp checkout', 'error');
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// The Status screen's "Try Paying Online Again" button (see showOrderStatus) — reachable after
// backing out of/failing a SumUp checkout, so paying still isn't a dead end. Pay-at-bar needs no
// equivalent button: staff take payment there directly and mark it paid from the admin side, no
// action for the customer to take on this device.
window.retrySumupPayment = function(orderId) {
  initiateSumupPayment(orderId, 'retrySumupBtn');
};

// ── Screen 3: Status ───────────────────────────────────────────────────────

function showOrderStatus(order) {
  const stage = orderStage(order);
  const isReady     = stage === 'ready';
  const isCollected = stage === 'collected';

  // 'unpaid' reuses the same warning-ish look as "being prepared" (.pending) plus its own
  // banner below, rather than a whole extra icon treatment for a stage that isn't visually
  // different from "order received" in any other way.
  const iconClass = isCollected ? 'collected' : isReady ? 'ready' : 'pending';
  document.getElementById('statusIcon').className   = `status-icon-wrap ${iconClass}`;
  document.getElementById('statusIcon').textContent = isCollected ? '🎉' : isReady ? '✅' : '';
  document.getElementById('statusTitle').textContent = isCollected ? 'Enjoy your drinks!'
    : isReady ? 'Your drinks are ready!' : 'Order received!';
  document.getElementById('statusSub').textContent = isCollected
    ? 'Your order has been collected.'
    : isReady ? 'Head to the collection point below.'
    : 'We\'re preparing your drinks. Check back soon!';

  const numEl = document.getElementById('confOrderNum');
  if (numEl) numEl.textContent = order.orderNumber ? '#' + order.orderNumber : '';

  // Persistent reminder for any unpaid order, not just pay-at-bar ones — a SumUp order can end up
  // here too if the customer backed out of checkout or it failed/expired, and "go pay at the bar"
  // is the honest fallback for that too (staff can always take payment there regardless of which
  // method was originally chosen) — separate from the ready/collected messaging above since
  // payment and prep are independent (an order can be made and even ready before it's paid).
  document.getElementById('payAtBarBanner').style.display = stage === 'unpaid' ? '' : 'none';

  // A SumUp order that comes back unpaid (backed out, failed, or the 30-minute checkout session
  // just expired) isn't a dead end — retrySumupPayment (above) creates a fresh checkout for the
  // same order. Pay-at-bar orders get no such button: there's nothing online to retry.
  const canRetry = stage === 'unpaid' && order.paymentMode === 'sumup';
  const retryBtn = document.getElementById('retrySumupBtn');
  if (retryBtn) {
    retryBtn.style.display = canRetry ? '' : 'none';
    if (canRetry) retryBtn.onclick = () => retrySumupPayment(order.id);
  }
  const retryLinks = document.getElementById('retrySumupLinks');
  if (retryLinks) retryLinks.style.display = canRetry ? '' : 'none';

  const locBanner = document.getElementById('locationBanner');
  if (isReady && order.locationName) {
    locBanner.style.display = '';
    document.getElementById('locationText').textContent = order.locationName;
  } else {
    locBanner.style.display = 'none';
  }

  document.getElementById('confName').textContent    = order.customerName;
  document.getElementById('confDate').textContent    = fmtDate(order.showDate);
  document.getElementById('confSession').textContent = order.sessionName || order.sessionId;
  document.getElementById('confTotal').textContent   = fmtCurrency(order.totalAmount || 0);

  const collectBtn = document.getElementById('collectBtn');
  if (collectBtn) collectBtn.style.display = isReady ? '' : 'none';
}

// Every current call to this is right after freshly placing/confirming an order — the home
// screen's own order cards keep live-updating the same status (see orderCard's ready-expanded
// state), so there's no need to keep sitting on this confirmation screen; it returns home on
// its own after a bit rather than waiting for the customer to tap Home themselves.
let _statusAutoHomeTimer = null;

function subscribeToOrderStatus(orderId) {
  if (state.statusUnsubscribe) state.statusUnsubscribe();
  state.statusUnsubscribe = db.collection('showdrinks_orders').doc(orderId).onSnapshot(snap => {
    if (snap.exists) showOrderStatus({ id: snap.id, ...snap.data() });
  });
  if (_statusAutoHomeTimer) clearTimeout(_statusAutoHomeTimer);
  _statusAutoHomeTimer = setTimeout(goHomeFromStatus, 10000);
}

// Shared by the status screen's own button and each ready order's inline "I've collected my
// drinks" button on the home screen (see orderCard).
async function markOrderCollected(orderId) {
  try {
    await db.collection('showdrinks_orders').doc(orderId).update({
      prepStatus: 'collected',
      collectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    toast('Order marked as collected', 'success');
  } catch(e) {
    toast('Error: ' + e.message, 'error');
  }
}

window.collectOrderInline = function(orderId) {
  markOrderCollected(orderId);
};

document.getElementById('collectBtn').addEventListener('click', () => {
  if (state.currentStatusOrderId) markOrderCollected(state.currentStatusOrderId);
});

function goHomeFromStatus() {
  if (_statusAutoHomeTimer) { clearTimeout(_statusAutoHomeTimer); _statusAutoHomeTimer = null; }
  if (state.statusUnsubscribe) { state.statusUnsubscribe(); state.statusUnsubscribe = null; }
  state.showDate = ''; state.sessionId = ''; state.sessionName = '';
  state.basket = {}; state.orderId = null; state.selectedCategory = null;
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null;
  goTo(0); renderHomeScreen();
}

document.getElementById('newOrderBtn').addEventListener('click', goHomeFromStatus);

// ── Service Worker update banner ───────────────────────────────────────────

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(sw);
      });
    });
  }).catch(e => console.warn('SW failed', e));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) { reloading = true; window.location.reload(); }
  });
}

function showUpdateBanner(sw) {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  banner.classList.add('visible');
  document.getElementById('updateBtn').addEventListener('click', () => {
    banner.querySelector('span').textContent = 'Updating…';
    sw.postMessage('SKIP_WAITING');
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  initServiceWorker();

  if (typeof APP_VERSION !== 'undefined') {
    const el = document.getElementById('heroVersion');
    if (el) el.textContent = 'v' + APP_VERSION;
  }

  try {
    const [showSnap, menuSnap, settingsDoc, posSnap] = await Promise.all([
      db.collection('showdrinks_shows').where('isCurrent', '==', true).limit(1).get(),
      db.collection('showdrinks_menuItems').orderBy('name').get(),
      db.collection('showdrinks_config').doc('settings').get(),
      db.collection('showdrinks_posGrids').get(),
    ]);

    const currentShow = showSnap.empty ? null : showSnap.docs[0].data();
    state.showConfig = currentShow || {};
    state.sessions   = currentShow?.sessions || {};
    state.menuItems  = menuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Per-show payment settings override the system defaults when set. Deliberately picking just
    // these two fields rather than spreading the whole settings doc — sumupMerchantCode/
    // sumupApiKey live in the same doc but must never reach this unauthenticated public page (the
    // Cloud Functions in createSumupCheckoutFn/verifySumupPaymentFn resolve those server-side).
    const systemSettings = settingsDoc.exists ? settingsDoc.data() : {};
    state.settings = {
      paymentMode: currentShow?.paymentMode || systemSettings.paymentMode,
      orderingMode: currentShow?.orderingMode || systemSettings.orderingMode,
    };
    state.posGrids   = {};
    posSnap.docs.forEach(d => { state.posGrids[d.id] = { id: d.id, ...d.data() }; });

    if (!currentShow) toast('No show is currently active', 'error');

    const showName = state.showConfig.name || 'ShowDrinks';
    document.getElementById('heroShowName').textContent = showName;
    document.title = showName;

    // Handle SumUp redirect-back — the query param only means "they're back from SumUp's
    // checkout page", never "they paid" (anyone could hand-edit a URL to claim that), so this
    // always asks the server to check the REAL status with SumUp before showing an order as paid.
    // Either way (paid or still pending — a customer who backed out without paying, say) the
    // order status screen is the right place to land: it'll just show whatever's actually true.
    const params = new URLSearchParams(window.location.search);
    if (params.get('sumup') === 'return' && params.get('ref')) {
      const orderId = params.get('ref');
      try {
        await verifySumupPaymentFn({ orderId });
      } catch(e) { console.error(e); }
      try {
        const doc = await db.collection('showdrinks_orders').doc(orderId).get();
        if (doc.exists) {
          showOrderStatus({ id: doc.id, ...doc.data() });
          subscribeToOrderStatus(orderId);
          goTo(3);
          history.replaceState({}, '', window.location.pathname);
          return;
        }
      } catch(e) { console.error(e); }
    }

  } catch(e) {
    console.error(e);
    toast('Could not connect – check your connection.', 'error');
  }

  renderHomeScreen();
}

init();
