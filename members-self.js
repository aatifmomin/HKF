// Membership gate. Replaces the old auto-join with the same approval flow as
// Android: existing members and admin-pre-registered emails pass through;
// brand-new sign-ins write /joinRequests/{uid} and wait on a full-screen
// overlay until an admin approves (live — no re-login needed).
//
// Drop-in: exports the same ensureMemberExists(user) that app.js already
// awaits. The promise now resolves only once the user is APPROVED; while
// waiting, this module renders its own blocking overlay.

import {
  getDatabase, ref, get, set, update, remove, onValue,
  serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

export async function ensureMemberExists(user) {
  const uid = user.uid;
  const email = (user.email || "").toLowerCase();
  const name = user.displayName || "";

  // 1. Already a member -> sync name/email, done.
  const meSnap = await get(ref(db, "members/" + uid));
  if (meSnap.exists()) {
    const cur = meSnap.val() || {};
    const patch = {};
    if (name && cur.displayName !== name) patch.displayName = name;
    if (email && cur.email !== email) { patch.email = email; patch.emailLower = email; }
    if (Object.keys(patch).length) await update(ref(db, "members/" + uid), patch);
    return;
  }

  // 2. Admin pre-registered this email as a pending_ row -> claim it
  //    (keeps member ID, role, profile, payments).
  if (email) {
    const all = await get(ref(db, "members"));
    let claimedKey = null, claimedRec = null;
    all.forEach(child => {
      const k = child.key || "";
      const v = child.val() || {};
      if (!claimedKey && k.indexOf("pending_") === 0 &&
          String(v.email || "").toLowerCase() === email) {
        claimedKey = k; claimedRec = v;
      }
    });
    if (claimedKey) {
      const rec = Object.assign({}, claimedRec, {
        displayName: claimedRec.displayName || name,
        email, emailLower: email
      });
      await set(ref(db, "members/" + uid), rec);
      const pays = await get(ref(db, "payments/" + claimedKey));
      if (pays.exists()) {
        const moves = {};
        pays.forEach(p => { moves[p.key] = p.val(); });
        await update(ref(db, "payments/" + uid), moves);
        await remove(ref(db, "payments/" + claimedKey));
      }
      await remove(ref(db, "members/" + claimedKey));
      return;
    }
  }

  // 3. Admin email -> auto-create (approvers can never lock themselves out).
  if (email) {
    const admins = await get(ref(db, "admins"));
    let isAdmin = false;
    admins.forEach(a => {
      if (String((a.val() || {}).email || "").toLowerCase() === email) isAdmin = true;
    });
    if (isAdmin) { await createMemberRow(uid, email, name); return; }
  }

  // 4. Brand-new: submit a join request and block on the overlay until an
  //    admin approves. Denied shows a request-again option.
  await submitJoin(uid, email, name);
  await waitForApproval(uid, email, name);
}

async function submitJoin(uid, email, name) {
  const cur = await get(ref(db, "joinRequests/" + uid));
  const status = cur.exists() ? (cur.val() || {}).status : null;
  if (cur.exists() && status !== "denied") return;
  await set(ref(db, "joinRequests/" + uid), {
    email, displayName: name,
    requestedAtMillis: serverTimestamp(),
    status: "pending",
    decidedByEmail: "", decidedByName: "", decidedAtMillis: 0
  });
}

function waitForApproval(uid, email, name) {
  return new Promise(resolve => {
    const overlay = buildOverlay();
    document.body.appendChild(overlay.root);

    const unsubMember = onValue(ref(db, "members/" + uid), s => {
      if (s.exists()) finish();
    });
    const unsubJoin = onValue(ref(db, "joinRequests/" + uid), s => {
      const st = s.exists() ? (s.val() || {}).status : null;
      if (st === "approved") { finish(); return; }
      if (st === null) { submitJoin(uid, email, name); return; } // owner deleted it
      overlay.setDenied(st === "denied", () => {
        set(ref(db, "joinRequests/" + uid), {
          email, displayName: name,
          requestedAtMillis: serverTimestamp(),
          status: "pending",
          decidedByEmail: "", decidedByName: "", decidedAtMillis: 0
        });
      });
    });

    function finish() {
      try { unsubMember(); } catch (e) {}
      try { unsubJoin(); } catch (e) {}
      overlay.root.remove();
      resolve();
    }
  });
}

async function createMemberRow(uid, email, name) {
  const counterRef = ref(db, "membersCounter");
  const tx = await runTransaction(counterRef, cur => (cur || 0) + 1);
  const num = tx.snapshot.val() || 1;
  const memberId = "M-" + String(num).padStart(3, "0");
  await set(ref(db, "members/" + uid), {
    memberId, displayName: name, email, emailLower: email,
    role: "Member", joinedAtMillis: serverTimestamp(), totalPaidMinor: 0,
    contactNumber: "", currentAddress: "", permanentAddress: "", occupation: ""
  });
}

function buildOverlay() {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:#FAF7F2;display:flex;" +
    "align-items:center;justify-content:center;text-align:center;padding:24px;";
  root.innerHTML =
    '<div style="max-width:340px;font-family:inherit;">' +
    '<div id="hkf-gate-spin" style="width:40px;height:40px;margin:0 auto 18px;' +
    'border:3px solid #E8C26A;border-top-color:#9A6A1F;border-radius:50%;' +
    'animation:hkfspin 0.9s linear infinite;"></div>' +
    '<style>@keyframes hkfspin{to{transform:rotate(360deg)}}</style>' +
    '<div id="hkf-gate-title" style="font-size:19px;font-weight:700;color:#111;">' +
    'Pending approval to join</div>' +
    '<div id="hkf-gate-sub" style="font-size:13px;color:#4A4A4A;margin-top:8px;">' +
    'An admin has been notified. You\'ll be let in automatically once approved.</div>' +
    '<button id="hkf-gate-again" style="display:none;margin-top:16px;padding:10px 20px;' +
    'border:none;border-radius:999px;background:#9A6A1F;color:#fff;font-weight:600;' +
    'cursor:pointer;">Request again</button>' +
    '</div>';
  const setDenied = (denied, onAgain) => {
    root.querySelector("#hkf-gate-spin").style.display = denied ? "none" : "";
    root.querySelector("#hkf-gate-title").textContent =
      denied ? "Request declined" : "Pending approval to join";
    root.querySelector("#hkf-gate-sub").textContent = denied
      ? "An admin declined your request. You can ask again."
      : "An admin has been notified. You'll be let in automatically once approved.";
    const btn = root.querySelector("#hkf-gate-again");
    btn.style.display = denied ? "" : "none";
    btn.onclick = onAgain;
  };
  return { root, setDenied };
}
