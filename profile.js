// Member Profile tab - port of Android's ProfileScreen.
//
// Replaces the read-only self-view that used to live on the member's Members
// tab (the nav pill is now labelled "Profile"). The difference that matters:
// a member can EDIT their own contact number, addresses and occupation here.
// Everything else - member id, role, email, name, totals - stays
// admin-managed and read-only.
//
// The stats strip is all-time, not year-filtered, and deliberately ignores the
// year picker: "AVG / MONTH" only means something across a member's whole
// history.

import {
  getDatabase,
  ref,
  onValue,
  get
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-08-20a";
import { updateSelfProfile } from "./members-self.js?v=2026-08-20a";
import { copyToClipboard, memberDisplayName } from "./members.js?v=2026-08-20a";

const db = getDatabase(firebaseApp);

const DEFAULT_CONTACT_PROMPT = "Please update your contact number in your HKF profile";

/** Whole rupees, no decimals - matches Android's profileRupees(). */
function profileRupees(minor) {
  return "₹" + Math.trunc((minor || 0) / 100).toLocaleString("en-IN");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// label, the member field it maps to, whether it's editable, and whether the
// editor should be a textarea.
const DETAIL_ROWS = [
  { key: "displayName",      label: "Full name",         edit: false },
  { key: "email",            label: "Email",             edit: false, copy: true },
  { key: "contactNumber",    label: "Contact number",    edit: true,  copy: true },
  { key: "currentAddress",   label: "Current address",   edit: true,  copy: true, multiline: true },
  { key: "permanentAddress", label: "Permanent address", edit: true,  copy: true, multiline: true },
  { key: "occupation",       label: "Occupation",        edit: true },
  { key: "role",             label: "Role",              edit: false, fallback: "Member" }
];

export function renderProfile(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Profile</div>
        <div class="page-subtitle">Your foundation record</div>
      </div>
    </div>
    <div id="profile-body">
      <div class="loading"><div class="spinner"></div>Loading your profile...</div>
    </div>
  `;

  const bodyEl = container.querySelector("#profile-body");
  let member = null;
  let sawMember = false;
  let stats = null;               // { yearMinor, allMinor, avgMinor }
  let contactPrompt = DEFAULT_CONTACT_PROMPT;

  const unsubMember = onValue(ref(db, "members/" + user.uid), snap => {
    member = snap.exists() ? { uid: user.uid, ...snap.val() } : null;
    sawMember = true;
    rerender();
  });

  // Stats come from the member's whole payment history, so they're computed
  // here rather than reused from the year-filtered Payments screen.
  const unsubPayments = onValue(ref(db, "payments/" + user.uid), snap => {
    const rows = Object.values(snap.val() || {});
    const yearPrefix = new Date().getFullYear() + "-";
    let yearMinor = 0, allMinor = 0;
    const months = new Set();
    rows.forEach(p => {
      const amt = p?.amountMinor || 0;
      allMinor += amt;
      if (String(p?.coversMonthKey || "").startsWith(yearPrefix)) yearMinor += amt;
      if (p?.coversMonthKey) months.add(p.coversMonthKey);
    });
    stats = {
      yearMinor,
      allMinor,
      // Average over months actually contributed to, not calendar months.
      avgMinor: months.size > 0 ? Math.floor(allMinor / months.size) : 0
    };
    rerender();
  });

  get(ref(db, "settings/updateContactText")).then(snap => {
    const v = String(snap.val() || "").trim();
    if (v) { contactPrompt = v; rerender(); }
  }).catch(() => {});

  function rerender() {
    if (!sawMember) return;
    if (!member) {
      bodyEl.innerHTML = `<div class="empty-state">Your member record isn't set up yet.</div>`;
      return;
    }

    const year = new Date().getFullYear();
    const stat = v => (stats ? profileRupees(v) : "—");

    bodyEl.innerHTML = `
      <div class="profile-hero">
        <div class="profile-avatar">${escapeHtml(member.memberId || "—")}</div>
        <div class="profile-hero-name">${escapeHtml(memberDisplayName(member))}</div>
      </div>

      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-label">PAID ${year}</div>
          <div class="profile-stat-value">${escapeHtml(stat(stats?.yearMinor))}</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-label">ALL TIME</div>
          <div class="profile-stat-value">${escapeHtml(stat(stats?.allMinor))}</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-label">AVG / MONTH</div>
          <div class="profile-stat-value">${escapeHtml(stat(stats?.avgMinor))}</div>
        </div>
      </div>

      ${!String(member.contactNumber || "").trim() ? `
        <div class="reminder-banner">
          <div class="reminder-banner-label">CONTACT NUMBER MISSING</div>
          <div class="reminder-banner-text">${escapeHtml(contactPrompt)}</div>
        </div>
      ` : ""}

      <div class="section-header">DETAILS</div>
      <div class="detail-card">
        ${DETAIL_ROWS.map(renderDetailRow).join("")}
      </div>
    `;

    bodyEl.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = DETAIL_ROWS.find(r => r.key === btn.dataset.edit);
        if (row) openEditDialog(member, row);
      });
    });
    bodyEl.querySelectorAll("[data-copy]").forEach(el => {
      el.addEventListener("click", () => copyToClipboard(el.dataset.copy, el.dataset.copyLabel));
    });
  }

  function renderDetailRow(row) {
    const raw = row.key === "displayName"
      ? memberDisplayName(member)
      : String(member[row.key] || "").trim() || (row.fallback || "");
    const has = !!raw;

    const value = has
      ? (row.copy
          ? `<button class="detail-value copyable" data-copy="${escapeHtml(raw)}" data-copy-label="${escapeHtml(row.label)}" title="Tap to copy">${escapeHtml(raw)}</button>`
          : `<span class="detail-value">${escapeHtml(raw)}</span>`)
      : `<span class="detail-value empty">Not added</span>`;

    return `
      <div class="detail-row ${row.multiline ? "multiline" : ""}">
        <div class="detail-label">${escapeHtml(row.label)}</div>
        <div class="detail-value-wrap">
          ${value}
          ${row.edit
            ? `<button class="detail-edit" data-edit="${row.key}" title="Edit ${escapeHtml(row.label)}" aria-label="Edit ${escapeHtml(row.label)}">&#x270E;</button>`
            : ""}
        </div>
      </div>
    `;
  }

  /**
   * One field at a time, matching Android. The write sends all four editable
   * fields (the three untouched ones with their current values), which keeps
   * it a single update and can't half-apply.
   */
  function openEditDialog(m, row) {
    const dialog = document.createElement("div");
    dialog.className = "modal-overlay";
    dialog.innerHTML = `
      <div class="modal">
        <div class="modal-title">Edit ${escapeHtml(row.label)}</div>
        <div class="modal-body">
          <label class="field">
            <span>${escapeHtml(row.label)}</span>
            ${row.multiline
              ? `<textarea id="pe-input" rows="3"></textarea>`
              : `<input type="${row.key === "contactNumber" ? "tel" : "text"}" id="pe-input" />`}
          </label>
        </div>
        <div class="modal-actions">
          <button class="modal-btn" id="pe-cancel">Cancel</button>
          <button class="modal-btn primary" id="pe-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);

    const input = dialog.querySelector("#pe-input");
    input.value = m[row.key] || "";
    setTimeout(() => input.focus(), 30);

    function close() { if (dialog.parentNode) document.body.removeChild(dialog); }
    dialog.querySelector("#pe-cancel").addEventListener("click", close);
    dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

    dialog.querySelector("#pe-save").addEventListener("click", async () => {
      const btn = dialog.querySelector("#pe-save");
      btn.disabled = true;
      btn.textContent = "Saving...";
      const ok = await updateSelfProfile(m.uid, {
        contactNumber: m.contactNumber,
        currentAddress: m.currentAddress,
        permanentAddress: m.permanentAddress,
        occupation: m.occupation,
        [row.key]: input.value
      });
      if (ok) {
        window.showSnackbar?.(row.label + " updated");
        close();
      } else {
        btn.disabled = false;
        btn.textContent = "Save";
        window.showSnackbar?.("Couldn't save — try again");
      }
    });
  }

  return function teardown() {
    unsubMember();
    unsubPayments();
  };
}
