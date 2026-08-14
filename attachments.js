// Shared attachment plumbing for handover documents and payment proofs.
//
// Storage model (mirrors the Android app so both clients read each other's
// files): the *blob* and the *index* live at different RTDB paths.
//
//   /handovers/{key}/documents/{docId}   -> { name, mime, sizeBytes }   (index)
//   /handoverDocs/{key}/{docId}          -> { ..., data: "<base64>" }   (blob)
//
//   /paymentRequests/{key}.proofId       -> "<proofId>"                 (index)
//   /payments/{uid}/{key}.proofId        -> "<proofId>"                 (index)
//   /paymentProofs/{proofId}             -> { ..., data: "<base64>" }   (blob)
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
    const data = await readAsDataUrl(file);
    return {
      name: file.name || "document.pdf",
      mime: "application/pdf",
      data,
      sizeBytes: dataUrlBytes(data)
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
    data: out,
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

/** Open an attachment in the browser's own viewer (new tab). */
export function openAttachment(att) {
  if (!att || !att.data) {
    window.showSnackbar?.("Attachment is empty");
    return;
  }
  try {
    const comma = att.data.indexOf(",");
    const b64 = att.data.slice(comma + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: att.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (!win) {
      // Popup blocked — fall back to a same-tab download so the user still
      // gets the file rather than a silent no-op.
      const a = document.createElement("a");
      a.href = url;
      a.download = att.name || "attachment";
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    window.showSnackbar?.("Couldn't open attachment");
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
