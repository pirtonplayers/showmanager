'use strict';

// Single Firebase project shared by every app under showmanager (portal, expenses, showdrinks
// admin, budget) — this is what makes "one login" work: same project, same Firebase Auth
// persistence, same origin, so signing in on one app's login screen leaves you signed in on
// every other page of this site too. showdrinks' customer-facing order.js never touches Auth at
// all, so this file loading there is harmless (just gives it a `db` handle).
const firebaseConfig = {
  apiKey: "AIzaSyDFL9_qnmA1429Ii3hMt4gSneS3Si2mafI",
  authDomain: "pirton-players-showmanager.firebaseapp.com",
  projectId: "pirton-players-showmanager",
  storageBucket: "pirton-players-showmanager.firebasestorage.app",
  messagingSenderId: "18675899434",
  appId: "1:18675899434:web:0a3cbeb9c7053d1b343753"
};

firebase.initializeApp(firebaseConfig);

// Explicit persistence, set immediately — without this, the Auth SDK's own auto-detection step
// (choosing the best persistence + a cross-tab/third-party-storage check via a hidden
// Google-hosted iframe, evidenced by apis.google.com/js/api.js + gapi_iframes showing up in the
// suite's load-time diagnostics) can hang for many seconds on iOS Safari specifically — its
// storage partitioning makes that check slow to resolve — before falling back to exactly this
// same LOCAL persistence anyway. Measured as a ~13s delay before onAuthStateChanged ever fired
// on ShowBudget, despite every script/resource itself loading in well under a second.
// showdrinks/index.html (the customer PWA, no login of its own) never loads
// firebase-auth-compat.js at all, so this is guarded rather than assumed present.
if (firebase.auth) firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);

const db = firebase.firestore();
