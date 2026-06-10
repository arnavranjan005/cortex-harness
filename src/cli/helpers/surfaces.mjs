// Re-export facade — preserves the original import path for all consumers and tests.
// Implementation is split across surfaces/ sub-modules by concern.
export { PRUNE_DIRS, SURFACE_PATTERNS, detectSurfaces } from "./surfaces/detect.mjs";
export { confirmSurfaces } from "./surfaces/confirm.mjs";
export { patchAgentScopes, applySurfaces } from "./surfaces/patch.mjs";
