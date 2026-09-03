// Year-scoped data lifecycle for the owner — port of Android's
// YearDataManager.
//
//   backup   export one year's records as a JSON file
//   restore  merge such a file back into the database
//   reset    delete one year's records
//
// Year attribution, matching Android exactly:
//   payments / paymentRequests  year of coversMonthKey (a multi-month request
//                               belongs to the year its FIRST month is in)
//   paymentProofs               follow their request
//   handovers (+docs)           application date, falling back to created date
//   collectorTransfers          transfer date
//
// Members, admins, settings, collector profiles, announcements and tech
// support are NOT year data and are never touched.
//
// Every write is a fan-out path update ("payments/{uid}/{key}") so only the
// selected year's rows move — neighbouring years and sibling records are never
// overwritten wholesale. Batches are chunked at 40 paths, same as Android.

import {
  getDatabase,
  ref,
  get,
  update
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02a";

const db = getDatabase(firebaseApp);

const CHUNK = 40;
const BACKUP_FORMAT = 1;

/** Paths a backup file is allowed to carry. Anything else is rejected. */
const ALLOWED_PREFIXES = [
  "payments/", "paymentRequests/", "paymentProofs/",
  "handovers/", "handoverDocs/", "collectorTransfers/"
];

function monthKeyYear(monthKey) {
  const s = String(monthKey || "");
  if (s.length < 4) return null;
  const y = parseInt(s.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function millisYear(millis) {
  const n = Number(millis) || 0;
  return n > 0 ? new Date(n).getFullYear() : null;
}

async function readNode(path) {
  try {
    const snap = await get(ref(db, path));
    return snap.val() || {};
  } catch (e) {
    console.warn("read failed: " + path, e);
    return {};
  }
}

/** Years that currently have any data, newest first. */
export async function discoverYears() {
  const years = new Set();

  const payments = await readNode("payments");
  Object.values(payments).forEach(byKey => {
    Object.values(byKey || {}).forEach(p => {
      const y = monthKeyYear(p?.coversMonthKey);
      if (y) years.add(y);
    });
  });

  const requests = await readNode("paymentRequests");
  Object.values(requests).forEach(r => {
    const y = monthKeyYear(r?.coversMonthKey);
    if (y) years.add(y);
  });

  const handovers = await readNode("handovers");
  Object.values(handovers).forEach(h => {
    const y = millisYear(h?.applicationDateMillis || h?.createdAtMillis);
    if (y) years.add(y);
  });

  const transfers = await readNode("collectorTransfers");
  Object.values(transfers).forEach(t => {
    const y = millisYear(t?.transferredAtMillis);
    if (y) years.add(y);
  });

  return Array.from(years).sort((a, b) => b - a);
}

/**
 * Collect every record belonging to `year`.
 * @returns {{paths:Object, paymentCount:number, requestCount:number,
 *            proofCount:number, handoverCount:number, transferCount:number,
 *            totalCount:number}}
 */
export async function sliceYear(year) {
  const paths = {};
  const prefix = year + "-";
  let paymentCount = 0, requestCount = 0, proofCount = 0, handoverCount = 0, transferCount = 0;

  const payments = await readNode("payments");
  Object.entries(payments).forEach(([uid, byKey]) => {
    Object.entries(byKey || {}).forEach(([key, p]) => {
      if (String(p?.coversMonthKey || "").startsWith(prefix)) {
        paths["payments/" + uid + "/" + key] = p;
        paymentCount++;
      }
    });
  });

  const requestKeys = [];
  const requests = await readNode("paymentRequests");
  Object.entries(requests).forEach(([key, r]) => {
    if (String(r?.coversMonthKey || "").startsWith(prefix)) {
      paths["paymentRequests/" + key] = r;
      requestKeys.push(key);
      requestCount++;
    }
  });

  if (requestKeys.length) {
    const proofs = await readNode("paymentProofs");
    requestKeys.forEach(key => {
      if (proofs[key] !== undefined) {
        paths["paymentProofs/" + key] = proofs[key];
        proofCount++;
      }
    });
  }

  const handoverKeys = [];
  const handovers = await readNode("handovers");
  Object.entries(handovers).forEach(([key, h]) => {
    if (millisYear(h?.applicationDateMillis || h?.createdAtMillis) === year) {
      paths["handovers/" + key] = h;
      handoverKeys.push(key);
      handoverCount++;
    }
  });

  if (handoverKeys.length) {
    const docs = await readNode("handoverDocs");
    handoverKeys.forEach(key => {
      if (docs[key] !== undefined) paths["handoverDocs/" + key] = docs[key];
    });
  }

  const transfers = await readNode("collectorTransfers");
  Object.entries(transfers).forEach(([key, t]) => {
    if (millisYear(t?.transferredAtMillis) === year) {
      paths["collectorTransfers/" + key] = t;
      transferCount++;
    }
  });

  return {
    paths, paymentCount, requestCount, proofCount, handoverCount, transferCount,
    totalCount: paymentCount + requestCount + proofCount + handoverCount + transferCount
  };
}

/** Serialise a slice into the backup-file JSON. Same shape Android writes. */
export function toBackupJson(year, slice) {
  return {
    app: "HKF",
    format: BACKUP_FORMAT,
    year,
    exportedAtMillis: Date.now(),
    counts: {
      payments: slice.paymentCount,
      paymentRequests: slice.requestCount,
      paymentProofs: slice.proofCount,
      handovers: slice.handoverCount,
      collectorTransfers: slice.transferCount
    },
    records: slice.paths
  };
}

/**
 * Parse and sanity-check a backup file.
 * Throws with a readable message rather than writing something unexpected —
 * this is the only place in either app where a file the user picked turns
 * into database paths, so it refuses anything outside the allowed prefixes.
 * @returns {{year:number, paths:Object}}
 */
export function parseBackup(json) {
  if (!json || json.app !== "HKF") throw new Error("Not an HKF backup file");
  if (json.format !== BACKUP_FORMAT) throw new Error("Unsupported backup format");
  const year = Number(json.year);
  if (!(year >= 2000 && year <= 2100)) throw new Error("Backup file has no valid year");

  const records = json.records || {};
  const paths = {};
  Object.keys(records).forEach(path => {
    const allowed = ALLOWED_PREFIXES.some(p => path.startsWith(p)) && !path.includes("..");
    if (!allowed) throw new Error("Backup contains an unexpected path: " + path);
    paths[path] = records[path];
  });
  return { year, paths };
}

async function writeChunks(entries) {
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    await update(ref(db), Object.fromEntries(slice));
  }
  return entries.length;
}

/** Merge records back in. Existing keys are overwritten; siblings untouched. */
export async function restore(paths) {
  return writeChunks(Object.entries(paths));
}

/** Delete a set of paths (chunked fan-out nulls). */
export async function deletePaths(paths) {
  return writeChunks(Array.from(paths).map(p => [p, null]));
}

/**
 * Reset scope, per the owner's own definition on Android — deliberately wider
 * than the backup slice, so read this before wiring a button to it:
 *   1. payments of the chosen YEAR only
 *   2. ALL handovers + their documents (numbering restarts at H-001)
 *   3. ALL activity — every payment request with every proof, and every join
 *      request, decided ones included
 * Members, collector profiles and transfers, and settings stay untouched.
 */
export async function resetSlice(year) {
  const paths = [];
  const prefix = year + "-";
  let paymentCount = 0, handoverCount = 0, requestCount = 0, proofCount = 0, joinCount = 0;

  const payments = await readNode("payments");
  Object.entries(payments).forEach(([uid, byKey]) => {
    Object.entries(byKey || {}).forEach(([key, p]) => {
      if (String(p?.coversMonthKey || "").startsWith(prefix)) {
        paths.push("payments/" + uid + "/" + key);
        paymentCount++;
      }
    });
  });

  const handovers = await readNode("handovers");
  Object.keys(handovers).forEach(key => { paths.push("handovers/" + key); handoverCount++; });
  paths.push("handoverDocs");       // all documents
  paths.push("handoversCounter");   // numbering restarts at H-001

  const requests = await readNode("paymentRequests");
  Object.keys(requests).forEach(key => { paths.push("paymentRequests/" + key); requestCount++; });

  const proofs = await readNode("paymentProofs");
  Object.keys(proofs).forEach(key => { paths.push("paymentProofs/" + key); proofCount++; });

  const joins = await readNode("joinRequests");
  Object.keys(joins).forEach(key => { paths.push("joinRequests/" + key); joinCount++; });

  return {
    paths, paymentCount, handoverCount, requestCount, proofCount, joinCount,
    totalCount: paymentCount + handoverCount + requestCount + proofCount + joinCount
  };
}

/**
 * Recompute every member's stored totalPaidMinor from the payments that
 * actually exist.
 *
 * Reset and restore write payment rows directly through fan-out paths, which
 * bypasses the per-write total upkeep both clients normally do. Without this
 * pass the member cards, the export and Android's widget keep showing
 * pre-reset figures.
 */
export async function recomputeAllMemberTotals() {
  const members = await readNode("members");
  const uids = Object.keys(members);
  if (!uids.length) return 0;

  const payments = await readNode("payments");
  const sums = {};
  Object.entries(payments).forEach(([uid, byKey]) => {
    sums[uid] = Object.values(byKey || {}).reduce((s, p) => s + (Number(p?.amountMinor) || 0), 0);
  });

  await writeChunks(uids.map(uid => ["members/" + uid + "/totalPaidMinor", sums[uid] || 0]));
  return uids.length;
}
