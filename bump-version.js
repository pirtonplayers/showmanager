#!/usr/bin/env node
'use strict';
// Bumps the portal's own version (root index.html/portal.js/sw.js). Each app under showmanager
// (expenses/, showdrinks/, budget/) versions itself independently with its own bump-version.js —
// run this one when you change root-level files (index.html, portal.js, style.css, shared/*).
const fs = require('fs');
const file = 'version.js';
const content = fs.readFileSync(file, 'utf8');
const m = content.match(/APP_VERSION = '(\d+\.\d+\.)(\d+)'/);
if (!m) { console.error('Could not find version in', file); process.exit(1); }
const next    = parseInt(m[2], 10) + 1;
const version = `${m[1]}${next}`;
fs.writeFileSync(file, content.replace(/APP_VERSION = '[\d.]+'/, `APP_VERSION = '${version}'`));

const ASSETS = ['style.css', 'portal.js', 'version.js', 'shared/firebase-config.js', 'shared/auth.js', 'shared/suite-nav.js', 'shared/a2hs.js'];

function restamp(text) {
  for (const asset of ASSETS) {
    const escaped = asset.replace(/\./g, '\\.').replace(/\//g, '\\/');
    text = text.replace(new RegExp(`(["'/]${escaped})(\\?v=[\\d.]+)?(["'])`, 'g'), `$1?v=${version}$3`);
  }
  return text;
}

const swFile = 'sw.js';
let swContent = restamp(fs.readFileSync(swFile, 'utf8'));
swContent = swContent.replace(/const CACHE = 'portal-[^']+'/, `const CACHE = 'portal-${version}'`);
fs.writeFileSync(swFile, swContent);

fs.writeFileSync('index.html', restamp(fs.readFileSync('index.html', 'utf8')));

console.log(`Version: ${version}`);
