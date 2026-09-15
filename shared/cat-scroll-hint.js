'use strict';
// Wobbling "more pills to scroll to" chevrons for showdrinks' .cat-bar category-pill rows — real,
// clickable elements (see .cat-scroll-chevron in style.css), fixed to the actual screen edge
// rather than CSS pseudo-elements pinned to the pill row's own edge (which sits inset by whatever
// page padding surrounds it), so they read as a carousel's arrows instead of inset UI chrome.
// Tapping one glides the row a bit further in that direction — see animateScroll below.
//
// Repositioned every animation frame instead of via scroll/resize listeners on whichever ancestor
// happens to own the scroll on a given screen — the customer app scrolls .pwa-content, admin
// screens mostly scroll the document, Menu Items scrolls its own bounded pane (see admin.js's
// updateMenuTheadStickyTop) — cheap for the couple of bars that exist, and it stays correct
// through anything that moves or resizes them, a category filter changing the pill count, or the
// bar's screen/tab becoming visible or hidden, with no per-case wiring needed.
(function() {
  function makeChevron(side, glyph, label) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cat-scroll-chevron ' + side;
    el.textContent = glyph;
    el.setAttribute('aria-label', label);
    document.body.appendChild(el);
    return el;
  }

  // A slow, eased glide rather than the browser's own (fast, non-configurable) scrollBy
  // behavior:'smooth' — deliberately unhurried since this is a "here's more, ease on over"
  // nudge, not a snap-to-page jump. Ignores taps mid-glide on the same bar instead of restarting
  // (a second tap before the first finishes almost always means "still going the same way").
  const animating = new WeakSet();
  function animateScroll(el, delta) {
    if (animating.has(el)) return;
    const start = el.scrollLeft;
    const target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, start + delta));
    const distance = target - start;
    if (!distance) return;
    animating.add(el);
    const duration = 900;
    const startTime = performance.now();
    const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // easeInOutQuad
    function step(now) {
      const t = Math.min(1, (now - startTime) / duration);
      el.scrollLeft = start + distance * ease(t);
      if (t < 1) requestAnimationFrame(step);
      else animating.delete(el);
    }
    requestAnimationFrame(step);
  }

  const bars = Array.from(document.querySelectorAll('.cat-bar')).map(bar => ({
    bar,
    left: makeChevron('left', '‹', 'Scroll categories left'),
    right: makeChevron('right', '›', 'Scroll categories right'),
  }));
  if (!bars.length) return;

  bars.forEach(({ bar, left, right }) => {
    // ~70% of the visible width — enough to feel like real progress without jumping clean past
    // whatever's only half-visible at the far edge.
    left.addEventListener('click', () => animateScroll(bar, -bar.clientWidth * 0.7));
    right.addEventListener('click', () => animateScroll(bar, bar.clientWidth * 0.7));
  });

  function tick() {
    bars.forEach(({ bar, left, right }) => {
      const rect = bar.getBoundingClientRect();
      const onScreen = rect.width > 0 && rect.height > 0;
      left.style.top = right.style.top = (rect.top + rect.height / 2) + 'px';
      left.classList.toggle('visible', onScreen && bar.scrollLeft > 1);
      right.classList.toggle('visible', onScreen && bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1);
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
