// Membership resolution for the signed-in user.
//
// This is a port of the Android AuthViewModel.resolveMembership() flow plus
// JoinRequestRepository. The order of the checks matters and is the same on
// both clients:
//
//   1. /members/{uid} exists              -> Approved (refresh name/email)
//   2. an admin pre-registered the email  -> claim the pending_ row -> Approved
//   3. owner, or listed in /admins        -> create the member row -> Approved
//   4. otherwise                          -> /joinRequests/{uid} = pending
//
// Step 2 exists because the admin who typed the email into Add Member has
// already approved that person; making them approve again is busywork.
// Step 3 stops an admin ever locking themselves out of their own foundation.
//
// Wire format notes (must match Android exactly):
//   * a pre-registered member row is keyed "pending_{pushKey}", and that key
//     prefix IS the pending flag - there is no `pending: true` field
//   * a declined join request has status "denied", not "declined"
//   * the timestamp field is requestedAtMillis, not createdAtMillis
//   * totalPaidMinor is always RECOMPUTED from /payments, never incremented

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  remove as fbRemove,
  push,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02c";
import { OWNER_EMAIL } from "./firebase-config.js?v=2026-09-02c";

const db = getDatabase(firebaseApp);

export const MEMBERSHIP_MEMBER = "member";
export const MEMBERSHIP_PENDING = "pending";
export const MEMBERSHIP_DECLINED = "declined";   // local name; DB value is "denied"

// Status strings as they appear in the database. Android compares join-request
// status with ==, so these have to be exact.
export const JOIN_PENDING = "pending";
export const JOIN_APPROVED = "approved";
export const JOIN_DENIED = "denied";

/**
 * Work out where the signed-in user stands, creating a join request if this
 * is their first sign-in. Safe to call on every auth state change.
 */
export async function resolveMembership(user) {
  if (!user || !user.uid) return { status: MEMBERSHIP_PENDING };
  const email = user.email || "";

  try {
    const memberRef = ref(db, "members/" + user.uid);
    const snap = await get(memberRef);
    if (snap.exists()) {
      await refreshMemberIdentity(memberRef, snap.val() || {}, user);
      return { status: MEMBERSHIP_MEMBER };
    }

    if (email && await claimPendingRowByEmail(user.uid, email, user.displayName)) {
      return { status: MEMBERSHIP_MEMBER };
    }

    // Owner and existing admins are members by definition.
    if (email && (isOwnerEmail(email) || await isAdminEmailInDb(email))) {
      await ensureMemberExists(user.uid, email, user.displayName);
      return { status: MEMBERSHIP_MEMBER };
    }

    // Brand-new user: open the join request, then follow it.
    //
    // DELIBERATE DIFFERENCE FROM ANDROID. AuthViewModel.resolveMembership()
    // calls submit() unconditionally here, and submit() rewrites a *denied*
    // row back to pending. The effect on Android is that a declined person
    // silently re-joins the queue every time they open the app: the
    // "Request declined" screen is unreachable, and an admin's Discard is
    // undone on the next launch, so the same request keeps reappearing in
    // Activity. We only submit when there is no row, and let the person
    // re-apply deliberately with the "Request again" button. Same data
    // shape either way - this is behaviour only.
    const reqSnap = await get(ref(db, "joinRequests/" + user.uid));
    if (!reqSnap.exists()) {
      await submitJoinRequest(user);
      return { status: MEMBERSHIP_PENDING };
    }
    const rec = reqSnap.val();
    return {
      status: rec?.status === JOIN_DENIED ? MEMBERSHIP_DECLINED : MEMBERSHIP_PENDING,
      request: { uid: user.uid, ...rec }
    };
  } catch (e) {
    // Fail closed to the gate screen rather than into the app. It offers
    // sign-out and retries on the next launch.
    console.error("membership check failed", e);
    return { status: MEMBERSHIP_PENDING, error: e?.message || "" };
  }
}

function isOwnerEmail(email) {
  return (email || "").toLowerCase() === OWNER_EMAIL.toLowerCase();
}

async function isAdminEmailInDb(email) {
  try {
    const snap = await get(ref(db, "admins"));
    const lower = email.toLowerCase();
    return Object.values(snap.val() || {}).some(
      a => (a?.emailLower || a?.email || "").toLowerCase() === lower
    );
  } catch {
    return false;
  }
}

async function refreshMemberIdentity(memberRef, cur, user) {
  const updates = {};
  const dn = (user.displayName || "").trim();
  if (dn && cur.displayName !== dn) updates.displayName = dn;
  if (cur.email !== (user.email || "")) updates.email = user.email || "";
  if (Object.keys(updates).length > 0) {
    try { await update(memberRef, updates); } catch (e) { console.warn("member refresh failed", e); }
  }
}

/**
 * Claim a row an admin pre-created for this email.
 *
 * Pre-registered rows are keyed "pending_{pushKey}" - Android identifies them
 * purely by that prefix, so matching on the email alone would also scoop up a
 * legitimate uid-keyed row belonging to someone else's account.
 */
export async function claimPendingRowByEmail(uid, email, displayName) {
  const lower = (email || "").toLowerCase();
  if (!uid || !lower) return false;

  let all;
  try {
    all = await get(ref(db, "members"));
  } catch (e) {
    console.warn("pre-registration lookup skipped", e);
    return false;
  }

  const match = Object.entries(all.val() || {}).find(([key, rec]) =>
    key.startsWith("pending_") && (rec?.email || "").toLowerCase() === lower
  );
  if (!match) return false;

  const [pendingKey, rec] = match;
  try {
    // Copy to the real uid key, filling a blank name from the auth profile.
    await set(ref(db, "members/" + uid), {
      ...rec,
      displayName: (rec.displayName || "").trim() || (displayName || "").trim(),
      email
    });

    // Migrate payments the admin recorded against the placeholder.
    const paySnap = await get(ref(db, "payments/" + pendingKey));
    if (paySnap.exists()) {
      await update(ref(db, "payments/" + uid), paySnap.val());
      await fbRemove(ref(db, "payments/" + pendingKey)).catch(() => {});
    }

    await fbRemove(ref(db, "members/" + pendingKey)).catch(() => {});
    await recalcMemberTotal(uid);
    return true;
  } catch (e) {
    console.warn("claim failed", e);
    return false;
  }
}

/** Create /members/{uid} if it isn't there. Idempotent. */
export async function ensureMemberExists(uid, email, displayName) {
  const memberRef = ref(db, "members/" + uid);
  const existing = await get(memberRef);
  if (existing.exists()) return;

  await set(memberRef, {
    memberId: await allocateNextMemberId(),
    displayName: (displayName || "").trim(),
    email: email || "",
    role: "Member",
    joinedAtMillis: Date.now(),
    totalPaidMinor: 0,
    contactNumber: "",
    currentAddress: "",
    permanentAddress: "",
    occupation: ""
  });
}

// ---------------- Join requests ----------------

/**
 * Create or re-open this user's join request. Idempotent, matching Android:
 * an existing pending or approved row is left alone; a denied row is reset to
 * pending (that's what "Request again" does).
 */
export async function submitJoinRequest(user) {
  const uid = user?.uid;
  if (!uid) return false;
  const reqRef = ref(db, "joinRequests/" + uid);
  const existing = await get(reqRef);
  if (existing.exists() && existing.val()?.status !== JOIN_DENIED) return true;

  await set(reqRef, {
    email: user.email || "",
    displayName: (user.displayName || "").trim(),
    requestedAtMillis: serverTimestamp(),
    status: JOIN_PENDING,
    decidedByEmail: "",
    decidedByName: "",
    decidedAtMillis: 0
  });
  return true;
}

/** "Request again" on the declined screen. */
export async function requestJoinAgain(user) {
  await submitJoinRequest(user);
}

/**
 * Live membership status. Fires whenever /members/{uid} or /joinRequests/{uid}
 * changes, which is what lets an approved user drop into the app without
 * signing out and back in.
 */
export function observeMembership(user, callback) {
  if (!user || !user.uid) return () => {};

  let hasMember = false;
  let request = null;
  let sawMember = false;
  let sawRequest = false;
  let resubmitting = false;
  let restoring = false;

  function emit() {
    if (!sawMember || !sawRequest) return;   // wait for both first snapshots
    if (hasMember) { callback({ status: MEMBERSHIP_MEMBER }); return; }

    // The row can vanish under a privileged user - most obviously when the
    // owner uses Settings > Delete all members, which takes their own row with
    // it. Android only resolves membership at sign-in so it doesn't notice
    // until relaunch; our live listener would otherwise dump the owner onto
    // the "Pending approval" screen inside their own foundation. Re-create the
    // row instead, which is exactly what the next sign-in would have done.
    if (user.email && isOwnerEmail(user.email)) {
      if (!restoring) {
        restoring = true;
        ensureMemberExists(user.uid, user.email, user.displayName)
          .catch(e => console.warn("owner row restore failed", e))
          .finally(() => { restoring = false; });
      }
      // Keep reporting MEMBER for every snapshot until the row is back.
      // Falling through even once would flash the gate screen, and that
      // remounts the shell and drops the owner out of Settings.
      callback({ status: MEMBERSHIP_MEMBER });
      return;
    }

    if (!request) {
      // The row vanished - the owner wiped activity from Settings. Put the
      // request back rather than stranding them on a dead screen.
      if (!resubmitting) {
        resubmitting = true;
        submitJoinRequest(user)
          .catch(e => console.warn("re-submit failed", e))
          .finally(() => { resubmitting = false; });
      }
      callback({ status: MEMBERSHIP_PENDING });
      return;
    }

    callback({
      status: request.status === JOIN_DENIED ? MEMBERSHIP_DECLINED : MEMBERSHIP_PENDING,
      request
    });
  }

  const unsubMember = onValue(ref(db, "members/" + user.uid), snap => {
    hasMember = snap.exists();
    sawMember = true;
    emit();
  }, () => { sawMember = true; emit(); });

  const unsubRequest = onValue(ref(db, "joinRequests/" + user.uid), snap => {
    const val = snap.val();
    request = val ? { uid: user.uid, ...val } : null;
    sawRequest = true;
    emit();
  }, () => { sawRequest = true; emit(); });

  return function () {
    unsubMember();
    unsubRequest();
  };
}

// ---------------- Admin-side decisions ----------------

/**
 * Approve a join request. Tries the pre-registration claim first so someone
 * an admin had already added keeps their member id, role and payments instead
 * of getting a duplicate row.
 */
export async function approveJoinRequest(request, approver) {
  const uid = request.uid || request.key;
  if (!uid) throw new Error("Join request has no user id");
  if (request.status !== JOIN_PENDING) return;

  const claimed = request.email
    ? await claimPendingRowByEmail(uid, request.email, request.displayName)
    : false;
  if (!claimed) {
    await ensureMemberExists(uid, request.email || "", request.displayName || "");
  }

  await update(ref(db, "joinRequests/" + uid), {
    status: JOIN_APPROVED,
    decidedByEmail: approver?.email || "",
    decidedByName: deciderName(approver),
    decidedAtMillis: serverTimestamp()
  });
}

/** Discard a join request. The person sees the declined screen next paint. */
export async function declineJoinRequest(request, approver) {
  const uid = request.uid || request.key;
  if (!uid) throw new Error("Join request has no user id");
  if (request.status !== JOIN_PENDING) return;
  await update(ref(db, "joinRequests/" + uid), {
    status: JOIN_DENIED,
    decidedByEmail: approver?.email || "",
    decidedByName: deciderName(approver),
    decidedAtMillis: serverTimestamp()
  });
}

/** Owner-only: permanently delete one join request. */
export async function deleteJoinRequest(request) {
  const uid = request.uid || request.key;
  if (!uid) return;
  await fbRemove(ref(db, "joinRequests/" + uid));
}

function deciderName(user) {
  if (!user) return "";
  return (user.displayName && user.displayName.trim()) || (user.email || "").split("@")[0] || "";
}

/**
 * A member editing their own profile from the Profile tab.
 *
 * Deliberately narrow: only the four fields a member owns. memberId, role,
 * email, displayName, joinedAtMillis and totalPaidMinor are admin-managed and
 * are not in the payload, so a member can't quietly promote themselves or
 * rewrite their own total.
 */
export async function updateSelfProfile(uid, fields) {
  if (!uid) return false;
  try {
    await update(ref(db, "members/" + uid), {
      contactNumber: String(fields.contactNumber || "").trim(),
      currentAddress: String(fields.currentAddress || "").trim(),
      permanentAddress: String(fields.permanentAddress || "").trim(),
      occupation: String(fields.occupation || "").trim()
    });
    return true;
  } catch (e) {
    console.warn("self profile update failed", e);
    return false;
  }
}

// ---------------- Totals ----------------

/**
 * Recompute /members/{uid}/totalPaidMinor as the sum of that member's payment
 * rows.
 *
 * Android never increments this field, it always recomputes. Matching that
 * matters: if one client adds a delta while the other recomputes, a payment
 * deleted on Android would leave the web's running total permanently high.
 */
export async function recalcMemberTotal(uid) {
  if (!uid) return 0;
  const snap = await get(ref(db, "payments/" + uid));
  let total = 0;
  Object.values(snap.val() || {}).forEach(p => { total += (p?.amountMinor || 0); });
  try {
    await update(ref(db, "members/" + uid), { totalPaidMinor: total });
  } catch (e) {
    console.warn("total recalc failed", e);
  }
  return total;
}

// ---------------- Member id allocation ----------------

/**
 * Next "M###" id. Android does a read-then-write here; we use a transaction,
 * which produces identical ids but can't hand two simultaneous sign-ins the
 * same number.
 */
export async function allocateNextMemberId() {
  const counterRef = ref(db, "membersCounter");
  let next = 1;
  await runTransaction(counterRef, current => {
    next = (current || 0) + 1;
    return next;
  });
  return "M" + String(next).padStart(3, "0");
}

/** Read-only peek at the next ID (used by the Add Member dialog). */
export async function peekNextMemberId() {
  const snap = await get(ref(db, "membersCounter"));
  return "M" + String((snap.val() || 0) + 1).padStart(3, "0");
}

/** The key an admin-created (not yet signed in) member row must use. */
export function newPendingMemberKey() {
  return "pending_" + push(ref(db, "members")).key;
}
