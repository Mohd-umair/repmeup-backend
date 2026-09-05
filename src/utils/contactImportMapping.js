'use strict';

function normalizeHeaderKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findHeader(headers, candidates, exclude) {
  for (const cand of candidates) {
    const found = headers.find((h) => normalizeHeaderKey(h) === cand);
    if (found && found !== exclude) return found;
  }
  return null;
}

function detectPhoneColumn(headers) {
  const exact = findHeader(headers, [
    'phone', 'mobile', 'whatsapp', 'whatsappnumber', 'number', 'phonenumber', 'msisdn', 'contact', 'cell'
  ]);
  if (exact) return exact;
  return headers.find((h) => /phone|mobile|whatsapp|mob/i.test(h)) || null;
}

function detectNameColumn(headers, phoneColumn) {
  const exact = findHeader(headers, [
    'name', 'firstname', 'fullname', 'customername', 'recipientname', 'displayname', 'contactname'
  ], phoneColumn);
  if (exact) return exact;
  return headers.find((h) => /name/i.test(h) && h !== phoneColumn) || null;
}

function detectEmailColumn(headers, phoneColumn) {
  const exact = findHeader(headers, ['email', 'emailaddress', 'mail', 'emailid'], phoneColumn);
  if (exact) return exact;
  return headers.find((h) => /email|mail/i.test(h) && h !== phoneColumn) || null;
}

/** Suggest column mapping for the UI — never applied unless the user confirms. */
function suggestImportMapping(headers = []) {
  const list = Array.isArray(headers) ? headers.filter(Boolean) : [];
  const phone = detectPhoneColumn(list);
  const email = detectEmailColumn(list, phone);
  const name = detectNameColumn(list, phone);
  return { name: name || '', phone: phone || '', email: email || '' };
}

/**
 * Validate user-confirmed mapping. Import uses only these columns — no auto-detection.
 */
function validateImportMapping(headers = [], userMapping = {}) {
  const list = Array.isArray(headers) ? headers : [];

  const pick = (field) => {
    const col = userMapping[field];
    if (col == null || col === '') return null;
    const trimmed = String(col).trim();
    if (!trimmed) return null;
    if (!list.includes(trimmed)) {
      return { error: `Column "${trimmed}" is not in this CSV.` };
    }
    return trimmed;
  };

  const phoneResult = pick('phone');
  if (phoneResult && typeof phoneResult === 'object') return phoneResult;

  const emailResult = pick('email');
  if (emailResult && typeof emailResult === 'object') return emailResult;

  const nameResult = pick('name');
  if (nameResult && typeof nameResult === 'object') return nameResult;

  const firstNameResult = pick('first_name');
  if (firstNameResult && typeof firstNameResult === 'object') return firstNameResult;

  const phone = phoneResult;
  const email = emailResult;
  const name = nameResult || firstNameResult;

  if (!phone && !email) {
    return { error: 'Map at least one CSV column to Phone or Email.' };
  }

  return {
    mapping: { phone, email, name, first_name: name }
  };
}

function pickRowValue(row, header) {
  if (!header || !row || typeof row !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(row, header)) return row[header];
  const target = normalizeHeaderKey(header);
  const key = Object.keys(row).find((k) => normalizeHeaderKey(k) === target);
  return key ? row[key] : '';
}

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, '');
  return digits || null;
}

module.exports = {
  normalizeHeaderKey,
  detectPhoneColumn,
  detectNameColumn,
  detectEmailColumn,
  suggestImportMapping,
  validateImportMapping,
  pickRowValue,
  normalizePhone
};
