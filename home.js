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

const db = getDatabase(firebaseApp);
const CHART_START = "2026-01";

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
        <div class="stat-sub">Jan - Dec 2026</div>
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
  `;

  const greetingEl = container.querySelector("#home-greeting");
  const user = window.__currentUser;
  greetingEl.textContent = user?.displayName ? "Welcome, " + user.displayName.split(" ")[0] : "Welcome";

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

  return function teardown() {
    if (unsubMembers) unsubMembers();
    if (unsubPayments) unsubPayments();
    if (unsubHandovers) unsubHandovers();
    unsubMembers = unsubPayments = unsubHandovers = null;
  };
}

function rerender(container) {
  const activeMembers = membersCache.filter(m => (m.totalPaidMinor || 0) > 0).length;
  const totalMembers = membersCache.length;

  const collectionByMonth = {};
  Object.values(paymentsByMember).forEach(list => {
    list.forEach(p => {
      const k = p.coversMonthKey;
      if (!k) return;
      collectionByMonth[k] = (collectionByMonth[k] || 0) + (p.amountMinor || 0);
    });
  });

  const handoverByMonth = {};
  let handoverPaidCount = 0;
  let handoverPendingCount = 0;
  handoversCache.forEach(h => {
    if ((h.status || "pending") === "paid") {
      handoverPaidCount++;
      if ((h.amountMinor || 0) > 0 && (h.paidAtMillis || 0) > 0) {
        const k = monthKeyFromMillis(h.paidAtMillis);
        if (k) handoverByMonth[k] = (handoverByMonth[k] || 0) + h.amountMinor;
      }
    } else {
      handoverPendingCount++;
    }
  });

  const chartKeys = nextNMonthKeys(CHART_START, 12);
  const collectionBars = chartKeys.map(k => ({ key: k, amountMinor: collectionByMonth[k] || 0 }));
  const handoverBars = chartKeys.map(k => ({ key: k, amountMinor: handoverByMonth[k] || 0 }));

  const totalCollectionMinor = collectionBars.reduce((s, b) => s + b.amountMinor, 0);
  const totalHandoverMinor = handoverBars.reduce((s, b) => s + b.amountMinor, 0);

  container.querySelector("#stat-active").textContent = activeMembers;
  container.querySelector("#stat-active-sub").textContent = "of " + totalMembers + " total";
  container.querySelector("#stat-collection").textContent = formatRupees(totalCollectionMinor);
  container.querySelector("#stat-handover-count").textContent = handoversCache.length;
  container.querySelector("#stat-handover-sub").textContent =
    handoverPaidCount + " paid - " + handoverPendingCount + " pending";
  container.querySelector("#stat-handover-total").textContent = formatRupees(totalHandoverMinor);

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
