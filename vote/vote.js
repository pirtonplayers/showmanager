'use strict';

// Anonymous guilty / not-guilty ballot, reached by QR code — no login. Totals live in one
// write-only doc, vote_totals/verdict, bumped with atomic increments so concurrent voters never
// overwrite each other; voters can't read it (the admin reads it via results.html). "One vote per
// person" is only enforced per browser (localStorage).

const totalsRef = db.collection('vote_totals').doc('verdict');
const VOTED_KEY = 'vote_verdict_cast';

const $ = id => document.getElementById(id);

function readVoted() {
  try { return localStorage.getItem(VOTED_KEY); } catch { return null; }
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

function lockBallot(choice) {
  $('ballot').hidden = true;
  $('prompt').hidden = true;
  $('thanks').hidden = false;
  $('thanks').textContent = `Thank you — your vote (${choice === 'guilty' ? 'Guilty' : 'Not guilty'}) has been recorded.`;
}

async function castVote(field) {
  $('guiltyBtn').disabled = $('notGuiltyBtn').disabled = true;
  showError('');
  const inc = n => firebase.firestore.FieldValue.increment(n);
  try {
    // Both fields in every write so the rules see a complete doc on the very first vote too.
    await totalsRef.set({
      guilty: inc(field === 'guilty' ? 1 : 0),
      notGuilty: inc(field === 'notGuilty' ? 1 : 0),
    }, { merge: true });
    try { localStorage.setItem(VOTED_KEY, field); } catch { /* private mode: vote still counted */ }
    lockBallot(field);
  } catch (err) {
    console.error(err);
    showError('Sorry, your vote could not be recorded. Please try again.');
    $('guiltyBtn').disabled = $('notGuiltyBtn').disabled = false;
  }
}

$('guiltyBtn').addEventListener('click', () => castVote('guilty'));
$('notGuiltyBtn').addEventListener('click', () => castVote('notGuilty'));

const already = readVoted();
if (already) lockBallot(already);
