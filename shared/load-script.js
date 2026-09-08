'use strict';
// Generic "load this <script> once, on first actual use" helper — for a heavy third-party
// library only one specific action needs (xlsx.js for an Export to Excel button, say), so it
// isn't a static <script> tag adding its own CDN round trip to the critical path of every single
// page load for a feature most opens never touch. A second call for the same src (even from a
// different caller) reuses the same in-flight/settled promise rather than injecting it twice.
const _loadScriptPromises = new Map();

// globalName: if that global already exists (e.g. the library's own <script> tag is still
// present somewhere, or a previous call already finished), skip the network entirely.
function loadScript(src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve();
  if (_loadScriptPromises.has(src)) return _loadScriptPromises.get(src);
  const promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { _loadScriptPromises.delete(src); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  _loadScriptPromises.set(src, promise);
  return promise;
}
