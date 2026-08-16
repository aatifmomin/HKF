// Settings - owner only, reached from the gear on Home.
//
// Port of Android's SettingsScreen. Not a nav tab on either client: it takes
// over the content area and offers a back link. The Admins management screen
// lives inside it (it used to be its own tab).
//
// Everything here writes to /settings, which both clients read:
//   apkLink      - the download link printed on the Share & refer card
//   reminderDay  - 1-28, or 0 for off; from this day members who haven't paid
//                  for the month see a reminder on their Payments tab
//   reminderText - the message used by the Reminder tab and that banner

import {
  getDatabase,
  ref,
  get,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { isOwner } from "./auth.js";
import { renderAdmins } from "./admins.js";
import { DEFAULT_REMINDER_MESSAGE } from "./reminder.js";

const db = getDatabase(firebaseApp);

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderSettings(container, { onBack } = {}) {
  const user = window.__currentUser;
  if (!isOwner(user?.email)) {
    container.innerHTML = `
      <div class="placeholder">
        <strong>Owner only</strong>
        These controls belong to the foundation owner.
      </div>`;
    return () => {};
  }

  let adminsTeardown = null;

  function renderMain() {
    if (adminsTeardown) { adminsTeardown(); adminsTeardown = null; }

    container.innerHTML = `
      <button class="back-link" id="st-back">&larr; Home</button>
      <div class="page-header">
        <div>
          <div class="page-title">Settings</div>
          <div class="page-subtitle">Super-admin controls</div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-label">SHARE &amp; REFER LINK</div>
        <div class="settings-help">Download link shown on the share card and in the share text.</div>
        <label class="field">
          <span>APK / app link</span>
          <input type="text" id="st-apk" placeholder="https://..." />
        </label>
        <button class="modal-btn primary settings-save" id="st-save-apk">Save link</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">PAYMENT REMINDER</div>
        <div class="settings-help">
          From this day of each month, members who haven't paid for the month
          see a reminder on their Payments tab. 1-28, blank to turn off.
        </div>
        <label class="field">
          <span>Day of month (1-28)</span>
          <input type="text" inputmode="numeric" id="st-day" maxlength="2" placeholder="off" />
        </label>
        <label class="field">
          <span>Reminder message</span>
          <textarea id="st-text" rows="3" placeholder="${escapeHtml(DEFAULT_REMINDER_MESSAGE)}"></textarea>
        </label>
        <div class="settings-help">
          Used by the Reminder tab's SMS and shown on the tab. Blank = default text.
        </div>
        <button class="modal-btn primary settings-save" id="st-save-reminder">Save reminder</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">ADMINS</div>
        <div class="settings-help">Add or remove admins (moved here from the old Admins tab).</div>
        <button class="modal-btn settings-save" id="st-admins">Manage admins</button>
      </div>

      <div class="settings-section danger">
        <div class="settings-label">DANGER ZONE</div>
        <div class="settings-help">
          Delete ALL activity: every payment request (and its proof image) and
          every join request. Recorded payments, members, and handovers are NOT
          touched. This cannot be undone.
        </div>
        <button class="modal-btn destructive settings-save" id="st-wipe">Delete all activity</button>
      </div>
    `;

    const apkEl = container.querySelector("#st-apk");
    const dayEl = container.querySelector("#st-day");
    const textEl = container.querySelector("#st-text");
    [apkEl, dayEl, textEl].forEach(el => { el.disabled = true; });

    // Load current values. Fields stay disabled until we know them, so a slow
    // network can't have the owner overwrite a setting they never saw.
    get(ref(db, "settings")).then(snap => {
      const v = snap.val() || {};
      apkEl.value = v.apkLink || "";
      const day = Number(v.reminderDay) || 0;
      dayEl.value = day > 0 ? String(day) : "";
      textEl.value = v.reminderText || "";
      [apkEl, dayEl, textEl].forEach(el => { el.disabled = false; });
    }).catch(e => {
      container.querySelector("#st-apk").placeholder = "couldn't load settings";
      console.warn("settings load failed", e);
    });

    // Digits only, max 2 - same input sanitising as the Android field.
    dayEl.addEventListener("input", () => {
      dayEl.value = dayEl.value.replace(/\D/g, "").slice(0, 2);
    });

    container.querySelector("#st-back").addEventListener("click", () => onBack?.());

    container.querySelector("#st-save-apk").addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await set(ref(db, "settings/apkLink"), apkEl.value.trim());
        window.showSnackbar?.("Link saved");
      } catch (err) {
        window.showSnackbar?.("Couldn't save: " + (err.message || "error"));
      } finally {
        btn.disabled = false;
      }
    });

    container.querySelector("#st-save-reminder").addEventListener("click", async e => {
      const btn = e.currentTarget;
      const raw = dayEl.value.trim();
      const day = raw === "" ? 0 : parseInt(raw, 10) || 0;
      if (day !== 0 && (day < 1 || day > 28)) {
        window.showSnackbar?.("Enter a day between 1 and 28");
        return;
      }
      btn.disabled = true;
      try {
        await update(ref(db, "settings"), {
          reminderDay: day,
          reminderText: textEl.value.trim()
        });
        window.showSnackbar?.("Reminder saved");
      } catch (err) {
        window.showSnackbar?.("Couldn't save: " + (err.message || "error"));
      } finally {
        btn.disabled = false;
      }
    });

    container.querySelector("#st-admins").addEventListener("click", () => renderAdminsPane());

    container.querySelector("#st-wipe").addEventListener("click", async e => {
      const ok = confirm(
        "Delete all activity?\n\n" +
        "Every payment request, join request, and proof image will be " +
        "permanently deleted. Recorded payments and handovers stay. " +
        "This cannot be undone."
      );
      if (!ok) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        // One multi-path null write, exactly as Android does it.
        await update(ref(db), {
          paymentRequests: null,
          joinRequests: null,
          paymentProofs: null
        });
        window.showSnackbar?.("All activity deleted");
      } catch (err) {
        window.showSnackbar?.("Couldn't delete — try again");
      } finally {
        btn.disabled = false;
        btn.textContent = "Delete all activity";
      }
    });
  }

  function renderAdminsPane() {
    if (adminsTeardown) { adminsTeardown(); adminsTeardown = null; }
    container.innerHTML = `
      <button class="back-link" id="ad-back">&larr; Settings</button>
      <div id="admins-host"></div>
    `;
    container.querySelector("#ad-back").addEventListener("click", () => renderMain());
    adminsTeardown = renderAdmins(container.querySelector("#admins-host"));
  }

  renderMain();

  return function teardown() {
    if (adminsTeardown) { adminsTeardown(); adminsTeardown = null; }
  };
}
