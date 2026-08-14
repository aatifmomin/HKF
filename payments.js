// Member's My Payments screen.
// - Header card with total + status pill + 12-month gold bar, with each
//   month's amount printed above its segment
// - History list in month order (Jan first), confirmed payments and open
//   requests together
// - + Request pill that opens a request dialog, optionally with a payment
//   screenshot attached as proof

import {
  getDatabase,
  ref,
  onValue,
  push,
  set,
  update,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { displayNameFor } from "./auth.js";
import { getSelectedYear, onYearChange, chartStartForYear } from "./year-state.js";
import {
  pickFiles,
  prepareAttachment,
  savePaymentProof,
  deletePaymentProof,
  viewPaymentProof,
  formatBytes,
  ACCEPT_IMAGES
} from "./attachments.js";

const db = getDatabase(firebaseApp);
const MONTH_LABELS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function formatRupees(minor) {
  if (!minor || minor <= 0) return "₹0";
  const r = minor / 100;
  if (minor % 100 === 0) return "₹" + Math.trunc(r).toLocaleString("en-IN");
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Compact amount for the labels sitting above the 12-month bar. Twelve full
 * "₹1,200"s will not fit across a phone, so anything four digits or longer
 * collapses to K / L.
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

    // Amount per month, so each bar segment can be labelled with what it's
    // actually worth rather than just on/off.
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

    // Status pill semantics with year filter:
    //   - "Not started" if no payments in selected year
    //   - "Full paid" if every month from Jan-of-year through min(today, Dec-of-year) is paid
    //   - "Up to {month} {year}" otherwise (latest paid month within the year)
    // Cap "today" at the selected year's end so future-year viewing doesn't
    // misreport: viewing 2027 in May 2026 should show "Not started" (no 2027
    // payments) rather than "Up to Jan 2027" surprises.
    const sortedPaid = monthCells.filter(c => c.paid).map(c => c.key).sort();
    const latestPaid = sortedPaid[sortedPaid.length - 1];
    const now = new Date();
    const todayKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const yearEndKey = year + "-12";
    const referenceKey = todayKey < yearEndKey ? todayKey : yearEndKey;
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

    // History reads as a calendar, not a changelog: Jan at the top, Dec at the
    // bottom, with a still-open request slotted into the month it covers.
    const entries = [
      ...yearPayments.map(p => ({
        kind: "confirmed",
        monthKey: p.coversMonthKey || "",
        tie: p.recordedAtMillis || 0,
        payment: p
      })),
      ...yearRequests
        .filter(r => r.status === "pending" || r.status === "denied")
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
          await update(ref(db, "paymentRequests/" + btn.dataset.requestKey), {
            proofId: "", proofName: "", proofMime: ""
          });
          await deletePaymentProof(btn.dataset.proofRemove);
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
    // Once approved the proof is part of the record - viewable, not editable.
    const proof = p.proofId
      ? `<div class="proof-strip">
           <span class="proof-tag">PROOF</span>
           <span class="proof-name">${escapeHtml(p.proofName || "screenshot")}</span>
           <button class="doc-btn" data-proof-view="${escapeHtml(p.proofId)}">View</button>
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
  const ml = monthLabel(r.coversMonthKey || "");
  let pillClass, pillLabel;
  if (r.status === "pending") { pillClass = "pill-amber"; pillLabel = "Pending Approval"; }
  else { pillClass = "pill-red"; pillLabel = "Denied"; }

  // While it's still a request the member owns the attachment and can swap it.
  const proof = r.proofId
    ? `<div class="proof-strip">
         <span class="proof-tag">PROOF</span>
         <span class="proof-name">${escapeHtml(r.proofName || "screenshot")}</span>
         <button class="doc-btn" data-proof-view="${escapeHtml(r.proofId)}">View</button>
         <button class="doc-btn danger" data-proof-remove="${escapeHtml(r.proofId)}" data-request-key="${escapeHtml(r.key)}">Remove</button>
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
  let proof = null;   // prepared attachment, uploaded on submit

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
      // Upload the proof first: if the image write fails we'd rather leave no
      // request at all than a request whose PROOF tag points at nothing.
      let proofId = "", proofName = "", proofMime = "";
      if (proof) {
        proofId = await savePaymentProof(proof, user);
        proofName = proof.name;
        proofMime = proof.mime;
      }

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
        paymentKey: "",
        proofId,
        proofName,
        proofMime
      });
      window.showSnackbar?.("Request submitted - awaiting approval");
      close();
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Request";
      window.showSnackbar?.("Couldn't submit: " + (e.message || "error"));
    }
  });
}
