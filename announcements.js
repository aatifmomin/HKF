// Announcements — port of Android's AnnouncementRepository +
// AnnouncementsSheet.
//
// A bell beside the year picker with a red unread dot. Everyone reads;
// admins and the owner post one announcement at a time (title, description,
// optional image ≤ 200 KB) and delete it.
//
//   /announcements/{pushKey}
//     { title, description, imageBase64, postedByName, postedByEmail,
//       postedAtMillis }
//
// "Unread" is per-device, not per-account: Android keeps the marker in
// SharedPreferences, the web keeps it in localStorage. Neither writes it to
// the database, so reading on your phone doesn't clear the dot on the web —
// that's Android's design and the web matches it.

import {
  getDatabase,
  ref,
  onValue,
  get,
  push,
  set,
  remove
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02a";
import { pickFiles, prepareImageWithin, ACCEPT_IMAGES } from "./attachments.js?v=2026-09-02a";

const db = getDatabase(firebaseApp);

const SEEN_KEY = "hkf_announcements_seen";

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nameBeforeAt(email) {
  const s = String(email || "");
  const i = s.indexOf("@");
  return i > 0 ? s.slice(0, i) : s;
}

function whenLabel(millis) {
  if (!millis) return "";
  return new Date(millis).toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"
  });
}

export function lastSeenMillis() {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
}

export function markSeen() {
  try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* private mode */ }
}

function toAnnouncement(key, rec) {
  const r = rec || {};
  const title = typeof r.title === "string" ? r.title : null;
  if (title === null) return null;   // Android skips rows with no title
  return {
    key,
    title,
    description: String(r.description || ""),
    imageBase64: String(r.imageBase64 || ""),
    postedByName: String(r.postedByName || ""),
    postedAtMillis: Number(r.postedAtMillis) || 0
  };
}

/** Newest first. A cancelled listener reports empty rather than throwing. */
export function observeAnnouncements(callback) {
  return onValue(ref(db, "announcements"), snap => {
    const val = snap.val() || {};
    const out = Object.entries(val)
      .map(([k, rec]) => toAnnouncement(k, rec))
      .filter(Boolean)
      .sort((a, b) => b.postedAtMillis - a.postedAtMillis);
    callback(out);
  }, err => {
    console.warn("announcements listener cancelled", err);
    callback([]);
  });
}

/**
 * Null on success, otherwise a human-readable reason.
 * Single-announcement policy, same as Android: one active post at a time, so
 * the bell always means exactly one thing.
 */
export async function postAnnouncement({ title, description, imageBase64, user }) {
  if (!String(title || "").trim()) return "Title is required";
  try {
    const existing = await get(ref(db, "announcements"));
    if (existing.exists() && Object.keys(existing.val() || {}).length > 0) {
      return "Only one announcement is allowed — delete the current one first";
    }
    const email = user?.email || "";
    await set(push(ref(db, "announcements")), {
      title: String(title).trim(),
      description: String(description || "").trim(),
      imageBase64: String(imageBase64 || ""),
      postedByName: String(user?.displayName || "").trim() || nameBeforeAt(email),
      postedByEmail: email,
      postedAtMillis: Date.now()
    });
    return null;
  } catch (e) {
    return e?.message || "unknown error";
  }
}

export async function deleteAnnouncement(key) {
  if (!key) return false;
  try {
    await remove(ref(db, "announcements/" + key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mount the bell into a host element. Returns a teardown.
 * The bell is drawn as an inline SVG rather than an emoji so it renders the
 * same on every platform — the same reason Android draws it on a Canvas.
 */
export function mountAnnouncementsBell(host) {
  host.innerHTML = `
    <button class="bell-btn" id="bell-btn" title="Announcements" aria-label="Announcements">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M12 2a6 6 0 0 0-6 6c0 3.6-.9 5.3-1.7 6.2A1 1 0 0 0 5 16h14a1 1 0 0 0 .7-1.8C18.9 13.3 18 11.6 18 8a6 6 0 0 0-6-6z"/>
        <path fill="currentColor" d="M10 18a2 2 0 0 0 4 0z"/>
      </svg>
      <span class="bell-dot" id="bell-dot" hidden></span>
    </button>`;

  let latestMillis = 0;
  const dot = host.querySelector("#bell-dot");

  const unsub = observeAnnouncements(items => {
    latestMillis = items[0]?.postedAtMillis || 0;
    dot.hidden = !(latestMillis > lastSeenMillis());
  });

  host.querySelector("#bell-btn").addEventListener("click", () => {
    markSeen();
    dot.hidden = true;
    openAnnouncementsSheet();
  });

  return function teardown() { unsub(); };
}

/**
 * The sheet. Admins and the owner get "+ New" and a ✕ per card; members read.
 * Rendered live so a post or delete from another device updates in place.
 */
export function openAnnouncementsSheet() {
  const canPost = window.__viewerIsAdmin === true;
  const user = window.__currentUser;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal sheet">
      <div class="sheet-head">
        <div class="sheet-head-text">
          <div class="modal-title">Announcements</div>
          <div class="sheet-count" id="an-count">loading…</div>
        </div>
        ${canPost ? `<button class="sheet-new" id="an-new">+ New</button>` : ""}
        <button class="sheet-close" id="an-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body" id="an-list">
        <div class="loading"><div class="spinner"></div>Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let items = [];

  const unsub = observeAnnouncements(list => {
    items = list;
    render();
  });

  function close() {
    unsub();
    if (overlay.parentNode) document.body.removeChild(overlay);
  }
  overlay.querySelector("#an-close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  function render() {
    overlay.querySelector("#an-count").textContent = items.length + " posted";
    const host = overlay.querySelector("#an-list");
    host.innerHTML = items.length
      ? items.map(card).join("")
      : `<div class="attach-empty">No announcements yet.</div>`;

    host.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const a = items.find(x => x.key === btn.dataset.del);
        if (!a) return;
        if (!confirm(`Delete announcement?\n\n"${a.title}" will be removed for everyone. This cannot be undone.`)) return;
        btn.disabled = true;
        const ok = await deleteAnnouncement(a.key);
        if (!ok) { btn.disabled = false; window.showSnackbar?.("Couldn't delete — try again"); }
      });
    });

    const newBtn = overlay.querySelector("#an-new");
    if (newBtn) {
      // One at a time: the button stays but says why it's unavailable, which
      // is exactly what Android does rather than hiding it.
      newBtn.classList.toggle("blocked", items.length > 0);
    }
  }

  overlay.querySelector("#an-new")?.addEventListener("click", () => {
    if (items.length > 0) {
      window.showSnackbar?.("Only one announcement is allowed — delete the current one (✕) first");
      return;
    }
    openPostDialog(user);
  });

  function card(a) {
    return `
      <div class="announce-card">
        ${a.imageBase64 ? `<img class="announce-img" alt="" src="data:image/jpeg;base64,${a.imageBase64}" />` : ""}
        <div class="announce-body">
          <div class="announce-head">
            <span class="announce-title">${escapeHtml(a.title)}</span>
            ${canPost ? `<button class="ticket-delete" type="button" data-del="${escapeHtml(a.key)}" title="Delete">✕</button>` : ""}
          </div>
          ${a.description ? `<div class="announce-desc">${escapeHtml(a.description)}</div>` : ""}
          <div class="announce-meta">${escapeHtml(a.postedByName)} · ${escapeHtml(whenLabel(a.postedAtMillis))}</div>
        </div>
      </div>`;
  }

  render();
}

function openPostDialog(user) {
  let image = null;   // { name, base64, sizeBytes }

  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <div class="modal-title">New announcement</div>
      <div class="modal-body">
        <label class="field">
          <span>Title *</span>
          <input type="text" id="an-title" />
        </label>
        <label class="field">
          <span>Description</span>
          <textarea id="an-desc" rows="3"></textarea>
        </label>
        <div class="field">
          <span>Image</span>
          <div class="attach-box">
            <div class="attach-head">
              <button class="attach-btn" type="button" id="an-attach">+ Attach image</button>
              <span class="attach-hint">Optional &middot; compressed to &le; 200 KB</span>
            </div>
            <div id="an-preview" class="attach-list"></div>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn" id="an-cancel">Cancel</button>
        <button class="modal-btn primary" id="an-post">Post</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);

  function close() { if (dialog.parentNode) document.body.removeChild(dialog); }
  dialog.querySelector("#an-cancel").addEventListener("click", close);
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  function renderPreview() {
    const el = dialog.querySelector("#an-preview");
    if (!image) {
      el.innerHTML = `<div class="attach-empty">No image attached.</div>`;
      return;
    }
    el.innerHTML = `
      <img class="announce-preview" alt="Preview" src="data:image/jpeg;base64,${image.base64}" />
      <div class="attach-item staged">
        <span class="doc-kind">IMG</span>
        <span class="doc-name">${escapeHtml(image.name)}</span>
        <button class="doc-btn danger" type="button" id="an-img-remove">Remove</button>
      </div>`;
    el.querySelector("#an-img-remove").addEventListener("click", () => { image = null; renderPreview(); });
  }
  renderPreview();

  dialog.querySelector("#an-attach").addEventListener("click", async e => {
    const btn = e.currentTarget;
    const files = await pickFiles({ multiple: false, accept: ACCEPT_IMAGES });
    if (!files.length) return;
    btn.disabled = true;
    btn.textContent = "Compressing…";
    try {
      image = await prepareImageWithin(files[0]);
      renderPreview();
    } catch (err) {
      window.showSnackbar?.(err.message || "Couldn't read that image");
    } finally {
      btn.disabled = false;
      btn.textContent = image ? "Replace image" : "+ Attach image";
    }
  });

  dialog.querySelector("#an-post").addEventListener("click", async e => {
    const btn = e.currentTarget;
    const title = dialog.querySelector("#an-title").value;
    if (!title.trim()) { window.showSnackbar?.("Title is required"); return; }
    btn.disabled = true;
    btn.textContent = "Posting…";
    const err = await postAnnouncement({
      title,
      description: dialog.querySelector("#an-desc").value,
      imageBase64: image?.base64 || "",
      user
    });
    if (err) {
      btn.disabled = false;
      btn.textContent = "Post";
      window.showSnackbar?.("Couldn't post: " + err);
      return;
    }
    close();
    window.showSnackbar?.("Announcement posted");
  });
}
