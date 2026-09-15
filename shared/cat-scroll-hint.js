'use strict';
// Ambient "there's more here" hint for showdrinks' .cat-bar category-pill rows: rather than a
// separate chevron element, a bar with more pills than fit just glides slowly back and forth
// between its scroll extremes on its own — nothing extra to look at, the pills themselves show
// there's more. Cosine-eased so it slows naturally at both ends (pendulum-like) instead of
// snapping direction. Stops for good the moment someone touches/scrolls/wheels a given bar
// themselves — once they've found the scroll, this gets out of their way rather than fighting it.
(function() {
  const ROUND_TRIP_MS = 16000; // one full there-and-back cycle — deliberately slow/ambient
  const bars = Array.from(document.querySelectorAll('.cat-bar'));
  if (!bars.length) return;

  const state = new Map(bars.map(bar => [bar, { paused: false, startTime: null }]));

  bars.forEach(bar => {
    const stop = () => { state.get(bar).paused = true; };
    bar.addEventListener('pointerdown', stop, { passive: true });
    bar.addEventListener('wheel', stop, { passive: true });
    bar.addEventListener('touchstart', stop, { passive: true });
  });

  function tick(now) {
    bars.forEach(bar => {
      const s = state.get(bar);
      if (s.paused) return;
      const maxScroll = bar.scrollWidth - bar.clientWidth;
      if (maxScroll <= 1) { s.startTime = null; return; } // not scrollable (yet) — nothing to hint at
      if (s.startTime === null) s.startTime = now;
      const phase = ((now - s.startTime) % ROUND_TRIP_MS) / ROUND_TRIP_MS;
      bar.scrollLeft = (maxScroll / 2) * (1 - Math.cos(phase * 2 * Math.PI));
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
