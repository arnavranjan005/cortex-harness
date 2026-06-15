/**
 * Pure helpers for probe-urls.json assembly.
 * Kept separate so run-autonomous.mjs (which has top-level await) is not imported in tests.
 */

/**
 * Merge detected URLs with user-configured smokeUrls.
 * smokeUrls entries that are already in detected are deduplicated.
 * Returns { merged, appended } where appended is only the net-new entries from smokeUrls.
 */
export function mergeProbeUrls(detected = [], smokeUrls = []) {
  const detectedSet = new Set(detected);
  const appended = smokeUrls.filter(u => !detectedSet.has(u));
  return { merged: [...detected, ...appended], appended };
}
