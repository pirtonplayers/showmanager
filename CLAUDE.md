showmanager brings expenses, showdrinks and a new showbudget app under one site, one Firebase
project (pirton-players-showmanager), and one shared login.

Structure: `/` is the portal (shared login, Users management). `/expenses/`, `/showdrinks/`,
`/budget/` are each their own app, each with its own login screen (same session — same Firebase
project/origin — so signing in on one leaves you signed in on all). `shared/firebase-config.js`
and `shared/auth.js` are loaded by every app; `shared/auth.js`'s `checkAccess(uid, key)` is how
each app's login gate checks the shared `users/{uid}` doc's `isManager`/`access.{key}` fields —
see README.md's "Access model" section for the full shape.

Firestore collections are prefixed per app (`expenses_shows`, `showdrinks_orders`, `budget_shows`,
...) because `expenses` and `showdrinks` both used bare `shows`/`config` before merging into one
database — see the comment block at the top of `firestore.rules`. `users` and `expenses` are the
only unprefixed collections (no collision).

`functions/index.js` is one merged Cloud Functions codebase for every app (region
europe-west1 throughout — the client always requests that region explicitly, so a function
deployed anywhere else 404s from every app).

expenses/showdrinks/budget were ported from their original separate repos (still live at
antonjung.github.io/expenses and /showdrinks) — `migration/MIGRATION.md` is the one-time,
manually-run step for moving their real data/users into this project; it is not part of normal
development here.
