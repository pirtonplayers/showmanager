'use strict';
// Ambient "there's more here" hint for showdrinks' .cat-bar category-pill rows: rather than a
// separate chevron element, a bar with more pills than fit just glides slowly back and forth
// between its scroll extremes on its own — nothing extra to look at, the pills themselves show
// there's more. Cosine-eased so it slows naturally at both ends (pendulum-like) instead of
// snapping direction. Pauses for the duration of a touch/drag/wheel and for 5s after it ends —
// long enough to not fight someone still browsing — then picks back up from wherever they left
// it (not a snap back to the start).
(function() {
  const ROUND_TRIP_MS = 16000; // one full there-and-back cycle — deliberately slow/ambient
  const RESUME_DELAY_MS = 5000;
  const bars = Array.from(document.querySelectorAll('.cat-bar'));
  if (!bars.length) return;

  const state = new Map(bars.map(bar => [bar, { resumeAt: 0, startTime: null }]));

  bars.forEach(bar => {
    const s = state.get(bar);
    const holdOff = () => { s.resumeAt = Infinity; }; // mid-press/drag — don't resume under their finger
    const extend  = () => { s.resumeAt = performance.now() + RESUME_DELAY_MS; };
    bar.addEventListener('pointerdown', holdOff, { passive: true });
    bar.addEventListener('pointerup', extend, { passive: true });
    bar.addEventListener('pointercancel', extend, { passive: true });
    bar.addEventListener('wheel', extend, { passive: true }); // trackpad/mouse wheel fires no pointer events
  });

  function tick(now) {
    bars.forEach(bar => {
      const s = state.get(bar);
      const maxScroll = bar.scrollWidth - bar.clientWidth;
      if (maxScroll <= 1) { s.startTime = null; return; } // not scrollable (yet) — nothing to hint at
      if (now < s.resumeAt) { s.startTime = null; return; } // mid-interaction, or within the post-interaction pause
      if (s.startTime === null) {
        // Resuming (or starting fresh) — begin exactly where the row currently sits rather than
        // snapping back to the start. acos only ever returns the "still heading toward max" half
        // of the cycle, which is a fine simplification here: a slow ambient hint doesn't need to
        // reconstruct which direction it was "really" going before it got interrupted.
        const ratio = Math.max(-1, Math.min(1, 1 - 2 * bar.scrollLeft / maxScroll));
        s.startTime = now - (Math.acos(ratio) / (2 * Math.PI)) * ROUND_TRIP_MS;
      }
      const phase = ((now - s.startTime) % ROUND_TRIP_MS) / ROUND_TRIP_MS;
      bar.scrollLeft = (maxScroll / 2) * (1 - Math.cos(phase * 2 * Math.PI));
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
