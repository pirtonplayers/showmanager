'use strict';

// One access model, shared by every app's login screen: a single users/{uid} Firestore doc
// (name, email, mustChangePassword, isManager, access: { expenses, expensesAdmin,
// showdrinksAdmin, budget }). isManager always passes every check below — it's the portal-level
// role that manages users/access for all apps and implicitly has every app's access too.
//
// Requires shared/firebase-config.js (for `db`) loaded first.

// Resolves to the users/{uid} doc's data if this account is allowed into the given app
// (isManager, or access[requiredKey] === true), or null if the doc is missing or the flag isn't
// set — the caller decides what "not allowed" looks like (usually: sign out with a message).
// Pass no requiredKey to just check "is this a real, provisioned account at all".
async function checkAccess(uid, requiredKey) {
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) return null;
  const data = doc.data();
  const allowed = data.isManager === true || !requiredKey || data.access?.[requiredKey] === true;
  return allowed ? data : null;
}

// The access flags in one place, so the portal's Users screen and every app's own display of
// "what you can reach" agree on the same list/labels.
const ACCESS_APPS = [
  { key: 'expenses',        label: 'Expenses — submit',      href: 'expenses/index.html' },
  { key: 'expensesAdmin',   label: 'Expenses — admin',        href: 'expenses/admin.html' },
  { key: 'showdrinksAdmin', label: 'ShowDrinks — admin',      href: 'showdrinks/admin.html' },
  { key: 'budget',          label: 'ShowBudget',              href: 'budget/index.html' },
];
