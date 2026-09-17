'use strict';

// The whole-suite shell: one persistent left-hand strip + one persistent work area (in the
// portal's index.html), where every app the account can reach loads into the SAME iframe slot
// instead of a full page navigation — from the user's side, it's one website throughout, not
// four separately-linked pages. Each app's own page (expenses/admin.html, etc.) is unchanged
// and still works fine visited directly/standalone (its own header+sidebar+login), but when
// loaded inside the shell's iframe it detects that (see shared/embed.js) and hides its own
// chrome, leaving only its content — the shell's strip is the only nav visible at that point.
//
// Requires shared/auth.js (ACCESS_APPS) loaded first.

// Each app's own sub-nav — the tab buttons already in that app's page, identified by the exact
// selector its own click handler already responds to (data-tab for admin.html-style apps,
// data-screen for expenses' entry app). The shell asks the iframe to click one of these via
// postMessage rather than reimplementing that app's tab-switching.
const APP_SUBNAV = {
  expenses: [
    { id: 'screenMain', label: 'New expense', selector: '[data-screen="screenMain"]' },
    { id: 'screenExpenses', label: 'Your expenses', selector: '[data-screen="screenExpenses"]' },
  ],
  expensesAdmin: [
    { id: 'dashboard', label: 'Expenses', selector: '[data-tab="dashboard"]' },
    { id: 'reports', label: 'Reports', selector: '[data-tab="reports"]' },
    { id: 'shows', label: 'Shows', selector: '[data-tab="shows"]' },
    { id: 'users', label: 'Users', selector: '[data-tab="users"]' },
    { id: 'settings', label: 'Settings', selector: '[data-tab="settings"]' },
  ],
  showdrinksAdmin: [
    { id: 'orders', label: 'Orders', selector: '[data-tab="orders"]' },
    { id: 'tabmembers', label: 'Bar Tabs', selector: '[data-tab="tabmembers"]' },
    { id: 'show', label: 'Show & Sessions', selector: '[data-tab="show"]' },
    { id: 'menu', label: 'Price List', selector: '[data-tab="menu"]' },
    { id: 'locations', label: 'Locations', selector: '[data-tab="locations"]' },
    { id: 'pos', label: 'POS Layout', selector: '[data-tab="pos"]' },
    { id: 'settings', label: 'Settings & QR', selector: '[data-tab="settings"]' },
  ],
  budget: [
    { id: 'shows', label: 'Shows', selector: '[data-tab="shows"]' },
  ],
};

// account: users/{uid} data (isManager, access) — same shape checkAccess() resolves.
function accessibleApps(account) {
  return ACCESS_APPS.filter(a => account.isManager || account.access?.[a.key]);
}

// ── Standalone-page nav (visiting an app's own URL directly, not through the shell) ─────────
// Renders the same "every reachable app, current one highlighted" list used before the shell
// existed — still what a bookmarked/direct link to an app's own page shows in its own header.

function renderSuiteNav(account, currentAppKey, basePath) {
  const apps = accessibleApps(account);
  const items = [
    { key: null, label: 'Portal', href: basePath + 'index.html' },
    ...apps.map(a => ({ key: a.key, label: a.label, href: basePath + a.href })),
  ];
  return items.map(item => {
    const isCurrent = item.key === currentAppKey;
    return isCurrent
      ? `<span class="tab-btn suite-app-link current" aria-current="page">${item.label}</span>`
      : `<a class="tab-btn suite-app-link" href="${item.href}">${item.label}</a>`;
  }).join('');
}

function mountSuiteNav(account, currentAppKey, basePath) {
  const html = renderSuiteNav(account, currentAppKey, basePath);
  const sidebar = document.getElementById('suiteNavSidebar');
  const dropdown = document.getElementById('suiteNavDropdown');
  if (sidebar) sidebar.innerHTML = html;
  if (dropdown) dropdown.innerHTML = html;
}
