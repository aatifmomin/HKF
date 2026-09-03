Hasnain Karimain Foundation — full web app bundle
==================================================

IF YOU DEPLOYED AND CAN'T SEE THE CHANGES, READ THIS FIRST
----------------------------------------------------------

Every build now carries a visible id. Check it before anything else:

  * it is printed on the SIGN-IN screen, under the Google button
  * it is at the bottom of Settings (gear on Home, owner only)
  * it is logged to the browser console at startup:
        HKF web build 2026-09-02b

This build is  2026-09-02b.

  Shows 2026-09-02b  -> the new code IS live. If a specific screen still
                        looks wrong, see "which screens changed" below —
                        several of the new ones are MEMBER-only and are
                        invisible while you're signed in as Admin.

  Shows nothing, or  -> your browser or host is still serving the old files.
  an older id           Work through the three causes below.

1. Browser cache. This app is ES modules, and the browser caches each .js
   file separately, so an ordinary reload can leave you running a mix of old
   and new. Hard-reload: Ctrl+Shift+R (Windows) / Cmd+Shift+R (Mac). If that
   doesn't do it, open DevTools > Application > Clear site data, or try a
   private window — a private window is the fastest way to prove whether it's
   a cache problem, because it starts with none.

   From this build on, every import carries a ?v=<build id>, so a new build is
   a new URL and this should stop happening. It cannot fix the ONE build where
   you upgrade INTO this scheme, though: index.html itself may still be
   cached. Hard-reload once and you're set.

2. Host cache. Firebase Hosting serves static files with max-age=3600 by
   default, so your changes can be up to an hour late. The included
   firebase.json fixes this: it tells Hosting to make browsers revalidate
   .js/.css/.html every time (still fast — an unchanged file returns 304).
   Deploy it along with the app. On any other host, set the equivalent
   Cache-Control header for .js files.

3. Files not actually uploaded. This build adds NEW files. If your upload
   only replaced files that already existed, the new ones are missing. Confirm
   all of these are on the server:

     version.js  profile.js  reminder.js  settings.js  attachments.js
     lib-loader.js  members-export.js  share-card.js  year-state.js

   A missing import breaks the whole module graph, so the symptom is the page
   sticking on "Loading…" with a red 404 in the console — worth checking the
   console either way.

AFTER YOU EDIT ANY .js FILE
---------------------------

Run ./bump-version.sh before redeploying. It rewrites the build id in
version.js and the ?v= stamp on every import, so browsers fetch the new code
instead of reusing what they already have.

  ./bump-version.sh              uses today's date, e.g. 2026-09-02b
  ./bump-version.sh my-build-7   uses whatever you pass

No shell? Edit version.js by hand and do a find-and-replace of the old ?v=
value across the .js files and index.html. All of them must match — a module
imported under two different stamps loads twice, and shared state splits in
two.

WHICH SCREENS CHANGED, AND WHO SEES THEM
----------------------------------------

Sign in as a MEMBER (or pick "Continue as Member" at the role screen) to see:
  * Pay contribution card  — Home, pick a collector admin or HKF directly
  * "Paid to" on requests  — Payments > + Request, mandatory
  * Support tab            — FOURTH tab, file and track tech-support tickets
  * Profile tab            — third tab, renamed from Members
  * Pay via bank QR card   — Home, only once the owner uploads a QR in Settings
  * Months-covered stepper — Payments > + Request
  * Payment reminder       — Payments, only from reminderDay onward

Sign in as ADMIN / OWNER to see:
  * Reminder tab           — fifth tab, with the Payment / Contact Update modes
  * Settings               — gear beside Sign out, OWNER ONLY
  * TECH SUPPORT queue     — Settings > TECH SUPPORT, OWNER ONLY
  * My Collections         — Home card, EVERY ADMIN (owner sees everyone)
  * Backup / restore / reset by year — Settings, OWNER ONLY
  * Multi-month ranges     — Activity, on requests covering >1 month
  * Three danger-zone wipes — Settings

If you were signed in as Admin, the Profile tab and the QR card are correctly
absent — admins get the Members directory and the report downloads instead.


This zip contains every file the live web app needs EXCEPT:
  - firebase-config.js (your real Firebase keys; keep your existing one)
  - Logo.png (your foundation logo; keep your existing one)

Files included:
  index.html              — entry point, loads app.js
  version.js              — the build id (see the top of this file)
  bump-version.sh         — stamps a new build id across every import
  firebase.json           — Hosting config incl. the cache headers
  styles.css              — all styles
  app.js                  — routing, sign-in, join gate, role picker, year chip
  firebase-init.js        — Firebase app/db/auth bootstrap
  auth.js                 — Google sign-in + admin email observer
  members-self.js         — membership resolution + join-request queue
  year-state.js           — global selected-year state (2026-2030)
  lib-loader.js           — shared lazy CDN loader for jsPDF / SheetJS
  attachments.js          — image compression + base64 blob storage helpers
  year-report.js          — annual PDF + XLSX report builders
  members-export.js       — 3-year member register workbook
  share-card.js           — 1080x1350 "Share & refer" canvas card
  home.js                 — dashboard: stats, charts, downloads, share
  members.js              — admin directory + member self-view
  admins.js               — owner-only: manage admin emails
  handover.js             — handovers list, dialog, document attachments
  payments.js             — member's My Payments screen
  activity.js             — admin Activity feed (replaces Discussion)
  reminder.js             — admin Reminder tab (payment SMS + contact email)
  settings.js             — owner Settings (gear on Home)
  profile.js              — member Profile tab (own record, self-editable)
  support.js              — member Support tab + owner ticket queue
  collectors.js           — collector profiles, transfers, pay chooser
  announcements.js        — the bell, the sheet, admin post/delete
  year-data.js            — year backup / restore / reset
  database.rules.json     — Realtime Database security rules (see below)
  ANDROID-COMPAT.md       — the Android data contract. READ THIS FIRST.
  SETUP.md                — first-time Firebase / Hosting setup

REMOVED in this build: discussion.js. The group chat and the online-presence
strip are gone from both clients.


What changed in this build
--------------------------

Collector payments  (NEW — the big one)
  Members don't all pay into the foundation's account. Several admins collect
  into their OWN accounts and move the money across later. That trail used to
  live in somebody's head; now it's in the database.

  Each admin opens My Collections from a card on their Home and sets up a
  collection QR and UPI ID, with an "Accepting payments" switch to hide
  themselves while away.

  A member taps Pay contribution on Home and picks who they're paying — a
  collector admin, or HKF's own account (QR, UPI and bank details with
  tap-to-copy). That choice pre-fills "Paid to" in the request dialog, which
  is now a required field.

  ONLY the admin the member paid can approve that request. Other admins see
  the card and read "Awaiting <name> — only they (or the owner) can confirm
  this money arrived." The owner can approve anything. Requests with no named
  collector, and anything paid to HKF directly, stay open to every admin, so
  old data keeps working.

  My Collections then shows each admin their own money picture — received,
  awaiting approval, transferred to HKF, and what's still sitting in their
  account — plus a Transfer to HKF button that records what they moved, with
  a UTR note. The owner additionally sees every collector side by side and
  the whole transfer ledger.

  An admin who still holds foundation money CANNOT be removed as admin until
  they've settled up. The Remove button says how much they're holding.

  Nothing here is counted or stored as a running total. Every figure is
  derived from the payments, requests and transfers that actually exist, so
  it can't drift between the phone and the web.

Announcements  (NEW)
  A bell in the top bar with a red dot when there's something new. Admins and
  the owner post one announcement at a time — title, description and an
  optional image compressed to 200 KB — and delete it with the ✕. Everyone
  reads it.

  One at a time is deliberate on both clients: the bell then always means
  exactly one thing. Delete the current one before posting the next.

  The unread dot is per-device, not per-account: reading it on your phone
  doesn't clear it on the web, and vice versa. That's how Android works and
  the web matches it.

Backup, restore and reset — by year  (NEW, owner only)
  In Settings. Backup downloads one year's records as hkf-backup-<year>.json;
  Restore takes such a file back; Reset deletes a year. The file format is
  identical to Android's, so a backup taken on the phone restores from the web
  and the other way round.

  READ THIS BEFORE USING RESET. It is wider than the backup, deliberately —
  this is how the owner defined it on Android:

    1. payments of the chosen YEAR only
    2. ALL handovers with their documents (numbering restarts at H-001)
    3. ALL activity — every payment request with every proof, and every join
       request, decided ones included

  Members, admins, collector profiles and settings are never touched, by
  either backup or reset. You have to type the year to confirm. Take a backup
  first — there is no undo.

  After a reset or a restore, every member's total is recomputed from the
  payments that actually survive, so the cards and exports don't show stale
  figures.

Android app update  (NEW — controls the PHONE app, not this one)
  Settings > ANDROID APP UPDATE. Put the new APK on the app link, enter the
  version and what's new, and switch it on. Android members whose phone is on
  an older version get an update card on their Home with a download button.
  Switch off to hide it. Nobody is ever blocked; they update manually.

  Nothing appears on the WEBSITE. There's no point: a browser has no installed
  version to be behind, and the APK is for a phone. The site always serves the
  newest build — the small "HKF web build ..." line at the bottom of Home is
  how you confirm which one you're on.

Website link on the share card
  Settings > SHARE & REFER LINK now takes a website URL alongside the app
  link. Both go out in the share TEXT. The link is no longer drawn onto the
  image itself: baked into a PNG it can't be tapped and goes stale the moment
  you change it.

Smaller things
  * A red dot on the Activity tab when something pending arrived since the
    last time this device opened it.
  * The request date picker no longer stops at today — paying for upcoming
    months in advance is the whole point of the months stepper.
  * Support says "+ Suggestion" instead of "+ New issue", matching Android.
  * Admins reach Tech Support from a card on their Home (the nav bar is full
    at five tabs, on both clients).
  * Bank details for the foundation's own account, shown to members with
    tap-to-copy under "pay HKF directly".

Tech Support  (from the previous build — matches the Android support screens)
  Members get a fourth tab, Support, next to Home / Payments / Profile. They
  file an issue with a title and description and get back a ticket id (T-001,
  T-002, ...). Their list shows open and resolved counts, a search box, and
  each card's status pill.

  The owner works the queue from Settings -> TECH SUPPORT: every ticket from
  every member, open ones first and newest-first inside each group, with the
  filer's name and date on the card. Resolve takes an optional note; the red
  X deletes the ticket outright.

  A resolved ticket shows the member a green block with the note and who
  closed it, plus a "Reopen issue" button. Reopening adds their note and puts
  the ticket back at the top of the owner's queue, marked REOPENED, without
  losing the original resolution.

  Ordinary admins do not see the queue — only the owner email does.

  Two new database nodes, /techSupport and /techSupportCounter. Both are in
  database.rules.json and BOTH MUST BE PUBLISHED or the feature is dead on
  both clients (see "Publish the rules" below).

Join approval
  Signing in no longer creates a member. A new Google account lands in
  /joinRequests and sees a "Pending approval to join" screen. A NEW MEMBER
  card appears in the admin Activity feed; Approve creates the member row and
  the person drops into the app live, with no re-login. Discard shows them a
  declined screen with a "Request again" button.

  Emails an admin pre-registered through "+ Add member" skip the queue: on
  first sign-in they claim their pre-created row, including any payments
  already recorded against it.

Activity feed (replaces Discussion)
  Chat and presence removed entirely. Members no longer have the tab. Admins
  get a card feed combining payment requests, handovers and join requests.
  Pending cards are gold and sorted to the top; decided cards are greyed and
  kept below as a log. Approve / Deny / Mark paid inline, plus search and the
  All / Requests / Handovers / Joins chips.

Super-admin decision editing
  The owner can reopen a decided payment request and flip it. Denied to
  Approved records the payment. Approved to Denied deletes the recorded
  payment behind a destructive-confirm warning, and every total recalculates.

Member profile fields
  Full name, contact number, current address, permanent address and
  occupation, captured in both Add and Edit member dialogs. Addresses and the
  contact number are tap-to-copy wherever they're displayed.

Member self-view
  A member's Members tab now shows only their own card, expanded with their
  profile and year totals. Search and filter chips are gone for members.

Handover document attachments
  "+ Attach" in the handover dialog takes multiple JPG / PNG / PDF files.
  Images are downscaled and re-encoded client-side; PDFs are capped at 2 MB.
  Documents are listed on the handover card with View and Remove.

Payment proof images
  Members can attach a screenshot when requesting a payment. It shows with
  View / Remove inside their own history card, admins see a PROOF tag and
  View on the Activity request card, and after approval the proof carries
  over to the confirmed payment row as view-only.

Export members (Excel)
  An Export button on the admin Members tab produces a workbook with three
  year sheets (selected year plus the next two), each carrying full member
  profiles, Jan-Dec payment columns, per-member year totals and a totals row.

Share & refer
  A button on Home renders a branded 1080x1350 card (logo, active members,
  year collection, link) and opens the share sheet. On browsers without file
  sharing it downloads the PNG instead.

Member Home simplified
  Annual report downloads are admin/owner only. Members still see the stats,
  charts and the share button.

Multi-month payment requests
  A member can cover up to 12 consecutive months in one request. The amount is
  the TOTAL; the dialog shows the covered range and a per-month preview.
  Approving writes one payment row per month, splitting the total with the
  remainder on the first month so the rows add back up exactly. Each row is
  noted "Approved request (2/4)". Reverting removes all of them.
  Tapping a month on the 12-month bar opens the request pre-set to that month.

Member Profile tab
  The member's third tab is now Profile, not Members. It shows their own
  record with PAID <year> / ALL TIME / AVG PER MONTH, and lets them edit their
  own contact number, addresses and occupation — nothing admin-managed. A
  banner nudges them while the contact number is empty.

Bank QR and UPI
  The owner uploads a payment QR and a UPI ID in Settings. Members get a
  "Pay via bank QR" card on Home that opens the QR full-size plus an "Open UPI
  apps" button (GPay / PhonePe / Cred). No amount is pre-filled.

Reminder: Contact Update mode
  The Reminder tab has two modes. Payment chases members who haven't paid this
  month by SMS; Contact Update chases members with no phone number at all, by
  email, using the owner's message.

Danger zone
  Three separate wipes instead of one: all members (+payments +counter), all
  handovers (+documents +counter), all activity (requests +proofs +joins).


Synced with Android
-------------------

This build is aligned field-by-field with the Android app and verified against
a production database export. Nine data contracts disagreed before; all nine
now match. Two of them were destructive:

  * handoversCounter — the web wrote handoversCounter/value (an object) while
    Android reads the node as a plain number. The first handover created on
    the web would have wrecked Android's application numbering. It is now a
    bare number, formatted H%03d ("H005") like the existing rows.

  * totalPaidMinor — the web incremented it, Android recomputes it. Mixing
    the two makes a payment deleted on Android leave the web total too high.
    The web now recomputes from /payments as well.

Collector rows are shared as-is: /collectors is keyed by the admin's auth uid
(not email, unlike /admins), and its `active` flag defaults to TRUE when
absent, matching the Kotlin data class. Collector QRs are bare base64 JPEG
like every other blob here. /collectorTransfers rows are written status
"confirmed" straight away on both clients — the admin's own record is the
truth and a mistake is deleted, not disputed.

Tech support tickets are shared as-is: /techSupport rows written by the web
carry exactly the fields Android's TechSupportTicket reads, and
/techSupportCounter is a bare number like handoversCounter (T-004 means the
counter reads 4). The one difference is that the web allocates the id with a
transaction rather than read-then-write, so two members filing at the same
second can't collide on a ticket id. Mixing clients is safe.

Attachments are BARE base64 (no "data:...;base64," prefix) with `type` as a
file EXTENSION ("jpg" / "pdf"), not a mime type:

  /handovers/{key}/documents/{docId} -> { name, type, sizeBytes,
                                          uploadedAtMillis, uploadedByEmail }
  /handoverDocs/{key}/{docId}        -> { name, type, base64 }

  /paymentRequests/{key}.proofName   -> "upi.jpg"   (the only flag)
  /paymentProofs/{key}               -> { name, type, base64 }
                                        keyed by the REQUEST key

The split matters: the handover list and the Activity feed subscribe to their
parent nodes, so inline blobs would mean re-downloading every megabyte on
every change. Blobs load only when someone taps View.

Reading is deliberately lenient, so the rows an earlier build of this app left
in /paymentProofs in a different shape still open.

ANDROID-COMPAT.md has the full contract, the one deliberate behavioural
difference, and the Android-side bug worth fixing.


Database rules
--------------

database.rules.json is now the rule set YOU sent on 2 September, with all the
nodes already in it — /settings, /reminderLog, /techSupport,
/techSupportCounter, /announcements, /collectors and /collectorTransfers.
That was the blocker for the last three rounds and it's gone. Publishing is
no longer standing between you and a working Settings screen.

The only edits are three index lines:

  /techSupport         memberUid, status, createdAtMillis
  /collectorTransfers  collectorUid, transferredAtMillis
  /announcements       postedAtMillis

A missing index is a console warning, never a permission error, so nothing
breaks if you skip them. What happens instead is that Firebase downloads the
whole node to the phone or browser and sorts it there. The member's own ticket
list is the one that genuinely queries the server, so /techSupport is the one
worth having.

One node is worth tightening when you next touch these rules:

  "collectors": {
    ".read": "auth != null",
    "$uid": { ".write": "auth != null && auth.uid == $uid" }
  }

As written, any signed-in account could overwrite any admin's collection QR.
Neither client ever does — both only write their own uid — so this is
theoretical rather than live, but it's the one place here where a tighter rule
costs nothing. /collectorTransfers can't take the same treatment: admins
record their own transfers and delete their own mistakes, so it has to stay
open. The owner's view in My Collections is what makes it accountable.

Nothing else was tightened, on purpose — both apps share these paths and a
stricter rule would break whichever client writes it differently. The comment
block at the end explains what the rules do and don't enforce, and which
single check would be a safe improvement.


Share link
----------

The card prints /settings/apkLink — the same value Android uses — which the
owner edits in Settings. If it's empty the web falls back to whatever origin
the app is served from, rather than Android's "www.drive_dummy/HKF.apk"
placeholder.


Year filter applies to:
  - Home: stats, both charts, pending balance, download report, share card
  - Payments: 12-segment bar with monthly amounts, history, status pill
  - Members: status pills, filter chips, export start year
  - Handover: paid scoped to year, pending always shown

Activity, Reminder and Settings are unchanged by year. Reminder is always
about the CURRENT month, matching Android.

Admin tabs now match Android: Home / Members / Handover / Activity / Reminder.
There is no Admins tab — admin management moved into Settings, reached from
the gear on Home (owner only).


Install / deploy:
  1. Extract this zip into your web/ folder. Overwrite existing files.
  2. Delete the old web/discussion.js — it is no longer imported.
     THREE NEW FILES this build: collectors.js, announcements.js and
     year-data.js. Missing one breaks the whole module graph, so the page
     sticks on "Loading…" with a 404 in the console.
  3. Verify your firebase-config.js and Logo.png are still there
     (the zip does not include them).
  4. Publish database.rules.json in the Firebase console — optional this time.
     Your live rules already cover every node this build uses; this file only
     adds three indexes, which are a performance nicety, not a gate.
  5. Commit and push to GitHub:
       git add web/
       git rm web/discussion.js
       git commit -m "Update web app"
       git push
  6. Hard-reload the live site (Ctrl+Shift+R) and confirm the build id on the
     sign-in screen matches the one at the top of this file.

If you are deploying from scratch, you also need:
  - firebase-config.js with your real Firebase credentials
  - Logo.png (your foundation logo, square, ideally 256x256+)
