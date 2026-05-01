// Admins management screen.
//
// Shows owner + all entries from /admins. Owner can add/remove admins.
// Owner row is read-only - cannot be removed and is always shown first.
//
// Adding an admin: enter email + display name. Saves under /admins/{pushKey}.
// Removing: drops the /admins entry. The user's /members row is untouched -
// they remain a member, just lose admin role.

import {
  getDatabase,
  ref,
  onValue,
  push,
  set,
  remove as fbRemove,
  get,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { isOwner } from "./auth.js";
import { OWNER_EMAIL } from "./firebase-config.js";

const db = getDatabase(firebaseApp);

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderAdmins(container) {
  const user = window.__currentUser;
  const viewerIsOwner = isOwner(user?.email);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Admins</div>
        <div class="page-subtitle" id="admins-subtitle">loading...</div>
      </div>
      ${viewerIsOwner ? `<button class="add-pill" id="add-admin-btn">+ Add</button>` : ""}
    </div>

    <div class="rows-list" id="admins-rows">
      <div class="loading"><div class="spinner"></div>Loading...</div>
    </div>

    ${!viewerIsOwner ? `
      <div class="placeholder" style="margin-top:18px;">
        Only the foundation owner can add or remove admins.
      </div>
    ` : ""}
  `;

  let admins = []; // [{ key, email, displayName, ... }]
  const subtitleEl = container.querySelector("#admins-subtitle");
  const rowsEl = container.querySelector("#admins-rows");

  if (viewerIsOwner) {
    container.querySelector("#add-admin-btn").addEventListener("click", () => openAddAdminDialog());
  }

  // OWNER_EMAIL is imported at the top of this module from firebase-config.

  const unsubAdmins = onValue(ref(db, "admins"), snap => {
    const val = snap.val() || {};
    admins = Object.entries(val)
      .map(([key, a]) => ({ key, ...a }))
      .filter(a => (a.email || a.emailLower)) // ignore broken entries
      .sort((a, b) => (a.displayName || a.email || "").localeCompare(b.displayName || b.email || ""));
    rerender();
  });

  function rerender() {
    const total = admins.length + 1; // +1 for owner
    subtitleEl.textContent = total + (total === 1 ? " admin" : " admins");

    const ownerRow = `
      <div class="admin-row owner">
        <div class="admin-avatar">OWN</div>
        <div class="admin-body">
          <div class="admin-name">${escapeHtml(OWNER_EMAIL.split("@")[0])}</div>
          <div class="admin-email">${escapeHtml(OWNER_EMAIL)}</div>
        </div>
        <span class="pill pill-gold pill-tiny">Owner</span>
      </div>
    `;

    const adminRows = admins.map(a => {
      const name = a.displayName || (a.email || a.emailLower || "?").split("@")[0];
      const email = a.email || a.emailLower || "";
      const isAlsoOwner = email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      // Skip if this admin entry IS the owner (avoid duplicate row)
      if (isAlsoOwner) return "";
      return `
        <div class="admin-row">
          <div class="admin-avatar">ADM</div>
          <div class="admin-body">
            <div class="admin-name">${escapeHtml(name)}</div>
            <div class="admin-email">${escapeHtml(email)}</div>
          </div>
          ${viewerIsOwner ? `
            <button class="row-btn danger" data-key="${escapeHtml(a.key)}" data-email="${escapeHtml(email)}" data-action="remove-admin">Remove</button>
          ` : ""}
        </div>
      `;
    }).join("");

    rowsEl.innerHTML = ownerRow + adminRows;

    // Wire remove buttons
    rowsEl.querySelectorAll("[data-action='remove-admin']").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = admins.find(a => a.key === btn.dataset.key);
        if (target) confirmRemoveAdmin(target);
      });
    });
  }

  return function teardown() {
    unsubAdmins();
  };
}

async function confirmRemoveAdmin(admin) {
  const email = admin.email || admin.emailLower || "(unknown)";
  if (!confirm("Remove " + email + " as admin? They'll remain a member but lose admin access.")) return;
  try {
    await fbRemove(ref(db, "admins/" + admin.key));
    window.showSnackbar?.("Admin removed");
  } catch (e) {
    window.showSnackbar?.("Couldn't remove: " + (e.message || "error"));
  }
}

function openAddAdminDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add admin</div>
      <div class="modal-body">
        <p style="font-size:11px;color:var(--text-3);margin:0;">
          The person must already have signed in with this email. Adding an
          email that hasn't signed in yet won't auto-create a member - they
          become admin only after their next sign-in.
        </p>
        <label class="field">
          <span>Email *</span>
          <input type="email" id="aa-email" placeholder="someone@example.com" />
        </label>
        <label class="field">
          <span>Display name</span>
          <input type="text" id="aa-name" placeholder="(optional)" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="aa-cancel">Cancel</button>
        <button class="modal-btn primary" id="aa-save">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  function close() { document.body.removeChild(dialog); }
  dialog.querySelector("#aa-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  dialog.querySelector("#aa-save").addEventListener("click", async () => {
    const email = dialog.querySelector("#aa-email").value.trim();
    const name = dialog.querySelector("#aa-name").value.trim();
    if (!email || !email.includes("@")) {
      window.showSnackbar?.("Enter a valid email");
      return;
    }
    const emailLower = email.toLowerCase();

    try {
      // Check duplicate
      const adminsSnap = await get(ref(db, "admins"));
      const existing = Object.values(adminsSnap.val() || {}).find(
        a => (a?.emailLower || a?.email || "").toLowerCase() === emailLower
      );
      if (existing) {
        window.showSnackbar?.("Already an admin");
        return;
      }
      const newRef = push(ref(db, "admins"));
      await set(newRef, {
        email,
        emailLower,
        displayName: name,
        addedByEmail: window.__currentUser?.email || "",
        addedAtMillis: serverTimestamp()
      });
      window.showSnackbar?.("Admin added");
      close();
    } catch (e) {
      window.showSnackbar?.("Couldn't add: " + (e.message || "error"));
    }
  });
}
