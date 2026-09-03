// Selected-year state for the global year filter.
//
// Defaults to the current calendar year on every page load (no persistence).
//
// The year list is a ROLLING WINDOW around today: two years back, this year,
// two years forward. In 2026 that is 2024-2028; in 2027 it becomes 2025-2029
// on its own, with nothing to edit and no build to ship.
//
// It replaces the old fixed 2026-2030 list, which was going to strand the app
// twice over: no way to look back at 2024 or 2025, and a picker that quietly
// ran out in 2031.
//
// The list still GROWS to include any year the data actually mentions, so
// back-filling a member's 2022 payments makes 2022 appear on its own. Data
// layers call ensureYears() with the years they see in coversMonthKey values.
//
// NOTE: Android still hardcodes 2026-2030 in YearState.baseYears. Until that
// changes the two pickers offer different years — cosmetic, since this list is
// computed per client and never stored, but worth matching. The Kotlin is the
// same three lines; see ANDROID-COMPAT.md.

const YEARS_BACK = 2;
const YEARS_FORWARD = 2;

/** [thisYear - 2 ... thisYear + 2], computed fresh at load. */
function baseYears() {
  const now = new Date().getFullYear();
  const out = [];
  for (let y = now - YEARS_BACK; y <= now + YEARS_FORWARD; y++) out.push(y);
  return out;
}

let years = baseYears();
let selectedYear = clampToSupported(new Date().getFullYear());
const subscribers = new Set();
const yearListSubscribers = new Set();

function clampToSupported(year) {
  if (years.includes(year)) return year;
  // Before the earliest known year -> snap to it; after the latest -> snap to that.
  if (year < years[0]) return years[0];
  return years[years.length - 1];
}

export function getSelectedYear() {
  return selectedYear;
}

export function getSupportedYears() {
  return [...years];
}

/**
 * Merge years discovered in real data into the picker.
 * @param {Iterable<number>} seen years parsed from month keys
 */
export function ensureYears(seen) {
  const valid = [...seen].filter(y => Number.isInteger(y) && y >= 1990 && y <= 2099);
  if (valid.length === 0) return;
  const merged = [...new Set([...years, ...valid])].sort((a, b) => a - b);
  if (merged.length === years.length && merged.every((y, i) => y === years[i])) return;
  years = merged;
  yearListSubscribers.forEach(fn => {
    try { fn(getSupportedYears()); } catch (e) { console.warn("year-list subscriber error", e); }
  });
}

/** Parse the year out of a batch of "YYYY-MM" keys and register them. */
export function ensureYearsFromMonthKeys(monthKeys) {
  const seen = new Set();
  for (const k of monthKeys) {
    const y = parseInt(String(k || "").split("-")[0], 10);
    if (!Number.isNaN(y)) seen.add(y);
  }
  ensureYears(seen);
}

/** Subscribe to changes in the available-years list. Returns an unsubscribe. */
export function onYearListChange(callback) {
  yearListSubscribers.add(callback);
  return () => yearListSubscribers.delete(callback);
}

export function setSelectedYear(year) {
  const clamped = clampToSupported(year);
  if (clamped === selectedYear) return;
  selectedYear = clamped;
  subscribers.forEach(fn => {
    try { fn(selectedYear); } catch (e) { console.warn("year subscriber error", e); }
  });
}

/**
 * Subscribe to year changes. Returns an unsubscribe function. Subscribers
 * are NOT called immediately with the current year - caller should read
 * getSelectedYear() at mount time and use this only for live updates.
 */
export function onYearChange(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

/** Convenience: build the chart start month key like "2026-01" for the current year. */
export function chartStartForYear(year = selectedYear) {
  return year + "-01";
}

/**
 * N consecutive month keys starting at `start`, walking the calendar so year
 * boundaries are handled ("2026-11", 3) -> ["2026-11","2026-12","2027-01"].
 * Mirrors Android's MonthKey.nextN, including its behaviour on a malformed
 * start key: return it alone rather than inventing a range.
 */
export function nextNMonths(start, count) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(start || ""));
  if (!m) return [String(start || "")];
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return [String(start)];
  const out = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    const total = year * 12 + (month - 1) + i;
    out.push(Math.floor(total / 12) + "-" + String((total % 12) + 1).padStart(2, "0"));
  }
  return out;
}
