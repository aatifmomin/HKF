// Auto-create a /members/{uid} row the first time a user signs in.
// Mirrors Android MembersRepository.ensureMemberExists():
//   - If row exists: update name/email if they changed
//   - If row is missing: allocate next M-XXX id from /membersCounter and create

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

export async function ensureMemberExists(user) {
  if (!user || !user.uid) return;

  const memberRef = ref(db, "members/" + user.uid);
  const snap = await get(memberRef);

  if (snap.exists()) {
    // Existing member: refresh display name + email if they changed.
    const cur = snap.val() || {};
    const updates = {};
    const dn = (user.displayName || "").trim();
    if (dn && cur.displayName !== dn) updates.displayName = dn;
    if (cur.email !== (user.email || "")) updates.email = user.email || "";
    if (Object.keys(updates).length > 0) {
      try { await update(memberRef, updates); } catch (e) { console.warn("member refresh failed", e); }
    }
    return;
  }

  // New member: atomically allocate the next M-XXX id, then write the row.
  const newId = await allocateNextMemberId();
  const record = {
    memberId: newId,
    displayName: (user.displayName || "").trim(),
    email: user.email || "",
    role: "Member",
    joinedAtMillis: Date.now(),
    totalPaidMinor: 0
  };
  try {
    await set(memberRef, record);
  } catch (e) {
    console.error("member create failed", e);
  }
}

// Atomic counter increment via runTransaction. Two clients signing in at the
// same time get unique IDs, no race.
async function allocateNextMemberId() {
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
