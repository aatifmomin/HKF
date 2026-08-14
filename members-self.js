// Membership resolution for the signed-in user.
//
// Signing in no longer creates a member. A brand-new Google account lands in
// a queue instead:
//
//   1. /members/{uid} already exists          -> they're in, refresh name/email
//   2. an admin pre-registered their email    -> claim that row (with any
//      payments already recorded against it) and they're in immediately
//   3. otherwise                              -> /joinRequests/{uid} = pending,
//      they see the "Pending approval to join" screen until an admin decides
//
// The pre-registration path deliberately skips the queue: an admin who typed
// the email into Add Member has already approved that person, and making them
// approve again once the person signs in would be busywork.

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  remove as fbRemove,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

export const MEMBERSHIP_MEMBER = "member";
export const MEMBERSHIP_PENDING = "pending";
export const MEMBERSHIP_DECLINED = "declined";

/**
 * Work out where the signed-in user stands, creating a join request if this
 * is their first ever sign-in. Safe to call on every auth state change.
 */
export async function resolveMembership(user) {
  if (!user || !user.uid) return { status: MEMBERSHIP_PENDING };

  const memberRef = ref(db, "members/" + user.uid);
  const snap = await get(memberRef);

  if (snap.exists()) {
    await refreshMemberIdentity(memberRef, snap.val() || {}, user);
    return { status: MEMBERSHIP_MEMBER };
  }

  // Pre-registered by an admin? Claim the row rather than queueing.
  const claimed = await tryClaimPreRegisteredRow(user);
  if (claimed) {
    // Any join request they'd previously filed is now moot.
    await fbRemove(ref(db, "joinRequests/" + user.uid)).catch(() => {});
    return { status: MEMBERSHIP_MEMBER };
  }

  const reqRef = ref(db, "joinRequests/" + user.uid);
  const reqSnap = await get(reqRef);
  const existing = reqSnap.val();

  if (existing) {
    if (existing.status === "approved") {
      // Approved, but the member row is gone - they were removed after being
      // let in. Reopen the request so an admin can decide again instead of
      // leaving them staring at a screen nobody can action.
      await set(reqRef, buildJoinRequest(user));
      return { status: MEMBERSHIP_PENDING };
    }
    const status = existing.status === "declined" ? MEMBERSHIP_DECLINED : MEMBERSHIP_PENDING;
    return { status, request: { key: user.uid, ...existing } };
  }

  await set(reqRef, buildJoinRequest(user));
  return { status: MEMBERSHIP_PENDING };
}

function buildJoinRequest(user) {
  return {
    uid: user.uid,
    displayName: (user.displayName || "").trim(),
    email: user.email || "",
    emailLower: (user.email || "").toLowerCase(),
    photoUrl: user.photoURL || "",
    status: "pending",
    createdAtMillis: Date.now(),
    decidedByEmail: "",
    decidedByName: "",
    decidedAtMillis: 0
  };
}

async function refreshMemberIdentity(memberRef, cur, user) {
  const updates = {};
  const dn = (user.displayName || "").trim();
  if (dn && cur.displayName !== dn) updates.displayName = dn;
  if (cur.email !== (user.email || "")) updates.email = user.email || "";
  if (!cur.emailLower && user.email) updates.emailLower = user.email.toLowerCase();
  // A claimed row keeps `pending: true` from the Add Member dialog until the
  // person actually signs in; clear it now that they have.
  if (cur.pending === true) updates.pending = false;
  if (Object.keys(updates).length > 0) {
    try { await update(memberRef, updates); } catch (e) { console.warn("member refresh failed", e); }
  }
}

/**
 * Look for a member row an admin created ahead of time for this email, keyed
 * by a push id rather than the user's uid. If one exists, move it (and any
 * payments recorded against it) to /members/{uid} so the person walks into a
 * populated account.
 */
async function tryClaimPreRegisteredRow(user) {
  const email = (user.email || "").toLowerCase();
  if (!email) return false;

  let all;
  try {
    all = await get(ref(db, "members"));
  } catch (e) {
    // A locked-down rule set can refuse the directory read to a non-member.
    // That's fine - they just go through the normal approval queue.
    console.warn("pre-registration lookup skipped", e);
    return false;
  }

  const match = Object.entries(all.val() || {}).find(([key, rec]) => {
    if (key === user.uid) return false;
    const rowEmail = (rec?.emailLower || rec?.email || "").toLowerCase();
    return rowEmail && rowEmail === email;
  });
  if (!match) return false;

  const [oldKey, rec] = match;

  try {
    // Carry the row over, keeping the admin-assigned member id and role.
    await set(ref(db, "members/" + user.uid), {
      ...rec,
      displayName: (user.displayName || "").trim() || rec.displayName || "",
      email: user.email || rec.email || "",
      emailLower: email,
      pending: false,
      claimedFromKey: oldKey,
      claimedAtMillis: Date.now()
    });

    // Payments the admin already recorded against the placeholder row.
    const paySnap = await get(ref(db, "payments/" + oldKey));
    const payments = paySnap.val();
    if (payments) {
      await update(ref(db, "payments/" + user.uid), payments);
      await fbRemove(ref(db, "payments/" + oldKey)).catch(() => {});
    }

    await fbRemove(ref(db, "members/" + oldKey)).catch(() => {});
    return true;
  } catch (e) {
    console.warn("claim failed", e);
    return false;
  }
}

/**
 * Live membership status. Fires whenever /members/{uid} or /joinRequests/{uid}
 * changes, which is what lets an approved user drop straight into the app
 * without signing out and back in.
 */
export function observeMembership(user, callback) {
  if (!user || !user.uid) return () => {};

  let hasMember = false;
  let request = null;
  let sawMember = false;
  let sawRequest = false;

  function emit() {
    if (!sawMember || !sawRequest) return;   // wait for both first snapshots
    if (hasMember) { callback({ status: MEMBERSHIP_MEMBER }); return; }
    if (request && request.status === "declined") {
      callback({ status: MEMBERSHIP_DECLINED, request });
      return;
    }
    callback({ status: MEMBERSHIP_PENDING, request });
  }

  const unsubMember = onValue(ref(db, "members/" + user.uid), snap => {
    hasMember = snap.exists();
    sawMember = true;
    emit();
  }, () => { sawMember = true; emit(); });

  const unsubRequest = onValue(ref(db, "joinRequests/" + user.uid), snap => {
    const val = snap.val();
    request = val ? { key: user.uid, ...val } : null;
    sawRequest = true;
    emit();
  }, () => { sawRequest = true; emit(); });

  return function () {
    unsubMember();
    unsubRequest();
  };
}

/** Re-open a declined request ("Request again" on the declined screen). */
export async function requestJoinAgain(user) {
  await set(ref(db, "joinRequests/" + user.uid), {
    ...buildJoinRequest(user),
    reRequestedAtMillis: Date.now()
  });
}

// ---------------- Admin-side decisions ----------------

/**
 * Approve a join request: allocate a member id, create /members/{uid}, and
 * stamp the request as approved (kept, not deleted, so the Activity feed can
 * still show who let them in).
 */
export async function approveJoinRequest(request, approver) {
  const uid = request.uid || request.key;
  if (!uid) throw new Error("Join request has no user id");

  const existing = await get(ref(db, "members/" + uid));
  if (!existing.exists()) {
    const memberId = await allocateNextMemberId();
    await set(ref(db, "members/" + uid), {
      memberId,
      displayName: request.displayName || (request.email || "").split("@")[0] || "",
      fullName: "",
      email: request.email || "",
      emailLower: (request.email || "").toLowerCase(),
      contactNumber: "",
      currentAddress: "",
      permanentAddress: "",
      occupation: "",
      role: "Member",
      joinedAtMillis: Date.now(),
      totalPaidMinor: 0,
      pending: false
    });
  }

  await update(ref(db, "joinRequests/" + uid), {
    status: "approved",
    decidedByEmail: approver?.email || "",
    decidedByName: approver?.displayName || (approver?.email || "").split("@")[0] || "",
    decidedAtMillis: serverTimestamp()
  });
}

/** Discard a join request. The person sees the declined screen next paint. */
export async function declineJoinRequest(request, approver) {
  const uid = request.uid || request.key;
  if (!uid) throw new Error("Join request has no user id");
  await update(ref(db, "joinRequests/" + uid), {
    status: "declined",
    decidedByEmail: approver?.email || "",
    decidedByName: approver?.displayName || (approver?.email || "").split("@")[0] || "",
    decidedAtMillis: serverTimestamp()
  });
}

// ---------------- Member id allocation ----------------

// Atomic counter increment via runTransaction. Two clients approving at the
// same time get unique IDs, no race.
export async function allocateNextMemberId() {
  const counterRef = ref(db, "membersCounter");
  let next = 1;
  await runTransaction(counterRef, current => {
    next = (current || 0) + 1;
    return next;
  });
  return "M" + String(next).padStart(3, "0");
}

// Read-only peek at the next ID (used by the Add Member dialog's auto-generate).
export async function peekNextMemberId() {
  const counterRef = ref(db, "membersCounter");
  const snap = await get(counterRef);
  const cur = (snap.val() || 0);
  return "M" + String(cur + 1).padStart(3, "0");
}
