// Settings - owner only, reached from the gear on Home.
//
// Port of Android's SettingsScreen. Not a nav tab on either client: it takes
// over the content area and offers a back link. Admin management lives inside
// it (it used to be its own tab).
//
// Everything here writes to /settings, which both clients read:
//   apkLink           - the Android APK download link, shared with the card
//   websiteLink       - the public site, shared alongside the app link
//   bankDetails       - the foundation's own account, for "pay HKF directly"
//   upiId / upiName   - powers the member's tap-to-pay button
//   paymentQr         - { name, base64 }, the QR image members scan
//   reminderDay       - 1-28, or 0 for off
//   reminderText      - the SMS / banner message for unpaid members
//   updateContactText - the nudge shown to members with no contact number
//   appLatestVersion / appUpdateNotes / appUpdateEnabled
//                     - the Android update card shown on everyone's Home

import {
  getDatabase,
  ref,
  get,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02b";
import { isOwner } from "./auth.js?v=2026-09-02b";
import { BUILD_ID } from "./version.js?v=2026-09-02b";
import { renderAdmins } from "./admins.js?v=2026-09-02b";
import { renderSupportAdmin } from "./support.js?v=2026-09-02b";
import {
  discoverYears,
  sliceYear,
  toBackupJson,
  parseBackup,
  restore,
  resetSlice,
  deletePaths,
  recomputeAllMemberTotals
} from "./year-data.js?v=2026-09-02b";
import { DEFAULT_REMINDER_MESSAGE, DEFAULT_CONTACT_MESSAGE } from "./reminder.js?v=2026-09-02b";
import {
  pickFiles,
  prepareAttachment,
  savePaymentQr,
  removePaymentQr,
  loadPaymentQr,
  ACCEPT_IMAGES
} from "./attachments.js?v=2026-09-02b";

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
        <div class="settings-help">Both links go out with every member's share card.</div>
        <label class="field">
          <span>APK / app link</span>
          <input type="text" id="st-apk" placeholder="https://..." />
        </label>
        <label class="field">
          <span>Website link</span>
          <input type="text" id="st-website" placeholder="https://hasnainkarimain.org" />
        </label>
        <button class="modal-btn primary settings-save" id="st-save-apk">Save links</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">FOUNDATION ACCOUNT (PAY HKF DIRECTLY)</div>
        <div class="settings-help">
          Members can pay a collector admin — each admin sets their own QR in
          My Collections — or pay the foundation directly using the details
          below. Bank details are shown with tap-to-copy; the UPI ID and QR are
          optional and enable tap-to-pay. No amount is ever pre-filled.
        </div>
        <label class="field">
          <span>Bank details (name, account no., IFSC, bank)</span>
          <textarea id="st-bank" rows="4"></textarea>
        </label>
        <button class="modal-btn primary settings-save" id="st-save-bank">Save bank details</button>
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

      <div class="settings-section">
        <div class="settings-label">ANDROID APP UPDATE</div>
        <div class="settings-help">
          This controls the <strong>phone app only</strong> — the website
          always serves the newest build, so nothing here changes what you're
          looking at now. Upload the new APK to the app link above, enter the
          version and what's new, and switch this on: Android members whose
          phone is on an older version get an update card on their Home with a
          download button. Switch off to hide it. Nobody is ever blocked.
        </div>
        <label class="field">
          <span>Latest version (e.g. 1.1)</span>
          <input type="text" id="st-app-version" placeholder="1.1" />
        </label>
        <label class="field">
          <span>What's new (optional)</span>
          <textarea id="st-app-notes" rows="2"></textarea>
        </label>
        <label class="toggle-field">
          <span class="toggle-text">
            <span class="toggle-title">Show update in the Android app</span>
            <span class="toggle-sub" id="st-app-state">Hidden</span>
          </span>
          <input type="checkbox" id="st-app-enabled" />
        </label>
        <button class="modal-btn primary settings-save" id="st-save-app">Save update info</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">RESET &middot; BACKUP &middot; RESTORE (BY YEAR)</div>
        <div class="settings-help">
          Year-wise data management: payments, requests with proofs, handovers
          with documents, and collector transfers. Members, admins, collector
          profiles and settings are never touched.
        </div>
        <div class="coll-actions">
          <button class="modal-btn settings-save" id="st-backup">Backup year…</button>
          <button class="modal-btn settings-save" id="st-restore">Restore…</button>
        </div>
        <button class="modal-btn destructive settings-save" id="st-reset">Reset year…</button>
        <div class="settings-help" id="st-year-busy"></div>
      </div>

      <div class="settings-section danger">
        <div class="settings-label">DANGER ZONE</div>
        <div class="settings-help">
          Each button permanently deletes that entire section from the database.
          There is no undo — take a Backup year… above first, or export from the
          Firebase Console.
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
    const websiteEl = container.querySelector("#st-website");
    const bankEl = container.querySelector("#st-bank");
    const appVersionEl = container.querySelector("#st-app-version");
    const appNotesEl = container.querySelector("#st-app-notes");
    const appEnabledEl = container.querySelector("#st-app-enabled");
    const upiIdEl = container.querySelector("#st-upi-id");
    const upiNameEl = container.querySelector("#st-upi-name");
    const dayEl = container.querySelector("#st-day");
    const textEl = container.querySelector("#st-text");
    const contactTextEl = container.querySelector("#st-contact-text");
    const inputs = [apkEl, websiteEl, bankEl, upiIdEl, upiNameEl, dayEl, textEl,
                    contactTextEl, appVersionEl, appNotesEl, appEnabledEl];
    inputs.forEach(el => { el.disabled = true; });

    // Load current values. Fields stay disabled until we know them, so a slow
    // network can't have the owner overwrite a setting they never saw.
    get(ref(db, "settings")).then(snap => {
      const v = snap.val() || {};
      apkEl.value = v.apkLink || "";
      websiteEl.value = v.websiteLink || "";
      bankEl.value = v.bankDetails || "";
      appVersionEl.value = v.appLatestVersion || "";
      appNotesEl.value = v.appUpdateNotes || "";
      appEnabledEl.checked = v.appUpdateEnabled === true;
      refreshAppState();
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
        await update(ref(db, "settings"), {
          apkLink: apkEl.value.trim(),
          websiteLink: websiteEl.value.trim()
        });
        window.showSnackbar?.("Links saved");
      });
    });

    container.querySelector("#st-save-bank").addEventListener("click", async e => {
      await saving(e.currentTarget, async () => {
        await set(ref(db, "settings/bankDetails"), bankEl.value.trim());
        window.showSnackbar?.("Bank details saved");
      });
    });

    function refreshAppState() {
      container.querySelector("#st-app-state").textContent =
        appEnabledEl.checked ? "Visible to Android users on an older version" : "Hidden";
    }
    appEnabledEl.addEventListener("change", refreshAppState);

    container.querySelector("#st-save-app").addEventListener("click", async e => {
      await saving(e.currentTarget, async () => {
        await update(ref(db, "settings"), {
          appLatestVersion: appVersionEl.value.trim(),
          appUpdateNotes: appNotesEl.value.trim(),
          appUpdateEnabled: appEnabledEl.checked
        });
        window.showSnackbar?.(appEnabledEl.checked
          ? "Saved — update card is live"
          : "Saved — update card hidden");
      });
    });

    wireYearData();

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

  /**
   * Year backup / restore / reset. Android reads and writes real files
   * through the storage-access framework; the browser downloads a Blob and
   * takes an <input type=file> back. The JSON is byte-identical, so a backup
   * taken on the phone restores from the web and vice versa.
   */
  function wireYearData() {
    const busyEl = container.querySelector("#st-year-busy");
    const setBusy = t => { busyEl.textContent = t || ""; };

    async function pickYear(title) {
      setBusy("Finding years…");
      const years = await discoverYears();
      setBusy("");
      if (!years.length) { window.showSnackbar?.("No year data found"); return null; }
      return new Promise(resolve => {
        const dialog = document.createElement("div");
        dialog.className = "modal-overlay";
        dialog.innerHTML = `
          <div class="modal">
            <div class="modal-title">${escapeHtml(title)}</div>
            <div class="modal-body">
              ${years.map(y => `<button class="choice-row" type="button" data-year="${y}">
                <span class="choice-text"><span class="choice-title">${y}</span></span>
                <span class="choice-caret">&rsaquo;</span>
              </button>`).join("")}
            </div>
            <div class="modal-actions"><button class="modal-btn" id="yp-cancel">Cancel</button></div>
          </div>`;
        document.body.appendChild(dialog);
        const close = value => { document.body.removeChild(dialog); resolve(value); };
        dialog.querySelector("#yp-cancel").addEventListener("click", () => close(null));
        dialog.addEventListener("click", e => { if (e.target === dialog) close(null); });
        dialog.querySelectorAll("[data-year]").forEach(btn => {
          btn.addEventListener("click", () => close(parseInt(btn.dataset.year, 10)));
        });
      });
    }

    container.querySelector("#st-backup").addEventListener("click", async () => {
      const year = await pickYear("Backup which year?");
      if (!year) return;
      setBusy("Collecting " + year + " data…");
      try {
        const slice = await sliceYear(year);
        if (slice.totalCount === 0) { window.showSnackbar?.("No data found for " + year); return; }
        const json = JSON.stringify(toBackupJson(year, slice));
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "hkf-backup-" + year + ".json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        window.showSnackbar?.(`Backup saved — ${slice.totalCount} records from ${year}`);
      } catch (e) {
        window.showSnackbar?.("Backup failed: " + (e.message || "error"));
      } finally {
        setBusy("");
      }
    });

    container.querySelector("#st-restore").addEventListener("click", async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        setBusy("Reading backup file…");
        let parsed;
        try {
          parsed = parseBackup(JSON.parse(await file.text()));
        } catch (e) {
          setBusy("");
          window.showSnackbar?.("Not a valid HKF backup: " + (e.message || "unreadable file"));
          return;
        }
        setBusy("");
        const count = Object.keys(parsed.paths).length;
        const ok = confirm(
          `Restore ${parsed.year} data?\n\n${count} records from the backup of ` +
          `${parsed.year} will be written back. Existing entries with the same IDs ` +
          `are overwritten; everything else stays untouched.`
        );
        if (!ok) return;
        setBusy("Restoring " + parsed.year + "…");
        try {
          const n = await restore(parsed.paths);
          setBusy("Recalculating member totals…");
          await recomputeAllMemberTotals();
          window.showSnackbar?.(`Restored ${n} records for ${parsed.year}`);
        } catch (e) {
          window.showSnackbar?.("Restore failed: " + (e.message || "error"));
        } finally {
          setBusy("");
        }
      });
      input.click();
    });

    container.querySelector("#st-reset").addEventListener("click", async () => {
      const year = await pickYear("Reset which year?");
      if (!year) return;
      setBusy("Collecting " + year + " data…");
      let slice;
      try {
        slice = await resetSlice(year);
      } catch (e) {
        setBusy("");
        window.showSnackbar?.("Couldn't read the data: " + (e.message || "error"));
        return;
      }
      setBusy("");
      if (slice.totalCount === 0) { window.showSnackbar?.("Nothing to reset"); return; }

      // Reset is wider than backup on purpose (Android's own definition):
      // that year's payments, but ALL handovers and ALL activity. Spell it
      // out, then make them type the year — this is the one action here with
      // no undo and no backup implied.
      const typed = prompt(
        `Delete ALL ${year} data?\n\n` +
        `This will permanently delete: ${slice.paymentCount} payments of ${year}, ` +
        `ALL ${slice.handoverCount} handovers with their documents (numbering ` +
        `restarts at H-001), and ALL activity — ${slice.requestCount} payment ` +
        `requests with ${slice.proofCount} proofs and ${slice.joinCount} join ` +
        `requests. Members and other years' payments stay. Take a backup first. ` +
        `There is no undo.\n\nType ${year} to confirm:`
      );
      if (String(typed || "").trim() !== String(year)) {
        if (typed !== null) window.showSnackbar?.("Reset cancelled — the year didn't match");
        return;
      }
      setBusy("Deleting " + year + "…");
      try {
        const n = await deletePaths(slice.paths);
        setBusy("Recalculating member totals…");
        await recomputeAllMemberTotals();
        window.showSnackbar?.(`Reset done (${n} records removed)`);
      } catch (e) {
        window.showSnackbar?.("Delete failed: " + (e.message || "error"));
      } finally {
        setBusy("");
      }
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
