'use strict';

// Shared left-hand "suite" navigation — injected into every admin-style app's sidebar and
// mobile dropdown once we know which apps this account can reach, so switching between
// showmanager's apps is one click from wherever you already are, not a trip back through the
// portal. The app you're currently in renders as a highlighted, non-clickable heading right
// above its own tabs (already in the page — see each app's .suite-current-section wrapper);
// every other app you have access to is a plain link that navigates straight there.
//
// Requires shared/auth.js (for ACCESS_APPS) loaded first.

// account: users/{uid} data (isManager, access) — same shape checkAccess() resolves.
// currentAppKey: an ACCESS_APPS[].key, or null when called from the portal itself.
// basePath: '../' from inside an app subfolder, '' from the portal root.
function renderSuiteNav(account, currentAppKey, basePath) {
  const apps = ACCESS_APPS.filter(a => account.isManager || account.access?.[a.key]);
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

// Renders the same list into both the desktop sidebar and mobile dropdown placeholders — every
// app's admin page has both, each with a #suiteNavSidebar/#suiteNavDropdown div near its top.
function mountSuiteNav(account, currentAppKey, basePath) {
  const html = renderSuiteNav(account, currentAppKey, basePath);
  const sidebar = document.getElementById('suiteNavSidebar');
  const dropdown = document.getElementById('suiteNavDropdown');
  if (sidebar) sidebar.innerHTML = html;
  if (dropdown) dropdown.innerHTML = html;
}
