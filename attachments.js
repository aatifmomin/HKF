// Shared attachment plumbing for handover documents and payment proofs.
//
// WIRE FORMAT - the Android client must match this exactly.
//
//   /handovers/{key}/documents/{docId} = {      <- index, no blob
//     name:      String,   // "receipt.jpg"
//     mime:      String,   // "image/jpeg" | "application/pdf"
//     sizeBytes: Long
//   }
//   /handoverDocs/{key}/{docId} = {             <- blob
//     name, mime, sizeBytes,
//     data:             String,  // BARE base64. NO "data:...;base64," prefix.
//     uploadedByEmail:  String,
//     uploadedAtMillis: Long
//   }
//
//   /paymentRequests/{key}.proofId = "<proofId>"    <- index
//   /payments/{uid}/{key}.proofId = "<proofId>"     <- index (same id, shared)
//   /paymentProofs/{proofId} = {                    <- blob
//     name, mime, sizeBytes, data,
//     uploadedByUid, uploadedByEmail, uploadedAtMillis
//   }
//
// `data` is bare base64 so Android can use Base64.encodeToString(bytes,
// NO_WRAP) and Base64.decode(s, DEFAULT) with no string surgery. On read the
// web is deliberately lenient about all of this - see normalizeAttachment().
//
// The split is the whole point: the Handover list and the Activity feed
// subscribe to their parent nodes, and if the base64 lived inline every
// listener would re-download every megabyte on every change. Blobs are only
// fetched when someone actually taps View.
//
// A payment proof keeps the SAME proofId when a request is approved, so the
// confirmed payment row points at the already-uploaded blob instead of us
// copying a megabyte around inside the database.

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  push,
  remove as fbRemove,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

// PDFs are stored as-is (we can't re-compress them client-side), so they get
// a hard cap. Images are re-encoded below and almost always land far under it.
export const MAX_PDF_BYTES = 2 * 1024 * 1024;

// Re-encode target for photos. 1400px on the long edge is enough to read a
// UPI screenshot or a scanned form, and keeps the base64 payload ~100-300KB.
const IMAGE_MAX_DIM = 1400;
const IMAGE_QUALITY_STEPS = [0.72, 0.6, 0.5, 0.4];
const IMAGE_TARGET_BYTES = 900 * 1024;

export const ACCEPT_DOCS = "image/jpeg,image/jpg,image/png,application/pdf";
export const ACCEPT_IMAGES = "image/jpeg,image/jpg,image/png";

/**
 * Open the OS file picker and resolve with the chosen files. Resolves with an
 * empty array if the user cancels (there is no reliable cancel event, so a
 * cancelled picker simply never fires change and the promise settles when the
 * element is garbage — we resolve on focus-return as a fallback).
 */
export function pickFiles({ multiple = false, accept = ACCEPT_DOCS } = {}) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);

    let settled = false;
    function finish(files) {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    }

    input.addEventListener("change", () => finish(Array.from(input.files || [])));
    // Cancel fallback: when the picker closes without a selection the window
    // regains focus and no change event ever arrives.
    window.addEventListener("focus", () => {
      setTimeout(() => finish(Array.from(input.files || [])), 400);
    }, { once: true });

    input.click();
  });
}

function formatBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
export { formatBytes };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("Couldn't read " + file.name));
    fr.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Not a readable image"));
    img.src = dataUrl;
  });
}

/**
 * Drop the "data:<mime>;base64," header a browser FileReader/canvas produces.
 *
 * We store BARE base64 on the wire. That is deliberate: it is exactly what
 * Android's Base64.encodeToString(bytes, NO_WRAP) emits and what
 * Base64.decode(s, DEFAULT) expects, so the Android client can read and write
 * these nodes without any string surgery. The web pays the trivial cost of
 * re-adding the header (or building a Blob) at display time instead.
 */
function stripDataUrl(dataUrl) {
  const m = /^data:[^;,]*(;[^,]*)?,/.exec(dataUrl);
  return m ? dataUrl.slice(m[0].length) : dataUrl;
}

/** Rough decoded size of a data URL's base64 payload, in bytes. */
function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(b64.length * 3 / 4) - padding);
}

/**
 * Turn a picked File into a storable attachment record.
 * Images are downscaled + re-encoded as JPEG; PDFs pass through with a cap.
 * Throws with a user-readable message on anything we can't take.
 */
export async function prepareAttachment(file) {
  const mime = (file.type || "").toLowerCase();
  const isPdf = mime === "application/pdf" || /\.pdf$/i.test(file.name || "");
  const isImage = mime.startsWith("image/");

  if (!isPdf && !isImage) {
    throw new Error(`"${file.name}" isn't a JPG, PNG or PDF`);
  }

  if (isPdf) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`"${file.name}" is ${formatBytes(file.size)} — PDFs must be under 2 MB`);
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      name: file.name || "document.pdf",
      mime: "application/pdf",
      data: stripDataUrl(dataUrl),
      sizeBytes: dataUrlBytes(dataUrl)
    };
  }

  // Image: draw to a canvas at a bounded size, then step the JPEG quality
  // down until it fits comfortably in a database row.
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // White matte so transparent PNGs don't turn black once flattened to JPEG.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  let out = null;
  for (const q of IMAGE_QUALITY_STEPS) {
    out = canvas.toDataURL("image/jpeg", q);
    if (dataUrlBytes(out) <= IMAGE_TARGET_BYTES) break;
  }
  if (!out) throw new Error("Couldn't compress " + file.name);

  const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
  return {
    name: baseName + ".jpg",
    mime: "image/jpeg",
    data: stripDataUrl(out),
    sizeBytes: dataUrlBytes(out)
  };
}

/** Convenience: prepare many files, collecting per-file errors instead of
 *  aborting the whole batch. Returns { ok: [...], errors: [message] }. */
export async function prepareAll(files) {
  const ok = [];
  const errors = [];
  for (const f of files) {
    try {
      ok.push(await prepareAttachment(f));
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  return { ok, errors };
}

// ---------------- Cross-client compatibility ----------------
//
// The Android app writes these same nodes, and it does not necessarily use
// our field names or our encoding. Android's
// Base64.encodeToString(bytes, NO_WRAP) produces BARE base64, while a
// browser's FileReader.readAsDataURL produces "data:image/jpeg;base64,...".
// Reading is where we can be generous, so we are: every alias below is
// checked, and both encodings are accepted.
//
// Writing has to pick one shape - see writeShape() at the bottom of this
// file for the single place that decides it.

const DATA_KEYS = ["data", "base64", "dataBase64", "base64Data", "content", "fileData", "bytes", "imageBase64", "docBase64"];
const MIME_KEYS = ["mime", "mimeType", "contentType", "type"];
const NAME_KEYS = ["name", "fileName", "filename", "displayName", "title"];
const SIZE_KEYS = ["sizeBytes", "size", "fileSize", "length", "byteCount"];

function firstString(rec, keys) {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}
function firstNumber(rec, keys) {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return 0;
}

/** Sniff the type from the base64 payload's magic bytes when no mime is stored. */
function sniffMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("JVBER")) return "application/pdf";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Coerce whatever shape a client stored into one we can render.
 * Returns { name, mime, sizeBytes, base64 } or null if there's no payload.
 */
export function normalizeAttachment(rec) {
  if (!rec || typeof rec !== "object") return null;

  let raw = firstString(rec, DATA_KEYS);
  if (!raw) return null;

  // Strip a data-URL header if there is one, and prefer the mime it declares
  // over any separately-stored field - it describes the actual bytes.
  let declaredMime = "";
  const m = /^data:([^;,]*)(;[^,]*)?,/.exec(raw);
  if (m) {
    declaredMime = m[1] || "";
    raw = raw.slice(m[0].length);
  }

  // Android's NO_WRAP is clean, but DEFAULT inserts newlines every 76 chars
  // and some encoders emit URL-safe base64. atob() rejects both.
  const base64 = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!base64) return null;

  const mime = declaredMime || firstString(rec, MIME_KEYS) || sniffMime(base64);
  const name = firstString(rec, NAME_KEYS) ||
    ("attachment" + (mime.includes("pdf") ? ".pdf" : mime.includes("png") ? ".png" : ".jpg"));

  return {
    name,
    mime,
    base64,
    sizeBytes: firstNumber(rec, SIZE_KEYS) || Math.floor(base64.length * 3 / 4)
  };
}

function base64ToBlob(base64, mime) {
  // Restore padding some encoders omit, or atob() throws on the tail.
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

/** Open an attachment in the browser's own viewer (new tab). */
export function openAttachment(att) {
  const norm = normalizeAttachment(att);
  if (!norm) {
    window.showSnackbar?.("Attachment is empty or in a format this app can't read");
    console.warn("unreadable attachment record", att && Object.keys(att));
    return;
  }
  try {
    const url = URL.createObjectURL(base64ToBlob(norm.base64, norm.mime));
    const win = window.open(url, "_blank");
    if (!win) {
      // Popup blocked - fall back to a download so the user still gets the
      // file rather than a silent no-op.
      const a = document.createElement("a");
      a.href = url;
      a.download = norm.name;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    console.error("attachment decode failed", e);
    window.showSnackbar?.("Couldn't open attachment: " + (e.message || "bad data"));
  }
}

// ---------------- Handover documents ----------------

/**
 * Store one prepared attachment against a handover. Writes the blob and the
 * lightweight index entry, in that order, so a half-finished upload never
 * shows a card row pointing at nothing.
 */
export async function saveHandoverDoc(handoverKey, att, user) {
  const docRef = push(ref(db, "handoverDocs/" + handoverKey));
  const docId = docRef.key;
  await set(docRef, {
    name: att.name,
    mime: att.mime,
    sizeBytes: att.sizeBytes,
    data: att.data,
    uploadedByEmail: user?.email || "",
    uploadedAtMillis: serverTimestamp()
  });
  await update(ref(db, "handovers/" + handoverKey + "/documents/" + docId), {
    name: att.name,
    mime: att.mime,
    sizeBytes: att.sizeBytes
  });
  return docId;
}

export async function loadHandoverDoc(handoverKey, docId) {
  const snap = await get(ref(db, "handoverDocs/" + handoverKey + "/" + docId));
  return snap.val();
}

export async function removeHandoverDoc(handoverKey, docId) {
  // Index first: if the blob delete fails we're left with an orphan blob,
  // which is invisible and harmless. The reverse would leave a broken row.
  await fbRemove(ref(db, "handovers/" + handoverKey + "/documents/" + docId));
  await fbRemove(ref(db, "handoverDocs/" + handoverKey + "/" + docId)).catch(() => {});
}

/** Drop every blob for a handover (called when the handover itself is deleted). */
export async function removeAllHandoverDocs(handoverKey) {
  await fbRemove(ref(db, "handoverDocs/" + handoverKey)).catch(() => {});
}

// ---------------- Payment proofs ----------------

/** Upload a proof image and return its stable proofId. */
export async function savePaymentProof(att, user) {
  const proofRef = push(ref(db, "paymentProofs"));
  await set(proofRef, {
    name: att.name,
    mime: att.mime,
    sizeBytes: att.sizeBytes,
    data: att.data,
    uploadedByUid: user?.uid || "",
    uploadedByEmail: user?.email || "",
    uploadedAtMillis: serverTimestamp()
  });
  return proofRef.key;
}

export async function loadPaymentProof(proofId) {
  if (!proofId) return null;
  const snap = await get(ref(db, "paymentProofs/" + proofId));
  return snap.val();
}

export async function deletePaymentProof(proofId) {
  if (!proofId) return;
  await fbRemove(ref(db, "paymentProofs/" + proofId)).catch(() => {});
}

/** Fetch a proof and hand it straight to the system viewer. */
export async function viewPaymentProof(proofId) {
  const rec = await loadPaymentProof(proofId);
  if (!rec) { window.showSnackbar?.("Proof is no longer available"); return; }
  openAttachment(rec);
}

/** Fetch a handover document and hand it straight to the system viewer. */
export async function viewHandoverDoc(handoverKey, docId) {
  const rec = await loadHandoverDoc(handoverKey, docId);
  if (!rec) { window.showSnackbar?.("Document is no longer available"); return; }
  openAttachment(rec);
}
