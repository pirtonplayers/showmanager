#!/usr/bin/env node
'use strict';
const fs = require('fs');
const file = 'version.js';
const content = fs.readFileSync(file, 'utf8');
const m = content.match(/APP_VERSION = '(\d+\.\d+\.)(\d+)'/);
if (!m) { console.error('Could not find version in', file); process.exit(1); }
const next    = parseInt(m[2], 10) + 1;
const version = `${m[1]}${next}`;
fs.writeFileSync(file, content.replace(/APP_VERSION = '[\d.]+'/, `APP_VERSION = '${version}'`));

// Every local asset reference (script/link tags in the HTML, and this same file list in sw.js)
// gets a ?v= query string bumped on every deploy. GitHub Pages' CDN caches these files for up
// to 10 minutes at the edge regardless of what cache-control a client fetch sends — an
// unversioned URL can keep serving a stale response through that whole window even to a
// freshly-loading page, which is what was actually behind the update-banner bugs: the page's
// own script/link tags (unversioned) could load stale, while an explicit cache-busted fetch
// elsewhere correctly saw the real latest version — two different truths on the same page. A
// version-stamped URL can't do that: it's a genuinely new cache key every deploy, so there's
// nothing stale to serve, because nothing has ever been requested at that exact URL before.
const ASSETS = [
  'style.css', 'app.js', 'admin.js', 'version.js',
  '../shared/firebase-config.js', '../shared/auth.js', '../shared/suite-nav.js', '../shared/embed.js',
];

function restamp(text) {
  for (const asset of ASSETS) {
    const escaped = asset.replace(/\./g, '\\.').replace(/\//g, '\\/');
    text = text.replace(new RegExp(`(["'/]${escaped})(\\?v=[\\d.]+)?(["'])`, 'g'), `$1?v=${version}$3`);
  }
  return text;
}

const swFile = 'sw.js';
let swContent = restamp(fs.readFileSync(swFile, 'utf8'));
// Update sw.js's own cache name so the browser detects a new service worker on every deploy.
swContent = swContent.replace(/const CACHE = 'expenses-[^']+'/, `const CACHE = 'expenses-${version}'`);
fs.writeFileSync(swFile, swContent);

for (const htmlFile of ['index.html', 'admin.html', 'help.html', 'admin-help.html']) {
  fs.writeFileSync(htmlFile, restamp(fs.readFileSync(htmlFile, 'utf8')));
}

console.log(`Version: ${version}`);
