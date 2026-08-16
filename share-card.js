// "Share & refer" card.
//
// Renders a 1080x1350 branded image on a canvas and hands it to the OS share
// sheet, so a member can forward the foundation to WhatsApp in two taps. A
// portrait 4:5 frame is deliberate: that's the aspect WhatsApp and Instagram
// show without cropping.
//
// Where a browser has no Web Share API for files (most desktops), the image
// downloads instead and the user attaches it themselves.

// ---------------------------------------------------------------------------
// The link printed on the card comes from /settings/apkLink, which the owner
// edits in Settings and which the Android client uses for the same purpose -
// so both apps advertise one link. If that setting is empty we fall back to
// whatever origin this app is served from, which is a better default for the
// web than Android's "www.drive_dummy/HKF.apk" placeholder.
// ---------------------------------------------------------------------------

import {
  getDatabase,
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js";

const db = getDatabase(firebaseApp);

async function fetchApkLink() {
  try {
    const snap = await get(ref(db, "settings/apkLink"));
    return String(snap.val() || "").trim();
  } catch {
    return "";
  }
}

const W = 1080;
const H = 1350;

const NAVY = "#0E2046";
const NAVY_DEEP = "#071229";
const GOLD = "#C68A2E";
const GOLD_LIGHT = "#E8C26A";
const CREAM = "#F7F1E6";

function fallbackUrl() {
  const { origin, pathname } = window.location;
  // Trim index.html so the printed link stays short and typeable.
  const path = pathname.replace(/index\.html$/i, "");
  return (origin + path).replace(/\/$/, "");
}

/** Strip the scheme so the link reads as a domain on the card. */
function prettyUrl(url) {
  return url.replace(/^https?:\/\//i, "");
}

function formatRupees(minor) {
  if (!minor || minor <= 0) return "₹0";
  const r = minor / 100;
  if (minor % 100 === 0) return "₹" + Math.trunc(r).toLocaleString("en-IN");
  return "₹" + r.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function loadLogo() {
  return new Promise(resolve => {
    const img = new Image();
    // Same-origin, so the canvas stays untainted and toBlob works.
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);   // card still renders without it
    img.src = "Logo.png";
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function centeredText(ctx, text, y, { font, color, letterSpacing = 0 }) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  if (!letterSpacing) {
    ctx.fillText(text, W / 2, y);
    return;
  }
  // Manual letter-spacing: ctx.letterSpacing isn't in Safari yet.
  const chars = [...text];
  const width = chars.reduce((s, c) => s + ctx.measureText(c).width, 0) + letterSpacing * (chars.length - 1);
  let x = W / 2 - width / 2;
  ctx.textAlign = "left";
  chars.forEach(c => {
    ctx.fillText(c, x, y);
    x += ctx.measureText(c).width + letterSpacing;
  });
  ctx.textAlign = "center";
}

/**
 * Draw the card.
 * @param {{year:number, activeMembers:number, totalMembers:number, collectionMinor:number}} stats
 */
async function drawCard(stats, url) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Background wash
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, NAVY);
  bg.addColorStop(1, NAVY_DEEP);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Soft gold glow behind the logo
  const glow = ctx.createRadialGradient(W / 2, 300, 20, W / 2, 300, 420);
  glow.addColorStop(0, "rgba(198,138,46,0.30)");
  glow.addColorStop(1, "rgba(198,138,46,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 720);

  // Gold hairline frame
  ctx.strokeStyle = "rgba(232,194,106,0.45)";
  ctx.lineWidth = 3;
  roundRect(ctx, 40, 40, W - 80, H - 80, 36);
  ctx.stroke();

  // Logo
  const logo = await loadLogo();
  if (logo) {
    const size = 260;
    const x = (W - size) / 2;
    const y = 150;
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.clip();
    ctx.drawImage(logo, x, y, size, size);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(W / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.strokeStyle = GOLD_LIGHT;
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  centeredText(ctx, "HASNAIN KARIMAIN", 510, {
    font: "700 62px -apple-system, Segoe UI, Helvetica, sans-serif",
    color: CREAM, letterSpacing: 4
  });
  centeredText(ctx, "FOUNDATION", 580, {
    font: "700 62px -apple-system, Segoe UI, Helvetica, sans-serif",
    color: GOLD_LIGHT, letterSpacing: 10
  });

  centeredText(ctx, "Giving, recorded honestly.", 640, {
    font: "400 30px -apple-system, Segoe UI, Helvetica, sans-serif",
    color: "rgba(247,241,230,0.62)"
  });

  // Stat panel
  const panelY = 706;
  const panelH = 250;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, 100, panelY, W - 200, panelH, 28);
  ctx.fill();
  ctx.strokeStyle = "rgba(232,194,106,0.22)";
  ctx.lineWidth = 2;
  roundRect(ctx, 100, panelY, W - 200, panelH, 28);
  ctx.stroke();

  // Divider between the two stats
  ctx.beginPath();
  ctx.moveTo(W / 2, panelY + 44);
  ctx.lineTo(W / 2, panelY + panelH - 44);
  ctx.strokeStyle = "rgba(232,194,106,0.22)";
  ctx.lineWidth = 2;
  ctx.stroke();

  function stat(cx, label, value) {
    ctx.textAlign = "center";
    ctx.font = "500 26px -apple-system, Segoe UI, Helvetica, sans-serif";
    ctx.fillStyle = "rgba(247,241,230,0.55)";
    ctx.fillText(label, cx, panelY + 84);
    ctx.font = "700 66px -apple-system, Segoe UI, Helvetica, sans-serif";
    ctx.fillStyle = GOLD_LIGHT;
    ctx.fillText(value, cx, panelY + 168);
  }
  stat(W / 4 + 50, "ACTIVE MEMBERS", String(stats.activeMembers || 0));
  stat((3 * W) / 4 - 50, "COLLECTED " + stats.year, formatRupees(stats.collectionMinor || 0));

  // Call to action
  centeredText(ctx, "Join us — every contribution is", 1052, {
    font: "400 34px -apple-system, Segoe UI, Helvetica, sans-serif",
    color: "rgba(247,241,230,0.82)"
  });
  centeredText(ctx, "tracked, visible and accountable.", 1100, {
    font: "400 34px -apple-system, Segoe UI, Helvetica, sans-serif",
    color: "rgba(247,241,230,0.82)"
  });

  // Link chip
  const shown = prettyUrl(url);
  ctx.font = "600 34px -apple-system, Segoe UI, Helvetica, sans-serif";
  const urlW = ctx.measureText(shown).width;
  const chipW = Math.min(W - 160, urlW + 90);
  const chipX = (W - chipW) / 2;
  const chipGrad = ctx.createLinearGradient(chipX, 0, chipX + chipW, 0);
  chipGrad.addColorStop(0, GOLD);
  chipGrad.addColorStop(1, GOLD_LIGHT);
  ctx.fillStyle = chipGrad;
  roundRect(ctx, chipX, 1165, chipW, 82, 41);
  ctx.fill();
  ctx.fillStyle = "#20130A";
  ctx.textAlign = "center";
  ctx.fillText(shown, W / 2, 1218);

  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't render the image"))), "image/png", 0.95);
  });
}

/**
 * Build the card and open the share sheet (or download as a fallback).
 * @param {{year:number, activeMembers:number, totalMembers:number, collectionMinor:number}} stats
 */
export async function shareReferralCard(stats) {
  const url = (await fetchApkLink()) || fallbackUrl();
  const canvas = await drawCard(stats, url);
  const blob = await canvasToBlob(canvas);
  const fileName = `hkf-${stats.year}.png`;
  const file = new File([blob], fileName, { type: "image/png" });
  // Same copy Android puts in the share intent, so a forwarded message reads
  // identically whichever app it came from.
  const text = `Join the Hasnain Karimain Foundation! Download the app: ${url}`;

  // Feature-detect the file share before calling it: Android Chrome supports
  // it, iOS Safari supports it, most desktops don't, and calling share() with
  // an unsupported payload throws rather than degrading.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Hasnain Karimain Foundation", text });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      // Fall through to download.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  return "downloaded";
}
