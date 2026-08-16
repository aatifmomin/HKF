// Reminder tab - admin only. Port of Android's ReminderScreen/ReminderViewModel.
//
// Lists members with no payment covering the CURRENT month and offers to text
// them. "Unpaid" is deliberately simple and matches Android exactly:
//
//   unpaid = every /members row with no /payments/{uid}/* whose
//            coversMonthKey == the current device-local month
//
// Amount, category and when it was recorded are all irrelevant - a single row
// covering the month counts as paid. There is no arrears logic and the year
// picker does not apply here; this tab is always about this month.
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

import { firebaseApp } from "./firebase-init.js";
import { displayNameFor } from "./auth.js";
import { memberDisplayName, copyToClipboard } from "./members.js";

const db = getDatabase(firebaseApp);

const MONTH_TITLE = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const DEFAULT_REMINDER_MESSAGE = "Assalamualekum! Please contribute for the current month";

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

/**
 * Build an sms: URL. Multiple recipients are comma-separated, which is what
 * both Android and iOS accept; the body goes in the query string.
 */
function smsHref(numbers, message) {
  const list = numbers.filter(Boolean).join(",");
  return "sms:" + list + "?body=" + encodeURIComponent(message);
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
    <div id="rm-body">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  const subtitleEl = container.querySelector("#rm-subtitle");
  const bodyEl = container.querySelector("#rm-body");

  let members = [];
  let paidMonthsByUid = {};
  let settings = { reminderDay: 0, reminderText: "" };
  let log = null;

  const unsubMembers = onValue(ref(db, "members"), snap => {
    members = Object.entries(snap.val() || {})
      .map(([uid, m]) => ({ uid, ...m }))
      .sort((a, b) => (a.memberId || "").localeCompare(b.memberId || ""));
    rerender();
  });

  const unsubPayments = onValue(ref(db, "payments"), snap => {
    paidMonthsByUid = {};
    Object.entries(snap.val() || {}).forEach(([uid, rows]) => {
      const set_ = new Set();
      Object.values(rows || {}).forEach(p => {
        if (p?.coversMonthKey) set_.add(p.coversMonthKey);
      });
      paidMonthsByUid[uid] = set_;
    });
    rerender();
  });

  const unsubSettings = onValue(ref(db, "settings"), snap => {
    const v = snap.val() || {};
    settings = { reminderDay: Number(v.reminderDay) || 0, reminderText: v.reminderText || "" };
    rerender();
  });

  const unsubLog = onValue(ref(db, "reminderLog"), snap => {
    log = snap.val();
    rerender();
  });

  function rerender() {
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

    let remindAll;
    if (withNumbers.length === 0) {
      remindAll = `<button class="reminder-cta" disabled>No contact numbers to remind</button>`;
    } else if (remindedThisMonth) {
      remindAll = `
        <a class="reminder-cta muted" id="rm-all" href="${escapeHtml(smsHref(withNumbers.map(m => m.contactNumber), message))}">
          Reminder given by ${escapeHtml(remindedBy)}
        </a>
        <div class="reminder-subnote">Tap again to send another round this month.</div>`;
    } else {
      remindAll = `
        <a class="reminder-cta" id="rm-all" href="${escapeHtml(smsHref(withNumbers.map(m => m.contactNumber), message))}">
          Remind all (${withNumbers.length})
        </a>`;
    }

    bodyEl.innerHTML = `
      <div class="reminder-info">
        <div class="reminder-info-line">${escapeHtml(dayLine)}</div>
        <div class="reminder-info-msg">Message: “${escapeHtml(message)}”</div>
      </div>

      ${remindAll}

      <div class="reminder-tools">
        <button class="doc-btn" id="rm-copy-msg">Copy message</button>
        ${withNumbers.length ? `<button class="doc-btn" id="rm-copy-nums">Copy ${withNumbers.length} number${withNumbers.length > 1 ? "s" : ""}</button>` : ""}
      </div>

      ${missingNumbers > 0
        ? `<div class="reminder-warning">${missingNumbers} unpaid member${missingNumbers > 1 ? "s have" : " has"} no contact number saved — add it via Members → Edit.</div>`
        : ""}

      <div class="section-header">UNPAID FOR ${escapeHtml(monthTitle(month).toUpperCase())}</div>
      ${unpaid.length === 0
        ? `<div class="empty-state">Everyone has paid for ${escapeHtml(monthTitle(month))}.</div>`
        : `<div class="rows-list">${unpaid.map(m => renderRow(m, message)).join("")}</div>`}
    `;

    const allBtn = bodyEl.querySelector("#rm-all");
    if (allBtn) allBtn.addEventListener("click", () => markReminded(user));

    bodyEl.querySelector("#rm-copy-msg")?.addEventListener("click", () => copyToClipboard(message, "Message"));
    bodyEl.querySelector("#rm-copy-nums")?.addEventListener("click", () =>
      copyToClipboard(withNumbers.map(m => m.contactNumber).join(", "), "Numbers"));
  }

  function renderRow(m, message) {
    const number = (m.contactNumber || "").trim();
    const sub = (m.memberId || "—") + (number ? " · " + number : " · no contact number");
    return `
      <div class="member-row">
        <div class="member-avatar">${escapeHtml(m.memberId || "?")}</div>
        <div class="member-body">
          <div class="member-name">${escapeHtml(memberDisplayName(m))}</div>
          <div class="member-email">${escapeHtml(sub)}</div>
        </div>
        ${number
          ? `<a class="row-btn" href="${escapeHtml(smsHref([number], message))}">Remind</a>`
          : ""}
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
