#!/usr/bin/env node
'use strict';

// One-time migration: copies Firestore data + recreates user accounts from the two live source
// projects (pirton-players-expenses, showdrinks) into the new shared project
// (pirton-players-showmanager). Run by hand, by you — never by an agent — after reading
// MIGRATION.md. Defaults to --dry-run (reads only, writes nothing) so you can sanity-check the
// counts and the generated users list before the real thing.
//
// Usage:
//   node migrate.js --dry-run          (default — read-only, prints what it WOULD do)
//   node migrate.js --write            (does it for real)
//
// Requires three service account key files (see MIGRATION.md for how to download each):
//   EXPENSES_SA_KEY=./keys/expenses-sa.json
//   SHOWDRINKS_SA_KEY=./keys/showdrinks-sa.json
//   SHOWMANAGER_SA_KEY=./keys/showmanager-sa.json
// set as environment variables before running.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const WRITE = process.argv.includes('--write');
const DRY_RUN = !WRITE;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable ${name} — see MIGRATION.md.`);
    process.exit(1);
  }
  return v;
}

function initApp(name, keyPathEnv) {
  const keyPath = requireEnv(keyPathEnv);
  const cred = JSON.parse(fs.readFileSync(path.resolve(keyPath), 'utf8'));
  return admin.initializeApp({ credential: admin.credential.cert(cred) }, name);
}

const expensesApp    = initApp('expenses', 'EXPENSES_SA_KEY');
const showdrinksApp   = initApp('showdrinks', 'SHOWDRINKS_SA_KEY');
const showmanagerApp = initApp('showmanager', 'SHOWMANAGER_SA_KEY');

const expensesDb    = expensesApp.firestore();
const showdrinksDb   = showdrinksApp.firestore();
const targetDb       = showmanagerApp.firestore();
const targetAuth     = showmanagerApp.auth();

function log(...args) { console.log(...args); }

// ── 1. Firestore collection copy (structure/renaming only — see firestore.rules comment block
//    at the top of the repo for why these get prefixed) ────────────────────────────────────────

const FIRESTORE_COPIES = [
  { from: expensesDb,  fromCollection: 'shows',       toCollection: 'expenses_shows' },
  { from: expensesDb,  fromCollection: 'config',      toCollection: 'expenses_config' },
  { from: expensesDb,  fromCollection: 'expenses',    toCollection: 'expenses' },
  { from: showdrinksDb, fromCollection: 'shows',       toCollection: 'showdrinks_shows' },
  { from: showdrinksDb, fromCollection: 'config',      toCollection: 'showdrinks_config' },
  { from: showdrinksDb, fromCollection: 'menuItems',   toCollection: 'showdrinks_menuItems' },
  { from: showdrinksDb, fromCollection: 'locations',   toCollection: 'showdrinks_locations' },
  { from: showdrinksDb, fromCollection: 'posGrids',    toCollection: 'showdrinks_posGrids' },
  { from: showdrinksDb, fromCollection: 'counters',    toCollection: 'showdrinks_counters' },
  { from: showdrinksDb, fromCollection: 'orders',      toCollection: 'showdrinks_orders' },
  { from: showdrinksDb, fromCollection: 'tabMembers',  toCollection: 'showdrinks_tabMembers' },
  { from: showdrinksDb, fromCollection: 'tabOrders',   toCollection: 'showdrinks_tabOrders' },
];

async function copyCollections() {
  for (const { from, fromCollection, toCollection } of FIRESTORE_COPIES) {
    const snap = await from.collection(fromCollection).get();
    log(`${fromCollection} -> ${toCollection}: ${snap.size} doc(s)`);
    if (DRY_RUN || snap.empty) continue;
    let batch = targetDb.batch();
    let n = 0;
    for (const doc of snap.docs) {
      batch.set(targetDb.collection(toCollection).doc(doc.id), doc.data());
      n++;
      if (n % 400 === 0) { await batch.commit(); batch = targetDb.batch(); }
    }
    await batch.commit();
  }
}

// ── 2. Users ─────────────────────────────────────────────────────────────
// expenses/users/{uid} already has the shape we want (name, email, isManager, approved,
// mustChangePassword) — approved becomes access.expenses, isManager becomes access.expensesAdmin
// (kept OUT of the new isManager flag: the old expenses "manager" role only ever managed
// expenses, not every app — promote someone to full portal Manager by hand afterwards if they
// should have that). showdrinks never had a users collection — every one of its Firebase Auth
// accounts WAS an admin by definition (bare "signed in" gate), so each becomes an
// access.showdrinksAdmin account here. Matched and merged by email.
//
// Passwords are NOT carried over (see MIGRATION.md for why) — every migrated account gets a
// fresh random temporary password and mustChangePassword:true, the same flow used for every
// account created normally. The generated passwords are written to
// migration-output/credentials.csv for you to distribute — that file is not committed and not
// emailed by this script.

function randomTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, c => ({ '+': 'A', '/': 'B', '=': '' }[c]));
}

async function buildMergedUsers() {
  const merged = new Map(); // email -> { name, isManager, access, sourceUids }

  const expUsersSnap = await expensesDb.collection('users').get();
  for (const doc of expUsersSnap.docs) {
    const d = doc.data();
    if (!d.email) continue;
    const email = d.email.toLowerCase();
    merged.set(email, {
      name: d.name || d.email,
      isManager: false, // see comment above — promote by hand if they should manage the whole portal
      access: { expenses: d.approved === true, expensesAdmin: d.isManager === true, showdrinksAdmin: false, budget: false },
    });
  }

  const sdUsersResult = await showdrinksApp.auth().listUsers(1000);
  for (const u of sdUsersResult.users) {
    if (!u.email) continue;
    const email = u.email.toLowerCase();
    const existing = merged.get(email);
    if (existing) {
      existing.access.showdrinksAdmin = true;
    } else {
      merged.set(email, {
        name: u.displayName || u.email,
        isManager: false,
        access: { expenses: false, expensesAdmin: false, showdrinksAdmin: true, budget: false },
      });
    }
  }

  return merged;
}

async function createMergedUsers(merged) {
  const rows = [['name', 'email', 'temp_password', 'access']];
  for (const [email, u] of merged) {
    log(`user: ${email} — manager=${u.isManager} access=${JSON.stringify(u.access)}`);
    if (DRY_RUN) continue;
    const tempPassword = randomTempPassword();
    let userRecord;
    try {
      userRecord = await targetAuth.createUser({ email, password: tempPassword, displayName: u.name });
    } catch (err) {
      console.error(`  FAILED to create ${email}: ${err.message}`);
      continue;
    }
    await targetDb.collection('users').doc(userRecord.uid).set({
      name: u.name, email, isManager: u.isManager, access: u.access,
      mustChangePassword: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    rows.push([u.name, email, tempPassword, JSON.stringify(u.access)]);
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.join(__dirname, 'migration-output'), { recursive: true });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    fs.writeFileSync(path.join(__dirname, 'migration-output', 'credentials.csv'), csv);
    log('\nWrote migration/migration-output/credentials.csv — distribute these temporary passwords securely, then delete the file.');
  }
}

// ── Run ──────────────────────────────────────────────────────────────────

(async () => {
  log(DRY_RUN ? '=== DRY RUN — reading only, nothing will be written ===' : '=== WRITE MODE — this will create real accounts and data ===');
  await copyCollections();
  const merged = await buildMergedUsers();
  log(`\n${merged.size} user(s) to create in the target project:`);
  await createMergedUsers(merged);
  log('\nDone.' + (DRY_RUN ? ' Re-run with --write when the counts above look right.' : ''));
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
