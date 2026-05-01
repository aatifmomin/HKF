// Members directory - read-only in this session.
// Live-binds to /members and /payments to compute per-member status.

import {
  getDatabase,
  ref,
  onValue
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

function formatRupees(minor) {
  if (!minor || minor <= 0) return "\u20B90";
  const r = minor / 100;
  if (minor % 100 === 0) return "\u20B9" + Math.trunc(r).toLocaleString("en-IN");
  return "\u20B9" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function statusFor(member, payments) {
  if (!payments || payments.length === 0) return { label: "Not started", cls: "pill-grey" };
  const months = payments.map(p => p.coversMonthKey).filter(Boolean).sort();
  const latest = months[months.length - 1];
  const now = new Date();
  const nowKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  if (latest >= nowKey) return { label: "Full paid", cls: "pill-green" };
  const [y, m] = latest.split("-");
  return { label: "Up to " + MONTH_LABELS[parseInt(m, 10) - 1] + " " + y, cls: "pill-amber" };
}

export function renderMembers(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Members</div>
        <div class="page-subtitle" id="members-subtitle">loading...</div>
      </div>
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
  let query = "";
  let filter = "all";

  const subtitleEl = container.querySelector("#members-subtitle");
  const rowsEl = container.querySelector("#members-rows");
  const searchEl = container.querySelector("#members-search");

  searchEl.addEventListener("input", e => { query = e.target.value.trim().toLowerCase(); rerender(); });
  container.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      filter = chip.dataset.filter;
      rerender();
    });
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
      if (!query) return true;
      const blob = ((m.memberId || "") + " " + (m.displayName || "") + " " + (m.email || "")).toLowerCase();
      return blob.includes(query);
    });

    if (filter !== "all") {
      filtered = filtered.filter(m => {
        const s = statusFor(m, paymentsByMember[m.uid]);
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
      const s = statusFor(m, paymentsByMember[m.uid]);
      const role = m.role || "Member";
      return `
        <div class="member-row">
          <div class="member-avatar">${escapeHtml(m.memberId || "?")}</div>
          <div class="member-body">
            <div class="member-name">${escapeHtml(m.displayName || (m.email || "-").split("@")[0])}</div>
            <div class="member-meta">
              <span class="pill pill-gold pill-tiny">${escapeHtml(role)}</span>
              <span class="pill ${s.cls} pill-tiny">${escapeHtml(s.label)}</span>
            </div>
            <div class="member-email">${escapeHtml(m.email || "")}</div>
          </div>
          <div class="member-amount">${formatRupees(m.totalPaidMinor || 0)}</div>
        </div>
      `;
    }).join("");
  }

  return function teardown() {
    unsubMembers();
    unsubPayments();
  };
}
