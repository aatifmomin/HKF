// Reminder tab - admin only. Port of Android's ReminderScreen/ReminderViewModel.
//
// Two modes behind a chip switch:
//
//   Payment Reminder - members with no payment covering the CURRENT month.
//                      Chased by SMS, because that's what a phone number gets
//                      you. "Unpaid" is deliberately simple and matches
//                      Android exactly: no /payments/{uid}/* row whose
//                      coversMonthKey equals the current device-local month.
//                      Amount, category and when it was recorded are all
//                      irrelevant, and the year picker does not apply here.
//
//   Contact Update   - members with no contact number at all, regardless of
//                      whether they've paid. Chased by EMAIL, since there's no
//                      number to text. They also see the nudge in-app on their
//                      Profile tab until they fill it in.
//
// Rows an admin pre-created (keys prefixed "pending_") are included on
// purpose: they are real members who owe a contribution, they just haven't
// signed in yet.

import {
  getDatabase,
  ref,
  onValue,
  set,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02a";
import { displayNameFor } from "./auth.js?v=2026-09-02a";
import { memberDisplayName, copyToClipboard } from "./members.js?v=2026-09-02a";

const db = getDatabase(firebaseApp);

const MONTH_TITLE = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const DEFAULT_REMINDER_MESSAGE = "Assalamualekum! Please contribute for the current month";
export const DEFAULT_CONTACT_MESSAGE = "Please update your contact number in your HKF profile";
const CONTACT_EMAIL_SUBJECT = "HKF — update your contact number";

function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function monthTitle(monthKey) {
  const [y, m] = String(monthKey || "").split("-");
  if (!m) return "";
  return MONTH_TITLE[parseInt(m, 10) - 1] + " " + y;
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nameBeforeAt(email) {
  return String(email || "").split("@")[0];
}

/** Comma-separated recipients; both Android and iOS accept that form. */
function smsHref(numbers, message) {
  return "sms:" + numbers.filter(Boolean).join(",") + "?body=" + encodeURIComponent(message);
}

function mailtoHref(emails, message) {
  return "mailto:" + emails.filter(Boolean).join(",") +
    "?subject=" + encodeURIComponent(CONTACT_EMAIL_SUBJECT) +
    "&body=" + encodeURIComponent(message);
}

export function renderReminder(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }
  if (window.__viewerIsAdmin !== true) {
    container.innerHTML = `
      <div class="placeholder">
        <strong>Admins only</strong>
        Reminders go out from the admin side.
      </div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Reminder</div>
        <div class="page-subtitle" id="rm-subtitle">loading...</div>
      </div>
    </div>
    <div class="filter-chips" id="rm-modes">
      <button class="chip active" data-mode="payment">Payment Reminder</button>
      <button class="chip" data-mode="contact">Contact Update</button>
    </div>
    <div id="rm-body">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  const subtitleEl = container.querySelector("#rm-subtitle");
  const bodyEl = container.querySelector("#rm-body");

  let mode = "payment";
  let members = [];
  let paidMonthsByUid = {};
  let settings = { reminderDay: 0, reminderText: "", updateContactText: "" };
  let log = null;

  container.querySelectorAll("[data-mode]").forEach(chip => {
    chip.addEventListener("click", () => {
      container.querySelectorAll("[data-mode]").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      mode = chip.dataset.mode;
      rerender();
    });
  });

  const unsubMembers = onValue(ref(db, "members"), snap => {
    members = Object.entries(snap.val() || {})
      .map(([uid, m]) => ({ uid, ...m }))
      .sort((a, b) => (a.memberId || "").localeCompare(b.memberId || ""));
    rerender();
  });

  const unsubPayments = onValue(ref(db, "payments"), snap => {
    paidMonthsByUid = {};
    Object.entries(snap.val() || {}).forEach(([uid, rows]) => {
      const months = new Set();
      Object.values(rows || {}).forEach(p => {
        if (p?.coversMonthKey) months.add(p.coversMonthKey);
      });
      paidMonthsByUid[uid] = months;
    });
    rerender();
  });

  const unsubSettings = onValue(ref(db, "settings"), snap => {
    const v = snap.val() || {};
    settings = {
      reminderDay: Number(v.reminderDay) || 0,
      reminderText: v.reminderText || "",
      updateContactText: v.updateContactText || ""
    };
    rerender();
  });

  const unsubLog = onValue(ref(db, "reminderLog"), snap => {
    log = snap.val();
    rerender();
  });

  function rerender() {
    return mode === "payment" ? renderPaymentMode() : renderContactMode();
  }

  // ---------------- Payment reminder (SMS) ----------------

  function renderPaymentMode() {
    const month = currentMonthKey();
    const unpaid = members.filter(m => !(paidMonthsByUid[m.uid]?.has(month)));
    const message = settings.reminderText || DEFAULT_REMINDER_MESSAGE;
    const withNumbers = unpaid.filter(m => (m.contactNumber || "").trim());
    const missingNumbers = unpaid.length - withNumbers.length;

    // The log is a single global node; it self-expires when the month rolls
    // over, so no cleanup job is needed.
    const remindedThisMonth = log && log.monthKey === month;
    const remindedBy = remindedThisMonth ? (log.byName || nameBeforeAt(log.byEmail)) : "";

    subtitleEl.textContent =
      `${unpaid.length} of ${members.length} members haven't paid for ${monthTitle(month)}`;

    const dayLine = (settings.reminderDay >= 1 && settings.reminderDay <= 28)
      ? `In-app reminder shows automatically from day ${settings.reminderDay} of each month.`
      : `Auto in-app reminder is OFF — set a day in Settings (gear on Home).`;

    let cta;
    if (withNumbers.length === 0) {
      cta = `<button class="reminder-cta" disabled>No contact numbers to remind</button>`;
    } else if (remindedThisMonth) {
      cta = `
        <a class="reminder-cta muted" id="rm-all" href="${escapeHtml(smsHref(withNumbers.map(m => m.contactNumber), message))}">
          Reminder given by ${escapeHtml(remindedBy)}
        </a>
        <div class="reminder-subnote">Tap again to send another round this month.</div>`;
    } else {
      cta = `
        <a class="reminder-cta" id="rm-all" href="${escapeHtml(smsHref(withNumbers.map(m => m.contactNumber), message))}">
          Remind all (${withNumbers.length})
        </a>`;
    }

    bodyEl.innerHTML = `
      <div class="reminder-info">
        <div class="reminder-info-line">${escapeHtml(dayLine)}</div>
        <div class="reminder-info-msg">SMS message: “${escapeHtml(message)}”</div>
      </div>

      ${cta}

      <div class="reminder-tools">
        <button class="doc-btn" id="rm-copy-msg">Copy message</button>
        ${withNumbers.length ? `<button class="doc-btn" id="rm-copy-to">Copy ${withNumbers.length} number${withNumbers.length > 1 ? "s" : ""}</button>` : ""}
      </div>

      ${missingNumbers > 0
        ? `<div class="reminder-warning">${missingNumbers} unpaid member${missingNumbers > 1 ? "s have" : " has"} no contact number saved — they appear under Contact Update.</div>`
        : ""}

      <div class="section-header">UNPAID FOR ${escapeHtml(monthTitle(month).toUpperCase())}</div>
      ${unpaid.length === 0
        ? `<div class="empty-state">Everyone has paid for ${escapeHtml(monthTitle(month))}.</div>`
        : `<div class="rows-list">${unpaid.map(m => row(m, {
              sub: (m.contactNumber || "").trim() || "no contact number",
              action: (m.contactNumber || "").trim()
                ? `<a class="row-btn" href="${escapeHtml(smsHref([m.contactNumber], message))}">Remind</a>`
                : ""
            })).join("")}</div>`}
    `;

    bodyEl.querySelector("#rm-all")?.addEventListener("click", () => markReminded(user));
    bodyEl.querySelector("#rm-copy-msg")?.addEventListener("click", () => copyToClipboard(message, "Message"));
    bodyEl.querySelector("#rm-copy-to")?.addEventListener("click", () =>
      copyToClipboard(withNumbers.map(m => m.contactNumber).join(", "), "Numbers"));
  }

  // ---------------- Contact update (email) ----------------

  function renderContactMode() {
    const missing = members.filter(m => !(m.contactNumber || "").trim());
    const message = settings.updateContactText || DEFAULT_CONTACT_MESSAGE;
    const withEmail = missing.filter(m => (m.email || "").trim());

    subtitleEl.textContent =
      `${missing.length} of ${members.length} members haven't added a contact number`;

    const cta = missing.length === 0
      ? `<button class="reminder-cta" disabled>Everyone has a contact number ✓</button>`
      : withEmail.length === 0
        ? `<button class="reminder-cta" disabled>No email addresses to write to</button>`
        : `<a class="reminder-cta" href="${escapeHtml(mailtoHref(withEmail.map(m => m.email), message))}">
             Email all (${withEmail.length})
           </a>`;

    bodyEl.innerHTML = `
      <div class="reminder-info">
        <div class="reminder-info-line">
          Members below have no contact number, so this reminder goes by EMAIL.
          They also see it in-app on their Profile until it's filled in.
        </div>
        <div class="reminder-info-msg">Email message: “${escapeHtml(message)}”</div>
      </div>

      ${cta}

      <div class="reminder-tools">
        <button class="doc-btn" id="rm-copy-msg">Copy message</button>
        ${withEmail.length ? `<button class="doc-btn" id="rm-copy-to">Copy ${withEmail.length} email${withEmail.length > 1 ? "s" : ""}</button>` : ""}
      </div>

      <div class="section-header">NO CONTACT NUMBER</div>
      ${missing.length === 0
        ? `<div class="empty-state">Every member has a contact number.</div>`
        : `<div class="rows-list">${missing.map(m => row(m, {
              sub: (m.email || "").trim() || "no email either",
              action: (m.email || "").trim()
                ? `<a class="row-btn" href="${escapeHtml(mailtoHref([m.email], message))}">Email</a>`
                : ""
            })).join("")}</div>`}
    `;

    bodyEl.querySelector("#rm-copy-msg")?.addEventListener("click", () => copyToClipboard(message, "Message"));
    bodyEl.querySelector("#rm-copy-to")?.addEventListener("click", () =>
      copyToClipboard(withEmail.map(m => m.email).join(", "), "Emails"));
  }

  function row(m, { sub, action }) {
    return `
      <div class="member-row">
        <div class="member-avatar">${escapeHtml(m.memberId || "?")}</div>
        <div class="member-body">
          <div class="member-name">${escapeHtml(memberDisplayName(m))}</div>
          <div class="member-email">${escapeHtml((m.memberId || "—") + " · " + sub)}</div>
        </div>
        ${action}
      </div>
    `;
  }

  return function teardown() {
    unsubMembers();
    unsubPayments();
    unsubSettings();
    unsubLog();
  };
}

/** Record that a reminder round went out this month. */
async function markReminded(user) {
  try {
    await set(ref(db, "reminderLog"), {
      monthKey: currentMonthKey(),
      byName: displayNameFor(user),
      byEmail: user?.email || "",
      atMillis: serverTimestamp()
    });
  } catch (e) {
    console.warn("reminder log failed", e);
  }
}
