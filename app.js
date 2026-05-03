// Top-level web app.
//
// Flow:
//   1. observeAuth -- if no user, show sign-in card
//   2. After Google sign-in, if user could be admin (owner email or in
//      /admins), show a role picker. If only a regular member, skip picker
//      and go straight to the member shell.
//   3. After role chosen, render the matching shell (admin or member).
//   4. Bottom nav is animated between tab switches.

import { signIn, signOut, observeAuth, observeAdminEmails, isAdminEmail, isOwner } from "./auth.js";
import { ensureMemberExists } from "./members-self.js";
import { getSelectedYear, getSupportedYears, setSelectedYear } from "./year-state.js";
import { renderHome } from "./home.js";
import { renderDiscussion } from "./discussion.js";
import { renderHandover } from "./handover.js";
import { renderPayments } from "./payments.js";
import { renderMembers } from "./members.js";
import { renderAdmins } from "./admins.js";

// Tab definitions per role. Mirrors Android nav order.
const ADMIN_TABS = [
  { id: "home",       label: "Home"     },
  { id: "admins",     label: "Admins"   },
  { id: "members",    label: "Members"  },
  { id: "handover",   label: "Handover" },
  { id: "discussion", label: "Discuss"  }
];
const MEMBER_TABS = [
  { id: "home",       label: "Home"     },
  { id: "payments",   label: "Payments" },
  { id: "members",    label: "Members"  },
  { id: "discussion", label: "Discuss"  }
];

let role = null;            // "admin" | "member" | null
let currentTab = "home";
let activeTeardown = null;
let adminEmails = [];

const root = document.getElementById("app");
boot();

function boot() {
  // Subscribe to /admins so role decisions are always current.
  observeAdminEmails(emails => {
    adminEmails = emails;
    window.__adminEmails = emails;
  });

  observeAuth(user => {
    window.__currentUser = user;
    if (!user) {
      role = null;
      window.__viewerIsAdmin = false;
      renderSignIn();
      return;
    }
    // Mirror Android: every sign-in upserts /members/{uid}. New users get a
    // fresh M-XXX id; existing users get their displayName/email refreshed.
    ensureMemberExists(user).catch(e => console.warn("ensureMemberExists", e));

    const couldBeAdmin = isOwner(user.email) || isAdminEmail(user.email, adminEmails);
    if (couldBeAdmin && role === null) {
      renderRolePicker();
    } else if (!couldBeAdmin) {
      role = "member";
      window.__viewerIsAdmin = false;
      renderShell();
    } else {
      renderShell();
    }
  });
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

function renderRolePicker() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  const user = window.__currentUser;
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
    renderShell();
  });
  document.getElementById("role-member").addEventListener("click", () => {
    role = "member";
    window.__viewerIsAdmin = false;
    currentTab = "home";
    renderShell();
  });
  document.getElementById("role-signout").addEventListener("click", async () => {
    await signOut();
  });
}

function renderShell() {
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }
  const tabs = role === "admin" ? ADMIN_TABS : MEMBER_TABS;

  root.innerHTML = `
    <div class="shell">
      <div class="status-spacer"></div>
      <div class="top-bar">
        <button class="year-picker" id="year-picker" aria-label="Select year">
          <span id="year-picker-label">${getSelectedYear()}</span>
          <span class="year-picker-caret">&#x25BE;</span>
        </button>
        <button class="signout-pill" id="signout-btn">Sign out</button>
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
      renderTab(currentTab);
    });
  });

  renderTab(currentTab);
}

function renderTab(tab) {
  const container = document.getElementById("content");
  if (!container) return;
  if (activeTeardown) { activeTeardown(); activeTeardown = null; }

  container.innerHTML = `<div class="tab-anim" id="tab-anim"></div>`;
  const anim = container.querySelector("#tab-anim");

  switch (tab) {
    case "home":       activeTeardown = renderHome(anim); break;
    case "admins":     activeTeardown = renderAdmins(anim); break;
    case "members":    activeTeardown = renderMembers(anim); break;
    case "handover":   activeTeardown = renderHandover(anim); break;
    case "discussion": activeTeardown = renderDiscussion(anim); break;
    case "payments":   activeTeardown = renderPayments(anim); break;
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
