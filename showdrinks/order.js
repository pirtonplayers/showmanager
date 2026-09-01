'use strict';

// ── localStorage ───────────────────────────────────────────────────────────

const LS_NAME   = 'showdrinks_name';
const LS_ORDERS = 'showdrinks_orders';

function getSavedName()  { return localStorage.getItem(LS_NAME) || ''; }
function saveName(n)     { localStorage.setItem(LS_NAME, n); }

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
  editingOrderId: null, editingOrderStatus: null, editingOrderNumber: null,
  currentStatusOrderId: null,
  showConfig: null, sessions: null, menuItems: [], settings: null,
  statusUnsubscribe: null,
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

function basketTotal() {
  return Object.values(state.basket).reduce((s, i) => s + i.price * i.quantity, 0);
}
function basketCount() {
  return Object.values(state.basket).reduce((s, i) => s + i.quantity, 0);
}

// ── Navigation ─────────────────────────────────────────────────────────────

const body = document.querySelector('.pwa-body');

function goTo(step) {
  document.getElementById('screen' + state.step).classList.remove('active');
  state.step = step;
  document.getElementById('screen' + step).classList.add('active');
  // Compact hero on all non-home screens
  body.classList.toggle('sub-screen', step !== 0);
  body.classList.toggle('pos-screen', step === 1);
  updateStepBar();
  updateBottomBar();
  window.scrollTo(0, 0);
}

function updateStepBar() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('dot' + i);
    dot.className = 'step-dot' + (i < state.step ? ' done' : i === state.step ? ' active' : '');
  }
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
  if (state.step === 1 && !state.editingOrderId) { bar.style.display = 'none'; return; }
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
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null;
    state.basket = {};
    goTo(0); renderHomeScreen();
  } else if (state.step === 1 && state.editingOrderId) {
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null;
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
  if (state.step === 1) {
    if (state.editingOrderId) {
      if (state.editingOrderStatus !== 'pending') {
        goTo(3); subscribeToOrderStatus(state.editingOrderId);
      } else {
        await saveOrderEdits();
      }
    } else {
      if (basketCount() === 0) { toast('Add at least one item', 'error'); return; }
      goTo(2); renderReview();
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

  if (!savedName) { renderNameForm(homeContent); return; }

  state.customerName = savedName;
  const allSaved = getSavedOrders();

  const sessionBtnsHtml = sessionButtonsHtml();

  homeContent.innerHTML = buildWelcomeCard(savedName) + sessionBtnsHtml +
    '<div style="text-align:center;padding:12px 0;color:var(--text-muted);font-size:13px">Loading orders…</div>';

  const docs = await Promise.all(
    allSaved.map(o => db.collection('showdrinks_orders').doc(o.id).get().catch(() => null))
  );
  const enriched = docs.map((doc, i) => {
    if (!doc || !doc.exists) return null;
    return { ...allSaved[i], ...doc.data(), id: doc.id };
  }).filter(Boolean).sort((a, b) => (b.orderNumber || 0) - (a.orderNumber || 0));

  const ordersSection = enriched.length
    ? `<div class="section-label" style="margin-bottom:6px">Your orders</div>${enriched.map(orderCard).join('')}`
    : '<p style="font-size:13px;color:var(--text-muted)">No orders yet.</p>';

  homeContent.innerHTML = buildWelcomeCard(savedName) + sessionBtnsHtml + ordersSection;
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
  const statusLabel = isCollected ? 'Collected'
    : isReady ? (o.locationName ? `✓ ${escHtml(o.locationName)}` : '✓ Ready') : 'Pending';
  const badgeCls = isCollected ? 'badge-primary' : isReady ? 'badge-success' : 'badge-warning';
  return `<div class="past-order-card ${isReady ? 'ready' : ''} ${isCollected ? 'collected' : ''}"
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
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null;
  goTo(1); renderMenu();
};

window.viewOrder = async function(orderId) {
  try {
    const doc = await db.collection('showdrinks_orders').doc(orderId).get();
    if (!doc.exists) { toast('Order not found', 'error'); return; }
    const order = { id: doc.id, ...doc.data() };
    state.currentStatusOrderId = orderId;
    // Load order into the edit/view screen (screen 2)
    state.editingOrderId     = orderId;
    state.editingOrderStatus = order.prepStatus;
    state.editingOrderNumber = order.orderNumber || null;
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
    ? ` · ${state.editingOrderStatus === 'ready' ? '✅ Ready' : state.editingOrderStatus === 'collected' ? '🎉 Collected' : '⏳ Pending'}`
    : '';
  const numTag = state.editingOrderNumber ? `#${state.editingOrderNumber} · ` : '';
  document.title = `${numTag}${state.sessionName}${statusTag}`;
  state.posGridStack = ['root'];
  renderPosGrid();
  renderOrderGrid();
}

function posIsLight(hex) {
  if (!hex || hex.length < 4) return true;
  const h = hex.length === 4 ? '#'+hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3] : hex;
  const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
  return (r*299+g*587+b*114)/1000 > 128;
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
    return `<button class="pos-btn" style="${style}" onclick="handlePosBtn(${i})">
      <span class="pb-lbl">${escHtml(cell.label || '')}</span>
      ${price ? `<span class="pb-price">${price}</span>` : ''}
    </button>`;
  }
  el.innerHTML =
    `<div class="pos-grid">${all.slice(0,12).map((c,i) => cellBtn(c,i)).join('')}</div>` +
    `<div class="pos-grid-extra">${all.slice(12).map((c,i) => cellBtn(c,12+i)).join('')}</div>`;
}

window.handlePosBtn = function(idx) {
  const gridId = state.posGridStack[state.posGridStack.length - 1];
  const grid = state.posGrids[gridId];
  if (!grid) return;
  const cell = (grid.cells || [])[idx];
  if (!cell || cell.type === 'empty') return;
  if (cell.type === 'item') {
    const menuItem = state.menuItems.find(i => i.id === cell.menuItemId);
    if (!menuItem) { toast('Item not available', 'error'); return; }
    const key = menuItem.name;
    if (!state.basket[key]) state.basket[key] = { name: menuItem.name, price: menuItem.price, quantity: 0 };
    state.basket[key].quantity += 1;
    state.selectedBasketKey = key;
    state.posGridStack = ['root'];
    renderPosGrid();
    renderOrderGrid();
    updateBottomBar();
  } else if (cell.type === 'clear') {
    if (!confirm('Clear all items?')) return;
    state.basket = {}; state.selectedBasketKey = null;
    renderOrderGrid(); updateBottomBar();
  } else if (cell.type === 'plus') {
    const key = state.selectedBasketKey;
    if (!key || !state.basket[key]) { toast('Select an item first', 'error'); return; }
    state.basket[key].quantity += 1;
    renderOrderGrid(); updateBottomBar();
  } else if (cell.type === 'minus') {
    const key = state.selectedBasketKey;
    if (!key || !state.basket[key]) { toast('Select an item first', 'error'); return; }
    state.basket[key].quantity -= 1;
    if (state.basket[key].quantity <= 0) { delete state.basket[key]; state.selectedBasketKey = null; }
    renderOrderGrid(); updateBottomBar();
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
    if (basketCount() === 0) { toast('Add at least one item', 'error'); return; }
    goTo(2); renderReview();
  }
};

function renderOrderGrid() {
  const pane  = document.getElementById('orderGridPane');
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

function renderMenuItems() {
  const grid = document.getElementById('menuGrid');
  const cat  = state.selectedCategory;
  const items = state.menuItems.filter(item =>
    cat === 'all' || !cat || item.category === cat
  );

  grid.innerHTML = items.length
    ? items.map(item => `
        <button class="item-btn" onclick="addItem('${item.id}')">
          <span class="ib-name">${escHtml(item.name)}</span>
          <span class="ib-price">${fmtCurrency(item.price)}</span>
        </button>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px;grid-column:1/-1">No items.</p>';
}

window.selectCategory = function(cat) {
  state.selectedCategory = cat;
  document.querySelectorAll('.cat-btn').forEach(b =>
    b.classList.toggle('active',
      (cat === 'all' && b.textContent.trim() === 'All') || b.textContent.trim() === cat));
  renderMenuItems();
};

window.addItem = function(menuItemId) {
  const item = state.menuItems.find(i => i.id === menuItemId);
  if (!item) return;
  const key = item.name;
  if (!state.basket[key]) state.basket[key] = { name: item.name, price: item.price, quantity: 0 };
  state.basket[key].quantity += 1;
  renderOrderGrid();
  updateBottomBar();
};

window.removeFromBasket = function(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  delete state.basket[key];
  renderOrderGrid();
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
    state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null;
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
  document.getElementById('paymentSection').style.display = viewing ? 'none' : '';
  const statusEl = document.getElementById('reviewStatus');
  if (viewing) {
    const s = state.editingOrderStatus;
    const num = state.editingOrderNumber ? `Order #${state.editingOrderNumber} · ` : '';
    const label = s === 'ready' ? '✅ Ready to collect' : s === 'collected' ? '🎉 Collected' : '⏳ Being prepared';
    statusEl.innerHTML = `<div class="review-status-row">${num}${label}</div>`;
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
  if (!viewing) {
    const mode = state.settings?.paymentMode || 'bar';
    document.getElementById('payAtBarSection').style.display  = mode === 'bar'   ? '' : 'none';
    document.getElementById('sumupSection').style.display     = mode === 'sumup' ? '' : 'none';

    const barBtn = document.getElementById('payAtBarBtn');
    barBtn.disabled = false;
    barBtn.textContent = 'Confirm Order (Pay at Bar)';
    const onlineBtn = document.getElementById('payOnlineBtn');
    onlineBtn.disabled = false;
    onlineBtn.textContent = '💳 Pay Online with SumUp';
  }
}

document.getElementById('payAtBarBtn').addEventListener('click', () => placeOrder('bar'));
document.getElementById('payOnlineBtn').addEventListener('click', () => {
  placeOrder('sumup').then(() => { if (state.orderId) initiateSumupPayment(); });
});

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

function initiateSumupPayment() {
  const code = state.settings?.sumupMerchantCode;
  if (!code) { toast('SumUp not configured', 'error'); return; }
  window.location.href = `https://pay.sumup.com/b2c/QRCODE?affiliate-key=${encodeURIComponent(code)}&amount=${basketTotal().toFixed(2)}&currency=GBP&ref=${encodeURIComponent(state.orderId)}`;
}

// ── Screen 3: Status ───────────────────────────────────────────────────────

function showOrderStatus(order) {
  const isReady     = order.prepStatus === 'ready';
  const isCollected = order.prepStatus === 'collected';

  const iconState = isCollected ? 'collected' : isReady ? 'ready' : 'pending';
  document.getElementById('statusIcon').className   = `status-icon-wrap ${iconState}`;
  document.getElementById('statusIcon').textContent = isCollected ? '🎉' : isReady ? '✅' : '⏳';
  document.getElementById('statusTitle').textContent = isCollected ? 'Enjoy your drinks!'
    : isReady ? 'Your drinks are ready!' : 'Order received!';
  document.getElementById('statusSub').textContent = isCollected
    ? 'Your order has been collected.'
    : isReady ? 'Head to the collection point below.'
    : 'We\'re preparing your drinks. Check back soon!';

  const numEl = document.getElementById('confOrderNum');
  if (numEl) numEl.textContent = order.orderNumber ? '#' + order.orderNumber : '';

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

function subscribeToOrderStatus(orderId) {
  if (state.statusUnsubscribe) state.statusUnsubscribe();
  state.statusUnsubscribe = db.collection('showdrinks_orders').doc(orderId).onSnapshot(snap => {
    if (snap.exists) showOrderStatus({ id: snap.id, ...snap.data() });
  });
}

document.getElementById('collectBtn').addEventListener('click', async () => {
  const orderId = state.currentStatusOrderId;
  if (!orderId) return;
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
});

document.getElementById('newOrderBtn').addEventListener('click', () => {
  if (state.statusUnsubscribe) { state.statusUnsubscribe(); state.statusUnsubscribe = null; }
  state.showDate = ''; state.sessionId = ''; state.sessionName = '';
  state.basket = {}; state.orderId = null; state.selectedCategory = null;
  state.editingOrderId = null; state.editingOrderStatus = null; state.editingOrderNumber = null;
  goTo(0); renderHomeScreen();
});

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
    // Per-show payment settings override the system defaults when set
    const systemSettings = settingsDoc.exists ? settingsDoc.data() : {};
    state.settings = {
      ...systemSettings,
      ...(currentShow?.paymentMode ? { paymentMode: currentShow.paymentMode } : {}),
      ...(currentShow?.sumupMerchantCode ? { sumupMerchantCode: currentShow.sumupMerchantCode } : {}),
      ...(currentShow?.sumupApiKey ? { sumupApiKey: currentShow.sumupApiKey } : {}),
    };
    state.posGrids   = {};
    posSnap.docs.forEach(d => { state.posGrids[d.id] = { id: d.id, ...d.data() }; });

    if (!currentShow) toast('No show is currently active', 'error');

    const showName = state.showConfig.name || 'ShowDrinks';
    document.getElementById('heroShowName').textContent = showName;
    document.title = showName;

    // Handle SumUp redirect-back
    const params = new URLSearchParams(window.location.search);
    if (params.get('sumup') === 'success' && params.get('ref')) {
      const orderId = params.get('ref');
      try {
        await db.collection('showdrinks_orders').doc(orderId).update({
          paymentStatus: 'paid',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
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
