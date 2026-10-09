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
  editingOrderId: null, editingOrderStatus: null, editingOrderNumber: null, editingOrderPaymentStatus: null, editingOrderCancelled: null,
  currentStatusOrderId: null,
  showConfig: null, sessions: null, menuItems: [], settings: null,
  statusUnsubscribe: null,
  homeOrderUnsubscribes: [],
  posGrids: {}, posGridStack: [],
  selectedBasketKey: null,
  sessionBuyNow: false,
};

// ── Utilities ──────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

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

// Payment methods on offer: the show's own setting (default pay-at-bar), except a buy-now order
// which is always online-only — it's paid for on the spot and handed over, so there's no "pay at
// the bar" for it. Used for both the Review screen and the Status screen's failed-payment wording.
// Categories marked "Buy now" in Admin (showdrinks_config/categories.buyNow). Every item in one of
// them is a buy-now item. Until that list has ever been saved, the old convention applies: the
// category literally named "Buy Now".
function catKey(c) { return (c || '').trim().toLowerCase(); }
function isBuyNowCategory(c) {
  const list = state.buyNowCats;
  return catKey(c) !== '' && (list ? list.has(catKey(c)) : catKey(c) === 'buy now');
}
function isBuyNowItem(item) {
  return !!item && isBuyNowCategory(item.category);
}
// A session can have a category assigned (session.category); the old per-session buyNow flag
// meant "the Buy Now category". It's a buy-now session when that category is a buy-now one.
function sessionCategoryOf(session) {
  return session?.category || (session?.buyNow ? 'Buy Now' : '');
}
function effectivePaymentMode(buyNow) {
  const m = state.settings?.paymentMode || 'bar';
  return buyNow ? (m === 'test' ? 'test' : 'sumup') : m;
}
// 'test' mode (Admin → payment mode "Test") offers pay-at-bar plus a fake online checkout that
// pretends to take the money — for walking through the whole flow without charging anyone.
function isTestMode() { return state.settings?.paymentMode === 'test'; }
function canPayAtBar(buyNow) {
  if (buyNow) return false;
  const m = effectivePaymentMode(false);
  return m === 'bar' || m === 'both' || m === 'test';
}
function onlineBtnLabel() { return isTestMode() ? '🧪 Pay Online (TEST — no money taken)' : '💳 Pay Online with SumUp'; }

// Shared by renderReview() (shows the payment section/Cancel Order option) and updateBottomBar()
// (swaps "Order Status →" for a guaranteed-clickable "Cancel Order" button there instead — see
// its own comment for why the in-content version of this button doesn't work reliably).
function isViewingUnpaidOrder() {
  return !!state.editingOrderId && state.editingOrderPaymentStatus !== 'paid' && !state.editingOrderCancelled;
}

function basketTotal() {
  return Object.values(state.basket).reduce((s, i) => s + i.price * i.quantity, 0);
}
function basketCount() {
  return Object.values(state.basket).reduce((s, i) => s + i.quantity, 0);
}

// Ordering screen has two interchangeable layouts, picked in Admin → Settings & QR: the
// staff-configured POS button grid (default), or a plain list of every item grouped by category.
// A buy-now session always uses the list (every Buy Now item as a card, buynow-screen styling), whatever
// ordering method is set — the POS grid would only offer the Buy Now items that happen to be placed in it.
function isPosMode() { return !state.sessionBuyNow && (state.settings && state.settings.orderingMode) !== 'list'; }

// Settings & QR → Ordering Method's "Starting page" for the customer ordering screen — falls
// back to root if unset or if the configured grid's since been deleted.
function posStartGrid() {
  const id = state.settings && state.settings.posStartGridId;
  return id && state.posGrids[id] ? id : 'root';
}

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
  body.classList.toggle('buynow-screen', step === 1 && !isPosMode() && state.sessionBuyNow);
  updateBottomBar();
  window.scrollTo(0, 0);
}

// A "Cancel" role — discarding a not-yet-placed order entirely (Order Summary's own Cancel,
// Review's own Cancel) or the edits so far while amending an existing one (item selection) —
// renders as plain red words wherever it appears, not a boxed button (see .cancel-text-link in
// index.html's own <style>), on whichever of backBtn/nextBtn is playing that role at the time.
// Everywhere else those two are the normal buttons they usually are, so this resets to that
// default on both every call and only the specific branches below opt one back in.
function setAsCancelLink(el, isCancel) {
  el.textContent = isCancel ? 'Cancel' : el.textContent;
  el.classList.toggle('cancel-text-link', isCancel);
  el.classList.toggle('btn', !isCancel);
  el.classList.toggle(el === document.getElementById('nextBtn') ? 'btn-primary' : 'btn-secondary', !isCancel);
}

// Shared by both Cancel buttons that discard a not-yet-placed order outright (item selection's
// own, and Order Summary's) — a confirm() first either way, so a stray tap can't wipe out a
// basket someone's actually building. Amend, by contrast, only steps back to keep editing, so it
// doesn't go through here — see cancelAmend below for its own, separately-worded safeguard.
function cancelFreshOrder() {
  if (!confirm('Cancel this order? Everything in your basket will be lost.')) return;
  state.basket = {};
  state.selectedCategory = null;
  goTo(0);
  renderHomeScreen();
}

// Discarding in-progress edits to an order that already exists — same safeguard, different
// wording, since it's the EDITS being lost here, not the order itself (that's still sitting in
// the system exactly as it was before this edit session started).
function cancelAmend() {
  if (!confirm('Discard your changes to this order?')) return;
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null; state.editingOrderCancelled = null;
  state.basket = {};
  goTo(0);
  renderHomeScreen();
}

function updateBottomBar() {
  const bar  = document.getElementById('bottomBar');
  const next = document.getElementById('nextBtn');
  const back = document.getElementById('backBtn');
  setAsCancelLink(back, false);
  setAsCancelLink(next, false);
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
      // Order Summary only ever has items in the basket already (you can't reach it otherwise),
      // but this still guards against showing "Cancel" over an empty order on the off chance.
      const hasGoods = basketCount() > 0;
      next.style.display = hasGoods ? '' : 'none';
      if (hasGoods) setAsCancelLink(next, true);
    }
    return;
  }
  if (state.step === 1 && !state.editingOrderId) {
    // POS grid mode: its own "Finish" cell drives navigation, so the bottom bar stays hidden.
    if (isPosMode()) { bar.style.display = 'none'; return; }
    // List mode: the basket total/trolley live in the header instead (see updateHeroBasket) and
    // the trolley is how you get to Review, so the bottom bar here is just Cancel — and with
    // nothing in the basket yet, there's nothing to cancel either, so the bar has nothing left to
    // show at all until something's actually been added. That left no way back to Home at all —
    if (basketCount() === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    next.style.display = 'none';
    setAsCancelLink(back, true);
    return;
  }
  next.style.display = '';
  bar.style.display = 'flex';
  if (state.step === 1) {
    setAsCancelLink(back, true);
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
    // "← Close" — just leaves the view; the order itself is untouched in Firestore either way,
    // so unlike the two Cancel roles below, there's nothing here worth confirming first.
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null; state.editingOrderCancelled = null;
    state.basket = {};
    goTo(0); renderHomeScreen();
  } else if (state.step === 1 && state.editingOrderId) {
    cancelAmend();
  } else if (state.step === 1 && !state.editingOrderId) {
    cancelFreshOrder();
  } else if (state.step > 0) {
    goTo(state.step - 1);
  }
});

document.getElementById('nextBtn').addEventListener('click', async () => {
  if (state.step === 2 && state.editingOrderId) {
    goTo(3); subscribeToOrderStatus(state.editingOrderId); return;
  }
  if (state.step === 2 && !state.editingOrderId) {
    // Order Summary's own Cancel (see updateBottomBar) — discards the whole not-yet-placed order,
    // unlike "← Amend" which just steps back to keep editing.
    cancelFreshOrder(); return;
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

// A session's own optional order cutoff — "HH:MM" (24h, local time), set in Admin → Show &
// Sessions. Blank/missing means no cutoff at all: the session stays orderable for as long as
// it's enabled. Compared against the real clock, not state.showDate — this whole app only ever
// has one current show, always assumed to be "today" (see today()).
function sessionCutoffPassed(session) {
  if (!session || !session.cutoffTime) return false;
  const [h, m] = session.cutoffTime.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const cutoff = new Date();
  cutoff.setHours(h, m, 0, 0);
  return new Date() >= cutoff;
}

function getAvailableSessions() {
  const sessions = state.sessions || {};
  return ['before','interval','after'].map(id => {
    const s = sessions[id] || {};
    if (!s.enabled) return null;
    return { id, name: s.name || id, cutoffTime: s.cutoffTime || '', closed: sessionCutoffPassed(s) };
  }).filter(Boolean);
}

function sessionButtonsHtml() {
  const items = getAvailableSessions();
  if (!items.length) return '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">No sessions available.</p>';
  return '<div class="session-btn-grid">' + items.map(s => `
    <button class="selector-btn${s.closed ? ' unavailable' : ''}" ${s.closed ? 'disabled' : ''} onclick="startSessionOrder('${s.id}','${escHtml(s.name)}')">
      ${escHtml(s.name)}
      ${s.closed ? `<span class="sub">Ordering closed${s.cutoffTime ? ' at ' + s.cutoffTime : ''}</span>` : ''}
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

  // True when at least one of the customer's saved orders is from today (any status), so the
  // "Your orders" header and All toggle only appear when there's something to look at.
  function allOrdersToday(map, saved) {
    return saved.some(o => map[o.id] && map[o.id].showDate === today());
  }

  function renderOrdersList() {
    const section = document.getElementById('ordersListSection');
    if (!section) return; // navigated off the home screen since this fired
    if (!allSaved.length) { section.innerHTML = ''; return; }
    const showAll = getShowAllOrders();
    // Only today's orders are listed at all; with none, nothing is shown (no header, no message).
    const enriched = allSaved.map(o => byId[o.id]).filter(Boolean)
      .filter(o => o.showDate === today())
      .filter(o => showAll || (o.prepStatus !== 'collected' && !o.cancelled))
      .sort((a, b) => (b.orderNumber || 0) - (a.orderNumber || 0));
    const header = `<div class="section-label" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <span>Your orders</span>
      <label class="switch-label">
        <input type="checkbox" id="showAllOrdersToggle" ${showAll ? 'checked' : ''}>
        <span class="switch"></span>
        <span>All</span>
      </label>
    </div>`;
    if (!allOrdersToday(byId, allSaved)) { section.innerHTML = ''; return; }
    section.innerHTML = header + enriched.map(orderCard).join('');
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

  // Checked before isReady/the normal stage badge below — a cancelled order is only ever reached
  // here via "Show all" (renderOrdersList excludes it by default), so it just needs its own
  // plain, non-clickable-to-pay row (renderReview's own cancelled check already keeps viewOrder
  // from re-offering payment on it; this just keeps the badge honest too).
  if (o.cancelled) {
    return `<div class="past-order-card" onclick="viewOrder('${o.id}')">
      <div class="past-order-info">
        <div class="poi-session">${numLabel}${escHtml(o.sessionName || '')}</div>
        <div class="poi-detail">${fmtDate(o.showDate)}</div>
      </div>
      <div class="poi-right">
        <span class="badge badge-danger">Cancelled</span>
        <div class="poi-total">${fmtCurrency(o.totalAmount)}</div>
      </div>
    </div>`;
  }

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
  // Shouldn't be reachable — the button's disabled once its own cutoff has passed — but no error
  // pill either way (matches the other "shouldn't be reachable" guards in this file).
  if (sessionCutoffPassed((state.sessions || {})[id])) return;
  state.showDate = today(); state.sessionId = id; state.sessionName = name; state.basket = {};
  const sessCat = sessionCategoryOf((state.sessions || {})[id]);
  state.sessionCategory = sessCat;
  state.sessionBuyNow = !!sessCat && isBuyNowCategory(sessCat);
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null; state.editingOrderCancelled = null;
  state.selectedCategory = !state.sessionBuyNow && sessCat ? sessCat : null;   // a plain category just opens on that category
  // Buy-now: the first item of the session's category is already in the basket, as if it had been tapped.
  if (state.sessionBuyNow) {
    const special = n => !/^[a-z0-9]/i.test(n || '');
    const first = state.menuItems.filter(i => catKey(i.category) === catKey(sessCat) && i.onSale !== false)
      .sort((a, b) => (special(a.name) - special(b.name)) || (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()))[0];
    if (first) state.basket[first.name] = { name: first.name, price: first.price, quantity: 1 };
  }
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
    state.editingOrderCancelled     = order.cancelled === true;
    state.showDate    = order.showDate;
    state.sessionId   = order.sessionId;
    state.sessionName = order.sessionName;
    state.sessionBuyNow = order.buyNow === true;
    state.sessionCategory = '';
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
    state.posGridStack = [posStartGrid()];
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
// In a buy-now session: only the session's own category (or, when viewing an old order with no
// category recorded, any buy-now category).
function sessionOffers(item) {
  if (!item) return false;
  return state.sessionCategory ? catKey(item.category) === catKey(state.sessionCategory) : isBuyNowItem(item);
}

function itemInPosGrid(item) {
  return !!item && Object.values(state.posGrids || {}).some(g => (g.cells || []).some(c => c && c.type === 'item' && c.menuItemId === item.id));
}

function itemShowsOnPos(item) {
  // A "buy-now" session (set per session in Admin → Show & Sessions) only offers items in the
  // "Buy Now" category — see also renderPosGrid, which blanks the cell.
  // ...and in every other session buy-now categories are hidden — unless the item has been
  // placed in a POS grid, which is an explicit choice to offer it there.
  if (state.sessionBuyNow) {
    if (!sessionOffers(item)) return false;
  } else if (isBuyNowItem(item) && !itemInPosGrid(item)) return false;
  if (!item) return true;
  if (item.showOnPos !== undefined) return item.showOnPos !== false;
  if (item.visibility) return item.visibility !== 'bar';
  return true;
}

// Main grid is POS_MAIN_N cells (3 columns × however many rows that divides into), the rest sit
// in the smaller fixed 6-column "extra" row below it — admin.js's own copy of this same split
// (POS_MAIN_N/POS_N there) has to agree with these, since both read/write the same
// showdrinks_posGrids docs; there's no shared constants file between the two scripts.
const POS_MAIN_N = 15;
const POS_N = 21;

function renderPosGrid() {
  const gridId = state.posGridStack[state.posGridStack.length - 1];
  const grid = state.posGrids[gridId];
  const el = document.getElementById('posGrid');
  if (!el) return;
  if (!grid) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:12px">POS layout not set up yet — configure it in Admin → POS Layout.</p>';
    return;
  }
  const all = (grid.cells || []).slice(0, POS_N);
  while (all.length < POS_N) all.push({ type: 'empty' });
  function cellBtn(cell, i) {
    if (!cell || cell.type === 'empty') return `<button class="pos-btn empty" disabled></button>`;
    const style = cell.color
      ? `background:${cell.color};color:${posIsLight(cell.color)?'#1e293b':'#fff'};border-color:${cell.color};` : '';
    const price = cell.type === 'item' && cell.menuItemPrice ? fmtCurrency(cell.menuItemPrice) : '';
    const menuItem = cell.type === 'item' ? state.menuItems.find(mi => mi.id === cell.menuItemId) : null;
    // In a buy-now session, anything that isn't a Buy Now item isn't just dimmed, it's not shown at
    // all. Other sessions show Buy Now items that have been placed in the grid (this cell is one).
    if (state.sessionBuyNow && cell.type === 'item' && !(menuItem && sessionOffers(menuItem))) {
      return `<button class="pos-btn empty" disabled></button>`;
    }
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
    `<div class="pos-grid">${all.slice(0,POS_MAIN_N).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${all.slice(POS_MAIN_N).map((c,i) => cellBtn(c,POS_MAIN_N+i)).join('')}</div>`;
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
    // Long press stays on this grid (adding several from the same category in a row) — so does a
    // plain tap, on a grid marked Sticky in POS Layout (grid.sticky). Otherwise a normal tap still
    // jumps back to the root menu, same as before.
    if (!isLongPress && !grid.sticky) state.posGridStack = [posStartGrid()];
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
        <span class="og-qty">×${i.quantity}</span>
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
  // Category POS: with nothing left in the basket the big button becomes "Tap to exit" (back to Home)
  // instead of a disabled checkout.
  const exitMode = basketCount() === 0;
  if (btn) btn.disabled = basketCount() === 0 && !exitMode;
  const cap = btn && btn.querySelector('.hero-basket-caption');
  if (cap) cap.textContent = exitMode ? 'Tap to exit' : 'Tap to pay';
}

window.goToListBasket = function() {
  if (basketCount() === 0) { goTo(0); renderHomeScreen(); return; } // shouldn't be reachable — button is disabled — but no error pill either way
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
  // Buy-now session: straight into the Buy Now category, with no category pills to switch away.
  const buyNowCat = state.sessionBuyNow ? catOrder.find(c => state.sessionCategory ? catKey(c) === catKey(state.sessionCategory) : isBuyNowCategory(c)) : null;
  const selected = buyNowCat ? buyNowCat
    : state.selectedCategory && validSelections.includes(state.selectedCategory)
    ? state.selectedCategory : null;
  state.selectedCategory = selected;

  barEl.style.display = (!state.sessionBuyNow && (catOrder.length || hasOrder)) ? 'flex' : 'none';
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
    ? `<div class="section-label">${state.sessionBuyNow ? 'Tap on an item below to add another, then tap on the total above to pay.' : escHtml(selected)}</div>
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
        <span class="qty-num">×${i.quantity}</span>
        <button onclick="listDecBasketItem('${encodeURIComponent(key)}')" title="Remove one">−</button>
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
  const img = item.image && isBuyNowItem(item)
    ? `<img class="mic-img" src="${item.image}" alt="" style="object-fit:cover;flex:none">` : '';
  return `<div class="menu-item-card${qty > 0 ? ' has-qty' : ''}" onclick="listIncItem('${item.id}')">
    ${img}<span class="mic-name">${escHtml(item.name)}</span>
    <span class="mic-price">${fmtCurrency(item.price)}</span>
    ${qty > 0 ? `<div class="qty-control">
      <span class="qty-num">×${qty}</span>
      <button onclick="event.stopPropagation();listDecBasketItem('${encodeURIComponent(item.name)}')" title="Remove one">−</button>
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
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null; state.editingOrderCancelled = null;
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
      <span class="osq">×${i.quantity}</span>
      <span class="osn">${escHtml(i.name)}</span>
      <span class="osp">${fmtCurrency(i.price * i.quantity)}</span>
    </div>`).join('');
  document.getElementById('reviewTotal').textContent = fmtCurrency(basketTotal());
  const viewing = !!state.editingOrderId;
  // Viewing an already-placed order that hasn't been paid yet still gets the payment section,
  // showing whatever methods the show currently allows (same state.settings.paymentMode a fresh
  // order uses) — not just whichever method was originally picked. A paid/ready/collected/
  // already-cancelled order has nothing left to pay (or cancel), so stays hidden same as before.
  const viewingUnpaid = isViewingUnpaidOrder();
  document.getElementById('paymentSection').style.display = (!viewing || viewingUnpaid) ? '' : 'none';
  const statusEl = document.getElementById('reviewStatus');
  if (viewing) {
    const s = state.editingOrderStatus;
    const num = state.editingOrderNumber ? `Order #${state.editingOrderNumber} · ` : '';
    const label = state.editingOrderCancelled ? '❌ Cancelled'
      : s === 'ready' ? '✅ Ready to collect'
      : s === 'collected' ? '🎉 Collected'
      : state.editingOrderPaymentStatus !== 'paid' ? '⏳ Awaiting payment'
      : 'Being prepared';
    statusEl.innerHTML = `<div class="review-status-row">${num}${label}</div>`;
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
  if (!viewing || viewingUnpaid) {
    const mode = effectivePaymentMode(state.sessionBuyNow);
    const showBar   = mode === 'bar'   || mode === 'both' || (mode === 'test' && !state.sessionBuyNow);
    const showSumup = mode === 'sumup' || mode === 'both' || mode === 'test';
    document.getElementById('payAtBarSection').style.display   = showBar ? '' : 'none';
    document.getElementById('sumupSection').style.display      = showSumup ? '' : 'none';
    // Only makes sense as a choice between two visible options, not layout filler above a lone
    // section — "both" is the only mode where it ever shows.
    document.getElementById('paymentOrDivider').style.display  = showBar && showSumup ? '' : 'none';

    const barBtn = document.getElementById('payAtBarBtn');
    barBtn.disabled = false;
    barBtn.textContent = viewing ? "I'll Pay at the Bar" : 'Confirm Order (Pay at Bar)';
    const onlineBtn = document.getElementById('payOnlineBtn');
    onlineBtn.disabled = false;
    onlineBtn.textContent = onlineBtnLabel();
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
    buyNow:       state.sessionBuyNow,
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
    btn.textContent = paymentMode === 'bar' ? 'Confirm Order (Pay at Bar)' : onlineBtnLabel();
  }
}

// Asks the server to create a real SumUp Hosted Checkout, then sends the browser there. Merchant
// code/API key resolution (show override → system default) all happens inside
// createSumupCheckoutFn — this page never sees either. Two callers: straight after placing a new
// order (orderId defaults to state.orderId, btnId to the Review screen's own button), and a
// retry from the Status screen for an order that came back unpaid — see retrySumupPayment below,
// which passes both explicitly since state.orderId isn't the right one there.
async function initiateSumupPayment(orderId = state.orderId, btnId = 'payOnlineBtn') {
  if (isTestMode()) { showTestCheckout(orderId, btnId); return; }
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

// Back from a checkout without paying, and no pay-at-bar to fall back on: the order isn't going
// anywhere, so mark it cancelled (retrySumupPayment un-cancels it if they try again). Returns the
// order as it now stands.
async function cancelIfUnsendable(order) {
  if (orderStage(order) !== 'unpaid' || order.cancelled || canPayAtBar(order.buyNow === true)) return order;
  try {
    await db.collection('showdrinks_orders').doc(order.id).update({
      cancelled: true, cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return { ...order, cancelled: true };
  } catch(e) { console.error(e); return order; }
}

// TEST payment mode's stand-in for SumUp's hosted checkout page: a full-screen "checkout" with a
// button to simulate success and one to simulate failure, so both outcomes can be walked through.
// Nothing is charged. A "successful" one marks the order paid straight from here (the order rules
// already let the customer page update its own order), and a buy-now order is collected as well,
// same as the real verifySumupPayment does.
function showTestCheckout(orderId, btnId) {
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = true;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center';
  ov.innerHTML = `<div style="font-size:12px;font-weight:700;letter-spacing:.1em;color:#b45309;background:#fef3c7;padding:4px 12px;border-radius:999px">TEST PAYMENT — NO MONEY TAKEN</div>
    <div style="font-size:22px;font-weight:800">Test checkout</div>
    <button class="btn btn-success btn-full btn-lg" id="testPayOk" style="height:56px;border-radius:12px">Simulate successful payment</button>
    <button class="btn btn-secondary btn-full btn-lg" id="testPayFail" style="height:56px;border-radius:12px">Simulate failed / abandoned payment</button>`;
  document.body.appendChild(ov);
  const finish = async (paid) => {
    ov.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const ref = db.collection('showdrinks_orders').doc(orderId);
      if (paid) {
        const snap = await ref.get();
        const upd = { paymentStatus: 'paid', testPayment: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        if (snap.exists && snap.data().buyNow) Object.assign(upd, { prepStatus: 'collected', collectedAt: firebase.firestore.FieldValue.serverTimestamp() });
        await ref.update(upd);
      }
      const doc = await ref.get();
      let order = { id: doc.id, ...doc.data() };
      if (!paid) order = await cancelIfUnsendable(order);
      ov.remove();
      state.currentStatusOrderId = orderId;
      showOrderStatus(order);
      subscribeToOrderStatus(orderId);
      goTo(3);
    } catch(e) {
      toast('Failed: ' + e.message, 'error');
      ov.remove();
    }
    if (btn) btn.disabled = false;
  };
  document.getElementById('testPayOk').onclick = () => finish(true);
  document.getElementById('testPayFail').onclick = () => finish(false);
}

// The Status screen's "Try Paying Online Again" button (see showOrderStatus) — reachable after
// backing out of/failing a SumUp checkout, so paying still isn't a dead end. Pay-at-bar needs no
// equivalent button: staff take payment there directly and mark it paid from the admin side, no
// action for the customer to take on this device.
window.retrySumupPayment = async function(orderId) {
  // An unpaid online-only order may have been auto-cancelled on return from SumUp — retrying revives it.
  try {
    await db.collection('showdrinks_orders').doc(orderId).update({
      cancelled: false, updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch(e) { console.error(e); }
  initiateSumupPayment(orderId, 'retrySumupBtn');
};

// The Status screen's own "Cancel Order" button (see showOrderStatus) — the only place it
// appears, and only while the order's still unpaid.
window.cancelOrder = async function(orderId) {
  if (!confirm('Cancel this order? This can\'t be undone.')) return;
  const btn = document.getElementById('cancelOrderBtn');
  if (btn) btn.disabled = true;
  try {
    // A cancel is a flag, not a delete — firestore.rules only allows showdrinksAdmin to actually
    // delete an order doc, and keeping the record (rather than erasing it) is what lets admin's
    // own Orders list show it was cancelled instead of it just silently vanishing.
    await db.collection('showdrinks_orders').doc(orderId).update({
      cancelled: true, cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    toast('Order cancelled', 'info');
    goHomeFromStatus(); // resets all editing/basket state and re-renders Home, same as any other "done here" exit
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
    if (btn) btn.disabled = false;
  }
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
  // An unpaid order where the show doesn't take pay-at-bar (online-only, or any buy-now order)
  // hasn't really been "sent" — nothing's been paid and there's no bar payment to fall back on —
  // so say that instead of "Order received", and drop the order number.
  const notSent = stage === 'unpaid' && !canPayAtBar(order.buyNow === true);
  document.getElementById('statusTitle').textContent = isCollected ? ((state.sessions || {})[order.sessionId]?.confirmationMessage || '')
    : isReady ? 'Your drinks are ready!' : notSent ? 'Payment not completed' : 'Order received!';
  document.getElementById('statusSub').textContent = isCollected
    ? ''
    : isReady ? 'Head to the collection point below.'
    : notSent ? 'Your order has not been sent. Please try paying online again, or order at the bar.'
    : 'We\'re preparing your drinks. Check back soon!';

  const numEl = document.getElementById('confOrderNum');
  if (numEl) numEl.textContent = (order.orderNumber && !notSent) ? '#' + order.orderNumber : '';

  // Persistent reminder for any unpaid order, not just pay-at-bar ones — a SumUp order can end up
  // here too if the customer backed out of checkout or it failed/expired, and "go pay at the bar"
  // is the honest fallback for that too (staff can always take payment there regardless of which
  // method was originally chosen) — separate from the ready/collected messaging above since
  // payment and prep are independent (an order can be made and even ready before it's paid).
  const banner = document.getElementById('payAtBarBanner');
  banner.style.display = stage === 'unpaid' && !notSent ? '' : 'none';
  const notSentBtn = document.getElementById('notSentHomeBtn');
  notSentBtn.textContent = order.buyNow ? 'Home (please pay at the bar)' : 'Home (please order at the bar)';
  notSentBtn.style.display = notSent ? '' : 'none';
  document.getElementById('newOrderBtn').style.display = notSent ? 'none' : '';

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

  // Cancel lives ONLY here, on the order's own status page, and only while it's still unpaid —
  // once it's paid/ready/collected there's nothing left to back out of. stage 'unpaid' already
  // excludes ready/collected; !order.cancelled additionally covers an already-cancelled order
  // reaching this screen (orderStage() itself has no notion of "cancelled" — it's a separate flag,
  // not a prepStatus/paymentStatus value), so its own cancel button doesn't just re-offer itself.
  const canCancel = stage === 'unpaid' && !order.cancelled;
  const cancelBtn = document.getElementById('cancelOrderBtn');
  if (cancelBtn) {
    cancelBtn.style.display = canCancel ? '' : 'none';
    if (canCancel) cancelBtn.onclick = () => cancelOrder(order.id);
  }

  // Nothing actionable left (paid, or already cancelled) — safe to auto-return home after a bit.
  // While unpaid/cancellable, never arm this: the customer may be mid-decision on Cancel or a
  // SumUp retry, and getting swept back to Home mid-confirm() used to look exactly like those
  // buttons silently doing nothing.
  if (_statusAutoHomeTimer) { clearTimeout(_statusAutoHomeTimer); _statusAutoHomeTimer = null; }
  if (stage !== 'unpaid') {
    _statusAutoHomeTimer = setTimeout(goHomeFromStatus, 10000);
  }

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

// When there's nothing left for the customer to do here (paid and either being prepared, ready,
// or collected), the home screen's own order cards keep live-updating the same status anyway (see
// orderCard's ready-expanded state) — so rather than making them tap Home themselves, this screen
// returns there on its own after a bit. BUT: while the order's still unpaid, there IS something to
// do here (Cancel Order, or retry a failed SumUp payment) — auto-navigating away mid-decision used
// to silently sweep the customer back to Home before they'd finished reading/confirming a cancel,
// which looked exactly like "the Cancel button does nothing". So this only arms itself once the
// order reaches a stage with nothing actionable left, and re-evaluates on every live update
// (showOrderStatus below) rather than once up front.
let _statusAutoHomeTimer = null;

function subscribeToOrderStatus(orderId) {
  if (state.statusUnsubscribe) state.statusUnsubscribe();
  state.statusUnsubscribe = db.collection('showdrinks_orders').doc(orderId).onSnapshot(snap => {
    if (snap.exists) showOrderStatus({ id: snap.id, ...snap.data() });
  });
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
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null; state.editingOrderPaymentStatus = null; state.editingOrderCancelled = null;
  goTo(0); renderHomeScreen();
}

document.getElementById('newOrderBtn').addEventListener('click', goHomeFromStatus);
document.getElementById('notSentHomeBtn').addEventListener('click', goHomeFromStatus);

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
    const [showSnap, menuSnap, settingsDoc, posSnap, catDoc] = await Promise.all([
      db.collection('showdrinks_shows').where('isCurrent', '==', true).limit(1).get(),
      db.collection('showdrinks_menuItems').orderBy('name').get(),
      db.collection('showdrinks_config').doc('settings').get(),
      db.collection('showdrinks_posGrids').get(),
      db.collection('showdrinks_config').doc('categories').get(),
    ]);
    state.buyNowCats = catDoc.exists ? new Set((catDoc.data().buyNow || []).map(catKey)) : null;

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
      posStartGridId: systemSettings.posStartGridId,
      qrAccessCode: systemSettings.qrAccessCode || '',
      qrValidUntil: systemSettings.qrValidUntil || '',
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
          let order = { id: doc.id, ...doc.data() };
          // Back from SumUp without paying, and no pay-at-bar to fall back on: the order isn't
          // going anywhere, so mark it cancelled (retrySumupPayment un-cancels it if they try again).
          order = await cancelIfUnsendable(order);
          showOrderStatus(order);
          subscribeToOrderStatus(orderId);
          goTo(3);
          history.replaceState({}, '', window.location.pathname);
          return;
        }
      } catch(e) { console.error(e); }
    }

    // QR link check (Admin → Settings & QR → Customer QR Code): the link's ?k= has to match the
    // access code, and the optional "valid until" time must not have passed. The last good code is
    // remembered so the installed/home-screen copy (which loses the ?k=) keeps working until the
    // code is changed or expires. A soft gate — it stops a stale or shared QR, not a determined user.
    const code = state.settings.qrAccessCode, until = state.settings.qrValidUntil;
    const expired = until && new Date(until) < new Date();
    let given = params.get('k') || '';
    if (!given) { try { given = localStorage.getItem('showdrinks_k') || ''; } catch {} }
    if (expired || (code && given !== code)) {
      document.getElementById('homeContent').innerHTML =
        '<div style="text-align:center;padding:32px 8px"><div class="pwa-section-title">This QR code is no longer valid</div>' +
        '<p style="color:var(--text-muted);font-size:14px;margin-top:8px">Please scan the current QR code to order.</p></div>';
      return;
    }
    if (code && given === code) { try { localStorage.setItem('showdrinks_k', code); } catch {} }

  } catch(e) {
    console.error(e);
    toast('Could not connect – check your connection.', 'error');
  }

  renderHomeScreen();
}

init();
