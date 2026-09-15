'use strict';
// Wobbling "more pills to scroll to" chevrons for showdrinks' .cat-bar category-pill rows — real
// elements (see .cat-scroll-chevron in style.css), fixed to the actual screen edge rather than
// CSS pseudo-elements pinned to the pill row's own edge (which sits inset by whatever page
// padding surrounds it), so they read as a carousel's arrows instead of inset UI chrome.
//
// Repositioned every animation frame instead of via scroll/resize listeners on whichever ancestor
// happens to own the scroll on a given screen — the customer app scrolls .pwa-content, admin
// screens mostly scroll the document, Menu Items scrolls its own bounded pane (see admin.js's
// updateMenuTheadStickyTop) — cheap for the couple of bars that exist, and it stays correct
// through anything that moves or resizes them, a category filter changing the pill count, or the
// bar's screen/tab becoming visible or hidden, with no per-case wiring needed.
(function() {
  function makeChevron(side, glyph) {
    const el = document.createElement('span');
    el.className = 'cat-scroll-chevron ' + side;
    el.textContent = glyph;
    document.body.appendChild(el);
    return el;
  }

  const bars = Array.from(document.querySelectorAll('.cat-bar')).map(bar => ({
    bar, left: makeChevron('left', '‹'), right: makeChevron('right', '›'),
  }));
  if (!bars.length) return;

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
