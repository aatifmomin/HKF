// Handover (donations) screen - admin only.

import {
  getDatabase,
  ref,
  onValue,
  push,
  set,
  update,
  remove,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

function formatRupees(minor) {
  if (!minor || minor <= 0) return "\u20B90";
  const r = minor / 100;
  if (minor % 100 === 0) return "\u20B9" + Math.trunc(r).toLocaleString("en-IN");
  return "\u20B9" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(millis) {
  if (!millis || millis <= 0) return "-";
  return new Date(millis).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function renderHandover(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Handover</div>
        <div class="page-subtitle" id="handover-subtitle">loading...</div>
      </div>
      <button class="add-pill" id="new-handover-btn">+ New form</button>
    </div>

    <input class="search-input" id="handover-search" placeholder="Search applications..." />

    <div class="filter-chips">
      <button class="chip active" data-filter="all">All</button>
      <button class="chip" data-filter="paid">Paid</button>
      <button class="chip" data-filter="pending">Pending</button>
    </div>

    <div class="rows-list" id="handover-rows">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>
  `;

  let applications = [];
  let queryStr = "";
  let filter = "all";

  const subtitleEl = container.querySelector("#handover-subtitle");
  const rowsEl = container.querySelector("#handover-rows");
  const searchEl = container.querySelector("#handover-search");

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

  container.querySelector("#new-handover-btn").addEventListener("click", () => {
    openHandoverDialog(null, user);
  });

  const unsubHandovers = onValue(ref(db, "handovers"), snap => {
    const val = snap.val() || {};
    applications = Object.entries(val)
      .map(([key, rec]) => ({ key, ...rec }))
      .sort((a, b) => {
        const an = a.applicationNumber || "";
        const bn = b.applicationNumber || "";
        if (an && bn) return bn.localeCompare(an);
        return (b.createdAtMillis || 0) - (a.createdAtMillis || 0);
      });
    rerender();
  });

  function rerender() {
    let filtered = applications;
    if (filter !== "all") {
      filtered = filtered.filter(a => (a.status || "pending") === filter);
    }
    if (queryStr) {
      filtered = filtered.filter(a => {
        return (
          (a.personName || "").toLowerCase().includes(queryStr) ||
          (a.applicationNumber || "").toLowerCase().includes(queryStr) ||
          (a.city || "").toLowerCase().includes(queryStr) ||
          (a.mobileNumber || "").toLowerCase().includes(queryStr) ||
          (a.purpose || "").toLowerCase().includes(queryStr)
        );
      });
    }

    const paidTotal = applications.filter(a => a.status === "paid").reduce((s, a) => s + (a.amountMinor || 0), 0);
    if (applications.length === 0) {
      subtitleEl.textContent = "Tap + New form to create your first application.";
    } else {
      const countText = applications.length === 1 ? "1 application" : applications.length + " applications";
      subtitleEl.textContent = paidTotal > 0 ? countText + " - " + formatRupees(paidTotal) + " paid" : countText;
    }

    if (filtered.length === 0) {
      rowsEl.innerHTML = `<div class="empty-state">No matching applications.</div>`;
      return;
    }

    rowsEl.innerHTML = filtered.map(a => renderRow(a)).join("");

    rowsEl.querySelectorAll("[data-action='toggle-paid']").forEach(btn => {
      btn.addEventListener("click", () => toggleStatus(btn.dataset.key, user));
    });
    rowsEl.querySelectorAll("[data-action='edit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = applications.find(a => a.key === btn.dataset.key);
        if (target) openHandoverDialog(target, user);
      });
    });
    rowsEl.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => deleteHandover(btn.dataset.key));
    });
  }

  return function teardown() {
    unsubHandovers();
  };
}

function renderRow(a) {
  const status = a.status || "pending";
  const statusClass = status === "paid" ? "pill-green" : "pill-amber";
  const statusLabel = status === "paid" ? "Paid" : "Pending";
  const amountText = a.amountMinor > 0 ? formatRupees(a.amountMinor) : "-";

  const footerParts = [];
  if (a.referenceMemberName) {
    const refStr = a.referenceMemberId ? a.referenceMemberId + " " + a.referenceMemberName : a.referenceMemberName;
    footerParts.push("Ref: " + refStr);
  }
  if (status === "paid" && a.paidByEmail) {
    footerParts.push("Paid by " + a.paidByEmail.split("@")[0]);
  }
  const footer = footerParts.join(" - ");

  return `
    <div class="handover-row">
      <div class="handover-row-main">
        <div class="handover-row-head">
          <span class="handover-num">${escapeHtml(a.applicationNumber || "-")}</span>
          <span class="handover-name">${escapeHtml(a.personName || "-")}</span>
        </div>
        <div class="handover-row-meta">
          ${escapeHtml(a.city || "")}${a.mobileNumber ? " - " + escapeHtml(a.mobileNumber) : ""}
        </div>
        <div class="handover-row-meta">${escapeHtml(formatDate(a.applicationDateMillis))}</div>
        ${footer ? `<div class="handover-row-meta">${escapeHtml(footer)}</div>` : ""}
        <div class="handover-row-bottom">
          <span class="pill ${statusClass}">${statusLabel}</span>
        </div>
      </div>
      <div class="handover-row-side">
        <div class="handover-amount">${amountText}</div>
        <div class="handover-amount-sub">donated</div>
        <div class="handover-row-actions">
          <button class="row-btn" data-action="toggle-paid" data-key="${escapeHtml(a.key)}">
            ${status === "paid" ? "Set pending" : "Mark paid"}
          </button>
          <button class="row-btn" data-action="edit" data-key="${escapeHtml(a.key)}">Edit</button>
          <button class="row-btn danger" data-action="delete" data-key="${escapeHtml(a.key)}">Del</button>
        </div>
      </div>
    </div>
  `;
}

async function toggleStatus(key, user) {
  const snap = await new Promise(resolve => {
    const r = ref(db, "handovers/" + key);
    onValue(r, s => resolve(s), { onlyOnce: true });
  });
  const cur = snap.val();
  if (!cur) return;
  if (cur.status === "paid") {
    await update(ref(db, "handovers/" + key), { status: "pending", paidByEmail: "", paidAtMillis: 0 });
    window.showSnackbar?.("Marked pending");
  } else {
    await update(ref(db, "handovers/" + key), {
      status: "paid",
      paidByEmail: user.email || "",
      paidAtMillis: serverTimestamp()
    });
    window.showSnackbar?.("Marked paid");
  }
}

async function deleteHandover(key) {
  if (!confirm("Delete this handover? This cannot be undone.")) return;
  try {
    await remove(ref(db, "handovers/" + key));
    window.showSnackbar?.("Deleted");
  } catch (e) {
    window.showSnackbar?.("Couldn't delete: " + (e.message || "error"));
  }
}

async function allocateNextNumber() {
  const counterRef = ref(db, "handoversCounter/value");
  let next = 1;
  await runTransaction(counterRef, current => {
    next = (current || 0) + 1;
    return next;
  });
  return "H-" + String(next).padStart(4, "0");
}

function openHandoverDialog(existing, user) {
  const isEdit = !!existing;
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">${isEdit ? "Edit application" : "New form application"}</div>
      <div class="modal-body">
        <label class="field">
          <span>Date</span>
          <input type="date" id="f-date" />
        </label>
        <label class="field">
          <span>Person name *</span>
          <input type="text" id="f-name" placeholder="Full name" />
        </label>
        <label class="field">
          <span>Address</span>
          <input type="text" id="f-address" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>City</span>
            <input type="text" id="f-city" />
          </label>
          <label class="field">
            <span>Mobile</span>
            <input type="tel" id="f-mobile" />
          </label>
        </div>
        <label class="field">
          <span>Amount donated (\u20B9) *</span>
          <input type="text" inputmode="decimal" id="f-amount" placeholder="0" />
        </label>
        <label class="field">
          <span>Purpose</span>
          <input type="text" id="f-purpose" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="f-cancel">Cancel</button>
        <button class="modal-btn primary" id="f-submit">${isEdit ? "Save" : "Submit"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = yyyy + "-" + mm + "-" + dd;
  const f = id => dialog.querySelector("#" + id);

  if (existing) {
    if (existing.applicationDateMillis) {
      const d = new Date(existing.applicationDateMillis);
      f("f-date").value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    } else {
      f("f-date").value = todayStr;
    }
    f("f-name").value = existing.personName || "";
    f("f-address").value = existing.address || "";
    f("f-city").value = existing.city || "";
    f("f-mobile").value = existing.mobileNumber || "";
    f("f-amount").value = existing.amountMinor > 0
      ? (existing.amountMinor % 100 === 0 ? String(existing.amountMinor / 100) : (existing.amountMinor / 100).toFixed(2))
      : "";
    f("f-purpose").value = existing.purpose || "";
  } else {
    f("f-date").value = todayStr;
  }

  f("f-amount").addEventListener("input", e => {
    const v = e.target.value;
    if (!/^\d*\.?\d{0,2}$/.test(v)) {
      e.target.value = v.slice(0, -1);
    }
  });

  function close() { document.body.removeChild(dialog); }

  f("f-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  f("f-submit").addEventListener("click", async () => {
    const name = f("f-name").value.trim();
    const amountText = f("f-amount").value.trim();
    const amountMinor = Math.round((parseFloat(amountText) || 0) * 100);

    if (!name) {
      window.showSnackbar?.("Person name is required");
      return;
    }
    if (amountMinor <= 0) {
      window.showSnackbar?.("Amount must be greater than zero");
      return;
    }

    const dateStr = f("f-date").value;
    const dateMillis = dateStr ? new Date(dateStr + "T12:00:00").getTime() : Date.now();

    const fields = {
      personName: name,
      address: f("f-address").value.trim(),
      city: f("f-city").value.trim(),
      mobileNumber: f("f-mobile").value.trim(),
      purpose: f("f-purpose").value.trim(),
      amountMinor,
      applicationDateMillis: dateMillis,
      referenceMemberUid: existing?.referenceMemberUid || "",
      referenceMemberId: existing?.referenceMemberId || "",
      referenceMemberName: existing?.referenceMemberName || ""
    };

    try {
      if (isEdit) {
        await update(ref(db, "handovers/" + existing.key), fields);
        window.showSnackbar?.("Updated " + (existing.applicationNumber || ""));
      } else {
        const appNum = await allocateNextNumber();
        const pushRef = push(ref(db, "handovers"));
        await set(pushRef, {
          ...fields,
          applicationNumber: appNum,
          status: "pending",
          paidByEmail: "",
          paidAtMillis: 0,
          createdByEmail: user.email || "",
          createdAtMillis: serverTimestamp()
        });
        window.showSnackbar?.("Created " + appNum);
      }
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't save: " + (e.message || "error"));
    }
  });
}
