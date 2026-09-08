'use strict';
// ── Temporary load-time diagnostics ─────────────────────────────────────────
// Investigating reported slow app-opens across the showmanager suite. Load this before your
// app's own main script (right after shared/version.js), call markPerf(label) at whatever
// milestones matter for that app (auth resolved, initial data loaded, etc.), then
// showPerfReport('App Name') once loading finishes — it renders into #perfReportPanel (each
// app's own HTML needs that markup; see showdrinks/admin.html for the reference copy) so the
// result can be copied and pasted back for diagnosis.
//
// Remove once diagnosed: this file, the <script> tag pulling it into each app, the matching
// markPerf/showPerfReport calls in each app's own JS, and #perfReportPanel from each app's HTML.

// performance.now() is already relative to navigation start, so marking here — this script loads
// right after shared/version.js, before the app's own main script — captures everything before
// it: HTML parse and every earlier blocking script (Firebase compat scripts, shared/*.js).
window._perfMarks = [{ label: 'perf-report.js executing', t: performance.now() }];

window.markPerf = function(label) {
  window._perfMarks.push({ label, t: performance.now() });
};

window.showPerfReport = function(appName) {
  const resources = performance.getEntriesByType('resource')
    .filter(r => r.initiatorType === 'script' || r.initiatorType === 'link' || r.initiatorType === 'css')
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 12);
  const nav = performance.getEntriesByType('navigation')[0];
  const lines = [
    `${appName} load timing — v${typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?'}`,
    `User agent: ${navigator.userAgent}`,
    '',
  ];
  if (nav) {
    lines.push(
      'Page fetch (ms since navigation start):',
      `  ${nav.responseEnd.toFixed(0).padStart(6)}  HTML received (server + network)`,
      `  ${nav.domContentLoadedEventEnd.toFixed(0).padStart(6)}  DOM content loaded`,
      `  ${nav.loadEventEnd.toFixed(0).padStart(6)}  window load event`,
      '',
    );
  }
  lines.push(
    'Milestones (ms since navigation start):',
    ...window._perfMarks.map(m => `  ${m.t.toFixed(0).padStart(6)}  ${m.label}`),
    '',
    'Slowest scripts/stylesheets loaded (ms):',
    ...resources.map(r => `  ${r.duration.toFixed(0).padStart(6)}  ${r.name.replace(location.origin, '')}`),
  );
  const text = lines.join('\n');
  const panel = document.getElementById('perfReportPanel');
  if (!panel) { console.log(text); return; }
  document.getElementById('perfReportText').value = text;
  panel.style.display = 'flex';
};

// DOMContentLoaded rather than wiring immediately: this script is meant to load early (right
// after shared/version.js, before the app's own main script and before #perfReportPanel's own
// markup further down the page has necessarily been parsed yet).
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('perfReportCopyBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('perfReportCopyBtn');
    try {
      await navigator.clipboard.writeText(document.getElementById('perfReportText').value);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    } catch (e) {
      // Clipboard API needs a permission the browser may not have granted — the text is already
      // visible/selected in the textarea either way, so manual copy still works.
      document.getElementById('perfReportText').select();
    }
  });
  document.getElementById('perfReportCloseBtn')?.addEventListener('click', () => {
    document.getElementById('perfReportPanel').style.display = 'none';
  });
});
