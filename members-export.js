// Members export - the admin Members tab's "Export" button.
//
// Produces one workbook with three year sheets: the selected year and the two
// after it. Three sheets rather than one because the committee plans a rolling
// three-year window, and having next year's empty grid in the same file is
// what makes it usable as a printed collection sheet.
//
// Each sheet carries the full member profile plus a Jan-Dec column per month
// and a year total, so a row can be read end-to-end without cross-referencing
// the annual report.

import {
  getDatabase,
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseApp } from "./firebase-init.js?v=2026-08-19a";
import { loadXlsx } from "./lib-loader.js?v=2026-08-19a";

const db = getDatabase(firebaseApp);

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function rupeesNumeric(minor) {
  if (!minor) return 0;
  return Math.round(minor) / 100;
}

const PROFILE_HEADERS = [
  "Member ID",
  "Name",
  "Email",
  "Contact number",
  "Occupation",
  "Current address",
  "Permanent address",
  "Role",
  "Joined"
];

function profileCells(m) {
  return [
    m.memberId || "",
    m.displayName || "",
    m.email || "",
    m.contactNumber || "",
    m.occupation || "",
    m.currentAddress || "",
    m.permanentAddress || "",
    m.role || "Member",
    m.joinedAtMillis ? new Date(m.joinedAtMillis).toLocaleDateString("en-GB") : ""
  ];
}

/** Column widths so the sheet is readable without the user dragging borders. */
const COL_WIDTHS = [
  { wch: 10 },  // Member ID
  { wch: 24 },  // Name
  { wch: 28 },  // Email
  { wch: 16 },  // Contact
  { wch: 18 },  // Occupation
  { wch: 34 },  // Current address
  { wch: 34 },  // Permanent address
  { wch: 16 },  // Role
  { wch: 12 },  // Joined
  ...Array.from({ length: 12 }, () => ({ wch: 9 })),
  { wch: 13 }   // Year total
];

async function fetchAll() {
  const [membersSnap, paymentsSnap] = await Promise.all([
    get(ref(db, "members")),
    get(ref(db, "payments"))
  ]);

  const members = Object.entries(membersSnap.val() || {})
    .map(([uid, m]) => ({ uid, ...m }))
    .sort((a, b) => (a.memberId || "").localeCompare(b.memberId || ""));

  // uid -> { "YYYY-MM": totalMinor }
  const byMonth = {};
  Object.entries(paymentsSnap.val() || {}).forEach(([uid, byKey]) => {
    const map = {};
    Object.values(byKey || {}).forEach(p => {
      const k = p?.coversMonthKey;
      if (!k) return;
      map[k] = (map[k] || 0) + (p.amountMinor || 0);
    });
    byMonth[uid] = map;
  });

  return { members, byMonth };
}

function buildYearSheet(XLSX, year, members, byMonth) {
  const rows = [
    ["Hasnain Karimain Foundation - member register " + year],
    ["Generated", new Date().toLocaleString("en-IN")],
    [],
    [...PROFILE_HEADERS, ...MONTH_LABELS.map(m => m + " (₹)"), "Year total (₹)"]
  ];

  const monthTotals = new Array(12).fill(0);
  let grandTotal = 0;

  members.forEach(m => {
    const map = byMonth[m.uid] || {};
    const monthly = [];
    let yearTotal = 0;
    for (let i = 0; i < 12; i++) {
      const key = year + "-" + String(i + 1).padStart(2, "0");
      const minor = map[key] || 0;
      monthly.push(rupeesNumeric(minor));
      monthTotals[i] += minor;
      yearTotal += minor;
    }
    grandTotal += yearTotal;
    rows.push([...profileCells(m), ...monthly, rupeesNumeric(yearTotal)]);
  });

  // Footer totals line, aligned under the month columns.
  const footerLabel = new Array(PROFILE_HEADERS.length).fill("");
  footerLabel[0] = "TOTAL";
  rows.push([]);
  rows.push([
    ...footerLabel,
    ...monthTotals.map(rupeesNumeric),
    rupeesNumeric(grandTotal)
  ]);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = COL_WIDTHS;
  // Freeze the header row + the identifying columns so scrolling right keeps
  // you oriented on a 23-column sheet.
  sheet["!freeze"] = { xSplit: 2, ySplit: 4 };
  return sheet;
}

/**
 * Build and download the three-year member workbook.
 * @param {number} startYear the currently selected year
 */
export async function downloadMembersWorkbook(startYear) {
  const [XLSX, data] = await Promise.all([loadXlsx(), fetchAll()]);

  if (data.members.length === 0) {
    throw new Error("there are no members to export yet");
  }

  const wb = XLSX.utils.book_new();
  for (let i = 0; i < 3; i++) {
    const year = startYear + i;
    const sheet = buildYearSheet(XLSX, year, data.members, data.byMonth);
    XLSX.utils.book_append_sheet(wb, sheet, String(year));
  }

  XLSX.writeFile(wb, `hkf-members-${startYear}-${startYear + 2}.xlsx`);
}
