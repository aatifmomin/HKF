// Authentication + admin-list observation.

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
  getDatabase,
  ref,
  onValue
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";
import { OWNER_EMAIL } from "./firebase-config.js";

const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);
const provider = new GoogleAuthProvider();

export async function signIn() {
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (e) {
    if (e?.code === "auth/popup-blocked") {
      throw new Error("Browser blocked the sign-in popup. Allow popups and try again.");
    }
    if (e?.code === "auth/popup-closed-by-user") return null;
    throw e;
  }
}

export async function signOut() {
  await fbSignOut(auth);
}

export function observeAuth(callback) {
  return onAuthStateChanged(auth, user => callback(user));
}

export function isOwner(email) {
  if (!email) return false;
  return email.toLowerCase() === OWNER_EMAIL.toLowerCase();
}

// Live observation of the /admins list. Owner email is always treated as admin
// even if it isn't in the list.
export function observeAdminEmails(callback) {
  const adminsRef = ref(db, "admins");
  return onValue(adminsRef, snap => {
    const val = snap.val() || {};
    const emails = Object.values(val)
      .map(a => (a?.emailLower || a?.email || "").toLowerCase())
      .filter(Boolean);
    if (!emails.includes(OWNER_EMAIL.toLowerCase())) {
      emails.push(OWNER_EMAIL.toLowerCase());
    }
    callback(emails);
  });
}

export function isAdminEmail(email, adminEmails) {
  if (!email) return false;
  if (isOwner(email)) return true;
  const lower = email.toLowerCase();
  return adminEmails.some(e => e === lower);
}

export function displayNameFor(user) {
  if (!user) return "";
  return (user.displayName && user.displayName.trim()) || user.email?.split("@")[0] || "";
}
