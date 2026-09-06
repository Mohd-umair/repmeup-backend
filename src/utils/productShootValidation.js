/**
 * Validation for the Content Studio "Product Shoot" generation contract.
 *
 * All enums/limits here are enforced server-side — the frontend Shoot Brief
 * only ever sends values from these same lists, but a malicious or buggy
 * client must not be able to inject arbitrary free text into the AI image
 * prompt (see fullstack rule: validate/sanitize all input at the boundary).
 */

const FIDELITY_MODES = ['strict', 'balanced', 'creative'];
const PRESETS = ['clean-studio', 'luxury-editorial', 'lifestyle', 'marketplace', 'social-ad', 'seasonal', 'custom'];
const BACKGROUNDS = ['white', 'black', 'gradient', 'lifestyle-scene', 'outdoor', 'textured-surface', 'brand-color', 'match-reference'];
const LIGHTING = ['soft-studio', 'dramatic', 'natural-daylight', 'golden-hour', 'high-key', 'low-key'];
const CAMERA_ANGLES = ['front', 'three-quarter', 'top-down', 'close-up', 'wide-shot'];
const PLACEMENTS = ['centered', 'off-center', 'floating', 'on-surface', 'in-hand'];
const RATIOS = ['1:1', '4:5', '9:16', '16:9'];
const MAX_STYLE_REFS = 3;
const MAX_CUSTOM_INSTRUCTIONS_LEN = 300;

/**
 * @param {object} shootConfig - raw client payload
 * @returns {{ value: object, errors: string[] }}
 */
function validateShootConfig(shootConfig) {
  const errors = [];
  const cfg = shootConfig && typeof shootConfig === 'object' ? shootConfig : {};
  const value = {};

  value.preset = PRESETS.includes(cfg.preset) ? cfg.preset : 'custom';
  if (cfg.background !== undefined) {
    if (!BACKGROUNDS.includes(cfg.background)) errors.push(`background must be one of: ${BACKGROUNDS.join(', ')}`);
    else value.background = cfg.background;
  }
  if (cfg.lighting !== undefined) {
    if (!LIGHTING.includes(cfg.lighting)) errors.push(`lighting must be one of: ${LIGHTING.join(', ')}`);
    else value.lighting = cfg.lighting;
  }
  if (cfg.cameraAngle !== undefined) {
    if (!CAMERA_ANGLES.includes(cfg.cameraAngle)) errors.push(`cameraAngle must be one of: ${CAMERA_ANGLES.join(', ')}`);
    else value.cameraAngle = cfg.cameraAngle;
  }
  if (cfg.placement !== undefined) {
    if (!PLACEMENTS.includes(cfg.placement)) errors.push(`placement must be one of: ${PLACEMENTS.join(', ')}`);
    else value.placement = cfg.placement;
  }
  if (cfg.aspectRatio !== undefined) {
    if (!RATIOS.includes(cfg.aspectRatio)) errors.push(`aspectRatio must be one of: ${RATIOS.join(', ')}`);
    else value.aspectRatio = cfg.aspectRatio;
  }
  value.includePeople = cfg.includePeople === true;
  value.textSafeZone = cfg.textSafeZone === true;

  if (cfg.customInstructions !== undefined) {
    const raw = String(cfg.customInstructions || '');
    if (raw.length > MAX_CUSTOM_INSTRUCTIONS_LEN) {
      errors.push(`customInstructions must be at most ${MAX_CUSTOM_INSTRUCTIONS_LEN} characters`);
    } else {
      // Strip control/prompt-injection-risky characters; keep plain text only.
      value.customInstructions = raw.replace(/[\n\r`{}]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, MAX_CUSTOM_INSTRUCTIONS_LEN);
    }
  }

  return { value, errors };
}

/**
 * @param {string} fidelityMode
 * @returns {string} a valid mode, defaulting to the safest ('strict') on bad input
 */
function normalizeFidelityMode(fidelityMode) {
  return FIDELITY_MODES.includes(fidelityMode) ? fidelityMode : 'strict';
}

/**
 * @param {any} ids - raw client value
 * @returns {{ value: string[], errors: string[] }}
 */
function validateStyleReferenceIds(ids) {
  const errors = [];
  if (ids === undefined || ids === null) return { value: [], errors };
  if (!Array.isArray(ids)) {
    return { value: [], errors: ['styleReferenceImageIds must be an array'] };
  }
  const deduped = [...new Set(ids.filter(Boolean).map(String))];
  if (deduped.length > MAX_STYLE_REFS) {
    errors.push(`styleReferenceImageIds supports at most ${MAX_STYLE_REFS} images`);
  }
  return { value: deduped.slice(0, MAX_STYLE_REFS), errors };
}

module.exports = {
  FIDELITY_MODES,
  PRESETS,
  BACKGROUNDS,
  LIGHTING,
  CAMERA_ANGLES,
  PLACEMENTS,
  RATIOS,
  MAX_STYLE_REFS,
  MAX_CUSTOM_INSTRUCTIONS_LEN,
  validateShootConfig,
  normalizeFidelityMode,
  validateStyleReferenceIds
};
