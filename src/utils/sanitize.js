/**
 * Input sanitization for user-controlled data that is stored or reflected in HTML.
 * Use escapeHtml for plain text that will be displayed as text; it prevents XSS when
 * content is later bound to HTML (e.g. in attributes or escaped contexts).
 */
const validator = require('validator');

/**
 * Escape HTML entities in a string so it is safe to embed in HTML as text.
 * @param {string} str - User input
 * @returns {string} Escaped string (empty string if input is not a string)
 */
function escapeHtml(str) {
  if (str == null || typeof str !== 'string') return '';
  return validator.escape(str.trim());
}

/**
 * Sanitize a string for safe storage/reflection: trim and escape HTML.
 * Optionally enforce max length (no truncation; validation should reject).
 * @param {string} str - User input
 * @param {object} opts - { maxLength: number } optional
 * @returns {string}
 */
function sanitizeString(str, opts = {}) {
  const s = str == null ? '' : String(str).trim();
  const escaped = validator.escape(s);
  if (opts.maxLength != null && escaped.length > opts.maxLength) {
    return escaped.slice(0, opts.maxLength);
  }
  return escaped;
}

/**
 * Escape special regex characters in a string for safe use in MongoDB $regex.
 * @param {string} str - User input
 * @returns {string} Escaped string safe for regex
 */
function escapeRegex(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  escapeHtml,
  sanitizeString,
  escapeRegex
};
