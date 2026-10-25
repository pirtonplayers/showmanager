'use strict';

// Admin results page, reached by its own QR code (…/results.html?k=<key>) — no login. The key is
// checked server-side by the getVoteTotals Cloud Function; vote_totals itself is unreadable
// from the client.

const $ = id => document.getElementById(id);
const key = new URLSearchParams(location.search).get('k') || '';
const getVoteTotals = firebase.app().functions('europe-west1').httpsCallable('getVoteTotals');

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

async function load() {
  showError('');
  try {
    const { data } = await getVoteTotals({ key });
    const guilty = data.guilty || 0;
    const notGuilty = data.notGuilty || 0;
    const total = guilty + notGuilty;
    $('guiltyCount').textContent = guilty;
    $('notGuiltyCount').textContent = notGuilty;
    $('guiltyBar').style.width = total ? `${(guilty / total) * 100}%` : '0';
    $('notGuiltyBar').style.width = total ? `${(notGuilty / total) * 100}%` : '0';
    $('total').textContent = `Total votes: ${total}`;
  } catch (err) {
    console.error(err);
    showError(err.code === 'functions/permission-denied' ? 'Invalid results key.' : 'Could not load the results.');
  }
}

$('refreshBtn').addEventListener('click', load);
load();
setInterval(load, 10000);
