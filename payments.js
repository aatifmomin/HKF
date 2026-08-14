// Member's My Payments screen.
// - Header card with total + status pill + 12-month gold bar
// - History list (confirmed payments + pending requests)
// - + Request pill that opens a request dialog

import {
  getDatabase,
  ref,
  onValue,
  push,
  set,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { displayNameFor } from "./auth.js";
import { getSelectedYear, onYearChange, chartStartForYear } from "./year-state.js";

const db = getDatabase(firebaseApp);
const MONTH_LABELS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function formatRupees(minor) {
  if (!minor || minor <= 0) return "\u20B90";
  const r = minor / 100;
  if (minor % 100 === 0) return "\u20B9" + Math.trunc(r).toLocaleString("en-IN");
  return "\u20B9" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nextNMonthKeys(start, n) {
  const [y0, m0] = start.split("-").map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (y0 - 1) * 12 + (m0 - 1) + i;
    out.push((Math.floor(t / 12) + 1) + "-" + String((t % 12) + 1).padStart(2, "0"));
  }
  return out;
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-");
  return MONTH_LABELS[parseInt(m, 10) - 1] + " " + y;
}

function monthKeyFromMillis(millis) {
  if (!millis) return "";
  const d = new Date(millis);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPayments(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Payments</div>
        <div class="page-subtitle">Your contribution record for the year</div>
      </div>
      <button class="add-pill" id="request-btn">+ Request</button>
    </div>
    <div id="payments-content">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  const contentEl = container.querySelector("#payments-content");
  let payments = [];
  let myRequests = [];

  const unsubPayments = onValue(ref(db, "payments/" + user.uid), snap => {
    const val = snap.val() || {};
    payments = Object.entries(val).map(([k, p]) => ({ key: k, ...p }));
    rerender();
  });

  const unsubRequests = onValue(ref(db, "paymentRequests"), snap => {
    const val = snap.val() || {};
    myRequests = Object.entries(val)
      .map(([k, r]) => ({ key: k, ...r }))
      .filter(r => r.memberUid === user.uid);
    rerender();
  });

  function rerender() {
    const year = getSelectedYear();
    const chartKeys = nextNMonthKeys(chartStartForYear(year), 12);

    // Filter payments + requests to the selected year so totals, bar, and
    // history all reflect the chosen window. Year membership uses
    // coversMonthKey ("YYYY-MM"), which is the canonical year a payment
    // counts toward (regardless of when it was actually recorded).
    const yearPrefix = String(year) + "-";
    const yearPayments = payments.filter(p => (p.coversMonthKey || "").startsWith(yearPrefix));
    const yearRequests = myRequests.filter(r => (r.coversMonthKey || "").startsWith(yearPrefix));

    const totalMinor = yearPayments.reduce((s, p) => s + (p.amountMinor || 0), 0);
    const paidMonths = new Set(yearPayments.map(p => p.coversMonthKey).filter(Boolean));
    const monthCells = chartKeys.map(k => ({
      key: k,
      paid: paidMonths.has(k),
      amountMinor: yearPayments
        .filter(p => p.coversMonthKey === k)
        .reduce((sum, p) => sum + (p.amountMinor || 0), 0)
    }));
    const paidCount = monthCells.filter(c => c.paid).length;

    // Status pill semantics with year filter:
    //   - "Not started" if no payments in selected year
    //   - "Full paid" if every month from Jan-of-year through min(today, Dec-of-year) is paid
    //   - "Up to {month} {year}" otherwise (latest paid month within the year)
    // Cap "today" at the selected year's end so future-year viewing doesn't
    // misreport: viewing 2027 in May 2026 should show "Not started" (no 2027
    // payments) rather than "Up to Jan 2027" surprises.
    const sortedPaid = [...paidMonths].sort();
    const latestPaid = sortedPaid[sortedPaid.length - 1];
    const now = new Date();
    const todayKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const yearEndKey = year + "-12";
    const referenceKey = todayKey < yearEndKey ? todayKey : yearEndKey;
    // referenceKey may pre-date the selected year; if so, the year is in the
    // future and we expect "Not started".
    const yearStartKey = year + "-01";
    let statusLabel, statusClass;
    if (!latestPaid) {
      statusLabel = "Not started";
      statusClass = "pill-grey";
    } else if (referenceKey < yearStartKey) {
      // Selected year is entirely in the future relative to today
      statusLabel = "Not started";
      statusClass = "pill-grey";
    } else if (latestPaid >= referenceKey) {
      statusLabel = "Full paid";
      statusClass = "pill-green";
    } else {
      const [, lm] = latestPaid.split("-");
      statusLabel = "Up to " + MONTH_LABELS[parseInt(lm, 10) - 1].slice(0, 3) + " " + year;
      statusClass = "pill-amber";
    }

    const entries = [
      ...yearPayments.map(p => ({ kind: "confirmed", sortKey: p.recordedAtMillis || 0, monthKey: p.coversMonthKey || "", payment: p })),
      ...yearRequests
        .filter(r => r.status === "pending" || r.status === "denied")
        .map(r => ({ kind: "request", sortKey: r.createdAtMillis || 0, monthKey: r.coversMonthKey || "", request: r }))
        ].sort((a, b) =>
      // Month order (Jan -> Dec) first, then record time within a month.
      a.monthKey === b.monthKey ? a.sortKey - b.sortKey
        : a.monthKey < b.monthKey ? -1 : 1
    );

    contentEl.innerHTML = `
      <div class="my-payments-card">
        <div class="mp-label">YOUR TOTAL PAID</div>
        <div class="mp-row">
          <div class="mp-total">${formatRupees(totalMinor)}</div>
          <span class="pill ${statusClass}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="mp-window">Jan ${year} - Dec ${year} - ${paidCount} of 12 paid</div>
        <div style="display:flex;margin-bottom:2px;">
          ${monthCells.map(c => `<div style="flex:1;text-align:center;font-size:8px;font-weight:600;color:var(--gold-dark);overflow:hidden;white-space:nowrap;">${c.amountMinor > 0 ? compactAmt(c.amountMinor) : ''}</div>`).join("")}
        </div>
        <div class="mp-bar">
          ${monthCells.map(c => `<div class="mp-segment ${c.paid ? 'on' : ''}"></div>`).join("")}
        </div>
        <div class="mp-bar-labels">
          ${monthCells.map(c => `<div class="mp-month-label">${MONTH_LABELS[parseInt(c.key.split('-')[1],10)-1].charAt(0)}</div>`).join("")}
        </div>
      </div>

      <div class="section-header">PAYMENT HISTORY</div>
      ${entries.length === 0
        ? `<div class="empty-state">No payments in ${year}.</div>`
        : `<div class="rows-list">${entries.map(renderHistoryRow).join("")}</div>`
      }
    `;
  }

  container.querySelector("#request-btn").addEventListener("click", () => {
    openRequestDialog(user);
  });

  // Year-filter subscription: re-render when the global year picker changes.
  const unsubYear = onYearChange(() => rerender());

  return function teardown() {
    unsubPayments();
    unsubRequests();
    unsubYear();
  };
}

function renderHistoryRow(entry) {
  if (entry.kind === "confirmed") {
    const p = entry.payment;
    const ml = monthLabel(p.coversMonthKey || "");
    return `
      <div class="history-row">
        <div class="history-row-circle on">${ml ? ml.charAt(0) : "?"}</div>
        <div class="history-row-body">
          <div class="history-row-title">
            <span>${escapeHtml(ml)}</span>
            <span class="pill pill-green pill-tiny">Paid</span>
          </div>
          <div class="history-row-sub">${escapeHtml(p.category || "Contribution")}</div>
        </div>
        <div class="history-row-amount">${formatRupees(p.amountMinor || 0)}</div>
      </div>
    `;
  }
  const r = entry.request;
  const ml = monthLabel(r.coversMonthKey || "");
  let pillClass, pillLabel;
  if (r.status === "pending") { pillClass = "pill-amber"; pillLabel = "Pending Approval"; }
  else { pillClass = "pill-red"; pillLabel = "Denied"; }
  return `
    <div class="history-row">
      <div class="history-row-circle">${ml ? ml.charAt(0) : "?"}</div>
      <div class="history-row-body">
        <div class="history-row-title">
          <span>${escapeHtml(ml)}</span>
          <span class="pill ${pillClass} pill-tiny">${pillLabel}</span>
        </div>
        <div class="history-row-sub">${escapeHtml(r.category || "Contribution")}</div>
      </div>
      <div class="history-row-amount muted">${formatRupees(r.amountMinor || 0)}</div>
    </div>
  `;
}

function openRequestDialog(user) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Request payment</div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text-3);margin:0 0 14px;">
          Submit for admin approval. Once approved, it will appear in your record.
        </p>
        <label class="field">
          <span>Date</span>
          <input type="date" id="r-date" />
        </label>
        <label class="field">
          <span>Amount (\u20B9) *</span>
          <input type="text" inputmode="decimal" id="r-amount" placeholder="0" />
        </label>
        <label class="field">
          <span>Category</span>
          <input type="text" id="r-category" value="Member contribution" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="r-cancel">Cancel</button>
        <button class="modal-btn primary" id="r-submit">Request</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0") + "-" + String(today.getDate()).padStart(2,"0");
  dialog.querySelector("#r-date").value = todayStr;
  dialog.querySelector("#r-date").max = todayStr;

  dialog.querySelector("#r-amount").addEventListener("input", e => {
    if (!/^\d*\.?\d{0,2}$/.test(e.target.value)) e.target.value = e.target.value.slice(0, -1);
  });

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#r-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#r-submit").addEventListener("click", async () => {
    const amount = parseFloat(dialog.querySelector("#r-amount").value);
    const amountMinor = Math.round((amount || 0) * 100);
    if (amountMinor <= 0) { window.showSnackbar?.("Enter an amount greater than zero"); return; }
    const dateStr = dialog.querySelector("#r-date").value || todayStr;
    const dateMillis = new Date(dateStr + "T12:00:00").getTime();
    const coversMonthKey = monthKeyFromMillis(dateMillis);
    const category = (dialog.querySelector("#r-category").value || "Member contribution").trim();

    try {
      const reqRef = push(ref(db, "paymentRequests"));
      const summary = displayNameFor(user) + " requested " + formatRupees(amountMinor) + " for " + monthLabel(coversMonthKey);
      await set(reqRef, {
        memberUid: user.uid,
        memberId: "",
        memberName: displayNameFor(user),
        memberEmail: user.email || "",
        amountMinor,
        requestedDateMillis: dateMillis,
        coversMonthKey,
        category,
        status: "pending",
        createdAtMillis: serverTimestamp(),
        decidedByEmail: "",
        decidedByName: "",
        decidedAtMillis: 0,
        discussionMessageKey: ""
      });
      const msgRef = push(ref(db, "messages"));
      await set(msgRef, {
        senderUid: user.uid,
        senderName: displayNameFor(user),
        senderEmail: user.email || "",
        text: summary,
        timestampMillis: serverTimestamp(),
        kind: "payment_request",
        paymentRequestKey: reqRef.key
      });
      window.showSnackbar?.("Request submitted - awaiting approval");
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't submit: " + (e.message || "error"));
    }
  });
}

// "500" / "1.5K" / "1.2L" - compact rupee labels above the 12-month bar.
function compactAmt(minor) {
  const r = minor / 100;
  if (r >= 100000) return (r / 100000).toFixed(1).replace(".0", "") + "L";
  if (r >= 1000) return (r / 1000).toFixed(1).replace(".0", "") + "K";
  return String(Math.round(r));
}
