// Members directory.
//
// Two very different screens share this module:
//
//   Admin  - the full directory: search, status filter chips, Excel export,
//            "+ Add", and a 3-dot menu per row (record payment, view profile,
//            edit, view payments, remove).
//   Member - just their own card, expanded to show their profile. No search,
//            no chips, no other people's rows.
//
// The member record shape is Android's MemberRecord, exactly:
//   memberId, displayName, email, role, joinedAtMillis, totalPaidMinor,
//   contactNumber, currentAddress, permanentAddress, occupation
// There is no separate "full name" - displayName is the name. Adding one
// would produce a field the Android client silently ignores.
//
// A member an admin adds before that person has ever signed in is stored
// under a key prefixed "pending_", which is how BOTH clients recognise a row
// waiting to be claimed at first sign-in.

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

import { firebaseApp } from "./firebase-init.js?v=2026-08-20a";
import { peekNextMemberId, newPendingMemberKey, recalcMemberTotal } from "./members-self.js?v=2026-08-20a";
import { getSelectedYear, onYearChange } from "./year-state.js?v=2026-08-20a";
import { viewPaymentProof } from "./attachments.js?v=2026-08-20a";

const db = getDatabase(firebaseApp);

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatRupees(minor) {
  if (!minor || minor <= 0) return "₹0";
  const r = minor / 100;
  if (minor % 100 === 0) return "₹" + Math.trunc(r).toLocaleString("en-IN");
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Clipboard write with the old-school fallback for non-secure origins. */
export async function copyToClipboard(text, label) {
  const value = String(text || "");
  if (!value) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    window.showSnackbar?.((label || "Text") + " copied");
  } catch {
    window.showSnackbar?.("Couldn't copy");
  }
}

/**
 * Compute a member's status pill for a given year window.
 *
 *   - "Not started" if no payment covers a month in the year
 *   - "Full paid" if latest covered month >= today (capped at year-end)
 *   - "Up to {Mon} {year}" otherwise
 */
function statusFor(payments, year) {
  if (!payments || payments.length === 0) return { label: "Not started", cls: "pill-grey" };
  const yearPrefix = String(year) + "-";
  const months = payments
    .map(p => p.coversMonthKey)
    .filter(k => k && k.startsWith(yearPrefix))
    .sort();
  if (months.length === 0) return { label: "Not started", cls: "pill-grey" };
  const latest = months[months.length - 1];
  const now = new Date();
  const todayKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const yearStartKey = year + "-01";
  const yearEndKey = year + "-12";
  const referenceKey = todayKey < yearEndKey ? todayKey : yearEndKey;
  if (referenceKey < yearStartKey) return { label: "Not started", cls: "pill-grey" };
  if (latest >= referenceKey) return { label: "Full paid", cls: "pill-green" };
  const [, m] = latest.split("-");
  return { label: "Up to " + MONTH_LABELS[parseInt(m, 10) - 1] + " " + year, cls: "pill-amber" };
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

/** Display name for a member row, with sensible fallbacks. */
export function memberDisplayName(m) {
  return (m?.displayName || "").trim() || (m?.email || "-").split("@")[0];
}

export function renderMembers(container) {
  // A member's own record now lives on the Profile tab (profile.js), where it
  // is editable. This screen is the admin directory only.
  if (window.__viewerIsAdmin !== true) {
    container.innerHTML = `
      <div class="placeholder">
        <strong>Admins only</strong>
        Your own record is on the Profile tab.
      </div>`;
    return () => {};
  }
  return renderAdminDirectory(container);
}

/**
 * Profile block used by the admin's read-only "View profile" dialog.
 * Addresses and the contact number are tap-to-copy - the permanent address in
 * particular gets pasted into forms constantly, and retyping it off a phone
 * screen is how typos get into paperwork.
 */
function renderProfileFields(m) {
  const rows = [
    { label: "Name", value: memberDisplayName(m), copy: false },
    { label: "Email", value: m.email || "", copy: true },
    { label: "Contact number", value: m.contactNumber || "", copy: true },
    { label: "Occupation", value: m.occupation || "", copy: false },
    { label: "Current address", value: m.currentAddress || "", copy: true, multiline: true },
    { label: "Permanent address", value: m.permanentAddress || "", copy: true, multiline: true }
  ];

  return `
    <div class="profile-block">
      ${rows.map(r => `
        <div class="profile-row ${r.multiline ? "multiline" : ""}">
          <div class="profile-label">${escapeHtml(r.label)}</div>
          ${r.value
            ? (r.copy
                ? `<button class="profile-value copyable" data-copy="${escapeHtml(r.value)}" data-copy-label="${escapeHtml(r.label)}" title="Tap to copy">
                     <span>${escapeHtml(r.value)}</span><span class="copy-hint">copy</span>
                   </button>`
                : `<div class="profile-value">${escapeHtml(r.value)}</div>`)
            : `<div class="profile-value empty">Not set</div>`}
        </div>
      `).join("")}
    </div>
  `;
}

function wireCopyTargets(scope) {
  scope.querySelectorAll("[data-copy]").forEach(el => {
    el.addEventListener("click", () => copyToClipboard(el.dataset.copy, el.dataset.copyLabel));
  });
}

// ================= Admin view: the full directory =================

function renderAdminDirectory(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Members</div>
        <div class="page-subtitle" id="members-subtitle">loading...</div>
      </div>
      <div class="header-actions">
        <button class="add-pill outline" id="export-members-btn">Export</button>
        <button class="add-pill" id="add-member-btn">+ Add</button>
      </div>
    </div>
    <input class="search-input" id="members-search" placeholder="Search by name, ID, email or number..." />
    <div class="filter-chips">
      <button class="chip active" data-filter="all">All</button>
      <button class="chip" data-filter="paid">Paid</button>
      <button class="chip" data-filter="pending">Pending</button>
      <button class="chip" data-filter="notstarted">Not started</button>
    </div>
    <div class="rows-list" id="members-rows">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  let members = [];
  let paymentsByMember = {};
  let queryStr = "";
  let filter = "all";

  const subtitleEl = container.querySelector("#members-subtitle");
  const rowsEl = container.querySelector("#members-rows");
  const searchEl = container.querySelector("#members-search");
  const exportBtn = container.querySelector("#export-members-btn");

  searchEl.addEventListener("input", e => { queryStr = e.target.value.trim().toLowerCase(); rerender(); });

  container.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      filter = chip.dataset.filter;
      rerender();
    });
  });

  container.querySelector("#add-member-btn").addEventListener("click", () => openAddMemberDialog());

  // Excel export is lazy-loaded: SheetJS is ~900KB and most sessions never
  // touch this button.
  exportBtn.addEventListener("click", async () => {
    const original = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = "Building...";
    try {
      const mod = await import("./members-export.js?v=2026-08-20a");
      await mod.downloadMembersWorkbook(getSelectedYear());
      window.showSnackbar?.("Members workbook downloaded");
    } catch (e) {
      console.error("member export failed", e);
      window.showSnackbar?.("Couldn't export: " + (e.message || "error"));
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = original;
    }
  });

  const unsubMembers = onValue(ref(db, "members"), snap => {
    const val = snap.val() || {};
    members = Object.entries(val)
      .map(([uid, m]) => ({ uid, ...m }))
      .sort((a, b) => (a.memberId || "").localeCompare(b.memberId || ""));
    rerender();
  });
  const unsubPayments = onValue(ref(db, "payments"), snap => {
    paymentsByMember = {};
    const val = snap.val() || {};
    Object.entries(val).forEach(([uid, byKey]) => {
      paymentsByMember[uid] = Object.entries(byKey || {}).map(([k, p]) => ({ key: k, ...p }));
    });
    rerender();
  });

  function rerender() {
    let filtered = members.filter(m => {
      if (!queryStr) return true;
      const blob = [
        m.memberId, m.displayName, m.email, m.contactNumber, m.occupation
      ].filter(Boolean).join(" ").toLowerCase();
      return blob.includes(queryStr);
    });

    const year = getSelectedYear();

    if (filter !== "all") {
      filtered = filtered.filter(m => {
        const s = statusFor(paymentsByMember[m.uid], year);
        if (filter === "paid") return s.label === "Full paid";
        if (filter === "pending") return s.label.startsWith("Up to");
        if (filter === "notstarted") return s.label === "Not started";
        return true;
      });
    }

    subtitleEl.textContent = members.length + (members.length === 1 ? " member" : " members");

    if (filtered.length === 0) {
      rowsEl.innerHTML = `<div class="empty-state">No matching members.</div>`;
      return;
    }

    rowsEl.innerHTML = filtered.map(m => {
      const s = statusFor(paymentsByMember[m.uid], year);
      return renderRow(m, s);
    }).join("");

    rowsEl.querySelectorAll("[data-action='menu']").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const m = members.find(x => x.uid === btn.dataset.uid);
        if (m) openMemberMenu(m, btn);
      });
    });
  }

  const unsubYear = onYearChange(() => rerender());

  return function teardown() {
    unsubMembers();
    unsubPayments();
    unsubYear();
    closeAnyOpenMenu();
  };
}

function renderRow(m, status) {
  const role = m.role || "Member";
  // A pending_ row is someone an admin added who hasn't signed in yet.
  const notSignedIn = String(m.uid || "").startsWith("pending_");
  const secondary = m.contactNumber || m.email || "";
  return `
    <div class="member-row">
      <div class="member-avatar">${escapeHtml(m.memberId || "?")}</div>
      <div class="member-body">
        <div class="member-name">${escapeHtml(memberDisplayName(m))}</div>
        <div class="member-meta">
          <span class="pill pill-gold pill-tiny">${escapeHtml(role)}</span>
          ${status && status.label
            ? `<span class="pill ${status.cls} pill-tiny">${escapeHtml(status.label)}</span>`
            : ""}
          ${notSignedIn ? `<span class="pill pill-grey pill-tiny">Not signed in</span>` : ""}
        </div>
        <div class="member-email">${escapeHtml(secondary)}</div>
      </div>
      <div class="member-amount">${formatRupees(m.totalPaidMinor || 0)}</div>
      <button class="row-kebab" data-action="menu" data-uid="${escapeHtml(m.uid)}" aria-label="Actions">&#x22EE;</button>
    </div>
  `;
}

// ---------------- 3-dot popover menu ----------------

let openMenuEl = null;

function closeAnyOpenMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

function openMemberMenu(member, anchorBtn) {
  closeAnyOpenMenu();

  const menu = document.createElement("div");
  menu.className = "kebab-menu";
  menu.innerHTML = `
    <button data-action="record">Record payment</button>
    <button data-action="profile">View profile</button>
    <button data-action="edit">Edit details</button>
    <button data-action="payments">View payments</button>
    <button data-action="remove" class="danger">Remove member</button>
  `;
  document.body.appendChild(menu);

  const rect = anchorBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 4;
  }
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  openMenuEl = menu;

  setTimeout(() => {
    document.addEventListener("click", onDocClick, { once: true });
  }, 0);
  function onDocClick() { closeAnyOpenMenu(); }

  const run = (action, fn) => {
    menu.querySelector(`[data-action='${action}']`).addEventListener("click", e => {
      e.stopPropagation();
      closeAnyOpenMenu();
      fn();
    });
  };

  run("record", () => openRecordPaymentDialog(member));
  run("profile", () => openProfileDialog(member));
  run("edit", () => openEditMemberDialog(member));
  run("payments", () => openPaymentsDialog(member));
  run("remove", () => confirmRemoveMember(member));
}

// ---------------- Profile dialog (read-only, tap-to-copy) ----------------

function openProfileDialog(member) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">${escapeHtml(member.memberId || "")} &middot; ${escapeHtml(memberDisplayName(member))}</div>
      <div class="modal-body">
        ${renderProfileFields(member)}
      </div>
      <div class="modal-actions">
        <button class="modal-btn primary" id="pf-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  wireCopyTargets(dialog);
  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#pf-close").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });
}

// ---------------- Record payment ----------------

function openRecordPaymentDialog(member) {
  const today = new Date();
  const nowMonthKey = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0");

  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Record payment for ${escapeHtml(memberDisplayName(member))}</div>
      <div class="modal-body">
        <label class="field">
          <span>Covers month</span>
          <select id="rp-month"></select>
        </label>
        <label class="field">
          <span>Amount (₹) *</span>
          <input type="text" inputmode="decimal" id="rp-amount" placeholder="0" />
        </label>
        <label class="field">
          <span>Category</span>
          <input type="text" id="rp-category" value="Member contribution" />
        </label>
        <label class="field">
          <span>Note (optional)</span>
          <input type="text" id="rp-note" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="rp-cancel">Cancel</button>
        <button class="modal-btn primary" id="rp-submit">Record</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const monthSelect = dialog.querySelector("#rp-month");
  const monthKeys = nextNMonthKeys(getSelectedYear() + "-01", 12);
  monthSelect.innerHTML = monthKeys.map(k => {
    const [y, m] = k.split("-");
    const label = MONTH_LABELS[parseInt(m, 10) - 1] + " " + y;
    return `<option value="${k}" ${k === nowMonthKey ? "selected" : ""}>${label}</option>`;
  }).join("");

  dialog.querySelector("#rp-amount").addEventListener("input", e => {
    if (!/^\d*\.?\d{0,2}$/.test(e.target.value)) e.target.value = e.target.value.slice(0, -1);
  });

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#rp-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#rp-submit").addEventListener("click", async () => {
    const amountText = dialog.querySelector("#rp-amount").value.trim();
    const amountMinor = Math.round((parseFloat(amountText) || 0) * 100);
    if (amountMinor <= 0) { window.showSnackbar?.("Enter an amount > 0"); return; }
    const monthKey = dialog.querySelector("#rp-month").value;
    const category = dialog.querySelector("#rp-category").value.trim() || "Member contribution";
    const note = dialog.querySelector("#rp-note").value.trim();
    const user = window.__currentUser;

    try {
      // PaymentRecord shape, exactly as Android writes it. No dateMillis -
      // the Android data class has no such property.
      const paymentRef = push(ref(db, "payments/" + member.uid));
      await set(paymentRef, {
        coversMonthKey: monthKey,
        amountMinor,
        category,
        note,
        batchKey: paymentRef.key,
        recordedByEmail: user?.email || "",
        recordedAtMillis: Date.now()
      });
      await recalcMemberTotal(member.uid);
      window.showSnackbar?.("Payment recorded");
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't record: " + (e.message || "error"));
    }
  });
}

// ---------------- Add / Edit member ----------------

// Matches Android's MemberRole enum, in the same order.
const MEMBER_ROLES = ["Founder", "President", "VP", "Treasurer", "Technical Director", "Monitor", "Member"];

/** The profile inputs shared by Add and Edit, so the two dialogs can't drift. */
function profileFieldsMarkup(prefix) {
  return `
    <label class="field">
      <span>Contact number</span>
      <input type="tel" id="${prefix}-contact" placeholder="e.g. 9876543210" />
    </label>
    <label class="field">
      <span>Occupation</span>
      <input type="text" id="${prefix}-occupation" />
    </label>
    <label class="field">
      <span>Current address</span>
      <textarea id="${prefix}-current" rows="2"></textarea>
    </label>
    <label class="field">
      <span>Permanent address</span>
      <textarea id="${prefix}-permanent" rows="2"></textarea>
    </label>
    <button class="link-btn small" type="button" id="${prefix}-same-address">Same as current address</button>
  `;
}

function readProfileFields(dialog, prefix) {
  const v = id => (dialog.querySelector("#" + prefix + "-" + id)?.value || "").trim();
  return {
    contactNumber: v("contact"),
    occupation: v("occupation"),
    currentAddress: v("current"),
    permanentAddress: v("permanent")
  };
}

function wireSameAddress(dialog, prefix) {
  const btn = dialog.querySelector("#" + prefix + "-same-address");
  if (!btn) return;
  btn.addEventListener("click", () => {
    dialog.querySelector("#" + prefix + "-permanent").value =
      dialog.querySelector("#" + prefix + "-current").value;
  });
}

function openEditMemberDialog(member) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit ${escapeHtml(member.memberId)}</div>
      <div class="modal-body">
        <label class="field">
          <span>Name *</span>
          <input type="text" id="em-name" />
        </label>
        ${profileFieldsMarkup("em")}
        <label class="field">
          <span>Email</span>
          <input type="email" id="em-email" />
        </label>
        <label class="field">
          <span>Member ID</span>
          <input type="text" id="em-id" maxlength="16" placeholder="e.g. M001" />
        </label>
        <label class="field">
          <span>Role</span>
          <select id="em-role">
            ${MEMBER_ROLES.map(r => `<option value="${r}">${r}</option>`).join("")}
          </select>
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" id="em-admin" style="width:auto;flex:none;" />
          <span style="font-weight:500;color:var(--text);">Also an admin</span>
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="em-cancel">Cancel</button>
        <button class="modal-btn primary" id="em-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  wireSameAddress(dialog, "em");

  dialog.querySelector("#em-name").value = member.displayName || "";
  dialog.querySelector("#em-contact").value = member.contactNumber || "";
  dialog.querySelector("#em-occupation").value = member.occupation || "";
  dialog.querySelector("#em-current").value = member.currentAddress || "";
  dialog.querySelector("#em-permanent").value = member.permanentAddress || "";
  dialog.querySelector("#em-email").value = member.email || "";
  dialog.querySelector("#em-id").value = member.memberId || "";

  const currentRole = MEMBER_ROLES.includes(member.role) ? member.role : "Member";
  dialog.querySelector("#em-role").value = currentRole;

  let wasAdmin = false;
  (async () => {
    try {
      const adminsSnap = await get(ref(db, "admins"));
      const target = Object.values(adminsSnap.val() || {}).find(
        a => (a?.emailLower || a?.email || "").toLowerCase() === (member.email || "").toLowerCase()
      );
      wasAdmin = !!target;
      dialog.querySelector("#em-admin").checked = wasAdmin;
    } catch {}
  })();

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#em-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#em-save").addEventListener("click", async () => {
    const name = dialog.querySelector("#em-name").value.trim();
    const email = dialog.querySelector("#em-email").value.trim();
    const newId = dialog.querySelector("#em-id").value.trim();
    const role = dialog.querySelector("#em-role").value;
    const wantsAdmin = dialog.querySelector("#em-admin").checked;
    const profile = readProfileFields(dialog, "em");

    if (!name) { window.showSnackbar?.("Name required"); return; }
    if (!newId) { window.showSnackbar?.("Member ID required"); return; }
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(newId)) {
      window.showSnackbar?.("ID: letters, digits, - or _ only (max 16)");
      return;
    }

    try {
      if (newId !== member.memberId) {
        const allSnap = await get(ref(db, "members"));
        const collision = Object.entries(allSnap.val() || {}).some(
          ([uid, rec]) => uid !== member.uid && (rec.memberId || "").toLowerCase() === newId.toLowerCase()
        );
        if (collision) {
          window.showSnackbar?.("That Member ID is already taken");
          return;
        }
      }

      await update(ref(db, "members/" + member.uid), {
        displayName: name,
        email,
        memberId: newId,
        role,
        ...profile
      });

      // Mirror the admin toggle to /admins
      if (wantsAdmin && !wasAdmin && email) {
        const adminRef = push(ref(db, "admins"));
        await set(adminRef, {
          email,
          emailLower: email.toLowerCase(),
          displayName: name,
          addedByEmail: window.__currentUser?.email || "",
          addedAtMillis: serverTimestamp()
        });
      } else if (!wantsAdmin && wasAdmin) {
        const adminsSnap = await get(ref(db, "admins"));
        const target = Object.entries(adminsSnap.val() || {}).find(
          ([_, a]) => (a?.emailLower || a?.email || "").toLowerCase() === (member.email || "").toLowerCase()
        );
        if (target) {
          await fbRemove(ref(db, "admins/" + target[0]));
        }
      }

      window.showSnackbar?.("Saved");
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't save: " + (e.message || "error"));
    }
  });
}

async function openAddMemberDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add member</div>
      <div class="modal-body">
        <p style="font-size:11px;color:var(--text-3);margin:0;">
          Pre-creates a member row. When this person signs in with this email
          they skip the approval queue and land straight on their record,
          including any payments you record here first.
        </p>
        <label class="field">
          <span>Name *</span>
          <input type="text" id="am-name" />
        </label>
        ${profileFieldsMarkup("am")}
        <label class="field">
          <span>Email</span>
          <input type="email" id="am-email" placeholder="(optional)" />
        </label>
        <label class="field">
          <span>Member ID</span>
          <input type="text" id="am-id" placeholder="auto" />
        </label>
        <label class="field">
          <span>Role</span>
          <select id="am-role">
            ${MEMBER_ROLES.map(r => `<option value="${r}" ${r === "Member" ? "selected" : ""}>${r}</option>`).join("")}
          </select>
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" id="am-admin" style="width:auto;flex:none;" />
          <span style="font-weight:500;color:var(--text);">Also an admin</span>
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="am-cancel">Cancel</button>
        <button class="modal-btn primary" id="am-save">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  wireSameAddress(dialog, "am");

  try {
    const next = await peekNextMemberId();
    dialog.querySelector("#am-id").placeholder = next + " (auto)";
  } catch {}

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#am-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#am-save").addEventListener("click", async () => {
    const name = dialog.querySelector("#am-name").value.trim();
    const email = dialog.querySelector("#am-email").value.trim();
    const explicitId = dialog.querySelector("#am-id").value.trim();
    const role = dialog.querySelector("#am-role").value;
    const wantsAdmin = dialog.querySelector("#am-admin").checked;
    const profile = readProfileFields(dialog, "am");

    if (!name) { window.showSnackbar?.("Name required"); return; }
    if (email && !email.includes("@")) { window.showSnackbar?.("Invalid email"); return; }

    try {
      const memberId = explicitId || await peekNextMemberId();

      // The "pending_" key prefix is how both clients recognise a row that is
      // waiting for its owner to sign in and claim it.
      await set(ref(db, "members/" + newPendingMemberKey()), {
        memberId,
        displayName: name,
        email: email.toLowerCase(),
        role,
        joinedAtMillis: Date.now(),
        totalPaidMinor: 0,
        ...profile
      });

      if (wantsAdmin && email) {
        const adminRef = push(ref(db, "admins"));
        await set(adminRef, {
          email,
          emailLower: email.toLowerCase(),
          displayName: name,
          addedByEmail: window.__currentUser?.email || "",
          addedAtMillis: serverTimestamp()
        });
      }

      window.showSnackbar?.("Added " + memberId);
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't add: " + (e.message || "error"));
    }
  });
}

// ---------------- View payments (read-only history dialog) ----------------

async function openPaymentsDialog(member) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">${escapeHtml(memberDisplayName(member))}'s payments</div>
      <div class="modal-body" id="vp-body">
        <div class="loading"><div class="spinner"></div>Loading...</div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn primary" id="vp-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#vp-close").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  try {
    const [snap, reqSnap] = await Promise.all([
      get(ref(db, "payments/" + member.uid)),
      get(ref(db, "paymentRequests"))
    ]);

    // Map every payment row an approval created back to its request, so the
    // sheet can show who approved it and surface the member's proof image.
    // approvedPaymentKey is comma-separated for a multi-month approval, and
    // every one of those rows resolves to the same parent request.
    const requestByPaymentKey = {};
    Object.entries(reqSnap.val() || {}).forEach(([key, r]) => {
      if (r?.memberUid !== member.uid || !r?.approvedPaymentKey) return;
      String(r.approvedPaymentKey).split(",").forEach(pk => {
        const trimmed = pk.trim();
        if (trimmed) requestByPaymentKey[trimmed] = { key, ...r };
      });
    });

    const payments = Object.entries(snap.val() || {})
      .map(([k, p]) => ({ key: k, ...p }))
      .sort((a, b) => (a.coversMonthKey || "").localeCompare(b.coversMonthKey || ""));
    const body = dialog.querySelector("#vp-body");
    if (payments.length === 0) {
      body.innerHTML = `<div class="empty-state">No payments yet.</div>`;
      return;
    }
    const total = payments.reduce((s, p) => s + (p.amountMinor || 0), 0);
    body.innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--gold-dark)">
        Total: ${formatRupees(total)}
      </div>
      <div class="rows-list">
        ${payments.map(p => {
          const [y, m] = (p.coversMonthKey || "-").split("-");
          const monthText = m ? MONTH_LABELS[parseInt(m,10)-1] + " " + y : "-";
          const req = requestByPaymentKey[p.key];
          const by = req ? (req.decidedByName || (req.decidedByEmail || "").split("@")[0]) : "";
          return `
            <div class="history-row ${req && req.proofName ? "has-proof" : ""}">
              <div class="history-row-circle on">${monthText.charAt(0)}</div>
              <div class="history-row-body">
                <div class="history-row-title">${escapeHtml(monthText)}</div>
                <div class="history-row-sub">${escapeHtml(p.category || "")}${p.note ? " - " + escapeHtml(p.note) : ""}</div>
                ${by ? `<div class="history-row-by">Approved by ${escapeHtml(by)}</div>` : ""}
                ${req && req.proofName ? `
                  <div class="proof-strip">
                    <span class="proof-tag">PROOF</span>
                    <span class="proof-name">${escapeHtml(req.proofName)}</span>
                    <button class="doc-btn" data-proof-view="${escapeHtml(req.key)}">View proof</button>
                  </div>` : ""}
              </div>
              <div class="history-row-amount">${formatRupees(p.amountMinor || 0)}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;

    body.querySelectorAll("[data-proof-view]").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try { await viewPaymentProof(btn.dataset.proofView); }
        finally { btn.disabled = false; }
      });
    });
  } catch (e) {
    dialog.querySelector("#vp-body").innerHTML = `<div class="empty-state">Couldn't load: ${escapeHtml(e.message || "")}</div>`;
  }
}

// ---------------- Remove member ----------------

/**
 * Remove a member and everything that belongs to them, in one atomic write:
 * the member row, their payments, their join application, and every payment
 * request they ever filed together with its proof image.
 *
 * The join request has to go or the person is stuck forever: their old row
 * still reads "approved" while the member row it created is gone. The
 * requests have to go because an orphaned request in the Activity feed points
 * at a member who no longer exists.
 */
async function confirmRemoveMember(member) {
  const ok = confirm(
    "Remove " + memberDisplayName(member) + "?\n\n" +
    "This permanently deletes the member with all their payment records, " +
    "payment requests, proof images, and join application — everything, from " +
    "the database. This cannot be undone."
  );
  if (!ok) return;

  const updates = {
    ["members/" + member.uid]: null,
    ["payments/" + member.uid]: null,
    ["joinRequests/" + member.uid]: null
  };

  // Best-effort scan: if this read fails the core delete still goes ahead.
  try {
    const reqSnap = await get(ref(db, "paymentRequests"));
    Object.entries(reqSnap.val() || {}).forEach(([key, r]) => {
      if (r?.memberUid === member.uid) {
        updates["paymentRequests/" + key] = null;
        updates["paymentProofs/" + key] = null;
      }
    });
  } catch (e) {
    console.warn("request scan skipped", e);
  }

  try {
    await update(ref(db), updates);
    window.showSnackbar?.("Member removed");
  } catch (e) {
    window.showSnackbar?.("Couldn't remove: " + (e.message || "error"));
  }
}
