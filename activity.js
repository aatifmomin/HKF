// Activity feed - admin only. Replaces the old Discussion tab.
//
// A port of Android's ActivityScreen + ActivityViewModel. Three sources feed
// one flat card list, each needing a decision:
//
//   * payment requests   -> Approve / Deny        (/paymentRequests)
//   * handovers          -> Mark paid             (/handovers)
//   * join requests      -> Approve / Discard     (/joinRequests)
//
// Pending is highlighted gold and sorted above everything; decided is greyed
// and kept below as a log. Both blocks sort newest-first.
//
// The owner gets three extra powers, matching Android: edit a decided payment
// request, move a paid handover back to pending, and delete a request or join
// row outright.
//
// Write semantics are deliberately identical to PaymentRequestRepository:
// status flips are claimed with a transaction so two admins tapping Approve
// at the same moment can't both record the payment, and the member total is
// RECOMPUTED rather than incremented.

import {
  getDatabase,
  ref,
  onValue,
  get,
  set,
  push,
  update,
  runTransaction,
  remove as fbRemove,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02c";
import { isOwner, displayNameFor } from "./auth.js?v=2026-09-02c";
import {
  approveJoinRequest,
  declineJoinRequest,
  deleteJoinRequest,
  recalcMemberTotal,
  JOIN_PENDING,
  JOIN_APPROVED
} from "./members-self.js?v=2026-09-02c";
import { viewPaymentProof } from "./attachments.js?v=2026-09-02c";
import { nextNMonths } from "./year-state.js?v=2026-09-02c";
import { HKF_DIRECT_UID } from "./collectors.js?v=2026-09-02c";

const db = getDatabase(firebaseApp);

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Timestamp of the newest item still awaiting a decision, across payment
 * requests and join requests. Drives the red dot on the Activity tab — the
 * web equivalent of Android's WidgetSyncBridge.newestPendingMillis.
 */
export function observeNewestPending(callback) {
  let reqNewest = 0;
  let joinNewest = 0;
  const emit = () => callback(Math.max(reqNewest, joinNewest));

  const newestOf = (val, isPending, stamp) => Object.values(val || {})
    .filter(isPending)
    .reduce((m, r) => Math.max(m, Number(stamp(r)) || 0), 0);

  const unsubReq = onValue(ref(db, "paymentRequests"), snap => {
    reqNewest = newestOf(snap.val(), r => statusOf(r) === "pending", r => r.createdAtMillis);
    emit();
  }, () => { reqNewest = 0; emit(); });

  const unsubJoin = onValue(ref(db, "joinRequests"), snap => {
    joinNewest = newestOf(snap.val(), r => statusOf(r) === JOIN_PENDING, r => r.requestedAtMillis);
    emit();
  }, () => { joinNewest = 0; emit(); });

  return function teardown() { unsubReq(); unsubJoin(); };
}

function formatRupees(minor) {
  if (!minor || minor <= 0) return "₹0";
  const r = minor / 100;
  if (minor % 100 === 0) return "₹" + Math.trunc(r).toLocaleString("en-IN");
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function monthLabel(monthKey) {
  if (!monthKey) return "-";
  const [y, m] = monthKey.split("-");
  const idx = parseInt(m, 10) - 1;
  if (idx < 0 || idx > 11) return monthKey;
  return MONTH_LABELS[idx] + " " + y;
}

function formatDate(millis) {
  if (!millis || millis <= 0) return "-";
  return new Date(millis).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Matches Android's relative-time helper. */
function formatWhen(millis) {
  if (!millis || millis <= 0) return "";
  const diff = Date.now() - millis;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return Math.floor(diff / min) + "m ago";
  if (diff < day) return Math.floor(diff / hour) + "h ago";
  if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
  return formatDate(millis);
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nameBeforeAt(email) {
  return String(email || "").split("@")[0];
}

/**
 * Collector rule: only the admin the member actually paid may confirm the
 * money arrived — nobody else can vouch for cash landing in someone else's
 * account. The owner overrides, and a request with no named collector
 * (legacy rows, or "HKF bank account (direct)") stays open to every admin,
 * which is what kept old data workable when Android shipped this.
 */
function canDecideRequest(rec, viewerIsOwner, viewerUid) {
  if (viewerIsOwner) return true;
  const c = String(rec?.collectorUid || "");
  if (!c || c === HKF_DIRECT_UID) return true;
  return c === viewerUid;
}

/** Android compares request/handover status case-insensitively. */
function statusOf(rec, fallback = "pending") {
  return String(rec?.status || fallback).toLowerCase();
}

export function renderActivity(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }
  if (window.__viewerIsAdmin !== true) {
    container.innerHTML = `
      <div class="placeholder">
        <strong>Admins only</strong>
        The activity feed shows decisions that only admins can make.
      </div>`;
    return () => {};
  }

  const viewerIsOwner = isOwner(user.email);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Activity</div>
        <div class="page-subtitle" id="activity-subtitle">loading...</div>
      </div>
    </div>

    <input class="search-input" id="activity-search" placeholder="Search by name" />

    <div class="filter-chips">
      <button class="chip active" data-filter="all">All</button>
      <button class="chip" data-filter="requests">Requests</button>
      <button class="chip" data-filter="handovers">Handovers</button>
      <button class="chip" data-filter="joins">Joins</button>
    </div>

    <div class="activity-list" id="activity-rows">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  let requests = [];
  let handovers = [];
  let joins = [];
  let queryStr = "";
  let filter = "all";
  const busyKeys = new Set();

  const subtitleEl = container.querySelector("#activity-subtitle");
  const rowsEl = container.querySelector("#activity-rows");
  const searchEl = container.querySelector("#activity-search");

  searchEl.addEventListener("input", e => {
    queryStr = e.target.value.trim().toLowerCase();
    rerender();
  });

  container.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      filter = chip.dataset.filter;
      rerender();
    });
  });

  const unsubRequests = onValue(ref(db, "paymentRequests"), snap => {
    requests = Object.entries(snap.val() || {}).map(([key, r]) => ({ key, ...r }));
    rerender();
  });

  const unsubHandovers = onValue(ref(db, "handovers"), snap => {
    handovers = Object.entries(snap.val() || {}).map(([key, h]) => ({ key, ...h }));
    rerender();
  });

  const unsubJoins = onValue(ref(db, "joinRequests"), snap => {
    joins = Object.entries(snap.val() || {}).map(([key, j]) => ({ uid: key, key, ...j }));
    rerender();
  });

  /** Flatten the three sources into one comparable card model. */
  function buildCards() {
    const cards = [];

    if (filter === "all" || filter === "requests") {
      requests.forEach(r => {
        cards.push({
          type: "request",
          key: r.key,
          pending: statusOf(r) === "pending",
          data: r,
          sortMillis: r.createdAtMillis || 0,
          // Android matches name / email / member id for requests.
          haystack: [r.memberName, r.memberEmail, r.memberId].join(" ").toLowerCase()
        });
      });
    }

    if (filter === "all" || filter === "handovers") {
      handovers.forEach(h => {
        const paid = statusOf(h) === "paid";
        cards.push({
          type: "handover",
          key: h.key,
          pending: !paid,
          data: h,
          sortMillis: (paid && h.paidAtMillis > 0)
            ? h.paidAtMillis
            : (h.createdAtMillis > 0 ? h.createdAtMillis : (h.applicationDateMillis || 0)),
          haystack: [h.personName, h.applicationNumber, h.city].join(" ").toLowerCase()
        });
      });
    }

    if (filter === "all" || filter === "joins") {
      joins.forEach(j => {
        cards.push({
          type: "join",
          key: j.uid,
          // Join status is compared exactly on Android, not case-folded.
          pending: (j.status || JOIN_PENDING) === JOIN_PENDING,
          data: j,
          sortMillis: j.requestedAtMillis || 0,
          haystack: [j.displayName, j.email].join(" ").toLowerCase()
        });
      });
    }

    // Pending block above the decided block; both newest-first.
    cards.sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      return (b.sortMillis || 0) - (a.sortMillis || 0);
    });

    return cards;
  }

  function rerender() {
    const cards = buildCards();
    const visible = queryStr ? cards.filter(c => c.haystack.includes(queryStr)) : cards;
    const pendingCount = cards.filter(c => c.pending).length;
    const feedEmpty = requests.length === 0 && handovers.length === 0 && joins.length === 0;

    subtitleEl.textContent = feedEmpty
      ? "Payment requests and handovers appear here."
      : pendingCount === 0
        ? "All caught up — nothing pending."
        : pendingCount + (pendingCount === 1 ? " pending item needs action" : " pending items need action");

    if (visible.length === 0) {
      rowsEl.innerHTML = `<div class="empty-state">${
        queryStr || filter !== "all" ? "No matching activity." : "Nothing here yet."
      }</div>`;
      return;
    }

    rowsEl.innerHTML = visible.map(c => renderCard(c, viewerIsOwner, busyKeys, user?.uid || "")).join("");
  }

  // One delegated listener, so a live database echo mid-click can't leave a
  // detached handler behind.
  rowsEl.addEventListener("click", onCardClick);

  async function onCardClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const key = btn.dataset.key;
    const busyId = act + ":" + key;
    if (busyKeys.has(busyId)) return;

    const request = requests.find(r => r.key === key);
    const handover = handovers.find(h => h.key === key);
    const join = joins.find(j => j.uid === key);

    const start = () => { busyKeys.add(busyId); rerender(); };

    try {
      switch (act) {
        case "req-approve": {
          if (!request) return;
          start();
          const who = request.memberName || request.memberEmail || "member";
          const ok = await approvePaymentRequest(request, user);
          window.showSnackbar?.(ok ? `Approved ${who}'s request` : "Couldn't approve — try again");
          break;
        }
        case "req-deny":
          if (!request) return;
          start();
          await denyPaymentRequest(request, user);
          window.showSnackbar?.("Request denied");
          break;
        case "req-edit":
          if (!request) return;
          openDecisionEditor(request, user);
          return;
        case "req-proof":
          btn.disabled = true;
          try { await viewPaymentProof(key); } finally { btn.disabled = false; }
          return;
        case "req-delete":
          if (!request) return;
          if (!confirmDelete("request")) return;
          start();
          await deleteRequestItem(request);
          window.showSnackbar?.("Activity deleted");
          break;
        case "ho-paid":
          if (!handover) return;
          start();
          await markHandoverPaid(handover, user);
          window.showSnackbar?.(`Marked ${handover.personName || handover.applicationNumber} as paid`);
          break;
        case "ho-pending":
          if (!handover) return;
          start();
          await revertHandoverToPending(handover);
          window.showSnackbar?.("Moved back to pending");
          break;
        case "join-approve": {
          if (!join) return;
          start();
          const who = join.displayName || join.email;
          await approveJoinRequest(join, user);
          window.showSnackbar?.(`${who} is now a member`);
          break;
        }
        case "join-deny":
          if (!join) return;
          start();
          await declineJoinRequest(join, user);
          window.showSnackbar?.("Join request discarded");
          break;
        case "join-delete":
          if (!join) return;
          if (!confirmDelete("join")) return;
          start();
          await deleteJoinRequest(join);
          window.showSnackbar?.("Activity deleted");
          break;
        default:
          return;
      }
    } catch (err) {
      console.error(act + " failed", err);
      window.showSnackbar?.("Couldn't complete: " + (err.message || "error"));
    } finally {
      busyKeys.delete(busyId);
      rerender();
    }
  }

  return function teardown() {
    rowsEl.removeEventListener("click", onCardClick);
    unsubRequests();
    unsubHandovers();
    unsubJoins();
  };
}

function confirmDelete(kind) {
  const body = kind === "request"
    ? "The request and its proof image will be permanently deleted. A payment recorded from an approval is NOT removed."
    : "The join request will be permanently deleted.";
  return confirm("Delete this activity?\n\n" + body + " This cannot be undone.");
}

// ---------------- Card rendering ----------------

function renderCard(card, viewerIsOwner, busyKeys, viewerUid) {
  const stateClass = card.pending ? "activity-card pending" : "activity-card decided";
  const busy = act => busyKeys.has(act + ":" + card.key);

  if (card.type === "request") return renderRequestCard(card, stateClass, viewerIsOwner, busy, viewerUid);
  if (card.type === "handover") return renderHandoverCard(card, stateClass, viewerIsOwner, busy);
  return renderJoinCard(card, stateClass, viewerIsOwner, busy);
}

function cardShell({ stateClass, eyebrow, accent, when, deleteBtn, title, amount, metaLines, actions }) {
  return `
    <div class="${stateClass}">
      <div class="activity-card-top">
        <span class="activity-eyebrow ${accent}">${escapeHtml(eyebrow)}</span>
        <span class="activity-top-right">
          ${when ? `<span class="activity-when">${escapeHtml(when)}</span>` : ""}
          ${deleteBtn || ""}
        </span>
      </div>
      <div class="activity-card-main">
        <div class="activity-card-text">
          <div class="activity-title">${title}</div>
          ${metaLines.filter(Boolean).map(l => `<div class="activity-meta">${l}</div>`).join("")}
        </div>
        ${amount ? `<div class="activity-amount">${escapeHtml(amount)}</div>` : ""}
      </div>
      ${actions ? `<div class="activity-actions">${actions}</div>` : ""}
    </div>
  `;
}

function ownerDelete(act, key) {
  return `<button class="activity-delete" data-act="${act}" data-key="${escapeHtml(key)}" title="Delete" aria-label="Delete">&#x2715;</button>`;
}

function decidedBy(rec) {
  const by = rec.decidedByName || nameBeforeAt(rec.decidedByEmail);
  return by ? `<span class="activity-decided-by">by ${escapeHtml(by)}</span>` : "";
}

function renderRequestCard(card, stateClass, viewerIsOwner, busy, viewerUid) {
  const r = card.data;
  const who = r.memberName || nameBeforeAt(r.memberEmail) || "Member";
  const status = statusOf(r);

  // The proof lives at /paymentProofs/{requestKey}; proofName is the flag.
  const proofLine = r.proofName
    ? `<span class="proof-tag">PROOF</span>
       <span class="proof-name">${escapeHtml(r.proofName)}</span>
       <button class="doc-btn" data-act="req-proof" data-key="${escapeHtml(card.key)}">View</button>`
    : "";

  let actions = "";
  if (card.pending && !canDecideRequest(r, viewerIsOwner, viewerUid)) {
    actions = `<span class="activity-waiting">Awaiting ${escapeHtml(r.collectorName || "the collector")} — only they (or the owner) can confirm this money arrived.</span>`;
  } else if (card.pending) {
    actions = `
      <button class="activity-btn primary" data-act="req-approve" data-key="${escapeHtml(card.key)}" ${busy("req-approve") ? "disabled" : ""}>
        ${busy("req-approve") ? "Working..." : "Approve"}
      </button>
      <button class="activity-btn danger" data-act="req-deny" data-key="${escapeHtml(card.key)}" ${busy("req-deny") ? "disabled" : ""}>
        ${busy("req-deny") ? "Working..." : "Deny"}
      </button>`;
  } else {
    const approved = status === "approved";
    actions = `
      <span class="pill ${approved ? "pill-green" : "pill-red"} pill-tiny">${approved ? "Approved" : "Denied"}</span>
      ${decidedBy(r)}
      ${viewerIsOwner ? `<button class="activity-btn" data-act="req-edit" data-key="${escapeHtml(card.key)}">Edit</button>` : ""}`;
  }

  const months = Math.min(12, Math.max(1, r.coversMonthCount || 1));
  const span = months > 1
    ? (() => {
        const keys = nextNMonths(r.coversMonthKey, months);
        return `${monthLabel(keys[0])} – ${monthLabel(keys[keys.length - 1])} (${months} months)`;
      })()
    : monthLabel(r.coversMonthKey);
  const detail = [formatRupees(r.amountMinor), span];
  if (r.category) detail.push(r.category);
  const paidToLine = r.collectorName
    ? `<span class="activity-paid-to">Paid to: ${escapeHtml(r.collectorName)}</span>`
    : "";

  return cardShell({
    stateClass,
    eyebrow: "Payment request",
    accent: "accent-gold",
    when: formatWhen(r.createdAtMillis),
    deleteBtn: viewerIsOwner ? ownerDelete("req-delete", card.key) : "",
    title: escapeHtml(who),
    amount: "",
    actions,
    metaLines: [
      escapeHtml(detail.join(" · ")),
      paidToLine,
      escapeHtml(r.memberEmail || ""),
      proofLine
    ]
  });
}

function renderHandoverCard(card, stateClass, viewerIsOwner, busy) {
  const h = card.data;
  const detail = [formatRupees(h.amountMinor)];
  if (h.applicationNumber) detail.push("#" + h.applicationNumber);
  if (h.city) detail.push(h.city);

  const docCount = h.documents ? Object.keys(h.documents).length : 0;

  const actions = card.pending
    ? `<button class="activity-btn primary" data-act="ho-paid" data-key="${escapeHtml(card.key)}" ${busy("ho-paid") ? "disabled" : ""}>
         ${busy("ho-paid") ? "Working..." : "Mark paid"}
       </button>`
    : `<span class="pill pill-green pill-tiny">Paid</span>
       ${h.paidByEmail ? `<span class="activity-decided-by">by ${escapeHtml(nameBeforeAt(h.paidByEmail))}</span>` : ""}
       ${viewerIsOwner ? `<button class="activity-btn" data-act="ho-pending" data-key="${escapeHtml(card.key)}" ${busy("ho-pending") ? "disabled" : ""}>
         ${busy("ho-pending") ? "Working..." : "Move to pending"}
       </button>` : ""}`;

  return cardShell({
    stateClass,
    eyebrow: "Handover",
    accent: "accent-blue",
    when: formatWhen(card.sortMillis),
    deleteBtn: "",
    title: escapeHtml(h.personName || ("Application " + (h.applicationNumber || "-"))),
    amount: "",
    actions,
    metaLines: [
      escapeHtml(detail.join(" · ")),
      escapeHtml(h.purpose || ""),
      docCount ? `<span class="proof-tag">${docCount} DOC${docCount > 1 ? "S" : ""}</span>` : ""
    ]
  });
}

function renderJoinCard(card, stateClass, viewerIsOwner, busy) {
  const j = card.data;
  const approved = j.status === JOIN_APPROVED;

  const actions = card.pending
    ? `<button class="activity-btn primary" data-act="join-approve" data-key="${escapeHtml(card.key)}" ${busy("join-approve") ? "disabled" : ""}>
         ${busy("join-approve") ? "Working..." : "Approve"}
       </button>
       <button class="activity-btn danger" data-act="join-deny" data-key="${escapeHtml(card.key)}" ${busy("join-deny") ? "disabled" : ""}>
         ${busy("join-deny") ? "Working..." : "Discard"}
       </button>`
    : `<span class="pill ${approved ? "pill-green" : "pill-red"} pill-tiny">${approved ? "Approved" : "Discarded"}</span>
       ${decidedBy(j)}`;

  return cardShell({
    stateClass,
    eyebrow: "New member",
    accent: "accent-green",
    when: formatWhen(j.requestedAtMillis),
    deleteBtn: viewerIsOwner ? ownerDelete("join-delete", card.key) : "",
    title: escapeHtml(j.displayName || nameBeforeAt(j.email) || "Someone"),
    amount: "",
    actions,
    metaLines: [
      escapeHtml(j.email || ""),
      "Wants to join the foundation"
    ]
  });
}

// ---------------- Decisions ----------------

/**
 * Atomically claim a status transition. Returns false if another admin got
 * there first, in which case the caller backs off silently rather than
 * recording a second payment for the same request.
 */
async function claimStatus(requestKey, expect, to) {
  const result = await runTransaction(ref(db, "paymentRequests/" + requestKey + "/status"), current => {
    if (current !== expect) return undefined;   // abort
    return to;
  });
  return result.committed;
}

/**
 * Record the payment behind an approved request and stamp the request.
 * `force` lets the owner re-decide a DENIED request; an approved one is never
 * re-approvable, because its payment row already exists.
 */
async function approvePaymentRequest(req, actor, force = false) {
  const status = statusOf(req);
  const decidable = status === "pending" || (force && status === "denied");
  if (!decidable) return true;

  if (!await claimStatus(req.key, req.status, "approved")) return true;

  await update(ref(db, "paymentRequests/" + req.key), {
    status: "approved",
    decidedByEmail: actor?.email || "",
    decidedByName: displayNameFor(actor),
    decidedAtMillis: serverTimestamp()
  });

  // A request can cover several consecutive months. The amount on the request
  // is the TOTAL; approval writes one payment row per month, splitting it with
  // floor division and putting the remainder on the FIRST month, so the rows
  // always add back up to exactly the total. Identical arithmetic to Android:
  //   perMonth  = floor(total / n)
  //   remainder = total - perMonth * n
  const monthCount = Math.min(12, Math.max(1, req.coversMonthCount || 1));
  const monthKeys = nextNMonths(req.coversMonthKey, monthCount);
  const total = req.amountMinor || 0;
  const perMonth = Math.floor(total / monthCount);
  const remainder = total - perMonth * monthCount;

  const createdKeys = [];
  let failed = false;
  for (let i = 0; i < monthKeys.length; i++) {
    try {
      const paymentRef = push(ref(db, "payments/" + req.memberUid));
      await set(paymentRef, {
        coversMonthKey: monthKeys[i],
        amountMinor: perMonth + (i === 0 ? remainder : 0),
        category: req.category || "Member contribution",
        note: monthCount === 1 ? "Approved request" : `Approved request (${i + 1}/${monthCount})`,
        batchKey: paymentRef.key,
        recordedByEmail: actor?.email || "",
        recordedAtMillis: Date.now(),
        // Carries the money trail from the request onto the payment row —
        // this is what the collector dashboard's "received" figure sums.
        collectorUid: req.collectorUid || "",
        collectorName: req.collectorName || ""
      });
      await recalcMemberTotal(req.memberUid);
      createdKeys.push(paymentRef.key);
    } catch (e) {
      console.error("payment write failed", e);
      failed = true;
      break;
    }
  }

  if (!failed && createdKeys.length) {
    // Comma-joined so a later revert deletes exactly these rows. A
    // single-month approval stores one bare key, so the format stays
    // backward compatible with rows approved before multi-month existed.
    await update(ref(db, "paymentRequests/" + req.key), { approvedPaymentKey: createdKeys.join(",") })
      .catch(() => { /* best effort - revert falls back to matching */ });
    return true;
  }

  // Partial failure: unwind whatever landed so totals don't drift.
  for (const k of createdKeys) {
    await fbRemove(ref(db, "payments/" + req.memberUid + "/" + k)).catch(() => {});
  }
  if (createdKeys.length) await recalcMemberTotal(req.memberUid).catch(() => {});

  // Payment failed: put the request back so an admin can retry.
  await update(ref(db, "paymentRequests/" + req.key), {
    status: "pending",
    decidedByEmail: "",
    decidedByName: "",
    decidedAtMillis: 0
  }).catch(() => {});
  return false;
}

async function denyPaymentRequest(req, actor) {
  if (statusOf(req) !== "pending") return;
  if (!await claimStatus(req.key, req.status, "denied")) return;
  await update(ref(db, "paymentRequests/" + req.key), {
    status: "denied",
    decidedByEmail: actor?.email || "",
    decidedByName: displayNameFor(actor),
    decidedAtMillis: serverTimestamp()
  });
}

/**
 * Owner-only: undo an approval. Deletes the payment row the approval created
 * and recomputes the member's total.
 *
 * Row location: approvedPaymentKey when present, otherwise match on
 * note=="Approved request" + month + amount, preferring the row recorded by
 * the original decider. If nothing matches we still flip the status - the
 * money is already un-recorded, which is the end state we want.
 */
async function revertApprovedRequest(req, actor) {
  const uid = req.memberUid;
  let removedMinor = 0;

  if (uid) {
    const allSnap = await get(ref(db, "payments/" + uid));
    const rows = allSnap.val() || {};

    // approvedPaymentKey is a comma-separated list once a request can cover
    // several months. Split it and delete every row it names.
    const storedKeys = String(req.approvedPaymentKey || "")
      .split(",").map(k => k.trim()).filter(Boolean)
      .filter(k => rows[k]);

    let targets = storedKeys;
    if (targets.length === 0) {
      // Legacy fallback for requests approved before the key was stamped.
      // Note this can only ever match a SINGLE-month approval - a split row's
      // note and amount both differ - which is correct, because multi-month
      // approvals always carry the key.
      const candidates = Object.entries(rows).filter(([, p]) =>
        (p.note || "") === "Approved request" &&
        (p.coversMonthKey || "") === (req.coversMonthKey || "") &&
        (p.amountMinor || 0) === (req.amountMinor || 0)
      );
      const preferred = candidates.find(([, p]) => (p.recordedByEmail || "") === (req.decidedByEmail || ""));
      const chosen = preferred || candidates[0];
      if (chosen) targets = [chosen[0]];
    }

    for (const k of targets) {
      removedMinor += rows[k]?.amountMinor || 0;
      await fbRemove(ref(db, "payments/" + uid + "/" + k));
    }
    if (targets.length) await recalcMemberTotal(uid);
  }

  await update(ref(db, "paymentRequests/" + req.key), {
    status: "denied",
    decidedByEmail: actor?.email || "",
    decidedByName: displayNameFor(actor),
    decidedAtMillis: serverTimestamp(),
    approvedPaymentKey: ""
  });

  return removedMinor;
}

/** Owner-only: drop a request and its proof image together. */
async function deleteRequestItem(req) {
  await update(ref(db), {
    [`paymentRequests/${req.key}`]: null,
    [`paymentProofs/${req.key}`]: null
  });
}

async function markHandoverPaid(handover, actor) {
  await update(ref(db, "handovers/" + handover.key), {
    status: "paid",
    paidByEmail: actor?.email || "",
    paidAtMillis: Date.now()
  });
}

async function revertHandoverToPending(handover) {
  await update(ref(db, "handovers/" + handover.key), {
    status: "pending",
    paidByEmail: "",
    paidAtMillis: 0
  });
}

// ---------------- Owner-only: edit a decided payment request ----------------

/**
 * Flip an already-decided request.
 *
 *   Denied  -> Approved : records the payment, same path as a fresh approval
 *   Approved -> Denied  : deletes the recorded payment and recomputes totals
 */
/** "Jan 2026" or "Jan 2026 – Apr 2026 (4 months)". */
function coveredSpan(req) {
  const months = Math.min(12, Math.max(1, req.coversMonthCount || 1));
  if (months <= 1) return monthLabel(req.coversMonthKey);
  const keys = nextNMonths(req.coversMonthKey, months);
  return `${monthLabel(keys[0])} – ${monthLabel(keys[keys.length - 1])} (${months} months)`;
}

function openDecisionEditor(req, actor) {
  const wasApproved = statusOf(req) === "approved";
  const who = req.memberName || req.memberEmail || "this member";

  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit decision</div>
      <div class="modal-body">
        <div class="decision-summary">
          <div class="decision-summary-row">
            <span>Member</span><strong>${escapeHtml(who)}</strong>
          </div>
          <div class="decision-summary-row">
            <span>Covers</span><strong>${escapeHtml(coveredSpan(req))}</strong>
          </div>
          <div class="decision-summary-row">
            <span>Amount</span><strong>${escapeHtml(formatRupees(req.amountMinor))}</strong>
          </div>
          <div class="decision-summary-row">
            <span>Current</span>
            <strong class="${wasApproved ? "text-green" : "text-red"}">${wasApproved ? "Approved" : "Denied"}</strong>
          </div>
        </div>

        ${wasApproved ? `
          <div class="danger-note">
            <strong>Currently APPROVED.</strong>
            Changing to Denied will delete the payment${
              (req.coversMonthCount || 1) > 1 ? " rows" : ""} recorded by the approval
            and reduce ${escapeHtml(who)}'s total. Every figure that includes it —
            their year total, the monthly collection chart, the pending balance —
            is recalculated. This cannot be undone automatically.
          </div>
        ` : `
          <div class="info-note">
            <strong>Currently DENIED.</strong>
            Changing to Approved will record
            ${escapeHtml(formatRupees(req.amountMinor))} for
            ${escapeHtml(coveredSpan(req))} against ${escapeHtml(who)}${
              (req.coversMonthCount || 1) > 1 ? ", split into one payment row per month" : ""}.
          </div>
        `}
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="de-cancel">Cancel</button>
        <button class="modal-btn ${wasApproved ? "destructive" : "primary"}" id="de-flip">
          ${wasApproved ? "Change to Denied" : "Change to Approved"}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  function close() { if (dialog.parentNode) document.body.removeChild(dialog); }
  dialog.querySelector("#de-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#de-flip").addEventListener("click", async () => {
    const btn = dialog.querySelector("#de-flip");
    btn.disabled = true;
    btn.textContent = "Working...";
    try {
      if (wasApproved) {
        const removed = await revertApprovedRequest(req, actor);
        window.showSnackbar?.(removed > 0
          ? "Approval reverted — payment removed"
          : "Approval reverted");
      } else {
        const ok = await approvePaymentRequest(req, actor, true);
        window.showSnackbar?.(ok ? "Changed to Approved — payment recorded" : "Couldn't approve — try again");
      }
      close();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = wasApproved ? "Change to Denied" : "Change to Approved";
      window.showSnackbar?.("Couldn't revert — try again");
    }
  });
}
