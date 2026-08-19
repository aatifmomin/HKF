Hasnain Karimain Foundation — full web app bundle
==================================================

This zip contains every file the live web app needs EXCEPT:
  - firebase-config.js (your real Firebase keys; keep your existing one)
  - Logo.png (your foundation logo; keep your existing one)

Files included:
  index.html              — entry point, loads app.js
  styles.css              — all styles
  app.js                  — routing, sign-in, join gate, role picker, year chip
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
  database.rules.json     — Realtime Database security rules (see below)
  ANDROID-COMPAT.md       — the Android data contract. READ THIS FIRST.

REMOVED in this build: discussion.js. The group chat and the online-presence
strip are gone from both clients.


What changed in this build
--------------------------

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

database.rules.json is YOUR current rule set with two nodes added: /settings
and /reminderLog were missing, and an unlisted path in Realtime Database is
DENIED. Until you publish it:

  * Settings > Save link / Save reminder silently fails on BOTH clients
  * the Share & refer card can't read apkLink
  * "Reminder given by ..." never appears on the Reminder tab

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
  3. Verify your firebase-config.js and Logo.png are still there
     (the zip does not include them).
  4. Publish database.rules.json in the Firebase console. This one is not
     optional — /settings and /reminderLog are denied until you do.
  5. Commit and push to GitHub:
       git add web/
       git rm web/discussion.js
       git commit -m "Update web app"
       git push
  6. Hard-reload the live site (Ctrl+Shift+R) so cached JS gets refreshed.

If you are deploying from scratch, you also need:
  - firebase-config.js with your real Firebase credentials
  - Logo.png (your foundation logo, square, ideally 256x256+)
