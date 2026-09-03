// Top-level web app.
//
// Flow:
//   1. observeAuth -- if no user, show sign-in card
//   2. Resolve membership. A brand-new account is NOT a member yet: it goes
//      into /joinRequests and sees the "Pending approval" screen until an
//      admin decides. Approval arrives over a live listener, so they enter
//      the app without signing out and back in.
//   3. If the (now) member could be an admin (owner email or in /admins),
//      show the role picker. Regular members skip straight to their shell.
//   4. Bottom nav is animated between tab switches.

import { signIn, signOut, observeAuth, observeAdminEmails, isAdminEmail, isOwner, displayNameFor } from "./auth.js?v=2026-09-02c";
import {
  resolveMembership,
  observeMembership,
  requestJoinAgain,
  MEMBERSHIP_MEMBER,
  MEMBERSHIP_PENDING,
  MEMBERSHIP_DECLINED
} from "./members-self.js?v=2026-09-02c";
import { getSelectedYear, getSupportedYears, setSelectedYear } from "./year-state.js?v=2026-09-02c";
import { renderHome } from "./home.js?v=2026-09-02c";
import { renderActivity, observeNewestPending } from "./activity.js?v=2026-09-02c";
import { renderHandover } from "./handover.js?v=2026-09-02c";
import { renderPayments } from "./payments.js?v=2026-09-02c";
import { renderMembers } from "./members.js?v=2026-09-02c";
import { renderProfile } from "./profile.js?v=2026-09-02c";
import { renderSupport } from "./support.js?v=2026-09-02c";
import { renderReminder } from "./reminder.js?v=2026-09-02c";
import { renderSettings } from "./settings.js?v=2026-09-02c";
import { renderCollections } from "./collectors.js?v=2026-09-02c";
import { mountAnnouncementsBell } from "./announcements.js?v=2026-09-02c";
import { BUILD_ID } from "./version.js?v=2026-09-02c";

// Tab definitions per role. Mirrors Android nav order. Members no longer have
// a Discussion tab at all - the chat is gone, and the Activity feed that
// replaced it is an admin tool.
// Order mirrors Android's AdminDestination. There is no Admins tab any more:
// admin management moved inside Settings, behind the gear on Home.
const ADMIN_TABS = [
  { id: "home",     label: "Home"     },
  { id: "members",  label: "Members"  },
  { id: "handover", label: "Handover" },
  { id: "activity", label: "Activity" },
  { id: "reminder", label: "Reminder" }
];
// The member's third tab is their own record, so it's labelled Profile - the
// id stays "members" to match Android's unchanged route.
const MEMBER_TABS = [
  { id: "home",     label: "Home"     },
  { id: "payments", label: "Payments" },
  { id: "members",  label: "Profile"  },
  { id: "support",  label: "Support"  }
];

let role = null;            // "admin" | "member" | null
let currentTab = "home";
let activeTeardown = null;
let adminEmails = [];
let currentUser = null;
let membership = null;      // { status, request? }
let unsubMembership = null;
let currentScreen = null;   // "signin" | "loading" | "pending" | "declined" | "role" | "shell"
let bellTeardown = null;
let unsubActivityBadge = null;

// Activity tab red dot. Android compares the newest PENDING item against a
// marker in SharedPreferences; the web does the same against localStorage, so
// the dot is per-device on both clients and neither writes it to the database.
const ACTIVITY_SEEN_KEY = "hkf_activity_seen";
function activitySeenAt() {
  try { return Number(localStorage.getItem(ACTIVITY_SEEN_KEY)) || 0; } catch { return 0; }
}
function markActivitySeen() {
  try { localStorage.setItem(ACTIVITY_SEEN_KEY, String(Date.now())); } catch { /* private mode */ }
}

const root = document.getElementById("app");

// Printed so "am I actually looking at the new build?" is answerable in one
// glance at the console, without digging through Sources.
console.log("%cHKF web build " + BUILD_ID, "color:#9A6A1F;font-weight:bold");

boot();

function boot() {
  // Subscribe to /admins so role decisions are always current.
  observeAdminEmails(emails => {
    adminEmails = emails;
    window.__adminEmails = emails;
    // The admin list often lands after the first auth callback. Re-evaluate
    // so someone who was just granted admin still gets the role picker.
    applyState();
  });

  observeAuth(user => {
    currentUser = user;
    window.__currentUser = user;

    if (unsubMembership) { unsubMembership(); unsubMembership = null; }

    if (!user) {
      role = null;
      membership = null;
      window.__viewerIsAdmin = false;
      applyState();
      return;
    }

    membership = null;
    applyState();   // shows the "checking access" card while we look

    // One-shot resolution creates the join request for first-time users; the
    // live observer then keeps us in sync with the admin's decision.
    resolveMembership(user)
      .then(result => { membership = result; applyState(); })
      .catch(e => {
        console.error("membership check failed", e);
        membership = { status: MEMBERSHIP_PENDING, error: e?.message || "" };
        applyState();
      });

    unsubMembership = observeMembership(user, result => {
      const prev = membership?.status;
      membership = result;
      // Entering the app for the first time should always land on Home.
      if (prev && prev !== MEMBERSHIP_MEMBER && result.status === MEMBERSHIP_MEMBER) {
        currentTab = "home";
      }
      applyState();
    });
  });
}

/**
 * Single place that decides which screen the user should be looking at.
 * Re-renders only when the screen actually changes, so live database updates
 * don't wipe out the tab the user is sitting on.
 */
function applyState() {
  if (!currentUser) {
    showScreen("signin", renderSignIn);
    return;
  }
  if (!membership) {
    showScreen("loading", renderCheckingAccess);
    return;
  }
  if (membership.status === MEMBERSHIP_DECLINED) {
    showScreen("declined", renderDeclined);
    return;
  }
  if (membership.status !== MEMBERSHIP_MEMBER) {
    showScreen("pending", renderPendingApproval);
    return;
  }

  const couldBeAdmin = isOwner(currentUser.email) || isAdminEmail(currentUser.email, adminEmails);
  if (couldBeAdmin && role === null) {
    showScreen("role", renderRolePicker);
    return;
  }
  if (!couldBeAdmin) {
    role = "member";
    window.__viewerIsAdmin = false;
  }
  showScreen("shell", renderShell);
}

function showScreen(name, renderFn) {
  // The shell manages its own updates once mounted; re-rendering it on every
  // database echo would throw the user back to whichever tab they started on.
  if (currentScreen === name) return;
  // Leaving the shell throws away the top bar, so its listeners have to go
  // with it — otherwise signing out leaves the bell subscribed to a node the
  // signed-out user can no longer read.
  if (currentScreen === "shell") releaseShellListeners();
  currentScreen = name;
  renderFn();
}

function releaseShellListeners() {
  if (bellTeardown) { bellTeardown(); bellTeardown = null; }
  if (unsubActivityBadge) { unsubActivityBadge(); unsubActivityBadge = null; }
}

/** Force the shell to (re)mount - used after the role picker. */
function rerenderShell() {
  currentScreen = "shell";
  renderShell();
}

function renderSignIn() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  root.innerHTML = `
    <div class="shell">
      <div class="signin-screen">
        <div class="signin-card">
          <img class="logo-img" src="Logo.png" alt="HKF logo" />
          <div class="signin-title">Hasnain Karimain Foundation</div>
          <div class="signin-subtitle">Sign in to continue</div>
          <button class="gold-button" id="signin-btn">Continue with Google</button>
          <div id="signin-error" style="margin-top:14px;color:var(--red-fg);font-size:12px;"></div>
          <div class="build-stamp">build ${escapeHtml(BUILD_ID)}</div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("signin-btn").addEventListener("click", async () => {
    const errEl = document.getElementById("signin-error");
    errEl.textContent = "";
    try {
      const u = await signIn();
      if (!u) return;
    } catch (e) {
      errEl.textContent = e?.message || "Sign in failed.";
    }
  });
}

function renderCheckingAccess() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  root.innerHTML = `
    <div class="shell">
      <div class="signin-screen">
        <div class="signin-card">
          <img class="logo-img" src="Logo.png" alt="HKF logo" />
          <div class="signin-title">Checking access</div>
          <div class="loading" style="padding:18px 0;"><div class="spinner"></div>One moment...</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Gate screen for someone whose join request hasn't been decided yet. No tab
 * is reachable from here. When an admin approves, observeMembership fires and
 * applyState swaps this out for the member shell mid-session.
 */
function renderPendingApproval() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  const user = currentUser;
  root.innerHTML = `
    <div class="shell">
      <div class="signin-screen">
        <div class="signin-card">
          <img class="logo-img" src="Logo.png" alt="HKF logo" />
          <div class="gate-badge gate-badge-pending">Awaiting approval</div>
          <div class="signin-title">Pending approval to join</div>
          <div class="signin-subtitle">
            Your request has gone to the foundation admins. You'll get access
            as soon as someone approves it - this page updates on its own, so
            there's no need to sign in again.
          </div>
          <div class="gate-identity">
            <div class="gate-identity-name">${escapeHtml(displayNameFor(user))}</div>
            <div class="gate-identity-email">${escapeHtml(user?.email || "")}</div>
          </div>
          <div class="gate-pulse"><span></span><span></span><span></span></div>
          <button class="link-btn" id="gate-signout">Sign out</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("gate-signout").addEventListener("click", () => signOut());
}

/** Gate screen after an admin discards the request. */
function renderDeclined() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  const user = currentUser;
  const decidedBy = membership?.request?.decidedByName || "";
  root.innerHTML = `
    <div class="shell">
      <div class="signin-screen">
        <div class="signin-card">
          <img class="logo-img" src="Logo.png" alt="HKF logo" />
          <div class="gate-badge gate-badge-declined">Not approved</div>
          <div class="signin-title">Request declined</div>
          <div class="signin-subtitle">
            Your request to join wasn't approved${decidedBy ? " by " + escapeHtml(decidedBy) : ""}.
            If you think that's a mistake, you can send it again.
          </div>
          <div class="gate-identity">
            <div class="gate-identity-name">${escapeHtml(displayNameFor(user))}</div>
            <div class="gate-identity-email">${escapeHtml(user?.email || "")}</div>
          </div>
          <button class="gold-button" id="gate-again">Request again</button>
          <div style="height:14px;"></div>
          <button class="link-btn" id="gate-signout">Sign out</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("gate-again").addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      await requestJoinAgain(currentUser);
      window.showSnackbar?.("Request sent again");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Request again";
      window.showSnackbar?.("Couldn't send: " + (err.message || "error"));
    }
  });
  document.getElementById("gate-signout").addEventListener("click", () => signOut());
}

function renderRolePicker() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  const user = currentUser;
  root.innerHTML = `
    <div class="shell">
      <div class="signin-screen">
        <div class="signin-card">
          <img class="logo-img" src="Logo.png" alt="HKF logo" />
          <div class="signin-title">Choose role</div>
          <div class="signin-subtitle">Signed in as ${escapeHtml(user.email || "")}</div>
          <button class="gold-button" id="role-admin">Continue as Admin</button>
          <div style="height:10px;"></div>
          <button class="gold-button-outline" id="role-member" style="width:100%">Continue as Member</button>
          <div style="height:14px;"></div>
          <button class="link-btn" id="role-signout">Sign out</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("role-admin").addEventListener("click", () => {
    role = "admin";
    window.__viewerIsAdmin = true;
    currentTab = "home";
    rerenderShell();
  });
  document.getElementById("role-member").addEventListener("click", () => {
    role = "member";
    window.__viewerIsAdmin = false;
    currentTab = "home";
    rerenderShell();
  });
  document.getElementById("role-signout").addEventListener("click", async () => {
    await signOut();
  });
}

function renderShell() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  const tabs = role === "admin" ? ADMIN_TABS : MEMBER_TABS;
  if (!tabs.some(t => t.id === currentTab)) currentTab = "home";

  root.innerHTML = `
    <div class="shell">
      <div class="status-spacer"></div>
      <div class="top-bar">
        <div class="top-bar-left">
          <button class="year-picker" id="year-picker" aria-label="Select year">
            <span id="year-picker-label">${getSelectedYear()}</span>
            <span class="year-picker-caret">&#x25BE;</span>
          </button>
          <span class="bell-host" id="bell-host"></span>
        </div>
        <div class="top-bar-right">
          ${role === "admin" && isOwner(currentUser?.email)
            ? `<button class="gear-pill" id="settings-btn" title="Settings" aria-label="Settings">&#x2699;</button>`
            : ""}
          <button class="signout-pill" id="signout-btn">Sign out</button>
        </div>
      </div>
      <div class="content" id="content"></div>
      <div class="bottom-nav" id="bottom-nav">
        ${tabs.map(t => `
          <div class="nav-item ${t.id === currentTab ? 'active' : ''}" data-tab="${t.id}">
            ${escapeHtml(t.label)}
          </div>
        `).join("")}
      </div>
    </div>
  `;

  document.getElementById("signout-btn").addEventListener("click", async () => {
    await signOut();
    role = null;
    window.__viewerIsAdmin = false;
    currentTab = "home";
  });

  document.getElementById("settings-btn")?.addEventListener("click", () => window.__openSettings());

  // Announcements bell. Android hangs it off Home beside the year picker; the
  // web top bar is shared by every tab, so it lives there and is reachable
  // from anywhere. Same node, same unread rule.
  if (bellTeardown) { bellTeardown(); bellTeardown = null; }
  const bellHost = document.getElementById("bell-host");
  if (bellHost) bellTeardown = mountAnnouncementsBell(bellHost);

  if (unsubActivityBadge) { unsubActivityBadge(); unsubActivityBadge = null; }
  if (role === "admin") unsubActivityBadge = watchActivityBadge();

  // Year picker: tap opens a small popover with the supported years
  document.getElementById("year-picker").addEventListener("click", e => {
    e.stopPropagation();
    openYearPickerPopover(e.currentTarget);
  });

  document.querySelectorAll(".nav-item").forEach(el => {
    el.addEventListener("click", () => {
      if (el.dataset.tab === currentTab) return;
      document.querySelectorAll(".nav-item").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
      currentTab = el.dataset.tab;
      if (currentTab === "activity") clearActivityBadge();
      renderTab(currentTab);
    });
  });

  if (currentTab === "activity") clearActivityBadge();
  renderTab(currentTab);
}

/**
 * Red dot on the Activity tab whenever something pending is newer than the
 * last time this device opened the tab.
 */
function watchActivityBadge() {
  return observeNewestPending(newest => {
    const el = document.querySelector('.nav-item[data-tab="activity"]');
    if (!el) return;
    el.classList.toggle("has-dot", newest > activitySeenAt() && currentTab !== "activity");
  });
}

function clearActivityBadge() {
  markActivitySeen();
  document.querySelector('.nav-item[data-tab="activity"]')?.classList.remove("has-dot");
}

/** Switch tabs programmatically, keeping the nav highlight in sync. */
function goToTab(tab) {
  currentTab = tab;
  if (tab === "activity") clearActivityBadge();
  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  renderTab(tab);
}

// Home's gear calls this. Only wired for an owner viewing as admin, which is
// the same gate Android uses.
// Home's MY COLLECTIONS card calls this. Admin-only, like Android's
// showCollections branch in AppScaffold.
window.__openCollections = function () {
  if (role !== "admin") return;
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
  currentTab = "collections";
  renderTab("collections");
};

// Home's TECH SUPPORT card calls this. Android moved the admin's own
// ticket screen onto Home because its nav bar is full; the web nav is too.
window.__openSupport = function () {
  if (role !== "admin") return;
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
  currentTab = "support";
  renderTab("support");
};

window.__openSettings = function () {
  if (role !== "admin") return;
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
  currentTab = "settings";
  renderTab("settings");
};

function renderTab(tab) {
  const container = document.getElementById("content");
  if (!container) return;
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }

  container.innerHTML = `<div class="tab-anim" id="tab-anim"></div>`;
  const anim = container.querySelector("#tab-anim");

  switch (tab) {
    case "home":     activeTeardown = renderHome(anim); break;
    case "members":
      // Same tab id, two different screens: admins get the directory, a member
      // gets their own editable profile.
      activeTeardown = (role === "admin") ? renderMembers(anim) : renderProfile(anim);
      break;
    case "handover": activeTeardown = renderHandover(anim); break;
    case "activity": activeTeardown = renderActivity(anim); break;
    case "reminder": activeTeardown = renderReminder(anim); break;
    case "support":  activeTeardown = renderSupport(anim); break;
    case "payments": activeTeardown = renderPayments(anim); break;
    case "collections":
      activeTeardown = renderCollections(anim, { onBack: () => goToTab("home") });
      break;
    case "settings":
      // Not a tab: Settings takes over the content area and offers a back
      // link. The bottom nav stays visible so the user is never stranded.
      activeTeardown = renderSettings(anim, { onBack: () => goToTab("home") });
      break;
    default:
      anim.innerHTML = `<div class="placeholder"><strong>Coming soon</strong>This tab is not built yet.</div>`;
  }
}

window.showSnackbar = function (text) {
  const existing = document.querySelector(".snackbar");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "snackbar";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
};

/**
 * Show the year-picker popover anchored to the picker button. One option per
 * supported year. Click outside to dismiss. Selecting a year updates the
 * shared state and refreshes the visible label; subscribed screens re-render
 * automatically via their onYearChange listeners.
 */
function openYearPickerPopover(anchorBtn) {
  const existing = document.querySelector(".year-popover");
  if (existing) { existing.remove(); return; }

  const current = getSelectedYear();
  const popover = document.createElement("div");
  popover.className = "year-popover";
  popover.innerHTML = getSupportedYears().map(y => `
    <button class="year-option ${y === current ? 'active' : ''}" data-year="${y}">${y}</button>
  `).join("");
  document.body.appendChild(popover);

  // Anchor below the button
  const rect = anchorBtn.getBoundingClientRect();
  popover.style.top = (rect.bottom + 4) + "px";
  popover.style.left = rect.left + "px";

  popover.querySelectorAll(".year-option").forEach(opt => {
    opt.addEventListener("click", e => {
      e.stopPropagation();
      const y = parseInt(opt.dataset.year, 10);
      setSelectedYear(y);
      // Update the visible label on the picker button
      const lbl = document.getElementById("year-picker-label");
      if (lbl) lbl.textContent = y;
      popover.remove();
    });
  });

  // Click outside to close
  setTimeout(() => {
    document.addEventListener("click", function onDocClick() { popover.remove(); }, { once: true });
  }, 0);
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
