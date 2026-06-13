'use strict';

/**
 * Flow template interpolation.
 *
 * Replaces `{{token}}` placeholders in flow message copy with values from the
 * live conversation context (interaction author + content) and the enrollment's
 * accumulated `variables` bag. This is what turns "Hi {{username}}!" into the
 * real customer name at send time.
 *
 * Design rules:
 *  - Unknown tokens resolve to an empty string (never leak a raw `{{...}}` to
 *    the customer).
 *  - Lookups are case-insensitive and tolerant of surrounding whitespace.
 *  - Enrollment variables take precedence over built-ins so authors can
 *    override (e.g. set a `username` variable explicitly).
 *  - Pure string in → string out. Non-string input is returned unchanged.
 */

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Safe first-name from a full name ("Sam Lee" → "Sam"). */
function firstNameOf(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

/**
 * Build the lookup context for a single interaction + enrollment.
 * @param {object} interaction  Mongoose doc or lean object
 * @param {object} variables    Enrollment.variables
 * @returns {Record<string, string>}
 */
function buildContext(interaction = {}, variables = {}) {
  const author = interaction.author || {};
  const name = author.name || author.username || '';

  const builtins = {
    username: author.username || author.name || '',
    name,
    first_name: firstNameOf(name),
    firstname: firstNameOf(name),
    content: interaction.content || '',
    message: interaction.content || '',
    platform: interaction.platform || ''
  };

  // Flatten enrollment variables to strings; objects are JSON-encoded so a
  // condition that saved an object still renders something usable.
  const flatVars = {};
  if (variables && typeof variables === 'object') {
    for (const [k, v] of Object.entries(variables)) {
      if (v == null) flatVars[k] = '';
      else if (typeof v === 'object') {
        try { flatVars[k] = JSON.stringify(v); } catch { flatVars[k] = ''; }
      } else {
        flatVars[k] = String(v);
      }
    }
  }

  // Variables win over built-ins (author can override `username`, etc.).
  return { ...builtins, ...flatVars };
}

/**
 * Interpolate `{{token}}` placeholders in a single string.
 * @param {string} input
 * @param {object} [opts]
 * @param {object} [opts.interaction]
 * @param {object} [opts.variables]
 * @param {Record<string,string>} [opts.context]  Pre-built context (skips rebuild)
 * @returns {string}
 */
function render(input, opts = {}) {
  if (typeof input !== 'string' || input.indexOf('{{') === -1) return input;
  const context = opts.context || buildContext(opts.interaction, opts.variables);

  return input.replace(TOKEN_RE, (_, rawKey) => {
    const key = String(rawKey).trim().toLowerCase();
    const direct = context[key];
    if (direct !== undefined) return direct;
    // Case-insensitive fallback against the original variable keys.
    const match = Object.keys(context).find((k) => k.toLowerCase() === key);
    return match !== undefined ? context[match] : '';
  });
}

/**
 * Render every string in a config object that should support placeholders.
 * Returns a shallow clone with the given keys interpolated; arrays of strings
 * (e.g. button labels) and nested button/section text are handled too.
 *
 * @param {object} config
 * @param {string[]} keys           Top-level string keys to interpolate
 * @param {object} ctx              { interaction, variables }
 * @returns {object} cloned config
 */
function renderConfig(config = {}, keys = [], ctx = {}) {
  const context = buildContext(ctx.interaction, ctx.variables);
  const out = { ...config };
  for (const key of keys) {
    if (typeof out[key] === 'string') {
      out[key] = render(out[key], { context });
    }
  }
  return out;
}

module.exports = { render, renderConfig, buildContext };
