'use strict';

// Merged Cloud Functions for showmanager — expenses + showdrinks, one codebase, one shared
// users/{uid} access model (see firestore.rules). Region europe-west1 throughout, matching both
// source projects (the default us-central1 would 404 every callable from the client, which
// always requests europe-west1 explicitly).

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const nodemailer = require('nodemailer');

initializeApp();
const db = getFirestore();

const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const SMTP_FROM = defineSecret('SMTP_FROM');
const SMTP_SECRETS = [SMTP_USER, SMTP_PASS, SMTP_FROM];
const SSO_SECRET = defineSecret('SSO_SECRET');

const EXPENSES_ADMIN_URL = 'https://pirtonplayers.github.io/showmanager/expenses/admin.html';
const PORTAL_URL = 'https://pirtonplayers.github.io/showmanager/index.html';
const SHOWDRINKS_ORDER_URL = 'https://pirtonplayers.github.io/showmanager/showdrinks/index.html';

function transporter() {
  return nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() },
  });
}

function money(n) {
  return `£${Number(n).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Builds matching plain-text and HTML bodies from the same list of lines, so a link actually
// renders as a clickable <a> in HTML-capable mail clients.
function mailBody(lines) {
  const text = lines.join('\n');
  const html = lines
    .map(line => (/^https?:\/\/\S+$/.test(line) ? `<p><a href="${line}">${line}</a></p>` : line === '' ? '<br>' : `<p style="margin:0 0 8px">${escapeHtml(line)}</p>`))
    .join('\n');
  return { text, html };
}

async function getSettings(configCollection) {
  const doc = await db.collection(configCollection).doc('settings').get();
  return doc.exists ? doc.data() : {};
}

// A settings doc's "Sender email" field, falling back to the SMTP_FROM secret when unset.
function fromAddress(settings) {
  return settings.fromEmail || SMTP_FROM.value();
}

// ── Shared access checks ────────────────────────────────────────────────────
// Every callable re-checks the caller's OWN users/{uid} doc via the Admin SDK rather than
// trusting anything the client sends — same pattern the original expenses functions used.

async function callerDoc(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? doc.data() : null;
}

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
}

// isManager only — used for anything that manages users/access itself (createUser, deleteUser,
// resync). A per-app admin (expensesAdmin/showdrinksAdmin) can administer their own app but not
// grant access to others.
async function requireManager(request) {
  requireAuth(request);
  const data = await callerDoc(request.auth.uid);
  if (!data || data.isManager !== true) {
    throw new HttpsError('permission-denied', 'Only a manager can do this.');
  }
  return data;
}

// isManager OR the named per-app access flag.
async function requireAppAccess(request, key) {
  requireAuth(request);
  const data = await callerDoc(request.auth.uid);
  if (!data || (data.isManager !== true && data.access?.[key] !== true)) {
    throw new HttpsError('permission-denied', 'Only a manager can do this.');
  }
  return data;
}

// ── Sign in from pirtonplayers.org (Joomla) ──────────────────────────────────
// A menu item on the Joomla site points at joomla/showmanager-sso.php (repo root), which — for a
// member already logged in there — redirects here with their email, a timestamp and a random
// nonce, signed with a shared secret (HMAC-SHA256 over "email\nname\nts\nnonce"). This verifies the
// signature, that it's under two minutes old, and that the nonce hasn't been used before, then
// redirects to the portal with a Firebase custom token in the URL *fragment* (never sent to any
// server or logged), which portal.js exchanges for a real sign-in and immediately strips.
//
// A member with no showmanager account yet gets one created on their first visit — Expenses
// access only (submit their own expenses), no password (they always arrive via the website; the
// portal's "Forgot password?" can still set one). Never a Manager, and never touches an existing
// account's access. So anyone who can log in to the Joomla site with a given email gets that
// showmanager account (or a fresh Expenses-only one), which is why the Joomla script can also
// restrict by user group — and why portal admin stays behind a password: a Manager's account is
// refused here, so a compromised website can't hand out control of every app.
exports.ssoLogin = onRequest({ region: 'europe-west1', secrets: [SSO_SECRET] }, async (req, res) => {
  const back = (frag) => res.redirect(302, `${PORTAL_URL}#${frag}`);
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const name = String(req.query.name || '').trim().slice(0, 100) || email;
    const ts = Number(req.query.ts);
    const nonce = String(req.query.nonce || '');
    const sig = String(req.query.sig || '');

    const expected = crypto.createHmac('sha256', SSO_SECRET.value()).update(`${email}\n${name}\n${req.query.ts}\n${nonce}`).digest('hex');
    const sigOk = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    const skew = Math.round(Date.now() / 1000 - ts);
    if (!email || !sigOk || !/^[a-f0-9]{16,64}$/.test(nonce) || !Number.isFinite(ts) || Math.abs(skew) > 120) {
      console.warn('ssoLogin rejected', { emailGiven: !!email, sigOk, nonceOk: /^[a-f0-9]{16,64}$/.test(nonce), tsOk: Number.isFinite(ts), skewSeconds: skew });
      return back('sso-error=invalid');
    }
    try {
      await db.collection('portal_ssoNonces').doc(nonce).create({ email, usedAt: FieldValue.serverTimestamp() });
    } catch (err) { console.warn('ssoLogin nonce not stored', err.code || err.message); return back('sso-error=invalid'); } // already used — a replayed link

    let user;
    try {
      user = await getAuth().getUserByEmail(email);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      user = await getAuth().createUser({ email, displayName: name });
    }
    if (user.disabled) return back('sso-error=disabled');
    const userRef = db.collection('users').doc(user.uid);
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({
        name, email, isManager: false, mustChangePassword: false, ssoCreated: true,
        access: { expenses: true, expensesAdmin: false, showdrinksAdmin: false, showdrinksTabsPos: false, budget: false, showplanner: false },
        createdAt: FieldValue.serverTimestamp(),
      });
    } else if (doc.data().isManager === true) {
      return back('sso-error=manager');
    }

    const token = await getAuth().createCustomToken(user.uid);
    return back(`sso=${token}`);
  } catch (err) {
    console.error('ssoLogin failed', err);
    return back('sso-error=invalid');
  }
});

// ── Users (portal — shared across every app) ────────────────────────────────

// Create a login — accounts are provisioned by a manager, not self-registered. Sets
// mustChangePassword so every app's login blocks them from doing anything until they set their
// own password (firestore.rules only lets the account itself clear that one field).
exports.createUser = onCall({ region: 'europe-west1' }, async (request) => {
  await requireManager(request);

  const { name, email, password, isManager, access } = request.data || {};
  if (!name || !email || !password) {
    throw new HttpsError('invalid-argument', 'name, email and password are required.');
  }
  if (password.length < 6) {
    throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  }

  let userRecord;
  try {
    userRecord = await getAuth().createUser({ email, password, displayName: name });
  } catch (err) {
    throw new HttpsError('already-exists', err.message);
  }

  await db.collection('users').doc(userRecord.uid).set({
    name,
    email,
    isManager: isManager === true,
    access: {
      expenses: access?.expenses === true,
      expensesAdmin: access?.expensesAdmin === true,
      showdrinksAdmin: access?.showdrinksAdmin === true,
      showdrinksTabsPos: access?.showdrinksTabsPos === true,
      budget: access?.budget === true,
      showplanner: access?.showplanner === true,
    },
    mustChangePassword: true,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, uid: userRecord.uid };
});

// Edit an existing login's name/email/permissions — Manager-only, same as createUser. Email
// lives on the Firebase Auth record, not just the users/{uid} doc, so this needs the Admin SDK
// rather than a plain Firestore write (which is all changing just the name or permissions would
// otherwise need). The target still needs to sign out/in to see a changed email reflected in
// their own session.
exports.updateUserProfile = onCall({ region: 'europe-west1' }, async (request) => {
  await requireManager(request);

  const { uid, name, email, isManager, access } = request.data || {};
  if (!uid || !name || !email) {
    throw new HttpsError('invalid-argument', 'uid, name and email are required.');
  }

  try {
    await getAuth().updateUser(uid, { email, displayName: name });
  } catch (err) {
    throw new HttpsError('already-exists', err.message);
  }

  await db.collection('users').doc(uid).update({
    name,
    email,
    isManager: isManager === true,
    access: {
      expenses: access?.expenses === true,
      expensesAdmin: access?.expensesAdmin === true,
      showdrinksAdmin: access?.showdrinksAdmin === true,
      showdrinksTabsPos: access?.showdrinksTabsPos === true,
      budget: access?.budget === true,
      showplanner: access?.showplanner === true,
    },
  });

  return { ok: true };
});

// Create a player login scoped to expenses only (access.expenses, nothing else — never
// isManager, never another app) — expensesAdmin-only, not full-Manager-only like createUser.
// Lets an expenses admin onboard a cast/crew member for expense submission on the spot, from
// expenses/admin.html's own Users tab, without needing a portal Manager to do it via the
// portal's Users screen. Same mustChangePassword-on-first-login flow as every other account.
exports.createExpensesUser = onCall({ region: 'europe-west1' }, async (request) => {
  await requireAppAccess(request, 'expensesAdmin');

  const { name, email, password } = request.data || {};
  if (!name || !email || !password) {
    throw new HttpsError('invalid-argument', 'name, email and password are required.');
  }
  if (password.length < 6) {
    throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  }

  let userRecord;
  try {
    userRecord = await getAuth().createUser({ email, password, displayName: name });
  } catch (err) {
    throw new HttpsError('already-exists', err.message);
  }

  await db.collection('users').doc(userRecord.uid).set({
    name,
    email,
    isManager: false,
    access: { expenses: true, expensesAdmin: false, showdrinksAdmin: false, showdrinksTabsPos: false, budget: false, showplanner: false },
    mustChangePassword: true,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, uid: userRecord.uid };
});

// Every account with some expenses-related access — expensesAdmin-scoped listing for
// expenses/admin.html's own Users tab (firestore.rules only lets a non-manager read their own
// doc, so this has to go through a function). Deliberately returns only what that screen needs
// — never isManager or the other apps' access flags, so an expenses admin managing this list
// isn't shown who has ShowDrinks/Budget access.
exports.listExpensesUsers = onCall({ region: 'europe-west1' }, async (request) => {
  await requireAppAccess(request, 'expensesAdmin');
  const snap = await db.collection('users').get();
  const users = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(u => u.access?.expenses === true || u.access?.expensesAdmin === true)
    .map(u => ({
      id: u.id, name: u.name || u.email, email: u.email,
      access: { expenses: u.access?.expenses === true, expensesAdmin: u.access?.expensesAdmin === true },
      mustChangePassword: u.mustChangePassword === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, users };
});

// Any showplanner user can list who else has showplanner access — needed to assign roles/tasks
// to specific people. Same shape/reasoning as listExpensesUsers: firestore.rules only lets an
// account read its own users/{uid} doc (or a manager read anyone's), so a directory of OTHER
// people's names has to come from a callable using the Admin SDK, not a client-side query.
exports.listShowplannerUsers = onCall({ region: 'europe-west1' }, async (request) => {
  await requireAppAccess(request, 'showplanner');
  const snap = await db.collection('users').get();
  const users = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(u => u.access?.showplanner === true || u.isManager === true)
    .map(u => ({ id: u.id, name: u.name || u.email, email: u.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, users };
});

// Edits just name + access.expenses on an existing account — expensesAdmin-scoped (unlike the
// portal's general users/{uid} update, which is Manager-only). Deliberately can't touch email,
// access.expensesAdmin itself, isManager, or any other app — an expenses admin can't promote
// anyone (including themselves) beyond that, or touch anything not editable from this screen.
exports.setExpensesUserAccess = onCall({ region: 'europe-west1' }, async (request) => {
  await requireAppAccess(request, 'expensesAdmin');
  const { uid, value, name } = request.data || {};
  if (!uid || typeof value !== 'boolean') {
    throw new HttpsError('invalid-argument', 'uid and a boolean value are required.');
  }
  if (uid === request.auth.uid && value === false) {
    throw new HttpsError('failed-precondition', "You can't remove your own Expenses access this way.");
  }
  const update = { 'access.expenses': value };
  if (typeof name === 'string' && name.trim()) update.name = name.trim();
  await db.collection('users').doc(uid).update(update);
  return { ok: true };
});

// Permanently delete a user — their Firebase Auth login AND their users/{uid} doc. Callable only
// by a manager; a manager can't delete their own account this way (avoids locking everyone out
// by accident). Past expenses/orders/tabs store the person's name/email directly, not a
// reference to this doc, so deleting a user never breaks that history.
exports.deleteUser = onCall({ region: 'europe-west1' }, async (request) => {
  await requireManager(request);
  const targetUid = request.data?.uid;
  if (!targetUid || typeof targetUid !== 'string') {
    throw new HttpsError('invalid-argument', 'uid is required.');
  }
  if (targetUid === request.auth.uid) {
    throw new HttpsError('failed-precondition', "You can't delete your own account this way.");
  }

  await db.collection('users').doc(targetUid).delete();
  await getAuth().deleteUser(targetUid).catch((err) => {
    if (err.code !== 'auth/user-not-found') throw err;
  });

  return { ok: true };
});

// Emails someone a link to the portal (the one shared login every app sits behind) plus
// whatever note the manager typed. Manager-only — unlike sendUserLink below, this isn't scoped
// to one app's admin, since it's the portal's own Users screen sending it. Doesn't require the
// target to already have a users/{uid} doc, just an email address.
exports.sendPortalUserLink = onCall({ region: 'europe-west1', secrets: SMTP_SECRETS }, async (request) => {
  await requireManager(request);
  const email = request.data?.email;
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'email is required.');
  }
  const message = typeof request.data?.message === 'string' ? request.data.message.trim() : '';

  const settings = await getSettings('portal_config');
  await transporter().sendMail({
    from: fromAddress(settings),
    to: email,
    subject: 'Pirton Players',
    ...mailBody([
      ...(message ? [...message.split('\n'), ''] : []),
      'Open the app:',
      PORTAL_URL,
    ]),
  });

  return { ok: true };
});

// Emails a player a link to the portal (not the expenses entry app directly — sign-in is
// unified there now, and it's what shows them whatever tiles they actually have) plus whatever
// note the manager/expenses admin typed. expensesAdmin-only (it's the expenses Users tab's own
// send-link action); doesn't require the target to be an existing users/{uid} doc, just an
// email address, so it also works for pointing someone brand new at the app.
exports.sendUserLink = onCall({ region: 'europe-west1', secrets: SMTP_SECRETS }, async (request) => {
  await requireAppAccess(request, 'expensesAdmin');
  const email = request.data?.email;
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'email is required.');
  }
  const message = typeof request.data?.message === 'string' ? request.data.message.trim() : '';

  const settings = await getSettings('expenses_config');
  await transporter().sendMail({
    from: fromAddress(settings),
    to: email,
    subject: 'Pirton Players Expenses',
    ...mailBody([
      ...(message ? [...message.split('\n'), ''] : []),
      'Open the app:',
      PORTAL_URL,
    ]),
  });

  return { ok: true };
});

// Mirrors users/{uid}.isManager / access.expensesAdmin onto an `expensesAdmin` custom claim, so
// storage.rules can check request.auth.token.expensesAdmin instead of calling into Firestore
// (Storage→Firestore cross-service rules aren't enabled on this project). Fires on every
// users/{uid} write, including the one createUser itself makes.
//
// Custom claims only reach the client on its NEXT signed-in ID token — an already-open session
// needs to sign out/in (or force a token refresh) to pick up a change made just now.
exports.syncExpensesAdminClaim = onDocumentWritten('users/{uid}', async (event) => {
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  const expensesAdmin = after?.isManager === true || after?.access?.expensesAdmin === true;
  try {
    await getAuth().setCustomUserClaims(event.params.uid, { expensesAdmin: expensesAdmin || null });
  } catch (err) {
    // The doc can be deleted moments before/after the Auth account itself — nothing to set a
    // claim on at that point, and that's fine.
    if (err.code !== 'auth/user-not-found') throw err;
  }
});

// Manual/repeat version of the same sync, covering accounts whose doc predates
// syncExpensesAdminClaim, or a general "permissions seem stuck" fix-it button. Manager-only; the
// caller re-syncing their own claim still needs to sign out and back in afterward.
exports.resyncExpensesAdminClaims = onCall({ region: 'europe-west1' }, async (request) => {
  await requireManager(request);

  const snap = await db.collection('users').get();
  let updated = 0;
  for (const doc of snap.docs) {
    const expensesAdmin = doc.data().isManager === true || doc.data().access?.expensesAdmin === true;
    try {
      await getAuth().setCustomUserClaims(doc.id, { expensesAdmin: expensesAdmin || null });
      updated++;
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
    }
  }
  return { ok: true, updated };
});

// ── Expenses ─────────────────────────────────────────────────────────────

// Sums the actual size of every stored receipt — the project's on the Blaze plan (pay-as-you-go,
// no fixed quota), so "used" is the number that's actually actionable. expensesAdmin-only, since
// it reads every receipt's metadata (cheap, but still real work).
exports.getStorageUsage = onCall({ region: 'europe-west1' }, async (request) => {
  await requireAppAccess(request, 'expensesAdmin');
  const [files] = await getStorage().bucket().getFiles({ prefix: 'receipts/' });
  const totalBytes = files.reduce((sum, f) => sum + Number(f.metadata.size || 0), 0);
  return { ok: true, totalBytes, fileCount: files.length };
});

// Notify expensesAdmins when a player submits new expenses — called once by the entry app after
// a "Submit all" batch finishes (not a Firestore trigger on expenses/{id}: that fires once per
// document, so a multi-expense submission would send that many separate emails instead of one
// summary). Re-reads each expense from Firestore by id rather than trusting the client.
exports.notifyExpensesSubmitted = onCall({ region: 'europe-west1', secrets: SMTP_SECRETS }, async (request) => {
  requireAuth(request);
  const ids = request.data?.ids;
  if (!Array.isArray(ids) || !ids.length) {
    throw new HttpsError('invalid-argument', 'ids is required.');
  }

  const settings = await getSettings('expenses_config');
  const notifyEmails = settings.notifyEmails || [];
  if (!notifyEmails.length) return { ok: true };

  const docs = await Promise.all(ids.map(id => db.collection('expenses').doc(id).get()));
  const expenses = docs
    .filter(d => d.exists && d.data().userEmail === request.auth.token.email)
    .map(d => d.data());
  if (!expenses.length) return { ok: true };

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const receiptTotal = expenses.reduce((sum, e) => sum + (e.receiptPaths?.length || (e.receiptPath ? 1 : 0)), 0);
  const { userName, userEmail } = expenses[0];

  await transporter().sendMail({
    from: fromAddress(settings),
    to: notifyEmails,
    subject: 'New expense added',
    ...mailBody([
      `${userName} (${userEmail}) submitted ${expenses.length} new expense${expenses.length === 1 ? '' : 's'}.`,
      '',
      ...expenses.map(e => `- ${e.referenceNumber ? '#' + e.referenceNumber + ' ' : ''}${e.showName}: ${e.description} — ${money(e.amount)}`),
      '',
      `Total: ${money(total)}`,
      receiptTotal ? `${receiptTotal} receipt photo${receiptTotal === 1 ? '' : 's'} attached — view them in the admin app.` : 'No receipts attached.',
      '',
      'Review it:',
      EXPENSES_ADMIN_URL,
    ]),
  });

  return { ok: true };
});

// Notify a player once a batch of their expenses is marked paid — called once by the admin app
// after a "Mark as paid" batch finishes (same one-email-per-batch reasoning as
// notifyExpensesSubmitted). Groups by submitter in case ids ever span more than one person.
exports.notifyExpensesPaid = onCall({ region: 'europe-west1', secrets: SMTP_SECRETS }, async (request) => {
  await requireAppAccess(request, 'expensesAdmin');
  const ids = request.data?.ids;
  if (!Array.isArray(ids) || !ids.length) {
    throw new HttpsError('invalid-argument', 'ids is required.');
  }

  const docs = await Promise.all(ids.map(id => db.collection('expenses').doc(id).get()));
  const expenses = docs.filter(d => d.exists && d.data().paid === true).map(d => d.data());
  if (!expenses.length) return { ok: true };

  const byEmail = new Map();
  for (const e of expenses) {
    if (!byEmail.has(e.userEmail)) byEmail.set(e.userEmail, []);
    byEmail.get(e.userEmail).push(e);
  }

  const settings = await getSettings('expenses_config');
  for (const [userEmail, own] of byEmail) {
    const total = own.reduce((sum, e) => sum + Number(e.amount), 0);
    await transporter().sendMail({
      from: fromAddress(settings),
      to: userEmail,
      subject: 'Your expenses have been paid',
      ...mailBody([
        `Hi ${own[0].userName},`,
        '',
        `${own.length} expense${own.length === 1 ? ' has' : 's have'} been marked as paid:`,
        '',
        ...own.map(e => `- ${e.referenceNumber ? '#' + e.referenceNumber + ' ' : ''}${e.showName}: ${e.description} — ${money(e.amount)}`),
        '',
        `Total: ${money(total)}`,
        '',
        'Thanks,',
        'Pirton Players',
      ]),
    });
  }

  return { ok: true };
});

// ── ShowDrinks ───────────────────────────────────────────────────────────

// The Show Tabs ✉ button — emails a cast/crew member their outstanding tab. showdrinksAdmin-only
// (was a bare "signed in" check before the shared access model existed).
exports.sendMemberEmail = onCall({ region: 'europe-west1', secrets: SMTP_SECRETS }, async (request) => {
  await requireAppAccess(request, 'showdrinksAdmin');

  const { to, subject, body } = request.data || {};
  if (!to || !subject || !body) {
    throw new HttpsError('invalid-argument', 'to, subject, and body are required.');
  }

  const settings = await getSettings('showdrinks_config');
  await transporter().sendMail({ from: fromAddress(settings), to, subject, text: body });

  return { ok: true };
});

// Show-override-then-system-default resolution for SumUp's merchant code/API key — same rule the
// Show Editor's own "Payment Settings (this show)" card documents ("leave blank to fall back to
// the system defaults"), and the same "currently active show" (isCurrent==true) every other
// payment-settings read in this app keys off, not the order's own showDate.
async function sumupCredentials() {
  const [showSnap, settingsDoc, systemSecretDoc] = await Promise.all([
    db.collection('showdrinks_shows').where('isCurrent', '==', true).limit(1).get(),
    db.collection('showdrinks_config').doc('settings').get(),
    db.collection('showdrinks_secrets').doc('system').get(),
  ]);
  const currentShowDoc = showSnap.empty ? null : showSnap.docs[0];
  const currentShow = currentShowDoc ? currentShowDoc.data() : {};
  const showSecretDoc = currentShowDoc ? await db.collection('showdrinks_secrets').doc('show_' + currentShowDoc.id).get() : null;
  // Credentials live in showdrinks_secrets (not publicly readable); the old fields on the show/
  // settings docs are still read as a fallback until the admin UI has migrated them across.
  const showSecret = showSecretDoc && showSecretDoc.exists ? showSecretDoc.data() : {};
  const systemSecret = systemSecretDoc.exists ? systemSecretDoc.data() : {};
  const settings = settingsDoc.exists ? settingsDoc.data() : {};
  return {
    merchantCode: showSecret.sumupMerchantCode || currentShow.sumupMerchantCode || systemSecret.sumupMerchantCode || settings.sumupMerchantCode,
    apiKey: showSecret.sumupApiKey || currentShow.sumupApiKey || systemSecret.sumupApiKey || settings.sumupApiKey,
  };
}

// Creates a real SumUp Hosted Checkout (https://developer.sumup.com/online-payments/checkouts/
// hosted-checkout) and hands back its hosted_checkout_url for the client to redirect to. This has
// to happen server-side — it's the only way to use the merchant's SumUp API key without ever
// putting it in front of the (unauthenticated, public) customer PWA. No caller-auth check here,
// matching showdrinks_orders' own firestore.rules (create/update: if true) — the whole ordering
// flow already trusts the client for what's IN the order; this only adds the one thing that
// can't be trusted client-side, the API key itself.
exports.createSumupCheckout = onCall({ region: 'europe-west1' }, async (request) => {
  const orderId = request.data?.orderId;
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpsError('invalid-argument', 'orderId is required.');
  }

  const orderRef = db.collection('showdrinks_orders').doc(orderId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) throw new HttpsError('not-found', 'Order not found.');
  const order = orderDoc.data();
  if (order.paymentMode !== 'sumup') {
    throw new HttpsError('failed-precondition', 'This order is not set up for online payment.');
  }
  if (order.paymentStatus === 'paid') {
    throw new HttpsError('failed-precondition', 'This order has already been paid.');
  }

  const { merchantCode, apiKey } = await sumupCredentials();
  if (!merchantCode || !apiKey) {
    throw new HttpsError('failed-precondition', 'SumUp is not configured for this show.');
  }

  // A re-tap of "Pay Online" before the first redirect actually happens (slow connection, etc.)
  // would otherwise hit SumUp's 409 (checkout_reference, which we set to orderId, must be unique
  // per merchant) — re-use the checkout already created for this order instead of erroring.
  if (order.sumupCheckoutId) {
    const existing = await fetch(`https://api.sumup.com/v0.1/checkouts/${order.sumupCheckoutId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (existing?.hosted_checkout_url && existing.status === 'PENDING') {
      return { hostedCheckoutUrl: existing.hosted_checkout_url };
    }
  }

  const redirectUrl = `${SHOWDRINKS_ORDER_URL}?sumup=return&ref=${encodeURIComponent(orderId)}`;
  const res = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      checkout_reference: orderId,
      amount: Number(Number(order.totalAmount || 0).toFixed(2)),
      currency: 'GBP',
      merchant_code: merchantCode,
      // A buy-now order shows up on SumUp's sales screen under its session's name.
      description: order.buyNow && order.sessionName
        ? order.sessionName
        : `ShowDrinks order${order.orderNumber ? ' #' + order.orderNumber : ''}`,
      redirect_url: redirectUrl,
      hosted_checkout: { enabled: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.hosted_checkout_url) {
    console.error('SumUp checkout creation failed', res.status, data);
    throw new HttpsError('internal', data.message || 'Could not start SumUp checkout.');
  }

  await orderRef.update({ sumupCheckoutId: data.id, updatedAt: FieldValue.serverTimestamp() });

  return { hostedCheckoutUrl: data.hosted_checkout_url };
});

// Called when the customer's browser returns from SumUp's hosted checkout page (order.js's
// init(), on seeing ?sumup=return&ref=...) — that query param only ever means "they're back",
// never "they paid" (nothing stops a customer hand-editing the URL to claim success), so this
// always re-checks the REAL status with SumUp's own API before ever marking an order paid.
exports.verifySumupPayment = onCall({ region: 'europe-west1' }, async (request) => {
  const orderId = request.data?.orderId;
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpsError('invalid-argument', 'orderId is required.');
  }

  const orderRef = db.collection('showdrinks_orders').doc(orderId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) throw new HttpsError('not-found', 'Order not found.');
  const order = orderDoc.data();
  if (order.paymentStatus === 'paid') return { paid: true };
  if (!order.sumupCheckoutId) {
    throw new HttpsError('failed-precondition', 'No SumUp checkout was started for this order.');
  }

  const { apiKey } = await sumupCredentials();
  if (!apiKey) throw new HttpsError('failed-precondition', 'SumUp is not configured.');

  const res = await fetch(`https://api.sumup.com/v0.1/checkouts/${order.sumupCheckoutId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('SumUp checkout status check failed', res.status, data);
    throw new HttpsError('internal', 'Could not confirm payment status with SumUp.');
  }

  if (data.status === 'PAID') {
    // A buy-now order is handed over on the spot, so paying for it is also collecting it.
    const paidUpdate = { paymentStatus: 'paid', updatedAt: FieldValue.serverTimestamp() };
    if (order.buyNow) Object.assign(paidUpdate, { prepStatus: 'collected', collectedAt: FieldValue.serverTimestamp() });
    await orderRef.update(paidUpdate);
    return { paid: true };
  }
  return { paid: false, status: data.status };
});

// ── ShowDrinks payment links ─────────────────────────────────────────────
// A payment link (showdrinks_payLinks/{id}: title, amount) is a fixed-price single item — a
// rehearsal sub, say — that anyone can pay via a QR/URL (showdrinks/index.html?pay=<id>). Each
// link can carry its own SumUp merchant code/API key (showdrinks_secrets/paylink_<id>, admin-only),
// so subs can go to a different SumUp profile than the bar; blank falls back to the system
// default (never the bar's current show). Each attempt is a showdrinks_payments doc (admin-readable).

async function payLinkCredentials(linkId) {
  const secretDoc = await db.collection('showdrinks_secrets').doc('paylink_' + linkId).get();
  const secret = secretDoc.exists ? secretDoc.data() : {};
  if (secret.sumupMerchantCode && secret.sumupApiKey) {
    return { merchantCode: secret.sumupMerchantCode, apiKey: secret.sumupApiKey };
  }
  // System default only — payment links deliberately ignore the bar's current show (and its
  // per-show SumUp override), which has nothing to do with a rehearsal sub.
  const [systemSecretDoc, settingsDoc] = await Promise.all([
    db.collection('showdrinks_secrets').doc('system').get(),
    db.collection('showdrinks_config').doc('settings').get(),
  ]);
  const systemSecret = systemSecretDoc.exists ? systemSecretDoc.data() : {};
  const settings = settingsDoc.exists ? settingsDoc.data() : {};
  return {
    merchantCode: systemSecret.sumupMerchantCode || settings.sumupMerchantCode,
    apiKey: systemSecret.sumupApiKey || settings.sumupApiKey,
  };
}

exports.createPaymentLinkCheckout = onCall({ region: 'europe-west1' }, async (request) => {
  const { linkId, payerName } = request.data || {};
  if (!linkId || typeof linkId !== 'string') throw new HttpsError('invalid-argument', 'linkId is required.');
  const name = typeof payerName === 'string' ? payerName.trim().slice(0, 80) : '';
  if (!name) throw new HttpsError('invalid-argument', 'Please enter your name.');

  const linkDoc = await db.collection('showdrinks_payLinks').doc(linkId).get();
  if (!linkDoc.exists || linkDoc.data().active === false) {
    throw new HttpsError('not-found', 'This payment link is no longer active.');
  }
  const link = linkDoc.data();
  const amount = Number(Number(link.amount || 0).toFixed(2));
  if (!(amount > 0)) throw new HttpsError('failed-precondition', 'This payment link has no amount set.');

  const paymentRef = db.collection('showdrinks_payments').doc();

  // Test links never touch SumUp: the payment page walks through a pretend checkout and calls
  // verifyPaymentLinkPayment with a testOutcome, which only a test payment accepts.
  if (link.testMode) {
    await paymentRef.set({
      linkId, showId: link.showId || null, linkTitle: link.title, payerName: name, amount,
      paymentStatus: 'pending', test: true, createdAt: FieldValue.serverTimestamp(),
    });
    return { test: true, paymentId: paymentRef.id, linkId };
  }

  const { merchantCode, apiKey } = await payLinkCredentials(linkId);
  if (!merchantCode || !apiKey) throw new HttpsError('failed-precondition', 'SumUp is not configured for this link.');

  const res = await fetch('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      checkout_reference: 'link-' + paymentRef.id,
      amount,
      currency: 'GBP',
      merchant_code: merchantCode,
      description: `${link.title} – ${name}`,
      redirect_url: `${SHOWDRINKS_ORDER_URL}?sumup=return&payment=${encodeURIComponent(paymentRef.id)}`,
      hosted_checkout: { enabled: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.hosted_checkout_url) {
    console.error('SumUp payment-link checkout creation failed', res.status, data);
    throw new HttpsError('internal', data.message || 'Could not start SumUp checkout.');
  }

  await paymentRef.set({
    linkId, showId: link.showId || null, linkTitle: link.title, payerName: name, amount,
    paymentStatus: 'pending', sumupCheckoutId: data.id,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { hostedCheckoutUrl: data.hosted_checkout_url, linkId };
});

// Same rule as verifySumupPayment: the return URL only means "they're back"; the real status
// always comes from SumUp's own API.
exports.verifyPaymentLinkPayment = onCall({ region: 'europe-west1' }, async (request) => {
  const paymentId = request.data?.paymentId;
  if (!paymentId || typeof paymentId !== 'string') throw new HttpsError('invalid-argument', 'paymentId is required.');

  const paymentRef = db.collection('showdrinks_payments').doc(paymentId);
  const paymentDoc = await paymentRef.get();
  if (!paymentDoc.exists) throw new HttpsError('not-found', 'Payment not found.');
  const p = paymentDoc.data();
  const linkDoc = await db.collection('showdrinks_payLinks').doc(p.linkId).get();
  const info = { title: p.linkTitle, amount: p.amount, linkId: p.linkId, message: linkDoc.exists ? (linkDoc.data().successMessage || '') : '' };
  if (p.paymentStatus === 'paid') return { paid: true, test: !!p.test, ...info };

  if (p.test) {
    if (request.data?.testOutcome === 'paid') {
      await paymentRef.update({ paymentStatus: 'paid', paidAt: FieldValue.serverTimestamp() });
      return { paid: true, test: true, ...info };
    }
    return { paid: false, test: true, ...info };
  }

  const { apiKey } = await payLinkCredentials(p.linkId);
  if (!apiKey) throw new HttpsError('failed-precondition', 'SumUp is not configured.');
  const res = await fetch(`https://api.sumup.com/v0.1/checkouts/${p.sumupCheckoutId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('SumUp payment-link status check failed', res.status, data);
    throw new HttpsError('internal', 'Could not confirm payment status with SumUp.');
  }
  if (data.status === 'PAID') {
    await paymentRef.update({ paymentStatus: 'paid', paidAt: FieldValue.serverTimestamp() });
    return { paid: true, ...info };
  }
  return { paid: false, status: data.status, ...info };
});
