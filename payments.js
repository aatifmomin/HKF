// Member's My Payments screen.
// - Reminder banner (driven by /settings/reminderDay + reminderText)
// - Header card with total + status pill + 12-month bar, each month's amount
//   printed above its segment
// - History in month order (Jan first), confirmed payments and open requests
//   together
// - + Request pill, optionally with a payment screenshot attached as proof
//
// Proof storage matches Android: one image per request, stored at
// /paymentProofs/{requestKey}, with `proofName` on the request as the only
// flag. There is no proofId and nothing is copied onto the payment row when a
// request is approved - the approved request keeps the image, and this screen
// looks it up via approvedPaymentKey.

import {
  getDatabase,
  ref,
  onValue,
  get,
  push,
  set,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { displayNameFor } from "./auth.js";
import { getSelectedYear, onYearChange, chartStartForYear } from "./year-state.js";
import {
  pickFiles,
  prepareAttachment,
  savePaymentProof,
  removePaymentProof,
  viewPaymentProof,
  formatBytes,
  ACCEPT_IMAGES
} from "./attachments.js";

const db = getDatabase(firebaseApp);
const MONTH_LABELS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_TITLE = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const DEFAULT_REMINDER = "Assalamualekum! Please contribute for the current month";

function formatRupees(minor) {
  if (!minor || minor <= 0) return "₹0";
  const r = minor / 100;
  if (minor % 100 === 0) return "₹" + Math.trunc(r).toLocaleString("en-IN");
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Compact amount for the labels above the 12-month bar. Twelve full "₹1,200"s
 * will not fit across a phone, so anything four digits or longer collapses.
 */
function formatRupeesCompact(minor) {
  if (!minor || minor <= 0) return "";
  const rupees = minor / 100;
  if (rupees < 1000) return "₹" + Math.round(rupees);
  if (rupees < 100000) {
    const k = rupees / 1000;
    return "₹" + (k >= 10 ? Math.round(k) : k.toFixed(1)) + "K";
  }
  const l = rupees / 100000;
  return "₹" + (l >= 10 ? Math.round(l) : l.toFixed(1)) + "L";
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
  const [y, m] = String(monthKey || "").split("-");
  if (!m) return "";
  return MONTH_LABELS[parseInt(m, 10) - 1] + " " + y;
}

function monthTitle(monthKey) {
  const [y, m] = String(monthKey || "").split("-");
  if (!m) return "";
  return MONTH_TITLE[parseInt(m, 10) - 1] + " " + y;
}

/** Device-local current month, matching Android's MonthKey.current(). */
function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
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
  let settings = { reminderDay: 0, reminderText: "" };

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

  // One-shot, like Android: the reminder settings don't change mid-session
  // often enough to justify a live listener on every member's device.
  get(ref(db, "settings")).then(snap => {
    const v = snap.val() || {};
    settings = { reminderDay: Number(v.reminderDay) || 0, reminderText: v.reminderText || "" };
    rerender();
  }).catch(() => {});

  /**
   * Reminder banner: shown from `reminderDay` of the month onwards, to members
   * who have no payment covering the CURRENT month. Deliberately independent
   * of the year picker - looking at 2027 shouldn't hide this month's nudge.
   */
  function reminderBanner() {
    const day = settings.reminderDay;
    if (!(day >= 1 && day <= 28)) return "";
    if (new Date().getDate() < day) return "";
    const month = currentMonthKey();
    const paidThisMonth = payments.some(p => (p.coversMonthKey || "") === month);
    if (paidThisMonth) return "";
    const text = settings.reminderText ||
      `Your contribution for ${monthTitle(month)} is pending. Tap + Request after paying to submit it.`;
    return `
      <div class="reminder-banner">
        <div class="reminder-banner-label">PAYMENT REMINDER</div>
        <div class="reminder-banner-text">${escapeHtml(text)}</div>
      </div>
    `;
  }

  function rerender() {
    const year = getSelectedYear();
    const chartKeys = nextNMonthKeys(chartStartForYear(year), 12);
    const yearPrefix = String(year) + "-";
    const yearPayments = payments.filter(p => (p.coversMonthKey || "").startsWith(yearPrefix));
    const yearRequests = myRequests.filter(r => (r.coversMonthKey || "").startsWith(yearPrefix));

    const totalMinor = yearPayments.reduce((s, p) => s + (p.amountMinor || 0), 0);

    const amountByMonth = {};
    yearPayments.forEach(p => {
      const k = p.coversMonthKey;
      if (!k) return;
      amountByMonth[k] = (amountByMonth[k] || 0) + (p.amountMinor || 0);
    });
    const monthCells = chartKeys.map(k => ({
      key: k,
      paid: (amountByMonth[k] || 0) > 0,
      amountMinor: amountByMonth[k] || 0
    }));
    const paidCount = monthCells.filter(c => c.paid).length;

    // Status pill, capped at the selected year's end so viewing a future year
    // reports "Not started" rather than a misleading "Up to Jan".
    const sortedPaid = monthCells.filter(c => c.paid).map(c => c.key).sort();
    const latestPaid = sortedPaid[sortedPaid.length - 1];
    const todayKey = currentMonthKey();
    const yearEndKey = year + "-12";
    const referenceKey = todayKey < yearEndKey ? todayKey : yearEndKey;
    const yearStartKey = year + "-01";
    let statusLabel, statusClass;
    if (!latestPaid || referenceKey < yearStartKey) {
      statusLabel = "Not started";
      statusClass = "pill-grey";
    } else if (latestPaid >= referenceKey) {
      statusLabel = "Full paid";
      statusClass = "pill-green";
    } else {
      const [, lm] = latestPaid.split("-");
      statusLabel = "Up to " + MONTH_TITLE[parseInt(lm, 10) - 1] + " " + year;
      statusClass = "pill-amber";
    }

    // An approved request keeps its proof image. Map the payment row it
    // created back to the request so the confirmed row can show it read-only.
    const proofByPaymentKey = {};
    myRequests.forEach(r => {
      if (r.proofName && r.approvedPaymentKey) proofByPaymentKey[r.approvedPaymentKey] = r;
    });

    // History reads as a calendar: Jan at the top, Dec at the bottom, with a
    // still-open request slotted into the month it covers.
    const entries = [
      ...yearPayments.map(p => ({
        kind: "confirmed",
        monthKey: p.coversMonthKey || "",
        tie: p.recordedAtMillis || 0,
        payment: p,
        proofRequest: proofByPaymentKey[p.key] || null
      })),
      ...yearRequests
        .filter(r => (r.status || "pending") === "pending" || (r.status || "") === "denied")
        .map(r => ({
          kind: "request",
          monthKey: r.coversMonthKey || "",
          tie: r.createdAtMillis || 0,
          request: r
        }))
    ].sort((a, b) => {
      const byMonth = (a.monthKey || "").localeCompare(b.monthKey || "");
      if (byMonth !== 0) return byMonth;
      return (a.tie || 0) - (b.tie || 0);
    });

    contentEl.innerHTML = `
      ${reminderBanner()}
      <div class="my-payments-card">
        <div class="mp-label">YOUR TOTAL PAID</div>
        <div class="mp-row">
          <div class="mp-total">${formatRupees(totalMinor)}</div>
          <span class="pill ${statusClass}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="mp-window">Jan ${year} - Dec ${year} - ${paidCount} of 12 paid</div>
        <div class="mp-bar-amounts">
          ${monthCells.map(c => `<div class="mp-month-amount">${escapeHtml(formatRupeesCompact(c.amountMinor))}</div>`).join("")}
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

    wireHistoryActions(contentEl);
  }

  function wireHistoryActions(scope) {
    scope.querySelectorAll("[data-proof-view]").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try { await viewPaymentProof(btn.dataset.proofView); }
        finally { btn.disabled = false; }
      });
    });
    scope.querySelectorAll("[data-proof-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove the payment proof from this request?")) return;
        btn.disabled = true;
        try {
          await removePaymentProof(btn.dataset.proofRemove);
          window.showSnackbar?.("Proof removed");
        } catch (e) {
          btn.disabled = false;
          window.showSnackbar?.("Couldn't remove: " + (e.message || "error"));
        }
      });
    });
  }

  container.querySelector("#request-btn").addEventListener("click", () => {
    openRequestDialog(user);
  });

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
    const ml = monthLabel(p.coversMonthKey);
    // Once approved the proof is part of the record - viewable, not editable.
    const r = entry.proofRequest;
    const proof = r
      ? `<div class="proof-strip">
           <span class="proof-tag">PROOF</span>
           <span class="proof-name">${escapeHtml(r.proofName)}</span>
           <button class="doc-btn" data-proof-view="${escapeHtml(r.key)}">View</button>
         </div>`
      : "";
    return `
      <div class="history-row ${proof ? "has-proof" : ""}">
        <div class="history-row-circle on">${ml ? ml.charAt(0) : "?"}</div>
        <div class="history-row-body">
          <div class="history-row-title">
            <span>${escapeHtml(ml)}</span>
            <span class="pill pill-green pill-tiny">Paid</span>
          </div>
          <div class="history-row-sub">${escapeHtml(p.category || "Contribution")}</div>
          ${proof}
        </div>
        <div class="history-row-amount">${formatRupees(p.amountMinor || 0)}</div>
      </div>
    `;
  }

  const r = entry.request;
  const ml = monthLabel(r.coversMonthKey);
  const pending = (r.status || "pending") === "pending";
  const pillClass = pending ? "pill-amber" : "pill-red";
  const pillLabel = pending ? "Pending Approval" : "Denied";

  // While it's still a request the member owns the attachment and can swap it.
  const proof = r.proofName
    ? `<div class="proof-strip">
         <span class="proof-tag">PROOF</span>
         <span class="proof-name">${escapeHtml(r.proofName)}</span>
         <button class="doc-btn" data-proof-view="${escapeHtml(r.key)}">View</button>
         ${pending ? `<button class="doc-btn danger" data-proof-remove="${escapeHtml(r.key)}">Remove</button>` : ""}
       </div>`
    : "";

  return `
    <div class="history-row ${proof ? "has-proof" : ""}">
      <div class="history-row-circle">${ml ? ml.charAt(0) : "?"}</div>
      <div class="history-row-body">
        <div class="history-row-title">
          <span>${escapeHtml(ml)}</span>
          <span class="pill ${pillClass} pill-tiny">${pillLabel}</span>
        </div>
        <div class="history-row-sub">${escapeHtml(r.category || "Contribution")}</div>
        ${proof}
      </div>
      <div class="history-row-amount muted">${formatRupees(r.amountMinor || 0)}</div>
    </div>
  `;
}

function openRequestDialog(user) {
  let proof = null;   // prepared attachment, uploaded after the request exists

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
          <span>Amount (₹) *</span>
          <input type="text" inputmode="decimal" id="r-amount" placeholder="0" />
        </label>
        <label class="field">
          <span>Category</span>
          <input type="text" id="r-category" value="Member contribution" />
        </label>

        <div class="field">
          <span>Payment proof</span>
          <div class="attach-box">
            <div class="attach-head">
              <button class="attach-btn" type="button" id="r-attach">+ Add screenshot</button>
              <span class="attach-hint">Optional &middot; JPG or PNG</span>
            </div>
            <div id="r-proof-list" class="attach-list"></div>
          </div>
        </div>
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

  function renderProofList() {
    const el = dialog.querySelector("#r-proof-list");
    if (!proof) {
      el.innerHTML = `<div class="attach-empty">No screenshot attached.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="attach-item staged">
        <span class="doc-kind">IMG</span>
        <span class="doc-name">${escapeHtml(proof.name)}</span>
        <span class="doc-size">${escapeHtml(formatBytes(proof.sizeBytes))}</span>
        <button class="doc-btn danger" type="button" id="r-proof-remove">Remove</button>
      </div>
    `;
    el.querySelector("#r-proof-remove").addEventListener("click", () => {
      proof = null;
      renderProofList();
    });
  }
  renderProofList();

  dialog.querySelector("#r-attach").addEventListener("click", async () => {
    const btn = dialog.querySelector("#r-attach");
    const files = await pickFiles({ multiple: false, accept: ACCEPT_IMAGES });
    if (!files.length) return;
    btn.disabled = true;
    btn.textContent = "Processing...";
    try {
      proof = await prepareAttachment(files[0]);
      renderProofList();
    } catch (e) {
      window.showSnackbar?.(e.message || "Couldn't read that image");
    } finally {
      btn.disabled = false;
      btn.textContent = proof ? "Replace screenshot" : "+ Add screenshot";
    }
  });

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#r-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#r-submit").addEventListener("click", async () => {
    const submitBtn = dialog.querySelector("#r-submit");
    const amount = parseFloat(dialog.querySelector("#r-amount").value);
    const amountMinor = Math.round((amount || 0) * 100);
    if (amountMinor <= 0) { window.showSnackbar?.("Enter an amount greater than zero"); return; }
    const dateStr = dialog.querySelector("#r-date").value || todayStr;
    const dateMillis = new Date(dateStr + "T12:00:00").getTime();
    const coversMonthKey = monthKeyFromMillis(dateMillis);
    const category = (dialog.querySelector("#r-category").value || "Member contribution").trim();

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";

    try {
      // The proof is keyed by the request, so the request has to exist first.
      const reqRef = push(ref(db, "paymentRequests"));
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
        discussionMessageKey: "",
        approvedPaymentKey: "",
        proofName: proof ? proof.name : ""
      });

      if (proof) {
        try {
          await savePaymentProof(reqRef.key, proof);
        } catch (e) {
          // The request stands; only the image failed. Clear the flag so the
          // card doesn't advertise a proof that isn't there.
          console.error("proof upload failed", e);
          await set(ref(db, "paymentRequests/" + reqRef.key + "/proofName"), "").catch(() => {});
          window.showSnackbar?.("Request sent, but the screenshot didn't upload");
          close();
          return;
        }
      }

      window.showSnackbar?.("Request submitted - awaiting approval");
      close();
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Request";
      window.showSnackbar?.("Couldn't submit: " + (e.message || "error"));
    }
  });
}
