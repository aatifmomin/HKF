// Lazy CDN script loading, shared by the report/export modules.
//
// Both year-report.js and members-export.js need SheetJS, and only one of
// them should ever pay for the download. Keeping the promise cache here
// means the second caller reuses the first caller's <script> tag.

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      // Another module already injected this tag. If it has finished we can
      // resolve immediately; otherwise piggy-back on its load event.
      if (existing.dataset.loaded === "1") { resolve(); return; }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load " + src)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

let xlsxPromise = null;
export async function loadXlsx() {
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = (async () => {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    if (!window.XLSX) throw new Error("XLSX failed to load");
    return window.XLSX;
  })();
  return xlsxPromise;
}

let jsPdfPromise = null;
export async function loadJsPdf() {
  if (jsPdfPromise) return jsPdfPromise;
  jsPdfPromise = (async () => {
    // jsPDF + autotable as classic <script> tags. Easier than ESM imports
    // because both libraries attach to window and autotable patches jsPDF.
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.0/jspdf.plugin.autotable.min.js");
    if (!window.jspdf) throw new Error("jsPDF failed to load");
    return window.jspdf.jsPDF;
  })();
  return jsPdfPromise;
}
