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

const db = firebase.firestore();
