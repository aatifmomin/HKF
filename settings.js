// Settings - owner only, reached from the gear on Home.
//
// Port of Android's SettingsScreen. Not a nav tab on either client: it takes
// over the content area and offers a back link. Admin management lives inside
// it (it used to be its own tab).
//
// Everything here writes to /settings, which both clients read:
//   apkLink           - the download link printed on the Share & refer card
//   upiId / upiName   - powers the member's tap-to-pay button
//   paymentQr         - { name, base64 }, the QR image members scan
//   reminderDay       - 1-28, or 0 for off
//   reminderText      - the SMS / banner message for unpaid members
//   updateContactText - the nudge shown to members with no contact number

import {
  getDatabase,
  ref,
  get,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-08-20a";
import { isOwner } from "./auth.js?v=2026-08-20a";
import { BUILD_ID } from "./version.js?v=2026-08-20a";
import { renderAdmins } from "./admins.js?v=2026-08-20a";
import { renderSupportAdmin } from "./support.js?v=2026-08-20a";
import { DEFAULT_REMINDER_MESSAGE, DEFAULT_CONTACT_MESSAGE } from "./reminder.js?v=2026-08-20a";
import {
  pickFiles,
  prepareAttachment,
  savePaymentQr,
  removePaymentQr,
  loadPaymentQr,
  ACCEPT_IMAGES
} from "./attachments.js?v=2026-08-20a";

const db = getDatabase(firebaseApp);

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The three danger-zone actions, each one atomic multi-path null write. */
const WIPES = [
  {
    id: "members",
    button: "Delete all members",
    title: "Delete ALL members?",
    body: "Every member, every payment record, and the member-ID counter will be " +
          "permanently deleted from the database (next member starts at M001). Totals " +
          "and charts reset to zero. Handovers and activity are not touched. " +
          "This cannot be undone.",
    paths: { members: null, payments: null, membersCounter: null },
    done: "All members deleted"
  },
  {
    id: "handovers",
    button: "Delete all handovers",
    title: "Delete ALL handovers?",
    body: "Every handover record with all attached documents, and the H-number " +
          "counter, will be permanently deleted from the database. Members, payments, " +
          "and activity are not touched. This cannot be undone.",
    paths: { handovers: null, handoverDocs: null, handoversCounter: null },
    done: "All handovers deleted"
  },
  {
    id: "activity",
    button: "Delete all activity",
    title: "Delete ALL activity?",
    body: "Every payment request (including approved ones, with all proof images) and " +
          "every join request will be permanently deleted from the database. Proof " +
          "images and approver names will disappear from member payment rows, since " +
          "those come from approved requests. Recorded payments, members, and " +
          "handovers are not touched. This cannot be undone.",
    paths: { paymentRequests: null, paymentProofs: null, joinRequests: null },
    done: "All activity deleted"
  }
];

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

  let paneTeardown = null;

  function renderMain() {
    if (paneTeardown) { paneTeardown(); paneTeardown = null; }

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
        <div class="settings-label">BANK QR &amp; UPI</div>
        <div class="settings-help">
          Members see this QR at the top of their Home tab. The UPI ID powers
          tap-to-pay: opening the QR offers their installed UPI apps (GPay,
          PhonePe, Cred, Paytm...). No amount is pre-filled — the member types it.
        </div>
        <label class="field">
          <span>UPI ID</span>
          <input type="text" id="st-upi-id" placeholder="e.g. name@okhdfcbank" />
        </label>
        <label class="field">
          <span>Payee name shown in UPI apps</span>
          <input type="text" id="st-upi-name" placeholder="Hasnain Karimain Foundation" />
        </label>
        <button class="modal-btn primary settings-save" id="st-save-upi">Save UPI details</button>

        <div class="qr-admin" id="st-qr-state">
          <div class="qr-admin-preview" id="st-qr-preview"></div>
          <div class="qr-admin-actions">
            <button class="modal-btn settings-save" id="st-qr-upload">Upload QR</button>
            <button class="modal-btn settings-save danger-text" id="st-qr-remove" hidden>Remove QR</button>
          </div>
        </div>
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
        <label class="field">
          <span>Update-contact message</span>
          <textarea id="st-contact-text" rows="2" placeholder="${escapeHtml(DEFAULT_CONTACT_MESSAGE)}"></textarea>
        </label>
        <div class="settings-help">
          Shown in-app to members whose contact number is empty, and used by the
          Reminder tab's Contact Update emails.
        </div>
        <button class="modal-btn primary settings-save" id="st-save-reminder">Save reminder</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">ADMINS</div>
        <div class="settings-help">Add or remove admins (moved here from the old Admins tab).</div>
        <button class="modal-btn settings-save" id="st-admins">Manage admins</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">TECH SUPPORT</div>
        <div class="settings-help">
          Issues filed by members from their Support tab. Resolve them here —
          the outcome shows on the member's ticket instantly.
        </div>
        <button class="modal-btn settings-save" id="st-support">View issues</button>
      </div>

      <div class="settings-section danger">
        <div class="settings-label">DANGER ZONE</div>
        <div class="settings-help">
          Each button permanently deletes that entire section from the database.
          There is no undo — export a JSON backup from the Firebase Console first.
        </div>
        ${WIPES.map(w => `
          <button class="modal-btn destructive settings-save" data-wipe="${w.id}">${escapeHtml(w.button)}</button>
        `).join("")}
      </div>

      <div class="build-stamp">
        Web build ${escapeHtml(BUILD_ID)} — if this doesn't match the build you
        just deployed, your browser is still running a cached copy. Hard-reload
        (Ctrl+Shift+R, or Cmd+Shift+R) to pick it up.
      </div>
    `;

    const apkEl = container.querySelector("#st-apk");
    const upiIdEl = container.querySelector("#st-upi-id");
    const upiNameEl = container.querySelector("#st-upi-name");
    const dayEl = container.querySelector("#st-day");
    const textEl = container.querySelector("#st-text");
    const contactTextEl = container.querySelector("#st-contact-text");
    const inputs = [apkEl, upiIdEl, upiNameEl, dayEl, textEl, contactTextEl];
    inputs.forEach(el => { el.disabled = true; });

    // Load current values. Fields stay disabled until we know them, so a slow
    // network can't have the owner overwrite a setting they never saw.
    get(ref(db, "settings")).then(snap => {
      const v = snap.val() || {};
      apkEl.value = v.apkLink || "";
      upiIdEl.value = v.upiId || "";
      upiNameEl.value = v.upiName || "";
      const day = Number(v.reminderDay) || 0;
      dayEl.value = day > 0 ? String(day) : "";
      textEl.value = v.reminderText || "";
      contactTextEl.value = v.updateContactText || "";
      inputs.forEach(el => { el.disabled = false; });
      // The blob itself is fetched separately - the settings node carries only
      // the file name so this read stays small.
      refreshQrPreview(!!(v.paymentQr && v.paymentQr.name));
    }).catch(e => {
      apkEl.placeholder = "couldn't load settings";
      console.warn("settings load failed", e);
    });

    // Digits only, max 2 - same input sanitising as the Android field.
    dayEl.addEventListener("input", () => {
      dayEl.value = dayEl.value.replace(/\D/g, "").slice(0, 2);
    });

    container.querySelector("#st-back").addEventListener("click", () => onBack?.());

    container.querySelector("#st-save-apk").addEventListener("click", async e => {
      await saving(e.currentTarget, async () => {
        await set(ref(db, "settings/apkLink"), apkEl.value.trim());
        window.showSnackbar?.("Link saved");
      });
    });

    container.querySelector("#st-save-upi").addEventListener("click", async e => {
      await saving(e.currentTarget, async () => {
        await update(ref(db, "settings"), {
          upiId: upiIdEl.value.trim(),
          upiName: upiNameEl.value.trim()
        });
        window.showSnackbar?.("UPI details saved");
      });
    });

    container.querySelector("#st-save-reminder").addEventListener("click", async e => {
      const raw = dayEl.value.trim();
      const day = raw === "" ? 0 : parseInt(raw, 10) || 0;
      if (day !== 0 && (day < 1 || day > 28)) {
        window.showSnackbar?.("Enter a day between 1 and 28");
        return;
      }
      await saving(e.currentTarget, async () => {
        await update(ref(db, "settings"), {
          reminderDay: day,
          reminderText: textEl.value.trim(),
          updateContactText: contactTextEl.value.trim()
        });
        window.showSnackbar?.("Reminder saved");
      });
    });

    // ---- QR upload / remove ----

    async function refreshQrPreview(hasQr) {
      const preview = container.querySelector("#st-qr-preview");
      const removeBtn = container.querySelector("#st-qr-remove");
      const uploadBtn = container.querySelector("#st-qr-upload");
      if (!hasQr) {
        preview.innerHTML = `<div class="qr-admin-empty">No QR uploaded — members see no pay button.</div>`;
        removeBtn.hidden = true;
        uploadBtn.textContent = "Upload QR";
        return;
      }
      uploadBtn.textContent = "Replace QR";
      removeBtn.hidden = false;
      preview.innerHTML = `<div class="qr-admin-empty">QR uploaded ✓</div>`;
      try {
        const blob = await loadPaymentQr();
        if (blob) {
          preview.innerHTML = `<img class="qr-admin-img" alt="Payment QR" src="data:image/png;base64,${blob.base64}" />`;
        }
      } catch { /* the "uploaded" line is enough */ }
    }

    container.querySelector("#st-qr-upload").addEventListener("click", async e => {
      const btn = e.currentTarget;
      const files = await pickFiles({ multiple: false, accept: ACCEPT_IMAGES });
      if (!files.length) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Uploading...";
      try {
        const att = await prepareAttachment(files[0]);
        await savePaymentQr(att);
        window.showSnackbar?.("QR uploaded");
        await refreshQrPreview(true);
      } catch (err) {
        window.showSnackbar?.(err.message || "Couldn't read that image");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    container.querySelector("#st-qr-remove").addEventListener("click", async e => {
      await saving(e.currentTarget, async () => {
        await removePaymentQr();
        window.showSnackbar?.("QR removed");
        await refreshQrPreview(false);
      }, "Couldn't remove");
    });

    container.querySelector("#st-admins").addEventListener("click", () => renderAdminsPane());
    container.querySelector("#st-support").addEventListener("click", () => renderSupportPane());

    // ---- danger zone ----

    container.querySelectorAll("[data-wipe]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const wipe = WIPES.find(w => w.id === btn.dataset.wipe);
        if (!wipe) return;
        if (!confirm(wipe.title + "\n\n" + wipe.body)) return;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Deleting...";
        try {
          // One multi-path null write, exactly as Android does it.
          await update(ref(db), wipe.paths);
          window.showSnackbar?.(wipe.done);
        } catch (err) {
          window.showSnackbar?.("Couldn't delete — try again");
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
    });
  }

  /** Disable-run-restore around a save button. */
  async function saving(btn, fn, failPrefix = "Couldn't save") {
    const original = btn.textContent;
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      window.showSnackbar?.(failPrefix + ": " + (err.message || "error"));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function renderAdminsPane() {
    if (paneTeardown) { paneTeardown(); paneTeardown = null; }
    container.innerHTML = `
      <button class="back-link" id="ad-back">&larr; Settings</button>
      <div id="admins-host"></div>
    `;
    container.querySelector("#ad-back").addEventListener("click", () => renderMain());
    paneTeardown = renderAdmins(container.querySelector("#admins-host"));
  }

  /** The ticket queue renders its own back link, so it takes the pane whole. */
  function renderSupportPane() {
    if (paneTeardown) { paneTeardown(); paneTeardown = null; }
    container.innerHTML = "";
    paneTeardown = renderSupportAdmin(container, { onBack: () => renderMain() });
  }

  renderMain();

  return function teardown() {
    if (paneTeardown) { paneTeardown(); paneTeardown = null; }
  };
}
