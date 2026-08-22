// Year report - generates a comprehensive PDF or XLSX of the foundation's
// data for a selected year. Loaded only when the user clicks Download so
// the libraries don't bloat first paint.
//
// Loaded via CDN as ESM to avoid bundling/build steps:
//   - jsPDF + jsPDF-AutoTable for PDF
//   - SheetJS (xlsx) for XLSX
//
// Data covered:
//   - Header with foundation name + selected year + generated timestamp
//   - Summary section (members, collection, handovers, balance)
//   - Per-month collection table
//   - All members + each member's payment record for the year
//   - All handovers (paid in year + all pending)
//
// Money is formatted with rupee sign and en-IN grouping. Dates use a short
// "DD MMM YYYY" format. The PDF is multi-page if needed (autotable handles
// page breaks).

import {
  getDatabase,
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-08-20a";
import { loadJsPdf, loadXlsx } from "./lib-loader.js?v=2026-08-20a";

const db = getDatabase(firebaseApp);

// Internal: rupee formatter shared with the rest of the app
function formatRupees(minor) {
  if (!minor || minor <= 0) return "\u20B90";
  const r = minor / 100;
  if (minor % 100 === 0) return "\u20B9" + Math.trunc(r).toLocaleString("en-IN");
  return "\u20B9" + r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Plain rupee number for spreadsheet cells (no symbol, full precision)
function rupeesNumeric(minor) {
  if (!minor) return 0;
  return Math.round(minor) / 100;
}

function formatDate(millis) {
  if (!millis || millis <= 0) return "-";
  return new Date(millis).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function monthLabel(monthKey) {
  if (!monthKey) return "-";
  const [y, m] = monthKey.split("-");
  const idx = parseInt(m, 10) - 1;
  if (idx < 0 || idx > 11) return monthKey;
  return MONTH_LABELS[idx] + " " + y;
}

/**
 * Pull /members, /payments, /handovers, /paymentRequests as one-shot reads.
 * Returns a normalized object the report builders consume. Filtering by the
 * target year happens here so each downstream builder stays simple.
 */
async function fetchYearData(year) {
  const yearPrefix = String(year) + "-";
  const [membersSnap, paymentsSnap, handoversSnap] = await Promise.all([
    get(ref(db, "members")),
    get(ref(db, "payments")),
    get(ref(db, "handovers"))
  ]);

  const members = Object.entries(membersSnap.val() || {})
    .map(([uid, m]) => ({ uid, ...m }))
    .sort((a, b) => (a.memberId || "").localeCompare(b.memberId || ""));

  // Per-uid list of payments in selected year
  const paymentsByUid = {};
  Object.entries(paymentsSnap.val() || {}).forEach(([uid, byKey]) => {
    const all = Object.entries(byKey || {}).map(([k, p]) => ({ key: k, ...p }));
    paymentsByUid[uid] = all.filter(p => (p.coversMonthKey || "").startsWith(yearPrefix));
  });

  // Handovers: paid scoped to year, pending shown always
  const handovers = Object.entries(handoversSnap.val() || {})
    .map(([k, h]) => ({ key: k, ...h }))
    .filter(h => {
      if ((h.status || "pending") !== "paid") return true;
      if (!h.paidAtMillis) return false;
      return new Date(h.paidAtMillis).getFullYear() === year;
    })
    .sort((a, b) => (a.applicationNumber || "").localeCompare(b.applicationNumber || ""));

  // Aggregate
  let totalCollectionMinor = 0;
  Object.values(paymentsByUid).forEach(list => {
    list.forEach(p => { totalCollectionMinor += (p.amountMinor || 0); });
  });
  let totalHandoverPaidMinor = 0;
  let paidCount = 0;
  let pendingCount = 0;
  handovers.forEach(h => {
    if (h.status === "paid") {
      paidCount++;
      totalHandoverPaidMinor += (h.amountMinor || 0);
    } else {
      pendingCount++;
    }
  });

  // Per-month collection
  const collectionByMonth = {};
  Object.values(paymentsByUid).forEach(list => {
    list.forEach(p => {
      const k = p.coversMonthKey;
      if (!k) return;
      collectionByMonth[k] = (collectionByMonth[k] || 0) + (p.amountMinor || 0);
    });
  });

  const activeMembers = members.filter(m => (paymentsByUid[m.uid] || []).length > 0).length;

  return {
    year,
    members,
    paymentsByUid,
    handovers,
    summary: {
      activeMembers,
      totalMembers: members.length,
      totalCollectionMinor,
      totalHandoverPaidMinor,
      pendingBalanceMinor: totalCollectionMinor - totalHandoverPaidMinor,
      handoverPaidCount: paidCount,
      handoverPendingCount: pendingCount,
      collectionByMonth
    }
  };
}

// The CDN loaders live in lib-loader.js so the Members export can reuse the
// same SheetJS download instead of pulling it twice.

// PDF report ---------------------------------------------------------------

export async function downloadYearReportPdf(year) {
  const [JsPDF, data] = await Promise.all([loadJsPdf(), fetchYearData(year)]);
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const margin = 40;
  let y = margin;

  // Title block
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Hasnain Karimain Foundation", margin, y);
  y += 22;
  doc.setFontSize(13);
  doc.setFont("helvetica", "normal");
  doc.text("Annual Report \u2014 " + year, margin, y);
  y += 16;
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text("Generated " + new Date().toLocaleString("en-IN"), margin, y);
  doc.setTextColor(0);
  y += 18;

  // Summary section
  const s = data.summary;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Summary", margin, y);
  y += 6;
  doc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    theme: "grid",
    headStyles: { fillColor: [154, 106, 31], textColor: 255 },
    styles: { fontSize: 9, cellPadding: 4 },
    head: [["Metric", "Value"]],
    body: [
      ["Active members (paid in " + year + ")", s.activeMembers + " of " + s.totalMembers],
      ["Total collection", formatRupees(s.totalCollectionMinor)],
      ["Handovers - paid", s.handoverPaidCount + " (" + formatRupees(s.totalHandoverPaidMinor) + ")"],
      ["Handovers - pending", s.handoverPendingCount.toString()],
      ["Pending balance (collection - handover)", formatRupees(s.pendingBalanceMinor)]
    ]
  });
  y = doc.lastAutoTable.finalY + 18;

  // Per-month collection table
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Monthly Collection", margin, y);
  y += 6;
  const monthRows = [];
  for (let i = 0; i < 12; i++) {
    const monthKey = year + "-" + String(i + 1).padStart(2, "0");
    monthRows.push([
      MONTH_LABELS[i] + " " + year,
      formatRupees(s.collectionByMonth[monthKey] || 0)
    ]);
  }
  doc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    theme: "grid",
    headStyles: { fillColor: [154, 106, 31], textColor: 255 },
    styles: { fontSize: 9, cellPadding: 4 },
    head: [["Month", "Total Collected"]],
    body: monthRows
  });
  y = doc.lastAutoTable.finalY + 18;

  // Members section - one table for the directory, then per-member payment list
  doc.addPage();
  y = margin;
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Members", margin, y);
  y += 18;

  doc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    theme: "grid",
    headStyles: { fillColor: [154, 106, 31], textColor: 255 },
    styles: { fontSize: 9, cellPadding: 4 },
    head: [["ID", "Name", "Email", "Role", "Paid in " + year, "All-time Total"]],
    body: data.members.map(m => {
      const list = data.paymentsByUid[m.uid] || [];
      const paidYear = list.reduce((acc, p) => acc + (p.amountMinor || 0), 0);
      return [
        m.memberId || "-",
        m.displayName || (m.email || "").split("@")[0] || "-",
        m.email || "-",
        m.role || "Member",
        formatRupees(paidYear),
        formatRupees(m.totalPaidMinor || 0)
      ];
    })
  });
  y = doc.lastAutoTable.finalY + 18;

  // Per-member payment detail
  data.members.forEach((m, i) => {
    const list = data.paymentsByUid[m.uid] || [];
    if (list.length === 0) return;

    if (y > 720) { doc.addPage(); y = margin; }
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text(`${m.memberId || "-"} \u2014 ${m.displayName || m.email || ""}`, margin, y);
    y += 4;
    doc.autoTable({
      startY: y + 4,
      margin: { left: margin, right: margin },
      theme: "striped",
      headStyles: { fillColor: [232, 194, 106], textColor: 30 },
      styles: { fontSize: 8, cellPadding: 3 },
      head: [["Month", "Amount", "Date paid", "Category", "Recorded by"]],
      body: list
        .sort((a, b) => (a.coversMonthKey || "").localeCompare(b.coversMonthKey || ""))
        .map(p => [
          monthLabel(p.coversMonthKey),
          formatRupees(p.amountMinor || 0),
          formatDate(p.dateMillis || p.recordedAtMillis),
          p.category || "-",
          p.recordedByEmail || "-"
        ])
    });
    y = doc.lastAutoTable.finalY + 10;
  });

  // Handovers section
  doc.addPage();
  y = margin;
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Handovers", margin, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text("Paid handovers in " + year + " plus all pending applications.", margin, y + 8);
  doc.setTextColor(0);
  y += 22;

  doc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    theme: "grid",
    headStyles: { fillColor: [154, 106, 31], textColor: 255 },
    styles: { fontSize: 8, cellPadding: 3 },
    head: [["App #", "Person", "City", "Mobile", "Amount", "Status", "Application date", "Paid date"]],
    body: data.handovers.map(h => [
      h.applicationNumber || "-",
      h.personName || "-",
      h.city || "-",
      h.mobileNumber || "-",
      formatRupees(h.amountMinor || 0),
      h.status === "paid" ? "Paid" : "Pending",
      formatDate(h.applicationDateMillis),
      h.paidAtMillis ? formatDate(h.paidAtMillis) : "-"
    ])
  });

  doc.save(`hkf-report-${year}.pdf`);
}

// XLSX report --------------------------------------------------------------

export async function downloadYearReportXlsx(year) {
  const [XLSX, data] = await Promise.all([loadXlsx(), fetchYearData(year)]);
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const s = data.summary;
  const summaryRows = [
    ["Hasnain Karimain Foundation"],
    ["Annual Report", year],
    ["Generated", new Date().toLocaleString("en-IN")],
    [],
    ["Metric", "Value"],
    ["Active members (paid in " + year + ")", s.activeMembers],
    ["Total members", s.totalMembers],
    ["Total collection (\u20B9)", rupeesNumeric(s.totalCollectionMinor)],
    ["Handovers - paid count", s.handoverPaidCount],
    ["Handovers - paid total (\u20B9)", rupeesNumeric(s.totalHandoverPaidMinor)],
    ["Handovers - pending count", s.handoverPendingCount],
    ["Pending balance (\u20B9)", rupeesNumeric(s.pendingBalanceMinor)],
    [],
    ["Month", "Total collected (\u20B9)"]
  ];
  for (let i = 0; i < 12; i++) {
    const monthKey = year + "-" + String(i + 1).padStart(2, "0");
    summaryRows.push([
      MONTH_LABELS[i] + " " + year,
      rupeesNumeric(s.collectionByMonth[monthKey] || 0)
    ]);
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // Members sheet - directory + each row's year total
  const memberRows = [
    ["Member ID", "Name", "Email", "Role", "Paid in " + year + " (\u20B9)", "All-time total (\u20B9)", "Joined"]
  ];
  data.members.forEach(m => {
    const list = data.paymentsByUid[m.uid] || [];
    const paidYear = list.reduce((acc, p) => acc + (p.amountMinor || 0), 0);
    memberRows.push([
      m.memberId || "",
      m.displayName || (m.email || "").split("@")[0] || "",
      m.email || "",
      m.role || "Member",
      rupeesNumeric(paidYear),
      rupeesNumeric(m.totalPaidMinor || 0),
      m.joinedAtMillis ? new Date(m.joinedAtMillis).toLocaleDateString("en-GB") : ""
    ]);
  });
  const memberSheet = XLSX.utils.aoa_to_sheet(memberRows);
  XLSX.utils.book_append_sheet(wb, memberSheet, "Members");

  // Payments sheet - every payment in the year, one row each
  const paymentRows = [
    ["Member ID", "Member Name", "Email", "Covers month", "Amount (\u20B9)", "Date paid", "Category", "Note", "Recorded by"]
  ];
  data.members.forEach(m => {
    const list = (data.paymentsByUid[m.uid] || [])
      .sort((a, b) => (a.coversMonthKey || "").localeCompare(b.coversMonthKey || ""));
    list.forEach(p => {
      paymentRows.push([
        m.memberId || "",
        m.displayName || "",
        m.email || "",
        monthLabel(p.coversMonthKey),
        rupeesNumeric(p.amountMinor || 0),
        p.dateMillis ? new Date(p.dateMillis).toLocaleDateString("en-GB")
          : (p.recordedAtMillis ? new Date(p.recordedAtMillis).toLocaleDateString("en-GB") : ""),
        p.category || "",
        p.note || "",
        p.recordedByEmail || ""
      ]);
    });
  });
  const paymentsSheet = XLSX.utils.aoa_to_sheet(paymentRows);
  XLSX.utils.book_append_sheet(wb, paymentsSheet, "Payments");

  // Handovers sheet
  const handoverRows = [
    ["App #", "Person", "Address", "City", "Mobile", "Purpose", "Amount (\u20B9)", "Status", "Application date", "Paid date", "Paid by", "Reference member"]
  ];
  data.handovers.forEach(h => {
    handoverRows.push([
      h.applicationNumber || "",
      h.personName || "",
      h.address || "",
      h.city || "",
      h.mobileNumber || "",
      h.purpose || "",
      rupeesNumeric(h.amountMinor || 0),
      h.status === "paid" ? "Paid" : "Pending",
      h.applicationDateMillis ? new Date(h.applicationDateMillis).toLocaleDateString("en-GB") : "",
      h.paidAtMillis ? new Date(h.paidAtMillis).toLocaleDateString("en-GB") : "",
      h.paidByEmail || "",
      h.referenceMemberName ? (h.referenceMemberId + " " + h.referenceMemberName).trim() : ""
    ]);
  });
  const handoverSheet = XLSX.utils.aoa_to_sheet(handoverRows);
  XLSX.utils.book_append_sheet(wb, handoverSheet, "Handovers");

  XLSX.writeFile(wb, `hkf-report-${year}.xlsx`);
}
