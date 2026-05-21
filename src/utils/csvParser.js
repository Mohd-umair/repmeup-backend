'use strict';

/**
 * Tiny RFC-4180-compliant CSV parser.
 *
 *  - Supports quoted fields with embedded commas, newlines, and escaped quotes ("")
 *  - Handles both \r\n and \n line endings
 *  - Skips a leading UTF-8 BOM
 *  - Returns { headers, rows } when `hasHeader` is true (default),
 *    or { headers: [], rows } when false.
 *  - Throws no errors — malformed lines just produce best-effort values.
 *
 * No external dependencies (keeps deploy surface small).
 */

const STATE_FIELD_START = 0;
const STATE_UNQUOTED = 1;
const STATE_QUOTED = 2;
const STATE_QUOTED_QUOTE = 3;

/**
 * Tokenize a CSV string into an array of rows (each row is an array of fields).
 */
function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  // Strip leading BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let state = STATE_FIELD_START;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (state === STATE_FIELD_START) {
      if (ch === '"') {
        state = STATE_QUOTED;
      } else if (ch === ',') {
        pushField();
      } else if (ch === '\n') {
        pushField();
        pushRow();
      } else if (ch === '\r') {
        // skip — handled on \n; but bare \r is also a newline
        if (text[i + 1] !== '\n') {
          pushField();
          pushRow();
        }
      } else {
        field += ch;
        state = STATE_UNQUOTED;
      }
      continue;
    }

    if (state === STATE_UNQUOTED) {
      if (ch === ',') {
        pushField();
        state = STATE_FIELD_START;
      } else if (ch === '\n') {
        pushField();
        pushRow();
        state = STATE_FIELD_START;
      } else if (ch === '\r') {
        if (text[i + 1] !== '\n') {
          pushField();
          pushRow();
          state = STATE_FIELD_START;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (state === STATE_QUOTED) {
      if (ch === '"') {
        state = STATE_QUOTED_QUOTE;
      } else {
        field += ch;
      }
      continue;
    }

    if (state === STATE_QUOTED_QUOTE) {
      if (ch === '"') {
        // Escaped quote inside quoted field
        field += '"';
        state = STATE_QUOTED;
      } else if (ch === ',') {
        pushField();
        state = STATE_FIELD_START;
      } else if (ch === '\n') {
        pushField();
        pushRow();
        state = STATE_FIELD_START;
      } else if (ch === '\r') {
        if (text[i + 1] !== '\n') {
          pushField();
          pushRow();
          state = STATE_FIELD_START;
        }
      } else {
        // Lenient — treat as end of quoted field
        field += ch;
        state = STATE_UNQUOTED;
      }
      continue;
    }
  }

  // Flush trailing field/row (unless it's an empty single field at EOF)
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  // Drop trailing completely-empty rows (common when CSV ends with newline)
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    const allEmpty = last.every((c) => String(c || '').trim() === '');
    if (allEmpty) rows.pop();
    else break;
  }

  return rows;
}

/**
 * @param {string} text raw CSV text
 * @param {object} [opts]
 * @param {boolean} [opts.hasHeader=true] - first row is treated as column headers
 * @returns {{ headers: string[], rows: string[][] }}
 */
function parseCsv(text, opts = {}) {
  const hasHeader = opts.hasHeader !== false;
  const rows = tokenize(text);
  if (!rows.length) return { headers: [], rows: [] };

  if (!hasHeader) return { headers: [], rows };

  const rawHeader = rows.shift().map((h) => String(h || '').trim());
  const seen = new Map();
  const headers = rawHeader.map((h) => {
    const base = h || 'column';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n}`;
  });

  // Pad / truncate each data row to match header length
  const out = rows.map((r) => {
    const a = r.slice(0, headers.length);
    while (a.length < headers.length) a.push('');
    return a.map((v) => String(v == null ? '' : v));
  });

  return { headers, rows: out };
}

/**
 * Heuristic: does this CSV text look like it has a header row?
 *
 *   - First row has no all-digit phone-looking values, AND
 *   - At least one cell in row 1 contains a letter, AND
 *   - Cell count matches across rows
 */
function looksLikeHeaderRow(text) {
  const rows = tokenize(text);
  if (rows.length < 2) return false;
  const first = rows[0].map((c) => String(c || '').trim());
  const second = rows[1].map((c) => String(c || '').trim());
  if (first.length === 0 || first.length !== second.length) return false;

  const phoneRe = /^[\d+\-\s()]{7,}$/;
  const hasAlphaInFirst = first.some((c) => /[a-zA-Z]/.test(c));
  const firstLooksLikePhones = first.some((c) => phoneRe.test(c));

  return hasAlphaInFirst && !firstLooksLikePhones;
}

module.exports = {
  parseCsv,
  looksLikeHeaderRow
};
