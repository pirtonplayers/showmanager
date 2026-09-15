'use strict';
// Toggles can-scroll-left/can-scroll-right on every .cat-bar (the horizontally-scrolling
// category-pill rows in showdrinks' admin.js/order.js) so the wobbling chevron hints in
// style.css/index.html's ::before/::after rules only show up on whichever edge(s) actually have
// more pills scrolled out of view. Runs once at load — every .cat-bar is a static element already
// in the DOM (just display:none until its screen/tab is shown and hidden again after, never
// removed/recreated), only its pill content and visibility change afterwards.
(function() {
  function update(el) {
    el.classList.toggle('can-scroll-left', el.scrollLeft > 1);
    el.classList.toggle('can-scroll-right', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }
  document.querySelectorAll('.cat-bar').forEach(el => {
    el.addEventListener('scroll', () => update(el), { passive: true });
    // Catches the two things a 'scroll' listener alone would miss: the pill count changing
    // (each app just replaces the bar's innerHTML wholesale on every category-filter re-render)
    // and the bar itself going from display:none to visible (both change scrollWidth/clientWidth
    // without ever firing a 'scroll' event).
    new MutationObserver(() => update(el)).observe(el, { childList: true });
    new ResizeObserver(() => update(el)).observe(el);
    update(el);
  });
})();
