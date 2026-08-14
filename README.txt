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
  database.rules.json     — Realtime Database security rules (see below)

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


Attachment storage
------------------

Attachments are base64 in the Realtime Database, with the blob and its index
deliberately at different paths:

  /handovers/{key}/documents/{docId}  ->  { name, mime, sizeBytes }
  /handoverDocs/{key}/{docId}         ->  { ..., data }

  /paymentRequests/{key}.proofId      ->  "<proofId>"
  /payments/{uid}/{key}.proofId       ->  "<proofId>"
  /paymentProofs/{proofId}            ->  { ..., data }

The split matters: the handover list and the Activity feed subscribe to their
parent nodes, so inline blobs would mean re-downloading every megabyte on
every change. Blobs load only when someone taps View. An approved request and
its payment row share one proofId rather than copying the image.


Database rules
--------------

database.rules.json is new. Paste it into Firebase Console > Realtime
Database > Rules and Publish. Without it, /joinRequests writes may be rejected
and the join queue will not work.

Read the comment block at the top before publishing — it explains what the
rules can and cannot enforce (RTDB rules have no queries, so "is this email in
/admins" is not checkable; the enforceable boundary is "does this account have
an approved member row").


Share link
----------

The card prints whatever origin the app is served from. To print something
else (a short link, a custom domain), set SHARE_URL_OVERRIDE at the top of
share-card.js.


Year filter applies to:
  - Home: stats, both charts, pending balance, download report, share card
  - Payments: 12-segment bar with monthly amounts, history, status pill
  - Members: status pills, filter chips, export start year
  - Handover: paid scoped to year, pending always shown

Activity and Admins are unchanged by year (always all-time).


Install / deploy:
  1. Extract this zip into your web/ folder. Overwrite existing files.
  2. Delete the old web/discussion.js — it is no longer imported.
  3. Verify your firebase-config.js and Logo.png are still there
     (the zip does not include them).
  4. Publish database.rules.json in the Firebase console.
  5. Commit and push to GitHub:
       git add web/
       git rm web/discussion.js
       git commit -m "Update web app"
       git push
  6. Hard-reload the live site (Ctrl+Shift+R) so cached JS gets refreshed.

If you are deploying from scratch, you also need:
  - firebase-config.js with your real Firebase credentials
  - Logo.png (your foundation logo, square, ideally 256x256+)
