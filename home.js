// Home screen. Same data shape as Android HomeViewModel.
//   - 2x2 stat grid (active members, total collection, handovers, handover total)
//   - Monthly Collection chart
//   - Monthly Handover chart (Paid only, bucketed by paidAtMillis)

import {
  getDatabase,
  ref,
  onValue
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { getSelectedYear, onYearChange, chartStartForYear } from "./year-state.js";

const db = getDatabase(firebaseApp);

function formatRupees(amountMinor) {
  if (!amountMinor || amountMinor <= 0) return "\u20B90";
  const rupees = amountMinor / 100;
  if (amountMinor % 100 === 0) {
    return "\u20B9" + Math.trunc(rupees).toLocaleString("en-IN");
  }
  return "\u20B9" + rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nextNMonthKeys(start, n) {
  const [y0, m0] = start.split("-").map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const total = (y0 - 1) * 12 + (m0 - 1) + i;
    const year = Math.floor(total / 12) + 1;
    const month = (total % 12) + 1;
    out.push(year + "-" + String(month).padStart(2, "0"));
  }
  return out;
}

function monthKeyFromMillis(millis) {
  if (!millis || millis <= 0) return "";
  const d = new Date(millis);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function monthLetter(monthKey) {
  const m = parseInt(monthKey.split("-")[1], 10);
  return "JFMAMJJASOND"[m - 1] || "?";
}

let unsubMembers = null;
let unsubPayments = null;
let unsubHandovers = null;
let membersCache = [];
let paymentsByMember = {};
let handoversCache = [];

export function renderHome(container) {
  container.innerHTML = `
    <div class="home-header">
      <img class="logo-img" src="Logo.png" alt="HKF logo" />
      <div class="home-title">Hasnain Karimain Foundation</div>
      <div class="home-subtitle" id="home-greeting">Welcome</div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Active members</div>
        <div class="stat-value" id="stat-active">-</div>
        <div class="stat-sub" id="stat-active-sub">loading...</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total collection</div>
        <div class="stat-value" id="stat-collection">-</div>
        <div class="stat-sub" id="stat-collection-window">Jan - Dec ${getSelectedYear()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Handovers</div>
        <div class="stat-value" id="stat-handover-count">-</div>
        <div class="stat-sub" id="stat-handover-sub">loading...</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Handover total</div>
        <div class="stat-value" id="stat-handover-total">-</div>
        <div class="stat-sub">donated to date</div>
      </div>
    </div>

    <div class="balance-card" id="balance-card">
      <div class="balance-label">PENDING BALANCE</div>
      <div class="balance-value" id="stat-pending">-</div>
      <div class="balance-sub" id="stat-pending-sub">Collection minus handovers paid</div>
    </div>

    <div class="chart-section">
      <div class="chart-label">Monthly collection</div>
      <div class="chart-card">
        <div class="chart-header">
          <span>12 months</span>
          <span id="collection-max">max \u20B90</span>
        </div>
        <div class="chart-bars" id="collection-bars"></div>
        <div class="chart-labels" id="collection-labels"></div>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-label">Monthly handover</div>
      <div class="chart-card">
        <div class="chart-header">
          <span>Paid only</span>
          <span id="handover-max">max \u20B90</span>
        </div>
        <div class="chart-bars" id="handover-bars"></div>
        <div class="chart-labels" id="handover-labels"></div>
      </div>
    </div>

    <div class="download-section">
      <div class="download-label">DOWNLOAD ANNUAL REPORT</div>
      <div class="download-sub" id="download-sub">Selected year: ${getSelectedYear()}</div>
      <div class="download-row">
        <button class="download-btn" id="dl-pdf">
          <span class="download-icon">\u2B07</span>
          <span>PDF</span>
        </button>
        <button class="download-btn" id="dl-xlsx">
          <span class="download-icon">\u2B07</span>
          <span>Excel</span>
        </button>
      </div>
      <div class="download-hint">Includes all members, payments, and handovers for the selected year.</div>
    </div>
  `;

  const greetingEl = container.querySelector("#home-greeting");
  const user = window.__currentUser;
  greetingEl.textContent = user?.displayName ? "Welcome, " + user.displayName.split(" ")[0] : "Welcome";

  // Download buttons. Show "Generating..." while async work runs; restore on
  // completion or error. The report module is dynamically imported on first
  // click so the heavy PDF/XLSX libs (loaded inside it from CDN) only kick
  // in when actually needed.
  const pdfBtn = container.querySelector("#dl-pdf");
  const xlsxBtn = container.querySelector("#dl-xlsx");
  pdfBtn.addEventListener("click", async () => {
    await runDownload(pdfBtn, async () => {
      const mod = await import("./year-report.js");
      await mod.downloadYearReportPdf(getSelectedYear());
    }, "PDF");
  });
  xlsxBtn.addEventListener("click", async () => {
    await runDownload(xlsxBtn, async () => {
      const mod = await import("./year-report.js");
      await mod.downloadYearReportXlsx(getSelectedYear());
    }, "Excel");
  });

  unsubMembers = onValue(ref(db, "members"), snap => {
    const val = snap.val() || {};
    membersCache = Object.entries(val).map(([uid, rec]) => ({ uid, ...rec }));
    rerender(container);
  });

  unsubPayments = onValue(ref(db, "payments"), snap => {
    paymentsByMember = {};
    const val = snap.val() || {};
    Object.entries(val).forEach(([uid, byKey]) => {
      paymentsByMember[uid] = Object.entries(byKey || {}).map(([k, p]) => ({ key: k, ...p }));
    });
    rerender(container);
  });

  unsubHandovers = onValue(ref(db, "handovers"), snap => {
    const val = snap.val() || {};
    handoversCache = Object.entries(val).map(([k, r]) => ({ key: k, ...r }));
    rerender(container);
  });

  // When the user picks a different year from the global picker, the chart
  // window shifts and the "Jan - Dec YYYY" label updates. We don't need to
  // re-fetch any RTDB data - same listeners keep firing, the rerender just
  // recomputes against the new window.
  const unsubYear = onYearChange(year => {
    const lbl = container.querySelector("#stat-collection-window");
    if (lbl) lbl.textContent = `Jan - Dec ${year}`;
    const dlSub = container.querySelector("#download-sub");
    if (dlSub) dlSub.textContent = `Selected year: ${year}`;
    rerender(container);
  });

  return function teardown() {
    if (unsubMembers) unsubMembers();
    if (unsubPayments) unsubPayments();
    if (unsubHandovers) unsubHandovers();
    unsubYear();
    unsubMembers = unsubPayments = unsubHandovers = null;
  };
}

function rerender(container) {
  const year = getSelectedYear();
  const yearPrefix = String(year) + "-";

  // Active members for the selected year: those with at least one payment
  // whose coversMonthKey falls in the year. Switching to a future year shows
  // 0 active members, which matches the rest of the year-aware UI.
  const activeMembers = membersCache.filter(m => {
    const list = paymentsByMember[m.uid] || [];
    return list.some(p => (p.coversMonthKey || "").startsWith(yearPrefix));
  }).length;
  const totalMembers = membersCache.length;

  const collectionByMonth = {};
  Object.values(paymentsByMember).forEach(list => {
    list.forEach(p => {
      const k = p.coversMonthKey;
      if (!k) return;
      collectionByMonth[k] = (collectionByMonth[k] || 0) + (p.amountMinor || 0);
    });
  });

  // Handovers: scope paid handovers to the selected year by paidAtMillis;
  // pending handovers are always counted (they have no paidAtMillis yet and
  // represent open commitments regardless of which year you're viewing).
  const handoverByMonth = {};
  let handoverPaidCount = 0;
  let handoverPendingCount = 0;
  let handoverInYearCount = 0;
  handoversCache.forEach(h => {
    if ((h.status || "pending") === "paid") {
      if ((h.paidAtMillis || 0) > 0) {
        const paidYear = new Date(h.paidAtMillis).getFullYear();
        if (paidYear === year) {
          handoverPaidCount++;
          handoverInYearCount++;
          if ((h.amountMinor || 0) > 0) {
            const k = monthKeyFromMillis(h.paidAtMillis);
            if (k) handoverByMonth[k] = (handoverByMonth[k] || 0) + h.amountMinor;
          }
        }
      }
    } else {
      handoverPendingCount++;
      handoverInYearCount++;
    }
  });

  const chartKeys = nextNMonthKeys(chartStartForYear(), 12);
  const collectionBars = chartKeys.map(k => ({ key: k, amountMinor: collectionByMonth[k] || 0 }));
  const handoverBars = chartKeys.map(k => ({ key: k, amountMinor: handoverByMonth[k] || 0 }));

  const totalCollectionMinor = collectionBars.reduce((s, b) => s + b.amountMinor, 0);
  const totalHandoverMinor = handoverBars.reduce((s, b) => s + b.amountMinor, 0);

  container.querySelector("#stat-active").textContent = activeMembers;
  container.querySelector("#stat-active-sub").textContent = "of " + totalMembers + " total";
  container.querySelector("#stat-collection").textContent = formatRupees(totalCollectionMinor);
  container.querySelector("#stat-handover-count").textContent = handoverInYearCount;
  container.querySelector("#stat-handover-sub").textContent =
    handoverPaidCount + " paid - " + handoverPendingCount + " pending";
  container.querySelector("#stat-handover-total").textContent = formatRupees(totalHandoverMinor);

  // Pending balance: collection still in hand minus handovers already paid out.
  // If handovers exceed collection (shouldn't happen in normal operation but
  // possible during data corrections), show the negative number so the admin
  // sees the issue clearly rather than us silently clamping to zero.
  const pendingMinor = totalCollectionMinor - totalHandoverMinor;
  const pendingEl = container.querySelector("#stat-pending");
  const balanceCardEl = container.querySelector("#balance-card");
  pendingEl.textContent = formatRupees(Math.abs(pendingMinor)) + (pendingMinor < 0 ? " (over)" : "");
  // Visual cue: green when there's a positive balance, amber when zero,
  // red when somehow negative.
  balanceCardEl.classList.remove("balance-positive", "balance-zero", "balance-negative");
  if (pendingMinor > 0)       balanceCardEl.classList.add("balance-positive");
  else if (pendingMinor === 0) balanceCardEl.classList.add("balance-zero");
  else                         balanceCardEl.classList.add("balance-negative");

  drawChart(container, "collection-bars", "collection-labels", "collection-max", collectionBars);
  drawChart(container, "handover-bars", "handover-labels", "handover-max", handoverBars);
}

function drawChart(container, barsId, labelsId, maxId, bars) {
  const max = bars.reduce((m, b) => Math.max(m, b.amountMinor), 0);
  const barsEl = container.querySelector("#" + barsId);
  const labelsEl = container.querySelector("#" + labelsId);
  const maxEl = container.querySelector("#" + maxId);

  maxEl.textContent = "max " + formatRupees(max);

  if (max <= 0) {
    barsEl.innerHTML = bars.map(() => `<div class="chart-bar-col"><div class="chart-bar-amount"></div><div class="chart-bar empty"></div></div>`).join("");
  } else {
    barsEl.innerHTML = bars.map(b => {
      const pct = b.amountMinor > 0 ? Math.max(8, Math.round((b.amountMinor / max) * 100)) : 8;
      const cls = b.amountMinor > 0 ? "chart-bar" : "chart-bar empty";
      // Compact rupee label only when there's an actual amount; empty bars
      // get an empty div to keep column heights consistent.
      const amountLabel = b.amountMinor > 0 ? formatRupeesCompact(b.amountMinor) : "";
      return `
        <div class="chart-bar-col">
          <div class="chart-bar-amount">${amountLabel}</div>
          <div class="${cls}" style="height:${pct}%"></div>
        </div>
      `;
    }).join("");
  }
  labelsEl.innerHTML = bars.map(b => `<div class="chart-month-label">${monthLetter(b.key)}</div>`).join("");
}

/**
 * Compact rupee formatter for the small label above each bar. "1,200" is too
 * wide for the ~25px-wide bar columns on a 12-month chart, so we abbreviate:
 *   < 1,000          -> "Rs500"
 *   1,000-99,999     -> "1.2K"
 *   100,000+         -> "1.2L"
 * Keeping it dense lets all 12 labels fit even on narrow phones.
 */
function formatRupeesCompact(amountMinor) {
  if (!amountMinor || amountMinor <= 0) return "";
  const rupees = amountMinor / 100;
  if (rupees < 1000) {
    return "\u20B9" + Math.round(rupees);
  }
  if (rupees < 100000) {
    const k = rupees / 1000;
    return "\u20B9" + (k >= 10 ? Math.round(k) : k.toFixed(1)) + "K";
  }
  const l = rupees / 100000;
  return "\u20B9" + (l >= 10 ? Math.round(l) : l.toFixed(1)) + "L";
}

/**
 * Run a download action with a button-disable + label-swap UX. Restores the
 * button on success or failure. Uses the global snackbar to surface errors
 * since downloads are asynchronous and the user may have scrolled away by
 * the time the lib finishes loading from CDN.
 */
async function runDownload(button, action, kindLabel) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="download-icon">\u22EF</span><span>Generating...</span>`;
  try {
    await action();
  } catch (e) {
    console.error("download failed", e);
    window.showSnackbar?.("Couldn't generate " + kindLabel + ": " + (e.message || "error"));
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}
