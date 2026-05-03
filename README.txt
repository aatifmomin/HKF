Hasnain Karimain Foundation — full web app bundle
==================================================

This zip contains every file the live web app needs EXCEPT:
  - firebase-config.js (your real Firebase keys; keep your existing one)
  - Logo.png (your foundation logo; keep your existing one)

Files included:
  index.html              — entry point, loads app.js
  styles.css              — all styles, ~1400 lines
  app.js                  — top-level routing, sign-in, role picker, year picker chip
  auth.js                 — Google sign-in + admin email observer
  members-self.js         — current-user member-row bootstrap
  year-state.js           — global selected-year state (2026-2030)
  year-report.js          — PDF + XLSX report builders, lazy-loaded on download
  home.js                 — dashboard: stats, charts, download buttons
  members.js              — member directory + admin CRUD
  admins.js               — owner-only: manage admin emails
  handover.js             — donation handovers list + dialog
  payments.js             — member's My Payments screen
  discussion.js           — group chat + presence + payment-request cards

Year filter applies to:
  - Home: stats, both charts, pending balance, download report
  - Payments: 12-segment bar, history, status pill
  - Members: status pills, filter chips
  - Handover: paid scoped to year, pending always shown

Discussion + Admins are unchanged by year (always all-time).

Install / deploy:
  1. Extract this zip into your web/ folder. Overwrite existing files.
  2. Verify your firebase-config.js and Logo.png are still there
     (the zip does not include them).
  3. Commit and push to GitHub:
       git add web/
       git commit -m "Update web app"
       git push
  4. Hard-reload the live site (Ctrl+Shift+R) so cached JS gets refreshed.

If you are deploying from scratch, you also need:
  - firebase-config.js with your real Firebase credentials
  - Logo.png (your foundation logo, square, ideally 256x256+)
