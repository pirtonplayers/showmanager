# showmanager

One shared login, one site, three apps for Pirton Players:

- **`/`** — the portal: sign in once, see the apps you have access to, (Managers) manage every
  user's access.
- **`/expenses/`** — submit and manage show expenses.
- **`/showdrinks/`** — pre-order drinks before/during/after a show (customer PWA is
  unauthenticated, same as before), plus its admin console.
- **`/budget/`** — plan and track show budgets from a reusable template.

All four share one Firebase project (`pirton-players-showmanager`) and one Firebase Auth login —
signing in on any app's login screen leaves you signed in on every other page of the site too,
because it's the same origin and the same project. See `shared/firebase-config.js` and
`shared/auth.js`.

## Access model

One `users/{uid}` Firestore doc per account (provisioned by a Manager — no self-registration):

```js
{
  name, email, mustChangePassword, createdAt,
  isManager: bool,       // manages every user's access; implicitly has every app below
  access: {
    expenses: bool,        // expenses entry app — submit expenses
    expensesAdmin: bool,   // expenses admin
    showdrinksAdmin: bool, // showdrinks admin
    budget: bool,          // showbudget
  }
}
```

Manage all of this from the portal → **Users** (Manager-only). Each app's own admin.html links
back there instead of managing users itself.

## Setup (new deployment)

1. **Firebase**: project `pirton-players-showmanager` already exists (see `.firebaserc`). In the
   [Console](https://console.firebase.google.com/project/pirton-players-showmanager):
   Firestore → Create database (production, `eur3`) · Storage → Get started · Authentication →
   enable Email/Password · Settings → upgrade to **Blaze**.
2. Deploy rules/functions:
   ```
   firebase deploy --only firestore:rules,firestore:indexes,storage,functions
   ```
3. **Brevo SMTP** (email — expenses notifications, showdrinks Show Tabs, portal user-link
   emails), same as both source apps used:
   ```
   firebase functions:secrets:set SMTP_USER
   firebase functions:secrets:set SMTP_PASS
   firebase functions:secrets:set SMTP_FROM
   firebase deploy --only functions
   ```
4. **First Manager** — createUser itself requires an existing manager, so there's one manual
   step: Console → Authentication → Add user (email+password) → Firestore → `users` collection →
   add a document with that account's UID as the document ID, fields `name`, `email`,
   `isManager: true`, `access: {expenses:true, expensesAdmin:true, showdrinksAdmin:true,
   budget:true}`, `mustChangePassword: false`. They can now sign in at `/` and create everyone
   else from Users.
5. **Hosting**: static site, no build step — push to GitHub with Pages enabled on `main` / root.
   `https://pirtonplayers.github.io/showmanager/`.
6. **PWA icons**: `icons/icon.svg` (and each app's own `icons/icon.svg`) need converting to
   `icon-192.png`/`icon-512.png` (any SVG-to-PNG tool) — expenses already ships its full PNG set;
   showdrinks and budget currently ship the SVG source only.

## Backup / restore

Portal → Users (Managers only):

- **Back up / Restore data (JSON)** — every app's Firestore collections (not `users`, which are
  tied to Firebase Auth accounts). Restore overwrites matching docs, never deletes.
- **Back up receipt images (ZIP)** — downloads every expenses receipt in Storage to one ZIP
  (save-only, no restore). One-time setup so the browser can fetch them:
  ```
  gsutil cors set cors.json gs://pirton-players-showmanager.firebasestorage.app
  ```

## Sign in from pirtonplayers.org (Joomla)

A menu item on the Joomla site signs a logged-in member straight into the portal. It signs in
the showmanager account with the same email, creating an Expenses-only one on their first visit
if they don't have one yet. It never signs in Managers (they use their password) and never changes
an existing account's access — grant more from portal → Users.

1. `openssl rand -hex 32` for a secret, then `firebase functions:secrets:set SSO_SECRET` (paste it).
2. `firebase deploy --only functions` (adds `ssoLogin`). If a sign-in reports failure and the
   function log shows a `signBlob`/permission error, grant the function's service account
   (Google Cloud Console → IAM) the **Service Account Token Creator** role.
3. Edit `joomla/showmanager-sso.php` (paste the same secret in), upload it to the Joomla root, and
   add a menu item of type **External URL** → `https://www.pirtonplayers.org/showmanager-sso.php`,
   access level Registered. Optionally list your members' Joomla group ID(s) in
   `SHOWMANAGER_SSO_ALLOWED_GROUPS` so only they get through.

Trust note: anyone who can log in to the Joomla site as a given email gets that showmanager
account, so Joomla must not let members change their email without confirming it (or self-register
with an address they don't own) — or restrict by group as above.

## Migrating the existing expenses/showdrinks projects' data

See `migration/MIGRATION.md` — deliberately a separate, manually-run step, not something done as
part of standing this repo up.

## Versioning

One version number for the whole suite, in `shared/version.js` — every app (root portal,
`expenses/`, `showdrinks/`, `budget/`) just references that file. Run `node bump-version.js` at
the repo root before deploying any change to a cacheable asset anywhere in the repo, so installed
PWAs pick up the change instead of serving a stale cached copy (see the comment in
`bump-version.js` for why the cache-busting query strings matter on GitHub Pages specifically —
and why a bump has to cover every app at once, not just the one you changed).

## Local testing

```
npx serve .
```
Then `/index.html` (portal), `/expenses/index.html`, `/expenses/admin.html`,
`/showdrinks/index.html`, `/showdrinks/admin.html`, `/budget/index.html`.
