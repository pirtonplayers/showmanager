# Migrating expenses + showdrinks into showmanager

This is the one genuinely irreversible step in this project: moving real people's logins and
real financial/order data from the two live projects (`pirton-players-expenses`, `showdrinks`)
into the new shared one (`pirton-players-showmanager`). Do this yourself, deliberately, not as
something an agent runs unattended — read this whole file first.

## Before you start

The new project needs three things set up in the
[Firebase Console](https://console.firebase.google.com/project/pirton-players-showmanager) —
none of these can be done from the CLI:

1. **Firestore** → Create database → production mode → same region as the old projects (`eur3`).
2. **Storage** → Get started (accept the default bucket) — needed for expense receipts.
3. **Authentication** → Sign-in method → enable **Email/Password**.
4. **Upgrade to the Blaze plan** (Settings → Usage and billing) — needed for Cloud Functions and
   Storage, same as both existing projects already are.

Then from the repo root:
```
firebase deploy --only firestore:rules,firestore:indexes,storage,functions --project pirton-players-showmanager
```

## Why passwords aren't carried over

Firebase Auth *can* export/import password hashes between projects, but only by also exporting
that project's scrypt signing key — a genuinely sensitive secret, and easy to get wrong in a way
that quietly breaks sign-in for everyone. Instead, `migrate.js` creates every migrated account
fresh with a new random temporary password and `mustChangePassword: true` — **exactly the flow
the app already uses for every account a manager creates normally.** Nobody's password is weaker
or reused; they just set a new one the first time they sign in to the new site, same as any new
starter would.

## Running it

1. Download three service account keys (Console → Project Settings → Service Accounts →
   Generate new private key) — one per project — and save them somewhere outside the repo (they
   are not, and must never be, committed).
2. `cd migration && npm install`
3. Set the three environment variables to those file paths, e.g.:
   ```
   export EXPENSES_SA_KEY=~/keys/expenses-sa.json
   export SHOWDRINKS_SA_KEY=~/keys/showdrinks-sa.json
   export SHOWMANAGER_SA_KEY=~/keys/showmanager-sa.json
   ```
4. **Dry run first** — reads both source projects, writes nothing, and prints exactly what it
   would copy and which user accounts it would create:
   ```
   node migrate.js
   ```
   Check the collection counts match what you'd expect (Firebase Console → Firestore on each
   source project), and that the printed user list — who becomes an expensesAdmin, who becomes a
   showdrinksAdmin, who gets both — looks right. If someone should also be a portal Manager, note
   their email now; the script deliberately never sets that flag itself (see the comment in
   `migrate.js`) — grant it afterwards from the portal's Users screen.
5. **Real run**, once the dry run looks right:
   ```
   node migrate.js --write
   ```
   This copies every collection's data into the new project and creates every merged user
   account. It writes `migration/migration-output/credentials.csv` (name, email, temporary
   password, access) — **distribute these individually and delete the file once you have**, the
   same way you'd hand anyone a temporary password today. It's already covered by this repo's
   `.gitignore`; don't commit it regardless.
6. Sign in to the new site (`portal.js` → Users) with one of the migrated Manager-eligible
   accounts, spot-check a few shows/expenses/orders, and promote whoever should be a full
   Manager.
7. Once you're confident the new site is right, add a short banner/redirect notice to the old
   `expenses` and `showdrinks` repos' `index.html`/`admin.html` pointing at the new URLs, and
   update the Pirton Players website's links (that site is outside this repo). Leave the old
   Firebase projects themselves alone for a few weeks before considering winding them down —
   there's no rush, and no harm in them sitting idle.

## If something looks wrong after a real run

Nothing on the *source* projects is touched — `migrate.js` only ever reads from
`pirton-players-expenses`/`showdrinks` and writes to `pirton-players-showmanager`. If a real run
produces the wrong result, the safe fix is deleting the affected data/users from the *new*
project (Console) and re-running — the two live apps keep working exactly as they do today
throughout.
