/**
 * Plain-text sanitization for JSON APIs consumed by Angular (or other clients).
 * Do NOT HTML-escape stored plain text: clients render with text interpolation and
 * will show &quot; literally; Angular already escapes XSS in {{ }} bindings.
 *
 * Use escapeHtml() only if you concatenate user input into raw HTML on the server
 * (e.g. email HTML without a templating layer) — not for normal REST body storage.
 */
const validator = require('validator');

/**
 * Escape HTML entities for rare server-side HTML concatenation contexts.
 */
function escapeHtml(str) {
  if (str == null || typeof str !== 'string') return '';
  return validator.escape(str.trim());
}

/**
 * Decode common HTML entities produced by validator.escape / legacy storage.
 * Safe to run on plain text; repeats until stable to fix double-encoding.
 */
function decodeHtmlEntities(str) {
  if (str == null || typeof str !== 'string') return '';
  let s = str;
  let prev;
  let guard = 0;
  do {
    prev = s;
    s = s
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/gi, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#039;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    guard += 1;
  } while (s !== prev && guard < 5);
  return s;
}

/**
 * Normalize plain text for storage: trim and optional max length. No HTML escaping.
 */
function sanitizeString(str, opts = {}) {
  const s = str == null ? '' : String(str).trim();
  if (opts.maxLength != null && s.length > opts.maxLength) {
    return s.slice(0, opts.maxLength);
  }
  return s;
}

/**
 * Escape special regex characters in a string for safe use in MongoDB $regex.
 */
function escapeRegex(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  escapeHtml,
  decodeHtmlEntities,
  sanitizeString,
  escapeRegex
};
