// Activity feed - admin only. Replaces the old Discussion tab.
//
// The group chat and online-presence strip are gone. What admins actually
// used that screen for was the payment-request cards buried between the
// messages, so this screen is only those cards - plus the two other things
// that need a decision:
//
//   * payment requests   -> Approve / Deny        (/paymentRequests)
//   * handovers          -> Mark paid             (/handovers)
//   * join requests      -> Approve / Discard     (/joinRequests)
//
// Anything still awaiting a decision is highlighted gold and sorted to the
// top; anything already decided is greyed out and kept below as a log. The
// owner can additionally reopen a decided payment request and flip it.

import {
  getDatabase,
  ref,
  onValue,
  get,
  set,
  push,
  update,
  remove as fbRemove,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { isOwner, displayNameFor } from "./auth.js";
import { approveJoinRequest, declineJoinRequest } from "./members-self.js";
import { viewPaymentProof } from "./attachments.js";

const db = getDatabase(firebaseApp);

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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

    <input class="search-input" id="activity-search" placeholder="Search name, email, amount, app no..." />

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
  let busyKeys = new Set();

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
    joins = Object.entries(snap.val() || {}).map(([key, j]) => ({ key, ...j }));
    rerender();
  });

  /** Flatten the three sources into one comparable card model. */
  function buildCards() {
    const cards = [];

    if (filter === "all" || filter === "requests") {
      requests.forEach(r => {
        const pending = (r.status || "pending") === "pending";
        cards.push({
          type: "request",
          key: r.key,
          pending,
          data: r,
          sortMillis: pending ? (r.createdAtMillis || 0) : (r.decidedAtMillis || r.createdAtMillis || 0),
          haystack: [
            r.memberName, r.memberEmail, r.memberId, r.category,
            monthLabel(r.coversMonthKey), formatRupees(r.amountMinor),
            String((r.amountMinor || 0) / 100), "payment request", r.status
          ].join(" ").toLowerCase()
        });
      });
    }

    if (filter === "all" || filter === "handovers") {
      handovers.forEach(h => {
        const pending = (h.status || "pending") !== "paid";
        cards.push({
          type: "handover",
          key: h.key,
          pending,
          data: h,
          sortMillis: pending
            ? (h.createdAtMillis || h.applicationDateMillis || 0)
            : (h.paidAtMillis || h.createdAtMillis || 0),
          haystack: [
            h.applicationNumber, h.personName, h.city, h.mobileNumber, h.purpose,
            formatRupees(h.amountMinor), String((h.amountMinor || 0) / 100), "handover", h.status
          ].join(" ").toLowerCase()
        });
      });
    }

    if (filter === "all" || filter === "joins") {
      joins.forEach(j => {
        const pending = (j.status || "pending") === "pending";
        cards.push({
          type: "join",
          key: j.key,
          pending,
          data: j,
          sortMillis: pending ? (j.createdAtMillis || 0) : (j.decidedAtMillis || j.createdAtMillis || 0),
          haystack: [j.displayName, j.email, "new member join request", j.status].join(" ").toLowerCase()
        });
      });
    }

    // Pending first (oldest pending at the top - it has waited longest),
    // then the decided log newest-first.
    cards.sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      if (a.pending) return (a.sortMillis || 0) - (b.sortMillis || 0);
      return (b.sortMillis || 0) - (a.sortMillis || 0);
    });

    return cards;
  }

  function rerender() {
    const cards = buildCards();
    const visible = queryStr ? cards.filter(c => c.haystack.includes(queryStr)) : cards;
    const pendingCount = cards.filter(c => c.pending).length;

    subtitleEl.textContent = pendingCount === 0
      ? "Nothing waiting on you"
      : pendingCount + (pendingCount === 1 ? " item needs a decision" : " items need a decision");

    if (visible.length === 0) {
      rowsEl.innerHTML = `<div class="empty-state">${queryStr ? "No matching activity." : "No activity yet."}</div>`;
      return;
    }

    rowsEl.innerHTML = visible.map(c => renderCard(c, viewerIsOwner, busyKeys)).join("");
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
    const join = joins.find(j => j.key === key);

    try {
      switch (act) {
        case "req-approve":
          if (!request) return;
          busyKeys.add(busyId); rerender();
          await approvePaymentRequest(request, user);
          window.showSnackbar?.("Approved - payment recorded");
          break;
        case "req-deny":
          if (!request) return;
          busyKeys.add(busyId); rerender();
          await denyPaymentRequest(request, user);
          window.showSnackbar?.("Request denied");
          break;
        case "req-edit":
          if (!request) return;
          openDecisionEditor(request, user);
          return;
        case "req-proof":
          await viewPaymentProof(btn.dataset.proof);
          return;
        case "ho-paid":
          if (!handover) return;
          busyKeys.add(busyId); rerender();
          await markHandoverPaid(handover, user);
          window.showSnackbar?.("Marked paid");
          break;
        case "join-approve":
          if (!join) return;
          busyKeys.add(busyId); rerender();
          await approveJoinRequest(join, user);
          window.showSnackbar?.("Approved - " + (join.displayName || join.email) + " can now use the app");
          break;
        case "join-deny":
          if (!join) return;
          if (!confirm("Discard the join request from " + (join.displayName || join.email) + "?")) return;
          busyKeys.add(busyId); rerender();
          await declineJoinRequest(join, user);
          window.showSnackbar?.("Request discarded");
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

// ---------------- Card rendering ----------------

function renderCard(card, viewerIsOwner, busyKeys) {
  const stateClass = card.pending ? "activity-card pending" : "activity-card decided";
  const busy = act => busyKeys.has(act + ":" + card.key);

  if (card.type === "request") return renderRequestCard(card, stateClass, viewerIsOwner, busy);
  if (card.type === "handover") return renderHandoverCard(card, stateClass, busy);
  return renderJoinCard(card, stateClass, busy);
}

function cardShell({ stateClass, eyebrow, accent, title, amount, metaLines, badge, actions }) {
  return `
    <div class="${stateClass}">
      <div class="activity-card-top">
        <span class="activity-eyebrow ${accent}">${escapeHtml(eyebrow)}</span>
        ${badge || ""}
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

function renderRequestCard(card, stateClass, viewerIsOwner, busy) {
  const r = card.data;
  const who = r.memberName || (r.memberEmail || "").split("@")[0] || "Member";
  const proofBtn = r.proofId
    ? `<button class="activity-btn ghost" data-act="req-proof" data-key="${escapeHtml(card.key)}" data-proof="${escapeHtml(r.proofId)}">View</button>`
    : "";

  let badge = "";
  let actions = "";

  if (card.pending) {
    badge = `<span class="pill pill-amber pill-tiny">Needs decision</span>`;
    actions = `
      <button class="activity-btn primary" data-act="req-approve" data-key="${escapeHtml(card.key)}" ${busy("req-approve") ? "disabled" : ""}>
        ${busy("req-approve") ? "Working..." : "Approve"}
      </button>
      <button class="activity-btn danger" data-act="req-deny" data-key="${escapeHtml(card.key)}" ${busy("req-deny") ? "disabled" : ""}>
        ${busy("req-deny") ? "Working..." : "Deny"}
      </button>
      ${proofBtn}
    `;
  } else {
    const approved = r.status === "approved";
    const by = r.decidedByName || (r.decidedByEmail || "").split("@")[0];
    badge = `<span class="pill ${approved ? "pill-green" : "pill-red"} pill-tiny">${approved ? "Approved" : "Denied"}</span>`;
    actions = `
      ${viewerIsOwner ? `<button class="activity-btn" data-act="req-edit" data-key="${escapeHtml(card.key)}">Edit decision</button>` : ""}
      ${proofBtn}
      ${by ? `<span class="activity-decided-by">by ${escapeHtml(by)} ${escapeHtml(formatWhen(r.decidedAtMillis))}</span>` : ""}
    `;
  }

  return cardShell({
    stateClass,
    eyebrow: "Payment request",
    accent: "accent-gold",
    title: escapeHtml(who),
    amount: formatRupees(r.amountMinor),
    badge,
    actions,
    metaLines: [
      escapeHtml(monthLabel(r.coversMonthKey)) + " &middot; " + escapeHtml(r.category || "Member contribution"),
      escapeHtml(r.memberEmail || ""),
      (r.proofId ? `<span class="proof-tag">PROOF</span> ` : "") + escapeHtml("Requested " + formatWhen(r.createdAtMillis))
    ]
  });
}

function renderHandoverCard(card, stateClass, busy) {
  const h = card.data;
  const badge = card.pending
    ? `<span class="pill pill-amber pill-tiny">Pending payout</span>`
    : `<span class="pill pill-green pill-tiny">Paid</span>`;

  const actions = card.pending
    ? `<button class="activity-btn primary" data-act="ho-paid" data-key="${escapeHtml(card.key)}" ${busy("ho-paid") ? "disabled" : ""}>
         ${busy("ho-paid") ? "Working..." : "Mark paid"}
       </button>`
    : `<span class="activity-decided-by">
         paid ${escapeHtml(formatWhen(h.paidAtMillis))}${h.paidByEmail ? " by " + escapeHtml(h.paidByEmail.split("@")[0]) : ""}
       </span>`;

  const docCount = h.documents ? Object.keys(h.documents).length : 0;

  return cardShell({
    stateClass,
    eyebrow: "Handover",
    accent: "accent-blue",
    title: `${escapeHtml(h.applicationNumber || "-")} &middot; ${escapeHtml(h.personName || "-")}`,
    amount: formatRupees(h.amountMinor),
    badge,
    actions,
    metaLines: [
      escapeHtml([h.city, h.mobileNumber].filter(Boolean).join(" · ")),
      escapeHtml(h.purpose || ""),
      escapeHtml("Applied " + formatDate(h.applicationDateMillis)) +
        (docCount ? ` &middot; <span class="proof-tag">${docCount} DOC${docCount > 1 ? "S" : ""}</span>` : "")
    ]
  });
}

function renderJoinCard(card, stateClass, busy) {
  const j = card.data;
  const decided = !card.pending;
  const approved = j.status === "approved";
  const by = j.decidedByName || (j.decidedByEmail || "").split("@")[0];

  const badge = card.pending
    ? `<span class="pill pill-amber pill-tiny">Needs decision</span>`
    : `<span class="pill ${approved ? "pill-green" : "pill-red"} pill-tiny">${approved ? "Approved" : "Discarded"}</span>`;

  const actions = card.pending
    ? `<button class="activity-btn primary" data-act="join-approve" data-key="${escapeHtml(card.key)}" ${busy("join-approve") ? "disabled" : ""}>
         ${busy("join-approve") ? "Working..." : "Approve"}
       </button>
       <button class="activity-btn danger" data-act="join-deny" data-key="${escapeHtml(card.key)}" ${busy("join-deny") ? "disabled" : ""}>
         ${busy("join-deny") ? "Working..." : "Discard"}
       </button>`
    : (by ? `<span class="activity-decided-by">by ${escapeHtml(by)} ${escapeHtml(formatWhen(j.decidedAtMillis))}</span>` : "");

  return cardShell({
    stateClass,
    eyebrow: decided ? "Join request" : "New member",
    accent: "accent-green",
    title: escapeHtml(j.displayName || (j.email || "").split("@")[0] || "Someone"),
    amount: "",
    badge,
    actions,
    metaLines: [
      escapeHtml(j.email || ""),
      escapeHtml("Asked to join " + formatWhen(j.createdAtMillis))
    ]
  });
}

// ---------------- Decisions ----------------

/**
 * Record the payment behind an approved request and stamp the request.
 * The created payment key is written back onto the request so the owner's
 * decision editor can find (and undo) exactly this payment later.
 */
async function approvePaymentRequest(req, actor) {
  const paymentRef = push(ref(db, "payments/" + req.memberUid));
  await set(paymentRef, {
    coversMonthKey: req.coversMonthKey,
    amountMinor: req.amountMinor || 0,
    category: req.category || "Member contribution",
    note: "Approved request",
    recordedByEmail: actor?.email || "",
    recordedAtMillis: serverTimestamp(),
    dateMillis: req.requestedDateMillis || Date.now(),
    batchKey: paymentRef.key,
    fromRequestKey: req.key,
    // The proof blob is shared, not copied: the confirmed payment row simply
    // points at the same /paymentProofs entry the member uploaded.
    proofId: req.proofId || "",
    proofName: req.proofName || "",
    proofMime: req.proofMime || ""
  });

  await bumpMemberTotal(req.memberUid, req.amountMinor || 0);

  await update(ref(db, "paymentRequests/" + req.key), {
    status: "approved",
    decidedByEmail: actor?.email || "",
    decidedByName: displayNameFor(actor),
    decidedAtMillis: serverTimestamp(),
    paymentKey: paymentRef.key
  });
}

async function denyPaymentRequest(req, actor) {
  await update(ref(db, "paymentRequests/" + req.key), {
    status: "denied",
    decidedByEmail: actor?.email || "",
    decidedByName: displayNameFor(actor),
    decidedAtMillis: serverTimestamp()
  });
}

/**
 * Undo an approval: delete the payment row this request created and subtract
 * it from the member's running total.
 */
async function revokePaymentForRequest(req) {
  const uid = req.memberUid;
  if (!uid) return 0;

  let paymentKey = req.paymentKey || "";
  let amount = 0;

  if (paymentKey) {
    const snap = await get(ref(db, "payments/" + uid + "/" + paymentKey));
    if (snap.exists()) amount = snap.val()?.amountMinor || 0;
    else paymentKey = "";
  }

  if (!paymentKey) {
    // Legacy rows approved before we started stamping paymentKey. Find the
    // payment by what the old approve path wrote: same month, same amount,
    // note "Approved request".
    const allSnap = await get(ref(db, "payments/" + uid));
    const match = Object.entries(allSnap.val() || {}).find(([, p]) =>
      (p.fromRequestKey && p.fromRequestKey === req.key) ||
      ((p.coversMonthKey || "") === (req.coversMonthKey || "") &&
       (p.amountMinor || 0) === (req.amountMinor || 0) &&
       (p.note || "") === "Approved request")
    );
    if (match) {
      paymentKey = match[0];
      amount = match[1]?.amountMinor || 0;
    }
  }

  if (!paymentKey) return 0;

  await fbRemove(ref(db, "payments/" + uid + "/" + paymentKey));
  await bumpMemberTotal(uid, -amount);
  return amount;
}

/** Add (or subtract) from a member's cached lifetime total, never below zero. */
async function bumpMemberTotal(uid, deltaMinor) {
  if (!uid || !deltaMinor) return;
  const memberRef = ref(db, "members/" + uid);
  const snap = await get(memberRef);
  if (!snap.exists()) return;
  const cur = snap.val()?.totalPaidMinor || 0;
  await update(memberRef, { totalPaidMinor: Math.max(0, cur + deltaMinor) });
}

async function markHandoverPaid(handover, actor) {
  await update(ref(db, "handovers/" + handover.key), {
    status: "paid",
    paidByEmail: actor?.email || "",
    paidAtMillis: serverTimestamp()
  });
}

// ---------------- Owner-only: edit a decided payment request ----------------

/**
 * Lets the owner flip an already-decided request.
 *
 *   Denied  -> Approved : records the payment (same path as a fresh approval)
 *   Approved -> Denied  : deletes the recorded payment and recalculates the
 *                         member's total. Destructive, so it gets a warning
 *                         and a typed-out consequence rather than a plain OK.
 */
function openDecisionEditor(req, actor) {
  const wasApproved = req.status === "approved";
  const who = req.memberName || (req.memberEmail || "").split("@")[0] || "this member";

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
            <span>Covers</span><strong>${escapeHtml(monthLabel(req.coversMonthKey))}</strong>
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
            <strong>Changing this to Denied deletes the recorded payment.</strong>
            The ${escapeHtml(formatRupees(req.amountMinor))} logged for
            ${escapeHtml(monthLabel(req.coversMonthKey))} will be removed from
            ${escapeHtml(who)}'s record, and every total that includes it -
            their year total, the monthly collection chart and the pending
            balance - is recalculated. This can't be undone.
          </div>
        ` : `
          <div class="info-note">
            Changing this to Approved records a
            ${escapeHtml(formatRupees(req.amountMinor))} payment for
            ${escapeHtml(monthLabel(req.coversMonthKey))} against
            ${escapeHtml(who)}, exactly as approving it the first time would have.
          </div>
        `}
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="de-cancel">Keep as is</button>
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
        const removed = await revokePaymentForRequest(req);
        await update(ref(db, "paymentRequests/" + req.key), {
          status: "denied",
          decidedByEmail: actor?.email || "",
          decidedByName: displayNameFor(actor),
          decidedAtMillis: serverTimestamp(),
          paymentKey: "",
          editedByEmail: actor?.email || "",
          editedAtMillis: serverTimestamp()
        });
        window.showSnackbar?.(removed > 0
          ? "Changed to Denied - " + formatRupees(removed) + " payment deleted"
          : "Changed to Denied");
      } else {
        await approvePaymentRequest(req, actor);
        await update(ref(db, "paymentRequests/" + req.key), {
          editedByEmail: actor?.email || "",
          editedAtMillis: serverTimestamp()
        });
        window.showSnackbar?.("Changed to Approved - payment recorded");
      }
      close();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = wasApproved ? "Change to Denied" : "Change to Approved";
      window.showSnackbar?.("Couldn't change: " + (e.message || "error"));
    }
  });
}
