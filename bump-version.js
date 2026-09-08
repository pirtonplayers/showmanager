#!/usr/bin/env node
'use strict';
// One version number for the whole showmanager suite — shared/version.js is the single source
// of truth every app's own HTML/service-worker just references, replacing what used to be four
// independent per-app counters (each with its own bump-version.js). Run this whenever ANY
// cacheable asset changes anywhere in the repo, not just when shared/ itself changes: a bump
// scoped to only one app would leave the others still pointing a stale ?v= at shared/version.js,
// which is exactly the GitHub-Pages-CDN staleness bug the ?v= scheme below exists to prevent —
// just relocated to the one file every app now shares.
const fs = require('fs');

const versionFile = 'shared/version.js';
const content = fs.readFileSync(versionFile, 'utf8');
const m = content.match(/APP_VERSION = '(\d+\.\d+\.)(\d+)'/);
if (!m) { console.error('Could not find version in', versionFile); process.exit(1); }
const next    = parseInt(m[2], 10) + 1;
const version = `${m[1]}${next}`;
fs.writeFileSync(versionFile, content.replace(/APP_VERSION = '[\d.]+'/, `APP_VERSION = '${version}'`));

// Every local asset reference (script/link tags in the HTML, and the same file list in each
// app's sw.js) gets a ?v= query string bumped on every deploy. GitHub Pages' CDN caches these
// files for up to 10 minutes at the edge regardless of what cache-control a client fetch sends —
// an unversioned URL can keep serving a stale response through that whole window even to a
// freshly-loading page. A version-stamped URL can't: it's a genuinely new cache key every
// deploy, so there's nothing stale to serve, because nothing has ever been requested at that
// exact URL before.
function restamp(text, assets) {
  for (const asset of assets) {
    const escaped = asset.replace(/\./g, '\\.').replace(/\//g, '\\/');
    text = text.replace(new RegExp(`(["'/]${escaped})(\\?v=[\\d.]+)?(["'])`, 'g'), `$1?v=${version}$3`);
  }
  return text;
}

// showdrinks is the one exception: it never adopted the ?v= scheme (its sw.js instead does a
// network-first fetch for everything, and update detection goes through the service worker's own
// waiting/updatefound events rather than polling version.js) — so it's just given the new shared
// version.js path/cache-name, no query-string restamping to do there.
function bumpApp({ dir, assets = [], html = [], swCache }) {
  const p = (name) => dir ? `${dir}/${name}` : name;
  if (swCache) {
    const swFile = p('sw.js');
    let sw = restamp(fs.readFileSync(swFile, 'utf8'), assets);
    sw = sw.replace(new RegExp(`const CACHE = '${swCache}-[^']+'`), `const CACHE = '${swCache}-${version}'`);
    fs.writeFileSync(swFile, sw);
  }
  for (const htmlFile of html) {
    const f = p(htmlFile);
    fs.writeFileSync(f, restamp(fs.readFileSync(f, 'utf8'), assets));
  }
}

bumpApp({
  dir: '', swCache: 'portal',
  assets: ['style.css', 'portal.js', 'shared/version.js', 'shared/firebase-config.js', 'shared/auth.js', 'shared/suite-nav.js', 'shared/a2hs.js'],
  html: ['index.html'],
});
bumpApp({
  dir: 'expenses', swCache: 'expenses',
  assets: [
    'style.css', 'app.js', 'admin.js',
    '../shared/version.js', '../shared/firebase-config.js', '../shared/auth.js', '../shared/suite-nav.js', '../shared/embed.js', '../shared/a2hs.js',
  ],
  html: ['index.html', 'admin.html', 'help.html', 'admin-help.html'],
});
bumpApp({
  dir: 'budget', swCache: 'budget',
  assets: [
    'style.css', 'budget.js',
    '../shared/version.js', '../shared/firebase-config.js', '../shared/auth.js', '../shared/suite-nav.js', '../shared/embed.js',
  ],
  html: ['index.html'],
});
bumpApp({
  dir: 'showdrinks', swCache: 'showdrinks',
  assets: ['../shared/version.js'],
  html: ['index.html', 'admin.html'],
});

console.log(`Version: ${version}`);
