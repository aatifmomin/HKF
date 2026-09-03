// Tech Support - a port of Android's SupportScreen + SupportAdminScreen.
//
// JIRA-lite ticketing shared by both clients:
//   * a member files an issue from their Support tab and gets a sequential
//     "T-001" id to track it
//   * the owner works the queue from Settings > Tech Support, resolving with
//     an optional note
//   * the member can reopen a resolved ticket, with a mandatory note saying
//     what is still wrong
//
// /techSupport/{pushKey} = {
//   ticketId, memberUid, memberName, memberEmail, title, description,
//   status: "open" | "resolved",
//   createdAtMillis, resolvedAtMillis, resolvedByName, resolutionNote,
//   reopenNote, reopenedAtMillis
// }
// /techSupportCounter = <number>
//
// A reopened ticket keeps its previous resolution fields on the row - the
// reopen only flips the status and adds the note. That is deliberate: the
// owner needs the history, and re-resolving overwrites the note cleanly.

import {
  getDatabase,
  ref,
  query,
  orderByChild,
  equalTo,
  onValue,
  push,
  set,
  update,
  remove as fbRemove,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02b";
import { displayNameFor } from "./auth.js?v=2026-09-02b";

const db = getDatabase(firebaseApp);

export const TICKET_OPEN = "open";
export const TICKET_RESOLVED = "resolved";

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nameBeforeAt(email) {
  return String(email || "").split("@")[0];
}

/** "5 Aug 2026, 3:07 pm", or an em dash when there's no timestamp. */
function dateLabel(millis) {
  if (!millis || millis <= 0) return "—";
  return new Date(millis).toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  });
}

function isResolved(t) { return t.status === TICKET_RESOLVED; }
function wasReopened(t) { return !!String(t.reopenNote || "").trim() || (t.reopenedAtMillis || 0) > 0; }

/** Rows without a ticket id are half-written; both clients skip them. */
function toTicket(key, rec) {
  if (!rec || !String(rec.ticketId || "").trim()) return null;
  return { key, ...rec };
}

// ---------------- Data ----------------

/**
 * One member's own tickets, newest first.
 *
 * Server-side filtered by memberUid so a member's client never downloads
 * anybody else's ticket text. Needs ".indexOn": "memberUid" on /techSupport -
 * without it Firebase still returns the right rows but pulls the whole node
 * down and warns in the console.
 */
export function observeMyTickets(uid, callback) {
  if (!uid) { callback([]); return () => {}; }
  const q = query(ref(db, "techSupport"), orderByChild("memberUid"), equalTo(uid));
  return onValue(q, snap => {
    const out = [];
    snap.forEach(child => {
      const t = toTicket(child.key, child.val());
      if (t) out.push(t);
    });
    out.sort((a, b) => (b.createdAtMillis || 0) - (a.createdAtMillis || 0));
    callback(out);
  }, err => {
    console.warn("ticket load failed", err);
    callback([]);
  });
}

/** Every ticket: open first, then newest-first within each group. */
export function observeAllTickets(callback) {
  return onValue(ref(db, "techSupport"), snap => {
    const out = [];
    snap.forEach(child => {
      const t = toTicket(child.key, child.val());
      if (t) out.push(t);
    });
    out.sort((a, b) => {
      const ar = isResolved(a) ? 1 : 0;
      const br = isResolved(b) ? 1 : 0;
      if (ar !== br) return ar - br;
      return (b.createdAtMillis || 0) - (a.createdAtMillis || 0);
    });
    callback(out);
  }, err => {
    console.warn("ticket load failed", err);
    callback([]);
  });
}

/**
 * Next "T-###". Android does a read-then-write here; a transaction produces
 * identical ids but can't hand two people filing at the same moment the same
 * number.
 */
async function allocateTicketId() {
  let next = 1;
  await runTransaction(ref(db, "techSupportCounter"), current => {
    next = (typeof current === "number" ? current : 0) + 1;
    return next;
  });
  return "T-" + String(next).padStart(3, "0");
}

export async function createTicket(user, title, description) {
  if (!user?.uid || !String(title || "").trim()) return null;
  const ticketId = await allocateTicketId();
  await set(push(ref(db, "techSupport")), {
    ticketId,
    memberUid: user.uid,
    memberName: (user.displayName || "").trim(),
    memberEmail: (user.email || "").trim(),
    title: String(title).trim(),
    description: String(description || "").trim(),
    status: TICKET_OPEN,
    createdAtMillis: Date.now(),
    resolvedAtMillis: 0,
    resolvedByName: "",
    resolutionNote: "",
    reopenNote: "",
    reopenedAtMillis: 0
  });
  return ticketId;
}

export async function resolveTicket(ticketKey, actor, note) {
  await update(ref(db, "techSupport/" + ticketKey), {
    status: TICKET_RESOLVED,
    resolvedAtMillis: Date.now(),
    // Android stores only a name, falling back to the email's local part.
    resolvedByName: (actor?.displayName || "").trim() || nameBeforeAt(actor?.email),
    resolutionNote: String(note || "").trim()
  });
}

/** Member reopens. The earlier resolution stays on the row for context. */
export async function reopenTicket(ticketKey, note) {
  await update(ref(db, "techSupport/" + ticketKey), {
    status: TICKET_OPEN,
    reopenNote: String(note || "").trim(),
    reopenedAtMillis: Date.now()
  });
}

export async function deleteTicket(ticketKey) {
  await fbRemove(ref(db, "techSupport/" + ticketKey));
}

// ---------------- Shared rendering ----------------

function headerCounts(tickets) {
  const open = tickets.filter(t => !isResolved(t)).length;
  return `${open} open · ${tickets.length} total`;
}

function statusPill(t) {
  return isResolved(t)
    ? `<span class="ticket-pill resolved">RESOLVED</span>`
    : `<span class="ticket-pill open">OPEN</span>`;
}

/** Simple dialog helper - all four support dialogs share this shape. */
function openDialog({ title, body, fields, confirm, confirmClass = "primary", onConfirm, requireFirstField = false }) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">${title}</div>
      <div class="modal-body">
        ${body || ""}
        ${(fields || []).map(f => `
          <label class="field">
            <span>${escapeHtml(f.label)}</span>
            ${f.multiline
              ? `<textarea id="${f.id}" rows="${f.rows || 3}"></textarea>`
              : `<input type="text" id="${f.id}" />`}
          </label>
        `).join("")}
      </div>
      <div class="modal-actions">
        <button class="modal-btn" data-close>Cancel</button>
        <button class="modal-btn ${confirmClass}" data-confirm>${escapeHtml(confirm)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const confirmBtn = dialog.querySelector("[data-confirm]");
  const first = fields && fields.length ? dialog.querySelector("#" + fields[0].id) : null;

  if (requireFirstField && first) {
    const sync = () => { confirmBtn.disabled = !first.value.trim(); };
    first.addEventListener("input", sync);
    sync();
  }
  if (first) setTimeout(() => first.focus(), 30);

  function close() { if (dialog.parentNode) document.body.removeChild(dialog); }
  dialog.querySelector("[data-close]").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  confirmBtn.addEventListener("click", async () => {
    const values = {};
    (fields || []).forEach(f => { values[f.id] = (dialog.querySelector("#" + f.id)?.value || ""); });
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Working...";
    try {
      await onConfirm(values);
      close();
    } catch (e) {
      console.error("support action failed", e);
      confirmBtn.disabled = false;
      confirmBtn.textContent = confirm;
      window.showSnackbar?.("Couldn't save — try again");
    }
  });

  return close;
}

// ================= Member: Support tab =================

export function renderSupport(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Tech Support</div>
        <div class="page-subtitle" id="sp-counts">0 open · 0 total</div>
      </div>
      <button class="add-pill" id="sp-new">+ Suggestion</button>
    </div>
    <input class="search-input" id="sp-search" placeholder="Search by ID or title…" />
    <div id="sp-list">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  let tickets = [];
  let queryStr = "";
  let loaded = false;

  const countsEl = container.querySelector("#sp-counts");
  const listEl = container.querySelector("#sp-list");

  container.querySelector("#sp-search").addEventListener("input", e => {
    queryStr = e.target.value;
    rerender();
  });

  container.querySelector("#sp-new").addEventListener("click", () => {
    openDialog({
      title: "Suggestion",
      fields: [
        { id: "sp-title", label: "Title" },
        { id: "sp-desc", label: "Describe your suggestion or issue", multiline: true, rows: 4 }
      ],
      confirm: "Submit",
      requireFirstField: true,
      onConfirm: async v => {
        const id = await createTicket(user, v["sp-title"], v["sp-desc"]);
        window.showSnackbar?.(id
          ? `Issue filed — your ticket ID is ${id}`
          : "Couldn't file the issue — try again");
      }
    });
  });

  const unsub = observeMyTickets(user.uid, list => {
    tickets = list;
    loaded = true;
    rerender();
  });

  function rerender() {
    countsEl.textContent = headerCounts(tickets);
    const needle = queryStr.trim().toLowerCase();
    const visible = needle
      ? tickets.filter(t => [t.ticketId, t.title, t.description]
          .some(f => String(f || "").toLowerCase().includes(needle)))
      : tickets;

    if (!loaded) return;

    if (tickets.length === 0) {
      listEl.innerHTML = `<div class="empty-state">
        Nothing filed yet. Tap + Suggestion to send a suggestion or report a
        problem — you'll get a ticket ID to track it.
      </div>`;
      return;
    }
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No tickets match “${escapeHtml(queryStr)}”.</div>`;
      return;
    }

    listEl.innerHTML = `<div class="ticket-list">${visible.map(memberCard).join("")}</div>`;

    listEl.querySelectorAll("[data-reopen]").forEach(btn => {
      btn.addEventListener("click", () => {
        const t = tickets.find(x => x.key === btn.dataset.reopen);
        if (!t) return;
        openDialog({
          title: `Reopen ${escapeHtml(t.ticketId)}?`,
          body: `<p class="modal-note">Tell the team what's still wrong — the issue goes back to the open queue.</p>`,
          fields: [{ id: "sp-reopen", label: "What's still not working?", multiline: true, rows: 3 }],
          confirm: "Reopen",
          requireFirstField: true,
          onConfirm: async v => {
            await reopenTicket(t.key, v["sp-reopen"]);
            window.showSnackbar?.(`${t.ticketId} reopened`);
          }
        });
      });
    });
  }

  function memberCard(t) {
    const reopened = !isResolved(t) && wasReopened(t);
    return `
      <div class="ticket-card">
        <div class="ticket-head">
          <span class="ticket-id">${escapeHtml(t.ticketId)}</span>
          <span class="ticket-title">${escapeHtml(t.title)}</span>
          ${statusPill(t)}
        </div>
        ${t.description ? `<div class="ticket-desc clamp">${escapeHtml(t.description)}</div>` : ""}
        <div class="ticket-meta">Filed ${escapeHtml(dateLabel(t.createdAtMillis))}</div>
        ${reopened ? `
          <div class="ticket-reopened">
            You reopened this${t.reopenNote ? ": " + escapeHtml(t.reopenNote) : ""}
            · ${escapeHtml(dateLabel(t.reopenedAtMillis))}
          </div>` : ""}
        ${isResolved(t) ? `
          <div class="ticket-resolved">
            <div class="ticket-resolved-by">
              Resolved by ${escapeHtml(t.resolvedByName || "the team")} · ${escapeHtml(dateLabel(t.resolvedAtMillis))}
            </div>
            ${t.resolutionNote ? `<div class="ticket-resolution-note">${escapeHtml(t.resolutionNote)}</div>` : ""}
            <button class="ticket-reopen-btn" data-reopen="${escapeHtml(t.key)}">Reopen issue</button>
          </div>` : ""}
      </div>
    `;
  }

  return function teardown() { unsub(); };
}

// ================= Owner: the queue, inside Settings =================

export function renderSupportAdmin(container, { onBack } = {}) {
  const user = window.__currentUser;

  container.innerHTML = `
    <button class="back-link" id="sa-back">&larr; Settings</button>
    <div class="page-header">
      <div>
        <div class="page-title">Tech Support</div>
        <div class="page-subtitle" id="sa-counts">0 open · 0 total</div>
      </div>
    </div>
    <input class="search-input" id="sa-search" placeholder="Search ID, title, member…" />
    <div id="sa-list">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  let tickets = [];
  let queryStr = "";
  let loaded = false;

  const countsEl = container.querySelector("#sa-counts");
  const listEl = container.querySelector("#sa-list");

  container.querySelector("#sa-back").addEventListener("click", () => onBack?.());
  container.querySelector("#sa-search").addEventListener("input", e => {
    queryStr = e.target.value;
    rerender();
  });

  const unsub = observeAllTickets(list => {
    tickets = list;
    loaded = true;
    rerender();
  });

  function rerender() {
    countsEl.textContent = headerCounts(tickets);
    const needle = queryStr.trim().toLowerCase();
    const visible = needle
      ? tickets.filter(t => [t.ticketId, t.title, t.description, t.memberName, t.memberEmail]
          .some(f => String(f || "").toLowerCase().includes(needle)))
      : tickets;

    if (!loaded) return;

    if (tickets.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No issues filed by members yet.</div>`;
      return;
    }
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No tickets match “${escapeHtml(queryStr)}”.</div>`;
      return;
    }

    listEl.innerHTML = `<div class="ticket-list">${visible.map(adminCard).join("")}</div>`;

    listEl.querySelectorAll("[data-resolve]").forEach(btn => {
      btn.addEventListener("click", () => {
        const t = tickets.find(x => x.key === btn.dataset.resolve);
        if (!t) return;
        openDialog({
          title: `Resolve ${escapeHtml(t.ticketId)}?`,
          body: `<p class="modal-note">${escapeHtml(t.title)} — filed by ${escapeHtml(t.memberName || t.memberEmail)}</p>`,
          fields: [{ id: "sa-note", label: "Resolution note (optional)", multiline: true, rows: 3 }],
          confirm: "Mark resolved",
          onConfirm: async v => {
            await resolveTicket(t.key, user, v["sa-note"]);
            window.showSnackbar?.(`${t.ticketId} resolved`);
          }
        });
      });
    });

    listEl.querySelectorAll("[data-delete]").forEach(btn => {
      btn.addEventListener("click", () => {
        const t = tickets.find(x => x.key === btn.dataset.delete);
        if (!t) return;
        const who = t.memberName || t.memberEmail;
        openDialog({
          title: `Delete ${escapeHtml(t.ticketId)}?`,
          body: `<p class="modal-note">"${escapeHtml(t.title)}" by ${escapeHtml(who)} will be
                 permanently deleted from the database. The member loses it from their
                 Support tab too. This cannot be undone.</p>`,
          confirm: "Delete",
          confirmClass: "destructive",
          onConfirm: async () => {
            await deleteTicket(t.key);
            window.showSnackbar?.(`${t.ticketId} deleted`);
          }
        });
      });
    });
  }

  function adminCard(t) {
    const reopened = !isResolved(t) && wasReopened(t);
    return `
      <div class="ticket-card">
        <div class="ticket-head">
          <span class="ticket-id">${escapeHtml(t.ticketId)}</span>
          <span class="ticket-title">${escapeHtml(t.title)}</span>
          ${isResolved(t)
            ? statusPill(t)
            : `<button class="ticket-resolve-btn" data-resolve="${escapeHtml(t.key)}">Resolve</button>`}
          <button class="ticket-delete" data-delete="${escapeHtml(t.key)}" title="Delete" aria-label="Delete">&#x2715;</button>
        </div>
        ${reopened ? `
          <div class="ticket-reopened-plain">
            REOPENED by member${t.reopenNote ? ": " + escapeHtml(t.reopenNote) : ""}
          </div>` : ""}
        <div class="ticket-meta">
          By ${escapeHtml(t.memberName || t.memberEmail || "unknown")} · ${escapeHtml(dateLabel(t.createdAtMillis))}
        </div>
        ${t.description ? `<div class="ticket-desc">${escapeHtml(t.description)}</div>` : ""}
        ${isResolved(t) && t.resolutionNote
          ? `<div class="ticket-resolution-note">Note: ${escapeHtml(t.resolutionNote)}</div>` : ""}
      </div>
    `;
  }

  return function teardown() { unsub(); };
}
