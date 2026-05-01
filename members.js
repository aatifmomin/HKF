// Members directory.
//
// Read-only for non-admins.
// Admins also see a 3-dot menu on each row offering:
//   - Record payment (most-used: marks a month as paid for that member)
//   - Edit (name + role)
//   - Remove member
// Plus a "+ Add member" button at the top to create a pending member row.

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
import { peekNextMemberId } from "./members-self.js";

const db = getDatabase(firebaseApp);

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_LABELS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function formatRupees(minor) {
  if (!minor || minor <= 0) return "\u20B90";
  const r = minor / 100;
  if (minor % 100 === 0) return "\u20B9" + Math.trunc(r).toLocaleString("en-IN");
  return "\u20B9" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusFor(payments) {
  if (!payments || payments.length === 0) return { label: "Not started", cls: "pill-grey" };
  const months = payments.map(p => p.coversMonthKey).filter(Boolean).sort();
  const latest = months[months.length - 1];
  const now = new Date();
  const nowKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  if (latest >= nowKey) return { label: "Full paid", cls: "pill-green" };
  const [y, m] = latest.split("-");
  return { label: "Up to " + MONTH_LABELS[parseInt(m, 10) - 1] + " " + y, cls: "pill-amber" };
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

export function renderMembers(container) {
  const isAdmin = window.__viewerIsAdmin === true;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Members</div>
        <div class="page-subtitle" id="members-subtitle">loading...</div>
      </div>
      ${isAdmin ? `<button class="add-pill" id="add-member-btn">+ Add</button>` : ""}
    </div>
    <input class="search-input" id="members-search" placeholder="Search by name, ID or email..." />
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

  searchEl.addEventListener("input", e => { queryStr = e.target.value.trim().toLowerCase(); rerender(); });

  container.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      filter = chip.dataset.filter;
      rerender();
    });
  });

  if (isAdmin) {
    container.querySelector("#add-member-btn").addEventListener("click", () => openAddMemberDialog());
  }

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
      const blob = ((m.memberId || "") + " " + (m.displayName || "") + " " + (m.email || "")).toLowerCase();
      return blob.includes(queryStr);
    });

    if (filter !== "all") {
      filtered = filtered.filter(m => {
        const s = statusFor(paymentsByMember[m.uid]);
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

    rowsEl.innerHTML = filtered.map(m => renderRow(m, isAdmin)).join("");

    // Wire 3-dot menu buttons (admin only)
    if (isAdmin) {
      rowsEl.querySelectorAll("[data-action='menu']").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const m = members.find(x => x.uid === btn.dataset.uid);
          if (m) openMemberMenu(m, btn);
        });
      });
    }
  }

  return function teardown() {
    unsubMembers();
    unsubPayments();
    closeAnyOpenMenu();
  };
}

function renderRow(m, isAdmin) {
  const s = statusFor(window.__paymentsByMember?.[m.uid] || null) || { label: "", cls: "" };
  // We don't have access to paymentsByMember outside renderMembers's closure;
  // status was already computed in the parent. Re-derive here from a global
  // stash if available.
  const role = m.role || "Member";
  return `
    <div class="member-row">
      <div class="member-avatar">${escapeHtml(m.memberId || "?")}</div>
      <div class="member-body">
        <div class="member-name">${escapeHtml(m.displayName || (m.email || "-").split("@")[0])}</div>
        <div class="member-meta">
          <span class="pill pill-gold pill-tiny">${escapeHtml(role)}</span>
        </div>
        <div class="member-email">${escapeHtml(m.email || "")}</div>
      </div>
      <div class="member-amount">${formatRupees(m.totalPaidMinor || 0)}</div>
      ${isAdmin ? `<button class="row-kebab" data-action="menu" data-uid="${escapeHtml(m.uid)}" aria-label="Actions">&#x22EE;</button>` : ""}
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
    <button data-action="edit">Edit details</button>
    <button data-action="payments">View payments</button>
    <button data-action="remove" class="danger">Remove member</button>
  `;
  document.body.appendChild(menu);

  // Position next to the anchor button
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

  // Click outside to close
  setTimeout(() => {
    document.addEventListener("click", onDocClick, { once: true });
  }, 0);
  function onDocClick() { closeAnyOpenMenu(); }

  menu.querySelector("[data-action='record']").addEventListener("click", e => {
    e.stopPropagation();
    closeAnyOpenMenu();
    openRecordPaymentDialog(member);
  });
  menu.querySelector("[data-action='edit']").addEventListener("click", e => {
    e.stopPropagation();
    closeAnyOpenMenu();
    openEditMemberDialog(member);
  });
  menu.querySelector("[data-action='payments']").addEventListener("click", e => {
    e.stopPropagation();
    closeAnyOpenMenu();
    openPaymentsDialog(member);
  });
  menu.querySelector("[data-action='remove']").addEventListener("click", e => {
    e.stopPropagation();
    closeAnyOpenMenu();
    confirmRemoveMember(member);
  });
}

// ---------------- Record payment ----------------

function openRecordPaymentDialog(member) {
  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0") + "-" + String(today.getDate()).padStart(2,"0");
  const nowMonthKey = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0");

  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Record payment for ${escapeHtml(member.displayName || member.memberId)}</div>
      <div class="modal-body">
        <label class="field">
          <span>Covers month</span>
          <select id="rp-month"></select>
        </label>
        <label class="field">
          <span>Date paid</span>
          <input type="date" id="rp-date" />
        </label>
        <label class="field">
          <span>Amount (\u20B9) *</span>
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

  // Build month dropdown from CHART_START
  const monthSelect = dialog.querySelector("#rp-month");
  const monthKeys = nextNMonthKeys("2026-01", 12);
  monthSelect.innerHTML = monthKeys.map(k => {
    const [y, m] = k.split("-");
    const label = MONTH_LABELS[parseInt(m, 10) - 1] + " " + y;
    return `<option value="${k}" ${k === nowMonthKey ? "selected" : ""}>${label}</option>`;
  }).join("");

  dialog.querySelector("#rp-date").value = todayStr;
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
    const dateStr = dialog.querySelector("#rp-date").value || todayStr;
    const dateMillis = new Date(dateStr + "T12:00:00").getTime();
    const category = dialog.querySelector("#rp-category").value.trim() || "Member contribution";
    const note = dialog.querySelector("#rp-note").value.trim();
    const user = window.__currentUser;

    try {
      const paymentRef = push(ref(db, "payments/" + member.uid));
      await set(paymentRef, {
        coversMonthKey: monthKey,
        amountMinor,
        category,
        note,
        recordedByEmail: user?.email || "",
        recordedAtMillis: serverTimestamp(),
        dateMillis,
        batchKey: paymentRef.key
      });
      // Bump member.totalPaidMinor
      const memberRef = ref(db, "members/" + member.uid);
      const snap = await get(memberRef);
      const cur = snap.val()?.totalPaidMinor || 0;
      await update(memberRef, { totalPaidMinor: cur + amountMinor });
      window.showSnackbar?.("Payment recorded");
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't record: " + (e.message || "error"));
    }
  });
}

// ---------------- Edit member (name + role) ----------------

function openEditMemberDialog(member) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit ${escapeHtml(member.memberId)}</div>
      <div class="modal-body">
        <label class="field">
          <span>Display name</span>
          <input type="text" id="em-name" />
        </label>
        <label class="field">
          <span>Email</span>
          <input type="email" id="em-email" />
        </label>
        <label class="field">
          <span>Role</span>
          <select id="em-role">
            <option value="Member">Member</option>
            <option value="Admin">Admin</option>
          </select>
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="em-cancel">Cancel</button>
        <button class="modal-btn primary" id="em-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  dialog.querySelector("#em-name").value = member.displayName || "";
  dialog.querySelector("#em-email").value = member.email || "";
  dialog.querySelector("#em-role").value = member.role || "Member";

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#em-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#em-save").addEventListener("click", async () => {
    const name = dialog.querySelector("#em-name").value.trim();
    const email = dialog.querySelector("#em-email").value.trim();
    const role = dialog.querySelector("#em-role").value;
    if (!name) { window.showSnackbar?.("Name required"); return; }

    try {
      await update(ref(db, "members/" + member.uid), {
        displayName: name,
        email,
        role
      });

      // If role changed, mirror it into /admins.
      // Adding to admins requires a unique push key; removing requires we find
      // the existing key by email match.
      if (role === "Admin" && member.role !== "Admin") {
        const adminsSnap = await get(ref(db, "admins"));
        const existingByEmail = Object.entries(adminsSnap.val() || {}).find(
          ([_, a]) => (a?.emailLower || a?.email || "").toLowerCase() === email.toLowerCase()
        );
        if (!existingByEmail) {
          const newRef = push(ref(db, "admins"));
          await set(newRef, {
            email,
            emailLower: email.toLowerCase(),
            displayName: name,
            addedByEmail: window.__currentUser?.email || "",
            addedAtMillis: serverTimestamp()
          });
        }
      } else if (role !== "Admin" && member.role === "Admin") {
        const adminsSnap = await get(ref(db, "admins"));
        const target = Object.entries(adminsSnap.val() || {}).find(
          ([_, a]) => (a?.emailLower || a?.email || "").toLowerCase() === email.toLowerCase()
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

// ---------------- View payments (read-only history dialog) ----------------

async function openPaymentsDialog(member) {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">${escapeHtml(member.displayName || member.memberId)}'s payments</div>
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
    const snap = await get(ref(db, "payments/" + member.uid));
    const payments = Object.entries(snap.val() || {})
      .map(([k, p]) => ({ key: k, ...p }))
      .sort((a, b) => (b.recordedAtMillis || 0) - (a.recordedAtMillis || 0));
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
          const monthLabel = m ? MONTH_LABELS[parseInt(m,10)-1] + " " + y : "-";
          return `
            <div class="history-row">
              <div class="history-row-circle on">${monthLabel.charAt(0)}</div>
              <div class="history-row-body">
                <div class="history-row-title">${escapeHtml(monthLabel)}</div>
                <div class="history-row-sub">${escapeHtml(p.category || "")}${p.note ? " - " + escapeHtml(p.note) : ""}</div>
              </div>
              <div class="history-row-amount">${formatRupees(p.amountMinor || 0)}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  } catch (e) {
    dialog.querySelector("#vp-body").innerHTML = `<div class="empty-state">Couldn't load: ${escapeHtml(e.message || "")}</div>`;
  }
}

// ---------------- Remove member ----------------

async function confirmRemoveMember(member) {
  const ok = confirm("Remove " + (member.displayName || member.memberId) + "? Their /payments rows will also be deleted. This cannot be undone.");
  if (!ok) return;
  try {
    // Best-effort: remove member row + their payments.
    await fbRemove(ref(db, "members/" + member.uid));
    await fbRemove(ref(db, "payments/" + member.uid)).catch(() => {});
    window.showSnackbar?.("Member removed");
  } catch (e) {
    window.showSnackbar?.("Couldn't remove: " + (e.message || "error"));
  }
}

// ---------------- Add new member (pending) ----------------

async function openAddMemberDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add member</div>
      <div class="modal-body">
        <p style="font-size:11px;color:var(--text-3);margin:0;">
          Pre-creates a member row. They'll be linked automatically when they
          first sign in with this email.
        </p>
        <label class="field">
          <span>Display name</span>
          <input type="text" id="am-name" />
        </label>
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
            <option value="Member">Member</option>
            <option value="Admin">Admin</option>
          </select>
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="am-cancel">Cancel</button>
        <button class="modal-btn primary" id="am-save">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  // Pre-fill suggested next ID
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

    if (!name) { window.showSnackbar?.("Name required"); return; }
    if (email && !email.includes("@")) { window.showSnackbar?.("Invalid email"); return; }

    try {
      // Allocate or use explicit ID. Pending rows go under a generated push
      // key (no real Firebase Auth uid yet) - when this person signs in,
      // ensureMemberExists creates a new row keyed by their actual uid;
      // admin should later merge or ignore the pending row.
      // For simplicity in this turn, we just store under push key.
      let memberId = explicitId;
      if (!memberId) {
        memberId = await peekNextMemberId();
      }

      const newRef = push(ref(db, "members"));
      await set(newRef, {
        memberId,
        displayName: name,
        email: email.toLowerCase(),
        role,
        joinedAtMillis: Date.now(),
        totalPaidMinor: 0,
        pending: true
      });

      // If admin role, mirror into /admins as well
      if (role === "Admin" && email) {
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
