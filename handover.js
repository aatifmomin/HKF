// Handover (donations) screen - admin only.
//
// Each application can carry supporting documents (the signed form, an ID
// scan, a hospital bill). They're attached from the Edit dialog and listed on
// the card itself with View / Remove. See attachments.js for why the blob and
// the index live at separate database paths.

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

import { firebaseApp } from "./firebase-init.js?v=2026-09-02b";
import { getSelectedYear, onYearChange } from "./year-state.js?v=2026-09-02b";
import {
  pickFiles,
  prepareAll,
  saveHandoverDoc,
  removeHandoverDoc,
  removeAllHandoverDocs,
  viewHandoverDoc,
  formatBytes,
  ACCEPT_DOCS
} from "./attachments.js?v=2026-09-02b";

const db = getDatabase(firebaseApp);

function formatRupees(minor) {
  if (!minor || minor <= 0) return "₹0";
  const r = minor / 100;
  if (minor % 100 === 0) return "₹" + Math.trunc(r).toLocaleString("en-IN");
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(millis) {
  if (!millis || millis <= 0) return "-";
  return new Date(millis).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** Android stores `type` as a bare extension ("jpg" | "pdf"), not a mime. */
function docIcon(type) {
  return String(type || "").toLowerCase().includes("pdf") ? "PDF" : "IMG";
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
    const year = getSelectedYear();

    // Year-filter rule for handovers:
    //   - Paid handovers: only those whose paidAtMillis falls in the
    //     selected year. Bucketing matches the Home chart (cash-flow view).
    //   - Pending handovers: always shown regardless of year. They have no
    //     paidAtMillis yet and represent open commitments the admin still
    //     needs to act on; hiding them per-year would risk losing track.
    let yearScoped = applications.filter(a => {
      const status = a.status || "pending";
      if (status !== "paid") return true;
      if (!a.paidAtMillis) return false;
      return new Date(a.paidAtMillis).getFullYear() === year;
    });

    let filtered = yearScoped;
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

    // Stats reflect the year-scoped list (so "5 applications" matches what
    // the user sees, not the all-time count).
    const paidTotal = yearScoped
      .filter(a => a.status === "paid")
      .reduce((s, a) => s + (a.amountMinor || 0), 0);
    if (yearScoped.length === 0) {
      subtitleEl.textContent = "No applications in " + year + ". Pending applications also appear here.";
    } else {
      const countText = yearScoped.length === 1 ? "1 application" : yearScoped.length + " applications";
      const yearNote = " (" + year + " + pending)";
      subtitleEl.textContent = paidTotal > 0
        ? countText + yearNote + " - " + formatRupees(paidTotal) + " paid"
        : countText + yearNote;
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
    rowsEl.querySelectorAll("[data-action='doc-view']").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try { await viewHandoverDoc(btn.dataset.key, btn.dataset.doc); }
        finally { btn.disabled = false; }
      });
    });
    rowsEl.querySelectorAll("[data-action='doc-remove']").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove "${btn.dataset.name}" from this application?`)) return;
        try {
          await removeHandoverDoc(btn.dataset.key, btn.dataset.doc);
          window.showSnackbar?.("Document removed");
        } catch (e) {
          window.showSnackbar?.("Couldn't remove: " + (e.message || "error"));
        }
      });
    });
  }

  const unsubYear = onYearChange(() => rerender());

  return function teardown() {
    unsubHandovers();
    unsubYear();
  };
}

/** The document strip shown under a handover card. */
function renderDocList(a) {
  const docs = Object.entries(a.documents || {});
  if (docs.length === 0) return "";
  return `
    <div class="doc-list">
      ${docs.map(([docId, d]) => `
        <div class="doc-chip">
          <span class="doc-kind">${docIcon(d.type)}</span>
          <span class="doc-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
          <span class="doc-size">${escapeHtml(formatBytes(d.sizeBytes))}</span>
          <button class="doc-btn" data-action="doc-view" data-key="${escapeHtml(a.key)}" data-doc="${escapeHtml(docId)}">View</button>
          <button class="doc-btn danger" data-action="doc-remove" data-key="${escapeHtml(a.key)}" data-doc="${escapeHtml(docId)}" data-name="${escapeHtml(d.name)}">Remove</button>
        </div>
      `).join("")}
    </div>
  `;
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
      ${renderDocList(a)}
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
  if (!confirm("Delete this handover? Its attached documents go with it. This cannot be undone.")) return;
  try {
    await remove(ref(db, "handovers/" + key));
    await removeAllHandoverDocs(key);
    window.showSnackbar?.("Deleted");
  } catch (e) {
    window.showSnackbar?.("Couldn't delete: " + (e.message || "error"));
  }
}

/**
 * Next application number.
 *
 * /handoversCounter is a BARE NUMBER, not { value: n } - Android reads it as
 * `snapshot.value as? Long`. Writing an object here would make every Android
 * client fail to allocate a number. The format is H%03d ("H001"), which is
 * what the four existing rows in production use.
 */
async function allocateNextNumber() {
  const counterRef = ref(db, "handoversCounter");
  let next = 1;
  await runTransaction(counterRef, current => {
    next = (typeof current === "number" ? current : 0) + 1;
    return next;
  });
  return "H" + String(next).padStart(3, "0");
}

function openHandoverDialog(existing, user) {
  const isEdit = !!existing;

  // Files chosen in this dialog but not yet written. On an existing record we
  // upload as soon as they're picked; on a new one we hold them until the
  // record has a key to hang them off.
  let staged = [];

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
          <span>Amount donated (₹) *</span>
          <input type="text" inputmode="decimal" id="f-amount" placeholder="0" />
        </label>
        <label class="field">
          <span>Purpose</span>
          <input type="text" id="f-purpose" />
        </label>

        <div class="field">
          <span>Documents</span>
          <div class="attach-box">
            <div class="attach-head">
              <button class="attach-btn" type="button" id="f-attach">+ Attach</button>
              <span class="attach-hint">JPG, PNG or PDF &middot; PDFs up to 2 MB</span>
            </div>
            <div id="f-doc-list" class="attach-list"></div>
          </div>
        </div>
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

  // ---- documents ----

  // Local mirror of what's already saved, so removing inside the dialog gives
  // instant feedback rather than waiting for the list listener to echo back.
  let savedDocs = { ...(existing?.documents || {}) };

  function renderDialogDocs() {
    const listEl = f("f-doc-list");
    const savedEntries = Object.entries(savedDocs);
    if (savedEntries.length === 0 && staged.length === 0) {
      listEl.innerHTML = `<div class="attach-empty">No documents attached.</div>`;
      return;
    }
    listEl.innerHTML = [
      ...savedEntries.map(([docId, d]) => `
        <div class="attach-item">
          <span class="doc-kind">${docIcon(d.type)}</span>
          <span class="doc-name">${escapeHtml(d.name)}</span>
          <span class="doc-size">${escapeHtml(formatBytes(d.sizeBytes))}</span>
          <button class="doc-btn" type="button" data-saved-view="${escapeHtml(docId)}">View</button>
          <button class="doc-btn danger" type="button" data-saved-remove="${escapeHtml(docId)}">Remove</button>
        </div>
      `),
      ...staged.map((att, i) => `
        <div class="attach-item staged">
          <span class="doc-kind">${docIcon(att.type)}</span>
          <span class="doc-name">${escapeHtml(att.name)}</span>
          <span class="doc-size">${escapeHtml(formatBytes(att.sizeBytes))}</span>
          <span class="pill pill-amber pill-tiny">on save</span>
          <button class="doc-btn danger" type="button" data-staged-remove="${i}">Remove</button>
        </div>
      `)
    ].join("");

    listEl.querySelectorAll("[data-saved-view]").forEach(btn => {
      btn.addEventListener("click", () => viewHandoverDoc(existing.key, btn.dataset.savedView));
    });
    listEl.querySelectorAll("[data-saved-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const docId = btn.dataset.savedRemove;
        if (!confirm(`Remove "${savedDocs[docId]?.name || "this document"}"?`)) return;
        btn.disabled = true;
        try {
          await removeHandoverDoc(existing.key, docId);
          delete savedDocs[docId];
          renderDialogDocs();
        } catch (e) {
          btn.disabled = false;
          window.showSnackbar?.("Couldn't remove: " + (e.message || "error"));
        }
      });
    });
    listEl.querySelectorAll("[data-staged-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        staged.splice(parseInt(btn.dataset.stagedRemove, 10), 1);
        renderDialogDocs();
      });
    });
  }
  renderDialogDocs();

  f("f-attach").addEventListener("click", async () => {
    const btn = f("f-attach");
    const files = await pickFiles({ multiple: true, accept: ACCEPT_DOCS });
    if (!files.length) return;

    btn.disabled = true;
    btn.textContent = "Processing...";
    try {
      const { ok, errors } = await prepareAll(files);
      errors.forEach(msg => window.showSnackbar?.(msg));

      if (isEdit) {
        // Existing record: write straight through, so a half-filled form that
        // never gets saved doesn't lose the files the admin just picked.
        for (const att of ok) {
          const docId = await saveHandoverDoc(existing.key, att, user);
          savedDocs[docId] = { name: att.name, type: att.type, sizeBytes: att.sizeBytes };
        }
        if (ok.length) window.showSnackbar?.(ok.length + (ok.length === 1 ? " document attached" : " documents attached"));
      } else {
        staged.push(...ok);
      }
      renderDialogDocs();
    } catch (e) {
      window.showSnackbar?.("Attach failed: " + (e.message || "error"));
    } finally {
      btn.disabled = false;
      btn.textContent = "+ Attach";
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

    const submitBtn = f("f-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

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
        for (const att of staged) {
          await saveHandoverDoc(pushRef.key, att, user);
        }
        window.showSnackbar?.("Created " + appNum);
      }
      close();
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? "Save" : "Submit";
      window.showSnackbar?.("Couldn't save: " + (e.message || "error"));
    }
  });
}
