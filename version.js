// Single source of truth for the build identity.
//
// Two jobs:
//   1. Cache-busting. Every local import in this app carries "?v=<BUILD_ID>",
//      so a new build is a new URL and no browser or CDN can serve you the
//      previous one. The stamp MUST be identical everywhere - a module
//      imported under two different query strings loads twice, and shared
//      state (the selected year, for instance) silently splits in two.
//      Run ./bump-version.sh to rewrite them all at once.
//   2. Telling you at a glance which build is actually live. The id shows on
//      the sign-in screen and at the bottom of Settings, and is logged to the
//      browser console at startup.

export const BUILD_ID = "2026-09-02c";
