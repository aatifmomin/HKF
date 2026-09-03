// Collector payments — port of Android's CollectorRepository +
// CollectorDashboardScreen + PayDialog.
//
// The problem this solves: members don't all pay into the foundation's own
// bank account. Several admins collect cash and UPI into their OWN accounts
// and move the money across later. Before this, that trail lived in
// somebody's head.
//
// Two nodes:
//   /collectors/{uid}           an admin's collection profile
//     { displayName, email, upiId, qrBase64, active, updatedAtMillis }
//   /collectorTransfers/{key}   money that admin moved to the foundation
//     { collectorUid, collectorName, amountMinor, note, transferredAtMillis,
//       status, confirmedByEmail, confirmedAtMillis, createdAtMillis }
//
// Nothing is counted. Every figure is DERIVED on demand from /payments,
// /paymentRequests and the transfer ledger, so there is no counter to drift
// between the two clients:
//
//   received    = sum of approved payments carrying this collectorUid
//   pending     = sum of still-pending requests naming this collector
//   transferred = sum of confirmed transfers by this collector
//   balance     = received - transferred      (money still in their account)
//
// A request also records WHO the member paid, and only that admin (or the
// owner) may approve it — see activity.js.

import {
  getDatabase,
  ref,
  onValue,
  get,
  push,
  set,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02a";
import { isOwner, displayNameFor } from "./auth.js?v=2026-09-02a";
import { pickFiles, prepareImageWithin, ACCEPT_IMAGES } from "./attachments.js?v=2026-09-02a";

const db = getDatabase(firebaseApp);

/** Sentinel for "paid the foundation's own bank account". */
export const HKF_DIRECT_UID = "hkf_direct";
export const HKF_DIRECT_LABEL = "HKF bank account (direct)";

export const TRANSFER_PENDING = "pending";
export const TRANSFER_CONFIRMED = "confirmed";

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatRupees(amountMinor) {
  const n = Number(amountMinor) || 0;
  if (n === 0) return "₹0";
  const rupees = n / 100;
  if (n % 100 === 0) return "₹" + Math.trunc(rupees).toLocaleString("en-IN");
  return "₹" + rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dateLabel(millis) {
  if (!millis) return "";
  return new Date(millis).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function nameBeforeAt(email) {
  const s = String(email || "");
  const i = s.indexOf("@");
  return i > 0 ? s.slice(0, i) : s;
}

/** Android's CollectorProfile, including its computed properties. */
function toProfile(uid, rec) {
  const r = rec || {};
  const displayName = String(r.displayName || "").trim();
  const email = String(r.email || "").trim();
  const upiId = String(r.upiId || "").trim();
  const qrBase64 = String(r.qrBase64 || "");
  const active = r.active !== false;   // absent means active, as in Kotlin
  return {
    uid,
    displayName,
    email,
    upiId,
    qrBase64,
    active,
    updatedAtMillis: Number(r.updatedAtMillis) || 0,
    hasQr: qrBase64.length > 0,
    canReceive: active && (qrBase64.length > 0 || upiId.length > 0),
    label: displayName || nameBeforeAt(email)
  };
}

function toTransfer(key, rec) {
  const r = rec || {};
  if (!r.collectorUid) return null;
  return {
    key,
    collectorUid: String(r.collectorUid),
    collectorName: String(r.collectorName || ""),
    amountMinor: Number(r.amountMinor) || 0,
    note: String(r.note || ""),
    transferredAtMillis: Number(r.transferredAtMillis) || 0,
    status: String(r.status || TRANSFER_PENDING),
    confirmedByEmail: String(r.confirmedByEmail || ""),
    confirmedAtMillis: Number(r.confirmedAtMillis) || 0,
    createdAtMillis: Number(r.createdAtMillis) || 0
  };
}

// ---------------------------------------------------------------- profiles

/**
 * Live list of collector profiles, sorted by label like Android does.
 * A cancelled listener (rules not published yet) reports an empty list rather
 * than throwing — the same "never close with an exception" rule Android's
 * repositories now follow, so a missing rule can't take a screen down.
 */
export function observeCollectors(callback) {
  return onValue(ref(db, "collectors"), snap => {
    const val = snap.val() || {};
    const out = Object.entries(val)
      .map(([uid, rec]) => toProfile(uid, rec))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    callback(out);
  }, err => {
    console.warn("collectors listener cancelled", err);
    callback([]);
  });
}

export async function fetchCollectors() {
  try {
    const snap = await get(ref(db, "collectors"));
    const val = snap.val() || {};
    return Object.entries(val).map(([uid, rec]) => toProfile(uid, rec));
  } catch (e) {
    console.warn("collectors read failed", e);
    return [];
  }
}

/** Null on success, otherwise a human-readable reason. */
export async function saveCollectorProfile(uid, { displayName, email, upiId, active }) {
  if (!uid) return "Not signed in";
  try {
    await update(ref(db, "collectors/" + uid), {
      displayName: String(displayName || "").trim(),
      email: String(email || "").trim(),
      upiId: String(upiId || "").trim(),
      active: !!active,
      updatedAtMillis: Date.now()
    });
    return null;
  } catch (e) {
    return e?.message || "unknown error";
  }
}

export async function setCollectorQr(uid, base64) {
  if (!uid) return "Not signed in";
  try {
    await update(ref(db, "collectors/" + uid), {
      qrBase64: String(base64 || ""),
      updatedAtMillis: Date.now()
    });
    return null;
  } catch (e) {
    return e?.message || "unknown error";
  }
}

// --------------------------------------------------------------- transfers

export function observeTransfers(callback) {
  return onValue(ref(db, "collectorTransfers"), snap => {
    const val = snap.val() || {};
    const out = Object.entries(val)
      .map(([k, rec]) => toTransfer(k, rec))
      .filter(Boolean)
      .sort((a, b) => b.transferredAtMillis - a.transferredAtMillis);
    callback(out);
  }, err => {
    console.warn("transfers listener cancelled", err);
    callback([]);
  });
}

/**
 * Record money the admin moved to the foundation. Android writes this
 * CONFIRMED straight away — the admin's own record is the truth, and a
 * mistaken entry is deleted rather than disputed — so the web does too.
 */
export async function recordTransfer(uid, collectorName, amountMinor, note, transferredAtMillis) {
  if (!uid) return "Not signed in";
  if (!(amountMinor > 0)) return "Enter an amount";
  try {
    const now = Date.now();
    await set(push(ref(db, "collectorTransfers")), {
      collectorUid: uid,
      collectorName: String(collectorName || ""),
      amountMinor,
      note: String(note || "").trim(),
      transferredAtMillis: transferredAtMillis || now,
      status: TRANSFER_CONFIRMED,
      confirmedAtMillis: now,
      createdAtMillis: now
    });
    return null;
  } catch (e) {
    return e?.message || "unknown error";
  }
}

export async function deleteTransfer(key) {
  if (!key) return false;
  try {
    await remove(ref(db, "collectorTransfers/" + key));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ stats

function emptyStats() {
  return {
    receivedMinor: 0, receivedCount: 0,
    pendingMinor: 0, pendingCount: 0, deniedCount: 0,
    transferredMinor: 0, inTransitMinor: 0, balanceMinor: 0
  };
}

/**
 * One round of reads over /payments, /paymentRequests and /collectorTransfers,
 * bucketed by collector uid. Same derivation as Android's statsAll().
 */
export async function statsAll() {
  const [paySnap, reqSnap, trSnap] = await Promise.all([
    get(ref(db, "payments")).catch(() => null),
    get(ref(db, "paymentRequests")).catch(() => null),
    get(ref(db, "collectorTransfers")).catch(() => null)
  ]);

  const out = {};
  const cell = uid => (out[uid] = out[uid] || emptyStats());

  const payments = paySnap?.val() || {};
  Object.values(payments).forEach(byKey => {
    Object.values(byKey || {}).forEach(p => {
      const c = String(p?.collectorUid || "");
      if (!c) return;
      const s = cell(c);
      s.receivedMinor += Number(p.amountMinor) || 0;
      s.receivedCount += 1;
    });
  });

  const requests = reqSnap?.val() || {};
  Object.values(requests).forEach(r => {
    const c = String(r?.collectorUid || "");
    if (!c) return;
    const s = cell(c);
    const status = String(r.status || "");
    if (status === "pending") {
      s.pendingMinor += Number(r.amountMinor) || 0;
      s.pendingCount += 1;
    } else if (status === "denied") {
      s.deniedCount += 1;
    }
  });

  const transfers = trSnap?.val() || {};
  Object.values(transfers).forEach(t => {
    const c = String(t?.collectorUid || "");
    if (!c) return;
    const s = cell(c);
    const amt = Number(t.amountMinor) || 0;
    if (String(t.status || "") === TRANSFER_CONFIRMED) s.transferredMinor += amt;
    else s.inTransitMinor += amt;
  });

  Object.values(out).forEach(s => { s.balanceMinor = s.receivedMinor - s.transferredMinor; });
  return out;
}

export async function statsFor(uid) {
  if (!uid) return emptyStats();
  const all = await statsAll();
  return all[uid] || emptyStats();
}

/**
 * Guard used before removing an admin: an admin still holding foundation
 * money can't be removed until the balance is settled, or the money trail is
 * orphaned. Matches AdminsScreen's check, matched by email because /admins is
 * keyed by email while /collectors is keyed by uid.
 */
export async function outstandingBalanceForEmail(email) {
  const needle = String(email || "").trim().toLowerCase();
  if (!needle) return 0;
  const profiles = await fetchCollectors();
  const profile = profiles.find(p => p.email.toLowerCase() === needle);
  if (!profile) return 0;
  const stats = await statsFor(profile.uid);
  return Math.max(0, stats.balanceMinor);
}

// ------------------------------------------------------------- pay dialog

/**
 * Member "Pay contribution" flow, two steps:
 *   1. pick the admin collecting from you, or the foundation's own account
 *   2. that target's QR / UPI / bank details
 * The choice is remembered for the request dialog's "Paid to" field. Android
 * keeps it in a process-lifetime object; the web keeps it in sessionStorage so
 * it survives the tab switch from Home to Payments.
 */
const CHOICE_KEY = "hkf_collector_choice";

export function setCollectorChoice(uid, name) {
  try {
    sessionStorage.setItem(CHOICE_KEY, JSON.stringify({ uid, name }));
  } catch { /* private mode — the dialog just won't pre-fill */ }
}

export function getCollectorChoice() {
  try {
    const raw = sessionStorage.getItem(CHOICE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.uid ? v : null;
  } catch {
    return null;
  }
}

export function clearCollectorChoice() {
  try { sessionStorage.removeItem(CHOICE_KEY); } catch { /* ignore */ }
}

/**
 * @param {object} foundation { bankDetails, upiId, upiName, qrBase64 }
 */
export function openPayDialog(foundation) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `<div class="modal"><div class="modal-title" id="pay-title">Who are you paying?</div>
    <div class="modal-body" id="pay-body"><div class="loading"><div class="spinner"></div>Loading collectors…</div></div>
    <div class="modal-actions" id="pay-actions">
      <button class="modal-btn" id="pay-close">Close</button>
    </div></div>`;
  document.body.appendChild(dialog);

  let collectors = [];
  let chosen = null;       // a CollectorProfile
  let chosenDirect = false;

  const unsub = observeCollectors(list => {
    collectors = list.filter(c => c.canReceive);
    if (!chosen && !chosenDirect) renderChoice();
  });

  function close() {
    unsub();
    if (dialog.parentNode) document.body.removeChild(dialog);
  }
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  const hasFoundation = !!(foundation?.bankDetails || foundation?.upiId || foundation?.qrBase64);

  function renderChoice() {
    chosen = null;
    chosenDirect = false;
    dialog.querySelector("#pay-title").textContent = "Who are you paying?";
    dialog.querySelector("#pay-body").innerHTML = `
      <p class="modal-note">
        Pick the admin collecting from you, or pay the foundation's account.
        Your payment request will name them, so they can approve it.
      </p>
      ${collectors.length === 0
        ? `<div class="attach-empty">No collector admins have set up a QR yet.</div>`
        : collectors.map((c, i) => `
            <button class="choice-row" type="button" data-choice="${i}">
              <span class="choice-text">
                <span class="choice-title">${escapeHtml(c.label)}</span>
                <span class="choice-sub">${escapeHtml(c.upiId || "QR only")}</span>
              </span>
              <span class="choice-caret">›</span>
            </button>`).join("")}
      ${hasFoundation ? `
        <button class="choice-row" type="button" data-choice="direct">
          <span class="choice-text">
            <span class="choice-title">${escapeHtml(HKF_DIRECT_LABEL)}</span>
            <span class="choice-sub">Bank transfer / UPI to the foundation</span>
          </span>
          <span class="choice-caret">›</span>
        </button>` : ""}
    `;
    dialog.querySelector("#pay-actions").innerHTML = `<button class="modal-btn" id="pay-close">Close</button>`;
    dialog.querySelector("#pay-close").addEventListener("click", close);
    dialog.querySelectorAll("[data-choice]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.choice === "direct") {
          chosenDirect = true;
          setCollectorChoice(HKF_DIRECT_UID, HKF_DIRECT_LABEL);
        } else {
          chosen = collectors[Number(btn.dataset.choice)];
          setCollectorChoice(chosen.uid, chosen.label);
        }
        renderDetail();
      });
    });
  }

  function renderDetail() {
    const qr = chosenDirect ? (foundation?.qrBase64 || "") : (chosen?.qrBase64 || "");
    const upiId = chosenDirect ? (foundation?.upiId || "") : (chosen?.upiId || "");
    const payee = chosenDirect ? (foundation?.upiName || "HKF") : (chosen?.label || "");
    const bank = chosenDirect ? (foundation?.bankDetails || "") : "";

    dialog.querySelector("#pay-title").textContent =
      chosenDirect ? "Pay HKF directly" : "Pay " + (chosen?.label || "");

    dialog.querySelector("#pay-body").innerHTML = `
      ${qr ? `<img class="qr-full" alt="Payment QR code" src="data:image/jpeg;base64,${qr}" />` : ""}
      ${upiId ? `
        <button class="copy-line" type="button" id="pay-copy-upi">
          <span class="copy-text"><span class="copy-label">UPI ID</span><span class="copy-value">${escapeHtml(upiId)}</span></span>
          <span class="copy-action">Copy</span>
        </button>` : ""}
      ${bank ? `
        <div class="copy-caption">Bank details (tap to copy)</div>
        <button class="copy-block" type="button" id="pay-copy-bank">${escapeHtml(bank)}</button>` : ""}
      <p class="modal-note">
        After paying, go to Payments → + Request. "Paid to" is pre-filled;
        attach your payment screenshot as proof.
      </p>
    `;

    dialog.querySelector("#pay-actions").innerHTML = `
      <button class="modal-btn" id="pay-back">Back</button>
      ${upiId ? `<a class="modal-btn primary" id="pay-upi" href="#">Open UPI apps</a>` : ""}
    `;
    dialog.querySelector("#pay-back").addEventListener("click", renderChoice);
    if (upiId) {
      dialog.querySelector("#pay-upi").href =
        "upi://pay?pa=" + encodeURIComponent(upiId) +
        "&pn=" + encodeURIComponent(payee || "HKF") +
        "&tn=" + encodeURIComponent("HKF contribution") +
        "&cu=INR";
    }
    dialog.querySelector("#pay-copy-upi")?.addEventListener("click", () => copy("UPI ID", upiId));
    dialog.querySelector("#pay-copy-bank")?.addEventListener("click", () => copy("Bank details", bank));
  }

  function copy(label, text) {
    navigator.clipboard?.writeText(text)
      .then(() => window.showSnackbar?.(label + " copied"))
      .catch(() => window.showSnackbar?.("Couldn't copy — select the text instead"));
  }

  renderChoice();
}

// ------------------------------------------------------ My Collections screen

/**
 * "My Collections" — an admin's own collector profile, money picture and
 * transfer ledger. The owner additionally sees every collector side by side.
 * Rendered full-screen over the tabs, exactly like Settings.
 */
export function renderCollections(container, { onBack } = {}) {
  const user = window.__currentUser;
  const uid = user?.uid || "";
  const viewerIsOwner = isOwner(user?.email);

  let collectors = [];
  let transfers = [];
  let stats = {};
  let statsLoading = true;
  let seeded = false;

  container.innerHTML = `
    <button class="back-link" id="co-back">&larr; Home</button>
    <div class="page-header">
      <div>
        <div class="page-title">My Collections</div>
        <div class="page-subtitle">Members pay you; you approve their requests; you transfer the money to HKF.</div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">MY MONEY PICTURE</div>
      <div class="coll-grid" id="co-stats"></div>
      <div class="settings-help" id="co-stats-note"></div>
      <div class="coll-actions">
        <button class="modal-btn primary settings-save" id="co-transfer">Transfer to HKF</button>
        <button class="modal-btn settings-save" id="co-refresh">Refresh</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">MY COLLECTION QR &amp; UPI</div>
      <div class="settings-help">
        Members see you in the pay list once you save with a QR or a UPI ID.
      </div>
      <div class="qr-admin" id="co-qr-state">
        <div class="qr-admin-preview" id="co-qr-preview"></div>
        <div class="qr-admin-actions">
          <button class="modal-btn settings-save" id="co-qr-upload">Upload my UPI QR</button>
          <button class="modal-btn settings-save danger-text" id="co-qr-remove" hidden>Remove QR</button>
        </div>
      </div>
      <label class="field">
        <span>My UPI ID (enables tap-to-pay)</span>
        <input type="text" id="co-upi" placeholder="e.g. name@okhdfcbank" />
      </label>
      <label class="toggle-field">
        <span class="toggle-text">
          <span class="toggle-title">Accepting payments</span>
          <span class="toggle-sub">Turn off to hide yourself from members while away.</span>
        </span>
        <input type="checkbox" id="co-active" checked />
      </label>
      <button class="modal-btn primary settings-save" id="co-save">Save profile</button>
      <div class="settings-warn" id="co-warn" hidden>
        Members will see you as a collector once you save with a QR or UPI ID.
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">MY TRANSFERS TO HKF</div>
      <div id="co-mine"></div>
    </div>

    ${viewerIsOwner ? `
    <div class="settings-section">
      <div class="settings-label">ALL COLLECTORS (OWNER VIEW)</div>
      <div id="co-all"></div>
    </div>
    <div class="settings-section">
      <div class="settings-label">ALL TRANSFERS TO HKF</div>
      <div id="co-all-transfers"></div>
    </div>` : ""}
  `;

  container.querySelector("#co-back").addEventListener("click", () => onBack?.());

  const upiEl = container.querySelector("#co-upi");
  const activeEl = container.querySelector("#co-active");

  function myProfile() {
    return collectors.find(c => c.uid === uid) || null;
  }

  async function refreshStats() {
    statsLoading = true;
    renderStats();
    stats = await statsAll();
    statsLoading = false;
    renderStats();
    renderOwnerPanes();
  }

  function renderStats() {
    const s = stats[uid] || emptyStats();
    container.querySelector("#co-stats").innerHTML = `
      ${statCell("RECEIVED", formatRupees(s.receivedMinor), s.receivedCount + " approved")}
      ${statCell("AWAITING APPROVAL", formatRupees(s.pendingMinor), s.pendingCount + " request(s) for you")}
      ${statCell("TRANSFERRED TO HKF", formatRupees(s.transferredMinor), "recorded by you")}
      ${statCell("PENDING (TO TRANSFER)", formatRupees(s.balanceMinor),
                 s.balanceMinor > 0 ? "received − transferred" : "all settled",
                 s.balanceMinor > 0)}
    `;
    container.querySelector("#co-stats-note").textContent = statsLoading ? "Refreshing figures…" : "";
  }

  function statCell(label, value, sub, highlight = false) {
    return `
      <div class="coll-cell${highlight ? " highlight" : ""}">
        <div class="coll-cell-label">${escapeHtml(label)}</div>
        <div class="coll-cell-value">${escapeHtml(value)}</div>
        <div class="coll-cell-sub">${escapeHtml(sub)}</div>
      </div>`;
  }

  function renderProfilePane() {
    const p = myProfile();
    if (!seeded && p) {
      upiEl.value = p.upiId;
      activeEl.checked = p.active;
      seeded = true;
    }
    const preview = container.querySelector("#co-qr-preview");
    const removeBtn = container.querySelector("#co-qr-remove");
    const uploadBtn = container.querySelector("#co-qr-upload");
    if (p?.hasQr) {
      preview.innerHTML = `<img class="qr-admin-img" alt="My collection QR" src="data:image/jpeg;base64,${p.qrBase64}" />`;
      removeBtn.hidden = false;
      uploadBtn.textContent = "Replace QR";
    } else {
      preview.innerHTML = `<div class="qr-admin-empty">No QR uploaded — members can still pay you by UPI ID.</div>`;
      removeBtn.hidden = true;
      uploadBtn.textContent = "Upload my UPI QR";
    }
    container.querySelector("#co-warn").hidden = !!(p && p.canReceive);
  }

  function renderMineePane() {
    const mine = transfers.filter(t => t.collectorUid === uid);
    const host = container.querySelector("#co-mine");
    host.innerHTML = mine.length
      ? mine.map(transferRow).join("")
      : `<div class="attach-empty">No transfers recorded yet.</div>`;
    wireDeletes(host);
  }

  function renderOwnerPanes() {
    if (!viewerIsOwner) return;
    const known = Array.from(new Set(collectors.map(c => c.uid).concat(Object.keys(stats))))
      .filter(u => u && u !== HKF_DIRECT_UID);
    const host = container.querySelector("#co-all");
    host.innerHTML = known.length ? known.map(cuid => {
      const p = collectors.find(c => c.uid === cuid);
      const s = stats[cuid] || emptyStats();
      return `
        <div class="coll-owner-card${s.balanceMinor > 0 ? " owing" : ""}">
          <div class="coll-owner-head">
            <span class="coll-owner-name">${escapeHtml(p?.label || "Unknown admin")}</span>
            ${p && !p.active ? `<span class="pill pill-grey pill-tiny">PAUSED</span>` : ""}
          </div>
          <div class="coll-owner-line">
            Received ${escapeHtml(formatRupees(s.receivedMinor))} &middot;
            Pending ${s.pendingCount} &middot;
            Transferred ${escapeHtml(formatRupees(s.transferredMinor))}
          </div>
          <div class="coll-owner-balance ${s.balanceMinor > 0 ? "owing" : "settled"}">
            Pending to transfer: ${escapeHtml(formatRupees(s.balanceMinor))}
          </div>
        </div>`;
    }).join("") : `<div class="attach-empty">No collectors yet.</div>`;

    const allHost = container.querySelector("#co-all-transfers");
    allHost.innerHTML = transfers.length
      ? transfers.slice(0, 30).map(transferRow).join("")
      : `<div class="attach-empty">No transfers recorded yet.</div>`;
    wireDeletes(allHost);
  }

  function transferRow(t) {
    const meta = [t.collectorName, dateLabel(t.transferredAtMillis)].filter(Boolean);
    if (t.note) meta.push(t.note);
    return `
      <div class="transfer-row">
        <div class="transfer-main">
          <div class="transfer-head">
            <span class="transfer-amount">${escapeHtml(formatRupees(t.amountMinor))}</span>
            <span class="pill pill-green pill-tiny">RECORDED</span>
          </div>
          <div class="transfer-meta">${escapeHtml(meta.join(" · "))}</div>
        </div>
        <button class="ticket-delete" type="button" data-del="${escapeHtml(t.key)}" title="Delete this record">✕</button>
      </div>`;
  }

  function wireDeletes(host) {
    host.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const t = transfers.find(x => x.key === btn.dataset.del);
        if (!t) return;
        const ok = confirm(
          "Delete this transfer record?\n\n" +
          formatRupees(t.amountMinor) + " recorded by " + (t.collectorName || "an admin") +
          " on " + dateLabel(t.transferredAtMillis) +
          " will be removed and the pending amount recalculated."
        );
        if (!ok) return;
        btn.disabled = true;
        await deleteTransfer(t.key);
        await refreshStats();
      });
    });
  }

  // ---- QR upload / remove ----
  container.querySelector("#co-qr-upload").addEventListener("click", async e => {
    const btn = e.currentTarget;
    const files = await pickFiles({ multiple: false, accept: ACCEPT_IMAGES });
    if (!files.length) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Uploading...";
    try {
      // A QR rides inside the /collectors record, which every member's pay
      // dialog downloads — so it gets the tight 200 KB budget, not the 1.5 MB
      // one used for one-off attachments.
      const att = await prepareImageWithin(files[0]);
      const err = await setCollectorQr(uid, att.base64);
      window.showSnackbar?.(err ? "Couldn't save: " + err : "QR saved");
    } catch (err) {
      window.showSnackbar?.(err.message || "Couldn't read that image");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  container.querySelector("#co-qr-remove").addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    await setCollectorQr(uid, "");
    window.showSnackbar?.("QR removed");
    btn.disabled = false;
  });

  container.querySelector("#co-save").addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const err = await saveCollectorProfile(uid, {
      displayName: displayNameFor(user),
      email: user?.email || "",
      upiId: upiEl.value,
      active: activeEl.checked
    });
    window.showSnackbar?.(err ? "Couldn't save: " + err : "Profile saved");
    btn.disabled = false;
  });

  container.querySelector("#co-refresh").addEventListener("click", () => refreshStats());
  container.querySelector("#co-transfer").addEventListener("click", () => openTransferDialog());

  function openTransferDialog() {
    const s = stats[uid] || emptyStats();
    const dialog = document.createElement("div");
    dialog.className = "modal-overlay";
    dialog.innerHTML = `
      <div class="modal">
        <div class="modal-title">Transfer to HKF</div>
        <div class="modal-body">
          <p class="modal-note">
            Record money you moved from your account to the foundation. It counts
            as transferred immediately; delete the entry if you made a mistake.
          </p>
          <label class="field">
            <span>Amount (₹) *</span>
            <input type="text" inputmode="numeric" id="tr-amount" placeholder="0" />
          </label>
          <label class="field">
            <span>Note (UTR / reference, optional)</span>
            <input type="text" id="tr-note" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="modal-btn" id="tr-cancel">Cancel</button>
          <button class="modal-btn primary" id="tr-ok">Record</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);

    const amountEl = dialog.querySelector("#tr-amount");
    // Android pre-fills whatever is still outstanding — one tap settles up.
    if (s.balanceMinor > 0) amountEl.value = String(Math.trunc(s.balanceMinor / 100));
    amountEl.addEventListener("input", () => { amountEl.value = amountEl.value.replace(/\D/g, ""); });

    function close() { if (dialog.parentNode) document.body.removeChild(dialog); }
    dialog.querySelector("#tr-cancel").addEventListener("click", close);
    dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

    dialog.querySelector("#tr-ok").addEventListener("click", async e => {
      const amountMinor = (parseInt(amountEl.value, 10) || 0) * 100;
      if (amountMinor <= 0) { window.showSnackbar?.("Enter an amount"); return; }
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Recording...";
      const err = await recordTransfer(
        uid,
        displayNameFor(user) || user?.email || "",
        amountMinor,
        dialog.querySelector("#tr-note").value,
        Date.now()
      );
      close();
      window.showSnackbar?.(err ? "Couldn't record: " + err : "Transfer recorded");
      await refreshStats();
    });
  }

  const unsubCollectors = observeCollectors(list => {
    collectors = list;
    renderProfilePane();
    renderOwnerPanes();
  });

  const unsubTransfers = observeTransfers(list => {
    transfers = list;
    renderMineePane();
    renderOwnerPanes();
  });

  renderStats();
  renderProfilePane();
  renderMineePane();
  refreshStats();

  return function teardown() {
    unsubCollectors();
    unsubTransfers();
  };
}
