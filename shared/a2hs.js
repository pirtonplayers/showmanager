'use strict';

// First-load "Add to Home Screen" prompt — pattern borrowed from foootie's own install flow
// (Android: capture beforeinstallprompt and offer a real install button; iOS has no such event,
// so it's just shown the manual Share -> Add to Home Screen steps instead), simplified to a
// single dismissible modal reusing the .modal-backdrop/.modal-card already styled in every
// app's own stylesheet, rather than a bespoke splash screen.
//
// One per installable app — the dismissed flag is scoped by pathname, so signing in on the
// portal doesn't also dismiss it for expenses' or showdrinks' own separate install prompts.
// Requires shared/firebase-config.js's page to also load a stylesheet with .modal-backdrop
// (root/expenses/showdrinks/budget all have one) — include this script after that link tag.
(function () {
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;
  if (window.self !== window.top) return; // never inside the showmanager shell's iframe
  const KEY = 'a2hs_dismissed_' + location.pathname.replace(/\W+/g, '_');
  if (localStorage.getItem(KEY)) return;

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let deferredPrompt = null;

  function dismiss() {
    localStorage.setItem(KEY, '1');
    document.getElementById('a2hsModal')?.remove();
  }

  function showModal() {
    if (document.getElementById('a2hsModal')) return;
    const appName = document.title || 'this app';
    const body = isIos
      ? `<ol style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.8">
           <li>Tap the <strong>Share</strong> button <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> in Safari</li>
           <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
           <li>Tap <strong>Add</strong> to confirm</li>
         </ol>`
      : `<p class="muted" style="margin-bottom:14px">Install ${appName} for quicker, full-screen access next time.</p>
         <button class="btn btn-primary btn-full" id="a2hsInstallBtn" style="margin-bottom:10px">Add to Home Screen</button>`;

    const el = document.createElement('div');
    el.id = 'a2hsModal';
    el.className = 'modal-backdrop';
    el.style.display = 'flex';
    el.innerHTML = `
      <div class="modal-card" style="max-width:340px;text-align:center">
        <div class="modal-header">
          <h3>Add to Home Screen</h3>
          <button class="modal-close-btn" id="a2hsCloseBtn" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          ${body}
          <button class="btn btn-secondary btn-full" id="a2hsDoneBtn">Not now</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('a2hsCloseBtn').addEventListener('click', dismiss);
    document.getElementById('a2hsDoneBtn').addEventListener('click', dismiss);
    el.addEventListener('click', (e) => { if (e.target === el) dismiss(); });
    document.getElementById('a2hsInstallBtn')?.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      dismiss();
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showModal();
  });
  window.addEventListener('appinstalled', dismiss);

  // No install-prompt event on iOS at all — show the manual steps directly, a couple seconds
  // after load so it doesn't compete with the page's own first paint/sign-in screen.
  if (isIos) setTimeout(showModal, 1500);
})();
