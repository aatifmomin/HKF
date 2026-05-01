// Discussion (group chat) screen.
// - live messages (limit 200, newest at bottom)
// - online presence chips
// - text bubbles + payment-request cards with Approve/Deny (admin only)
// - auto-scroll on entry, on new message (when near bottom), on input focus

import {
  getDatabase,
  ref,
  push,
  onValue,
  set,
  update,
  query,
  limitToLast,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { displayNameFor } from "./auth.js";

const db = getDatabase(firebaseApp);

function formatRupees(minor) {
  if (!minor || minor <= 0) return "\u20B90";
  const r = minor / 100;
  if (minor % 100 === 0) return "\u20B9" + Math.trunc(r).toLocaleString("en-IN");
  return "\u20B9" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTime(millis) {
  if (!millis || millis <= 0) return "";
  const now = Date.now();
  const diff = now - millis;
  const day = 24 * 60 * 60 * 1000;
  const d = new Date(millis);
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ampm = hh >= 12 ? "PM" : "AM";
  const time = (((hh + 11) % 12) + 1) + ":" + mm + " " + ampm;
  if (diff < day) return time;
  if (diff < 2 * day) return "Yesterday " + time;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " - " + time;
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderDiscussion(container) {
  const user = window.__currentUser;
  if (!user) {
    container.innerHTML = `<div class="placeholder">Sign in required.</div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="discussion-header">
      <div class="discussion-title">Discussion</div>
      <div class="discussion-online" id="presence-bar">no one online</div>
    </div>
    <div class="presence-row" id="presence-row"></div>
    <div class="messages-list" id="messages-list">
      <div class="loading"><div class="spinner"></div>Loading messages...</div>
    </div>
    <div class="composer">
      <input type="text" id="composer-input" placeholder="Type a message..." autocomplete="off" />
      <button class="composer-send" id="composer-send">Send</button>
    </div>
  `;

  const presenceBarEl = container.querySelector("#presence-bar");
  const presenceRowEl = container.querySelector("#presence-row");
  const messagesEl = container.querySelector("#messages-list");
  const inputEl = container.querySelector("#composer-input");
  const sendEl = container.querySelector("#composer-send");

  let messages = [];
  let requestCache = {};
  const requestSubs = {};
  let didInitialScroll = false;

  // Presence
  const presenceRef = ref(db, "presence/" + user.uid);
  const onlineData = {
    online: true,
    displayName: displayNameFor(user),
    email: user.email || "",
    lastChangedMillis: serverTimestamp()
  };
  const connectedRef = ref(db, ".info/connected");
  const unsubConnected = onValue(connectedRef, snap => {
    if (snap.val() === true) {
      onDisconnect(presenceRef).set({ online: false, lastChangedMillis: serverTimestamp() });
      set(presenceRef, onlineData);
    }
  });

  const presenceListRef = ref(db, "presence");
  const unsubPresence = onValue(presenceListRef, snap => {
    const val = snap.val() || {};
    const rows = Object.entries(val).map(([uid, p]) => ({ uid, ...p }));
    const online = rows.filter(p => p.online === true);
    presenceBarEl.textContent =
      online.length === 0 ? "no one online"
      : online.length === 1 ? "1 online"
      : online.length + " online";
    presenceRowEl.innerHTML = online.map(p => {
      const name = (p.displayName && p.displayName.trim()) || (p.email || "?").split("@")[0];
      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("");
      return `<div class="presence-chip"><div class="presence-dot">${escapeHtml(initials)}</div><span>${escapeHtml(name)}</span></div>`;
    }).join("");
  });

  // Messages
  const messagesQuery = query(ref(db, "messages"), limitToLast(200));
  const unsubMessages = onValue(messagesQuery, snap => {
    const val = snap.val() || {};
    messages = Object.entries(val)
      .map(([key, m]) => ({ key, ...m }))
      .sort((a, b) => (a.timestampMillis || 0) - (b.timestampMillis || 0));
    rerenderMessages();
  });

  function rerenderMessages() {
    if (messages.length === 0) {
      messagesEl.innerHTML = `<div class="empty-state">No messages yet. Be the first.</div>`;
      return;
    }

    messagesEl.innerHTML = messages.map(m => renderMessage(m, user)).join("");

    messages.forEach(m => {
      if (m.kind === "payment_request" && m.paymentRequestKey && !requestSubs[m.paymentRequestKey]) {
        const reqRef = ref(db, "paymentRequests/" + m.paymentRequestKey);
        requestSubs[m.paymentRequestKey] = onValue(reqRef, s => {
          const val = s.val();
          if (val) val.key = m.paymentRequestKey;
          requestCache[m.paymentRequestKey] = val;
          renderCardStatuses();
        });
      }
    });

    messagesEl.querySelectorAll("[data-action='approve']").forEach(btn => {
      btn.addEventListener("click", () => approveRequest(btn.dataset.requestKey));
    });
    messagesEl.querySelectorAll("[data-action='deny']").forEach(btn => {
      btn.addEventListener("click", () => denyRequest(btn.dataset.requestKey));
    });

    if (!didInitialScroll) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      didInitialScroll = true;
    } else {
      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    renderCardStatuses();
  }

  function renderCardStatuses() {
    Object.entries(requestCache).forEach(([key, req]) => {
      const card = messagesEl.querySelector(`[data-card-key="${key}"]`);
      if (!card) return;
      const statusEl = card.querySelector(".card-status");
      if (!statusEl) return;
      statusEl.innerHTML = renderCardStatusInner(req);
      card.querySelectorAll("[data-action='approve']").forEach(btn => {
        btn.addEventListener("click", () => approveRequest(btn.dataset.requestKey));
      });
      card.querySelectorAll("[data-action='deny']").forEach(btn => {
        btn.addEventListener("click", () => denyRequest(btn.dataset.requestKey));
      });
    });
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    const msgRef = push(ref(db, "messages"));
    set(msgRef, {
      senderUid: user.uid,
      senderName: displayNameFor(user),
      senderEmail: user.email || "",
      text,
      timestampMillis: serverTimestamp(),
      kind: "text",
      paymentRequestKey: ""
    }).catch(err => {
      window.showSnackbar?.("Couldn't send: " + (err.message || "error"));
      inputEl.value = text;
    });
  }

  sendEl.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener("focus", () => {
    setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 200);
  });

  async function approveRequest(requestKey) {
    if (!requestKey) return;
    const req = requestCache[requestKey];
    if (!req || req.status !== "pending") return;
    try {
      await update(ref(db, "paymentRequests/" + requestKey), {
        status: "approved",
        decidedByEmail: user.email || "",
        decidedByName: displayNameFor(user),
        decidedAtMillis: serverTimestamp()
      });
      const paymentRef = push(ref(db, "payments/" + req.memberUid));
      await set(paymentRef, {
        coversMonthKey: req.coversMonthKey,
        amountMinor: req.amountMinor,
        category: req.category || "Member contribution",
        note: "Approved request",
        recordedByEmail: user.email || "",
        recordedAtMillis: serverTimestamp(),
        dateMillis: req.requestedDateMillis || Date.now(),
        batchKey: paymentRef.key
      });
      const memberRef = ref(db, "members/" + req.memberUid);
      onValue(memberRef, snap => {
        const cur = snap.val()?.totalPaidMinor || 0;
        update(memberRef, { totalPaidMinor: cur + (req.amountMinor || 0) });
      }, { onlyOnce: true });
      window.showSnackbar?.("Approved - payment recorded");
    } catch (e) {
      window.showSnackbar?.("Couldn't approve: " + (e.message || "error"));
      update(ref(db, "paymentRequests/" + requestKey), {
        status: "pending",
        decidedByEmail: "",
        decidedByName: "",
        decidedAtMillis: 0
      });
    }
  }

  async function denyRequest(requestKey) {
    if (!requestKey) return;
    const req = requestCache[requestKey];
    if (!req || req.status !== "pending") return;
    try {
      await update(ref(db, "paymentRequests/" + requestKey), {
        status: "denied",
        decidedByEmail: user.email || "",
        decidedByName: displayNameFor(user),
        decidedAtMillis: serverTimestamp()
      });
      window.showSnackbar?.("Request denied");
    } catch (e) {
      window.showSnackbar?.("Couldn't deny: " + (e.message || "error"));
    }
  }

  return function teardown() {
    unsubConnected();
    unsubPresence();
    unsubMessages();
    Object.values(requestSubs).forEach(fn => fn && fn());
    set(presenceRef, { online: false, lastChangedMillis: serverTimestamp() }).catch(() => {});
  };
}

function renderMessage(m, user) {
  if (m.kind === "payment_request") {
    return renderPaymentCard(m);
  }
  const isOwn = m.senderUid === user.uid;
  const sideClass = isOwn ? "own" : "";
  return `
    <div class="message-row ${sideClass}">
      ${isOwn ? "" : `<div class="message-sender">${escapeHtml(m.senderName || (m.senderEmail || "").split("@")[0])}</div>`}
      <div class="bubble ${sideClass}">${escapeHtml(m.text)}</div>
      <div class="bubble-time">${escapeHtml(formatTime(m.timestampMillis))}</div>
    </div>
  `;
}

function renderPaymentCard(m) {
  return `
    <div class="payment-card" data-card-key="${escapeHtml(m.paymentRequestKey)}">
      <div class="payment-card-head">
        <div class="payment-card-icon">\u20B9</div>
        <div class="payment-card-body">
          <div class="payment-card-eyebrow">Payment request</div>
          <div class="payment-card-text">${escapeHtml(m.text || "")}</div>
        </div>
      </div>
      <div class="card-status">Loading...</div>
    </div>
  `;
}

function renderCardStatusInner(req) {
  if (!req) return `<div style="color:var(--text-3);font-size:11px">Loading...</div>`;
  const isAdmin = window.__viewerIsAdmin === true;

  if (req.status === "pending") {
    if (isAdmin) {
      return `
        <div class="card-actions">
          <button class="card-btn primary" data-action="approve" data-request-key="${escapeHtml(req.key || '')}">Approve</button>
          <button class="card-btn" data-action="deny" data-request-key="${escapeHtml(req.key || '')}">Deny</button>
        </div>
      `;
    }
    return `<div class="pill pill-amber">Waiting for admin approval</div>`;
  }
  if (req.status === "approved") {
    const by = req.decidedByName || (req.decidedByEmail || "").split("@")[0];
    return `<span class="pill pill-green">Approved</span> <span class="card-meta">by ${escapeHtml(by)}</span>`;
  }
  if (req.status === "denied") {
    const by = req.decidedByName || (req.decidedByEmail || "").split("@")[0];
    return `<span class="pill pill-red">Denied</span> <span class="card-meta">by ${escapeHtml(by)}</span>`;
  }
  return "";
}
