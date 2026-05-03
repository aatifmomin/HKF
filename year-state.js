// Selected-year state for the global year filter.
//
// Defaults to the current calendar year on every page load (no persistence).
// Stage 1 of the year-filter rollout: only home.js reads this. In the next
// stage, Payments / Members / Handover will also subscribe.

const SUPPORTED_YEARS = [2026, 2027, 2028, 2029, 2030];

let selectedYear = clampToSupported(new Date().getFullYear());
const subscribers = new Set();

function clampToSupported(year) {
  if (SUPPORTED_YEARS.includes(year)) return year;
  // Today is < 2026 -> snap to 2026 (earliest supported)
  // Today is > 2030 -> snap to 2030 (latest supported)
  if (year < SUPPORTED_YEARS[0]) return SUPPORTED_YEARS[0];
  return SUPPORTED_YEARS[SUPPORTED_YEARS.length - 1];
}

export function getSelectedYear() {
  return selectedYear;
}

export function getSupportedYears() {
  return [...SUPPORTED_YEARS];
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
