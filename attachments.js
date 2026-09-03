// Shared attachment plumbing for handover documents and payment proofs.
//
// THE SHAPES BELOW ARE DICTATED BY THE ANDROID APP. Both clients read and
// write the same nodes, so this file is a port of HandoverRepository's
// document methods and PaymentProofRepository, not an independent design.
// Verified against the production RTDB export.
//
//   /handovers/{key}/documents/{docId} = {      <- index, rides the list listener
//     name:             String,   // "Screenshot_20260814.jpg"
//     type:             String,   // "jpg" | "pdf"   <- NOT a mime type
//     sizeBytes:        Long,
//     uploadedAtMillis: Long,
//     uploadedByEmail:  String
//   }
//   /handoverDocs/{key}/{docId} = {             <- blob, fetched only on View
//     name:   String,
//     type:   String,
//     base64: String              // BARE base64, Base64.NO_WRAP
//   }
//
//   /paymentRequests/{requestKey}.proofName = "upi.jpg"   <- the only flag
//   /paymentProofs/{requestKey} = { name, type, base64 }  <- keyed by REQUEST
//
// Two things here are easy to get wrong and were both wrong in the first
// version of this file:
//
//   * `type` is a file extension ("jpg"), not a mime type. Feeding it to a
//     Blob constructor produces a file the OS can't open.
//   * a payment proof is keyed by the payment-request key, not by an id of
//     its own. There is exactly one proof per request, and clearing it means
//     nulling that node — there is no proofId to chase.
//
// Writes go through a single multi-path update() so a failure can't leave a
// blob without an index row (or vice versa), matching Android's behaviour.

import {
  getDatabase,
  ref,
  get,
  update,
  push
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-09-02c";

const db = getDatabase(firebaseApp);

// Android caps compressed images at ~1.5 MB and rejects anything larger.
export const MAX_PDF_BYTES = 2 * 1024 * 1024;

// Match AttachmentUtils: 1600px long edge, quality ladder, ~1.5MB ceiling.
const IMAGE_MAX_DIM = 1600;
const IMAGE_QUALITY_STEPS = [0.75, 0.6, 0.45];
const IMAGE_TARGET_BYTES = 1_500_000;

export const ACCEPT_DOCS = "image/jpeg,image/jpg,image/png,application/pdf";
export const ACCEPT_IMAGES = "image/jpeg,image/jpg,image/png";

/**
 * Open the OS file picker and resolve with the chosen files. Resolves with an
 * empty array if the user cancels (there is no reliable cancel event, so we
 * fall back to resolving when the window regains focus).
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
    window.addEventListener("focus", () => {
      setTimeout(() => finish(Array.from(input.files || [])), 400);
    }, { once: true });

    input.click();
  });
}

export function formatBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/** "jpg" | "pdf" -> a mime type a Blob can actually use. */
export function mimeForType(type) {
  return String(type || "").toLowerCase() === "pdf" ? "application/pdf" : "image/jpeg";
}

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

/** Drop the "data:<mime>;base64," header so we store what Android stores. */
function stripDataUrl(dataUrl) {
  const m = /^data:[^;,]*(;[^,]*)?,/.exec(dataUrl);
  return m ? dataUrl.slice(m[0].length) : dataUrl;
}

function base64Bytes(b64) {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(b64.length * 3 / 4) - padding);
}

/**
 * Turn a picked File into a storable attachment: { name, type, base64, sizeBytes }.
 * Images are downscaled and re-encoded as JPEG; PDFs pass through with a cap.
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
    const base64 = stripDataUrl(await readAsDataUrl(file));
    return {
      name: file.name || "document.pdf",
      type: "pdf",
      base64,
      sizeBytes: base64Bytes(base64)
    };
  }

  // Android names the output "{original base}.jpg" regardless of input format,
  // so a PNG attached on either client shows the same filename on both.
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
    out = stripDataUrl(canvas.toDataURL("image/jpeg", q));
    if (base64Bytes(out) <= IMAGE_TARGET_BYTES) break;
  }
  if (!out) throw new Error("Couldn't compress " + file.name);

  const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
  return {
    name: baseName + ".jpg",
    type: "jpg",
    base64: out,
    sizeBytes: base64Bytes(out)
  };
}

/**
 * Tighter variant of prepareAttachment for images that live inside a record
 * a list listener downloads (announcement banners, collector QRs). Android's
 * compressBitmapTo200Kb walks the quality ladder, then halves the bitmap once
 * if it still doesn't fit; this does the same with the same 1280px long edge
 * and 200 KB ceiling, so a picture attached on either client is about the
 * same weight on the wire.
 */
export async function prepareImageWithin(file, maxBytes = 200_000, maxDim = 1280) {
  const mime = (file.type || "").toLowerCase();
  if (!mime.startsWith("image/")) throw new Error(`"${file.name}" isn't a JPG or PNG`);

  const img = await loadImage(await readAsDataUrl(file));

  function encode(w, h, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return stripDataUrl(canvas.toDataURL("image/jpeg", quality));
  }

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  let w = Math.round(img.width * scale);
  let h = Math.round(img.height * scale);

  let out = "";
  for (let q = 0.88; q >= 0.35; q -= 0.08) {
    out = encode(w, h, q);
    if (base64Bytes(out) <= maxBytes) break;
  }
  if (base64Bytes(out) > maxBytes) {
    out = encode(Math.round(w / 2), Math.round(h / 2), 0.7);
  }
  if (base64Bytes(out) > maxBytes) {
    throw new Error("That image is too detailed to fit — try a smaller crop");
  }

  const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
  return { name: baseName + ".jpg", type: "jpg", base64: out, sizeBytes: base64Bytes(out) };
}

/** Prepare many files, collecting per-file errors instead of aborting. */
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

// ---------------- Reading (deliberately lenient) ----------------
//
// The canonical shape is { name, type, base64 }, but this database already
// contains rows written by an earlier version of this web app in a different
// shape ({ name, mime, data: "data:image/jpeg;base64,..." }). Rather than
// migrate them we read both, plus the obvious aliases, so no existing
// attachment becomes unopenable.

const DATA_KEYS = ["base64", "data", "dataBase64", "base64Data", "content"];
const TYPE_KEYS = ["type", "mime", "mimeType", "contentType"];
const NAME_KEYS = ["name", "fileName", "filename", "displayName"];
const SIZE_KEYS = ["sizeBytes", "size", "fileSize", "length"];

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

/** Last resort when nothing declares a type: read the payload's magic bytes. */
function sniffMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("JVBER")) return "application/pdf";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Coerce any stored attachment row into { name, mime, sizeBytes, base64 },
 * or null when there's no payload. Handles the "jpg"-vs-"image/jpeg"
 * ambiguity: a value with no slash is treated as a file extension.
 */
export function normalizeAttachment(rec) {
  if (!rec || typeof rec !== "object") return null;

  let raw = firstString(rec, DATA_KEYS);
  if (!raw) return null;

  // A data: URL declares its own type, and that beats any stored field
  // because it describes the actual bytes.
  let declaredMime = "";
  const m = /^data:([^;,]*)(;[^,]*)?,/.exec(raw);
  if (m) {
    declaredMime = m[1] || "";
    raw = raw.slice(m[0].length);
  }

  // Base64.DEFAULT wraps at 76 chars; some encoders emit URL-safe alphabets.
  const base64 = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!base64) return null;

  let mime = declaredMime;
  if (!mime) {
    const stored = firstString(rec, TYPE_KEYS);
    // "jpg"/"pdf" are extensions; "image/jpeg" is a mime type.
    mime = stored.includes("/") ? stored : (stored ? mimeForType(stored) : "");
  }
  if (!mime) mime = sniffMime(base64);

  const name = firstString(rec, NAME_KEYS) ||
    ("attachment" + (mime.includes("pdf") ? ".pdf" : ".jpg"));

  return { name, mime, base64, sizeBytes: firstNumber(rec, SIZE_KEYS) || base64Bytes(base64) };
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
export function openAttachment(rec) {
  const norm = normalizeAttachment(rec);
  if (!norm) {
    console.warn("unreadable attachment record", rec && Object.keys(rec));
    window.showSnackbar?.("Attachment is empty or in a format this app can't read");
    return;
  }
  try {
    const url = URL.createObjectURL(base64ToBlob(norm.base64, norm.mime));
    const win = window.open(url, "_blank");
    if (!win) {
      // Popup blocked - fall back to a download so the user still gets it.
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
 * Attach one prepared document to a handover. Index and blob are written in a
 * single multi-path update, so a failure can't leave a card row pointing at
 * nothing (Android's HandoverRepository.addDocument does the same).
 */
export async function saveHandoverDoc(handoverKey, att, user) {
  const docId = push(ref(db, "handoverDocs/" + handoverKey)).key;
  await update(ref(db), {
    [`handovers/${handoverKey}/documents/${docId}`]: {
      name: att.name,
      type: att.type,
      sizeBytes: att.sizeBytes,
      uploadedAtMillis: Date.now(),
      uploadedByEmail: user?.email || ""
    },
    [`handoverDocs/${handoverKey}/${docId}`]: {
      name: att.name,
      type: att.type,
      base64: att.base64
    }
  });
  return docId;
}

export async function loadHandoverDoc(handoverKey, docId) {
  const snap = await get(ref(db, "handoverDocs/" + handoverKey + "/" + docId));
  return snap.val();
}

/** Remove index + blob together. */
export async function removeHandoverDoc(handoverKey, docId) {
  await update(ref(db), {
    [`handovers/${handoverKey}/documents/${docId}`]: null,
    [`handoverDocs/${handoverKey}/${docId}`]: null
  });
}

/** Drop every blob for a handover (called when the handover itself goes). */
export async function removeAllHandoverDocs(handoverKey) {
  await update(ref(db), { [`handoverDocs/${handoverKey}`]: null }).catch(() => {});
}

/** Fetch a handover document and hand it to the system viewer. */
export async function viewHandoverDoc(handoverKey, docId) {
  const rec = await loadHandoverDoc(handoverKey, docId);
  if (!rec) { window.showSnackbar?.("Couldn't load document"); return; }
  openAttachment(rec);
}

// ---------------- Payment proofs ----------------
//
// One proof per payment request, stored under the REQUEST's own key. The
// request row carries `proofName` and nothing else - its presence is the flag
// that a proof exists.

/** Attach (or replace) the proof image for a request. */
export async function savePaymentProof(requestKey, att) {
  await update(ref(db), {
    [`paymentRequests/${requestKey}/proofName`]: att.name,
    [`paymentProofs/${requestKey}`]: {
      name: att.name,
      type: att.type,
      base64: att.base64
    }
  });
}

/** Clear the proof image and the request's flag in one update. */
export async function removePaymentProof(requestKey) {
  await update(ref(db), {
    [`paymentRequests/${requestKey}/proofName`]: "",
    [`paymentProofs/${requestKey}`]: null
  });
}

export async function loadPaymentProof(requestKey) {
  if (!requestKey) return null;
  const snap = await get(ref(db, "paymentProofs/" + requestKey));
  return snap.val();
}

// ---------------- Payment QR (owner-uploaded, shown to members) ----------------
//
// /settings/paymentQr = { name, base64 }
//
// Kept out of the live /settings listener on purpose: every member's client
// subscribes to /settings for the reminder text, and an inline image would be
// re-downloaded on every unrelated settings change. The observer only checks
// whether `name` is set; the blob is fetched on demand.

export async function savePaymentQr(att) {
  await update(ref(db, "settings/paymentQr"), {
    name: att.name,
    base64: att.base64
  });
}

export async function removePaymentQr() {
  await update(ref(db, "settings"), { paymentQr: null });
}

/** One-shot blob fetch. Returns { name, base64 } or null. */
export async function loadPaymentQr() {
  const snap = await get(ref(db, "settings/paymentQr"));
  const v = snap.val();
  return v && v.base64 ? v : null;
}

/** Fetch a proof and hand it straight to the system viewer. */
export async function viewPaymentProof(requestKey) {
  const rec = await loadPaymentProof(requestKey);
  if (!rec) { window.showSnackbar?.("Couldn't load proof"); return; }
  openAttachment(rec);
}
