// Home screen. Same data shape as Android HomeViewModel.
//   - 2x2 stat grid (active members, total collection, handovers, handover total)
//   - Monthly Collection chart
//   - Monthly Handover chart (Paid only, bucketed by paidAtMillis)

import {
  getDatabase,
  ref,
  onValue,
  get
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02c";
import { getSelectedYear, onYearChange, chartStartForYear, ensureYearsFromMonthKeys } from "./year-state.js?v=2026-09-02c";
import { loadPaymentQr } from "./attachments.js?v=2026-09-02c";
import { openPayDialog, statsFor } from "./collectors.js?v=2026-09-02c";
import { BUILD_ID } from "./version.js?v=2026-09-02c";

const db = getDatabase(firebaseApp);

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

// Last numbers rerender() computed, so the share card can be built from
// exactly what's on screen rather than re-querying.
let lastStats = { year: 0, activeMembers: 0, totalMembers: 0, collectionMinor: 0 };

export function renderHome(container) {
  // Annual report downloads are an admin tool: a member's own record lives on
  // the Payments tab, and handing them a foundation-wide export of everyone
  // else's contributions isn't theirs to have.
  const isAdmin = window.__viewerIsAdmin === true;

  container.innerHTML = `
    <div class="home-header">
      <img class="logo-img" src="Logo.png" alt="HKF logo" />
      <div class="home-title">Hasnain Karimain Foundation</div>
      <div class="home-subtitle" id="home-greeting">Welcome</div>
    </div>

    ${isAdmin ? "" : `
    <div class="qr-card" id="qr-card">
      <div class="qr-card-text">
        <div class="qr-eyebrow">PAY CONTRIBUTION</div>
        <div class="qr-title">Pay a collector admin or HKF directly</div>
        <div class="qr-sub" id="qr-sub">Loading…</div>
      </div>
      <div class="qr-glyph" id="qr-glyph"><div class="spinner"></div></div>
    </div>
    `}

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

    ${isAdmin ? `
    <div class="nav-card" id="collections-card">
      <div class="nav-card-head">
        <div class="nav-card-text">
          <div class="nav-card-eyebrow">MY COLLECTIONS</div>
          <div class="nav-card-title">Your QR, money received, transfers to HKF</div>
        </div>
        <span class="nav-card-caret">&rsaquo;</span>
      </div>
      <div class="coll-summary" id="coll-summary">
        <div class="coll-summary-cell"><span class="coll-summary-label">RECEIVED</span><span class="coll-summary-value">…</span></div>
        <div class="coll-summary-cell"><span class="coll-summary-label">PENDING</span><span class="coll-summary-value">…</span></div>
        <div class="coll-summary-cell"><span class="coll-summary-label">TRANSFERRED</span><span class="coll-summary-value">…</span></div>
      </div>
    </div>
    ` : ""}

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

    ${isAdmin ? `
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
    ` : ""}

    ${isAdmin ? `
    <div class="nav-card" id="support-card">
      <div class="nav-card-head">
        <div class="nav-card-text">
          <div class="nav-card-eyebrow">TECH SUPPORT</div>
          <div class="nav-card-title">Send a suggestion or report a problem</div>
        </div>
        <span class="nav-card-caret">&rsaquo;</span>
      </div>
    </div>
    ` : ""}

    <div class="share-section">
      <div class="share-text">
        <div class="share-label">SPREAD THE WORD</div>
        <div class="share-sub">A card with this year's numbers and a link to the app.</div>
      </div>
      <button class="share-btn" id="share-refer">
        <span class="share-icon">\u2197</span>
        <span>Share &amp; refer</span>
      </button>
    </div>

    <div class="app-version-line">HKF web build ${escapeHtml(BUILD_ID)}</div>
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
  if (pdfBtn) {
    pdfBtn.addEventListener("click", async () => {
      await runDownload(pdfBtn, async () => {
        const mod = await import("./year-report.js?v=2026-09-02c");
        await mod.downloadYearReportPdf(getSelectedYear());
      }, "PDF");
    });
  }
  if (xlsxBtn) {
    xlsxBtn.addEventListener("click", async () => {
      await runDownload(xlsxBtn, async () => {
        const mod = await import("./year-report.js?v=2026-09-02c");
        await mod.downloadYearReportXlsx(getSelectedYear());
      }, "Excel");
    });
  }

  // Bank QR: members only, and only when the owner has uploaded one. The card
  // renders in a loading state first so it doesn't pop in halfway down the
  // page, then hides itself if there's nothing to show.
  let qrTeardown = null;
  if (!isAdmin) qrTeardown = setupPayCard(container);

  // Admin-only entry points. Android puts both on Home for the same reason the
  // web does: the nav bar is full at five tabs.
  container.querySelector("#collections-card")?.addEventListener("click", () => window.__openCollections?.());
  container.querySelector("#support-card")?.addEventListener("click", () => window.__openSupport?.());
  if (isAdmin) loadCollectionSummary(container);


  // Share card. Rendered from the numbers already on screen, so the button is
  // instant after the canvas module loads.
  const shareBtn = container.querySelector("#share-refer");
  shareBtn.addEventListener("click", async () => {
    const original = shareBtn.innerHTML;
    shareBtn.disabled = true;
    shareBtn.innerHTML = `<span class="share-icon">⋯</span><span>Building...</span>`;
    try {
      const mod = await import("./share-card.js?v=2026-09-02c");
      const outcome = await mod.shareReferralCard({ ...lastStats, year: getSelectedYear() });
      if (outcome === "downloaded") {
        window.showSnackbar?.("Card saved to your downloads - attach it to a message");
      }
    } catch (e) {
      console.error("share failed", e);
      window.showSnackbar?.("Couldn't build the card: " + (e.message || "error"));
    } finally {
      shareBtn.disabled = false;
      shareBtn.innerHTML = original;
    }
  });

  unsubMembers = onValue(ref(db, "members"), snap => {
    const val = snap.val() || {};
    membersCache = Object.entries(val).map(([uid, rec]) => ({ uid, ...rec }));
    rerender(container);
  });

  unsubPayments = onValue(ref(db, "payments"), snap => {
    paymentsByMember = {};
    const val = snap.val() || {};
    const seen = [];
    Object.entries(val).forEach(([uid, byKey]) => {
      paymentsByMember[uid] = Object.entries(byKey || {}).map(([k, p]) => ({ key: k, ...p }));
      paymentsByMember[uid].forEach(p => seen.push(p.coversMonthKey));
    });
    // Any year the data actually mentions joins the year picker.
    ensureYearsFromMonthKeys(seen);
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
    if (qrTeardown) qrTeardown();
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

  lastStats = {
    year,
    activeMembers,
    totalMembers,
    collectionMinor: totalCollectionMinor
  };

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
 * "Pay contribution" card for members.
 *
 * Android replaced the old bank-QR dialog with a two-step chooser: pick the
 * admin who is collecting from you (each admin sets their own QR and UPI ID in
 * My Collections) or the foundation's own account, then see that target's QR,
 * UPI ID and — for the foundation — its bank details with tap-to-copy. The
 * choice is remembered so the request dialog's "Paid to" is pre-filled.
 *
 * The card no longer removes itself when the owner has uploaded no QR: with
 * collector admins in the picture there is usually somebody to pay even when
 * /settings/paymentQr is empty.
 */
function setupPayCard(container) {
  const card = container.querySelector("#qr-card");
  if (!card) return null;

  let cancelled = false;
  let foundation = { bankDetails: "", upiId: "", upiName: "", qrBase64: "" };

  (async () => {
    try {
      const settingsSnap = await get(ref(db, "settings"));
      if (cancelled) return;
      const v = settingsSnap.val() || {};
      foundation.upiId = String(v.upiId || "").trim();
      foundation.upiName = String(v.upiName || "").trim();
      foundation.bankDetails = String(v.bankDetails || "").trim();
      // The QR blob is a separate read: /settings carries only its file name
      // so the settings listener stays small.
      if (v.paymentQr && v.paymentQr.name) {
        const blob = await loadPaymentQr();
        if (!cancelled && blob) foundation.qrBase64 = blob.base64;
      }
    } catch (e) {
      console.warn("pay card settings load failed", e);
    }
    if (cancelled) return;

    card.querySelector("#qr-sub").textContent = "QR · UPI · bank transfer";
    card.querySelector("#qr-glyph").innerHTML = foundation.qrBase64
      ? `<img alt="" src="data:image/jpeg;base64,${foundation.qrBase64}" />`
      : `<span class="qr-glyph-mark">₹</span>`;
    card.classList.add("ready");
  })();

  card.addEventListener("click", () => openPayDialog(foundation));

  return function teardown() { cancelled = true; };
}

/**
 * The admin's own collection figures, shown on the MY COLLECTIONS card.
 * Derived, so this is a one-shot read rather than a listener — the full
 * screen behind the card has its own Refresh.
 */
async function loadCollectionSummary(container) {
  const host = container.querySelector("#coll-summary");
  if (!host) return;
  const uid = window.__currentUser?.uid;
  if (!uid) return;
  try {
    const s = await statsFor(uid);
    const cells = [
      ["RECEIVED", s.receivedMinor, false],
      ["PENDING", s.balanceMinor, s.balanceMinor > 0],
      ["TRANSFERRED", s.transferredMinor, false]
    ];
    host.innerHTML = cells.map(([label, minor, highlight]) => `
      <div class="coll-summary-cell${highlight ? " highlight" : ""}">
        <span class="coll-summary-label">${label}</span>
        <span class="coll-summary-value">${escapeHtml(formatRupees(minor))}</span>
      </div>`).join("");
  } catch (e) {
    console.warn("collection summary failed", e);
    host.innerHTML = `<div class="coll-summary-error">Couldn't load figures</div>`;
  }
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
