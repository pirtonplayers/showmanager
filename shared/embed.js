'use strict';

// Loaded by every app page (expenses, showdrinks, budget). When that page is sitting inside the
// showmanager shell's iframe (portal index.html's work area) rather than opened directly, this:
//  1. adds .embedded to <html> immediately (synchronous, before first paint) so this app's own
//     header/sidebar/dropdown/auth-gate never render at all — the shell's strip is the only nav
//     visible, and the shell's own #authGate already covered the flash before this page even
//     started loading.
//  2. listens for the shell telling it to switch to one of its own tabs (see APP_SUBNAV in
//     shared/suite-nav.js) — reuses that app's own existing tab-button click handler rather than
//     re-implementing tab-switching here.
// Visiting an app's page directly (not through the shell) skips all of this — window.top ===
// window.self, so isEmbedded stays false and the page behaves exactly as it always has.

const isEmbedded = window.self !== window.top;
if (isEmbedded) document.documentElement.classList.add('embedded');

window.addEventListener('message', (e) => {
  if (!e.data || e.data.source !== 'showmanager-shell') return;
  if (e.data.type === 'activateTab' && e.data.selector) {
    document.querySelector(e.data.selector)?.click();
  }
});
