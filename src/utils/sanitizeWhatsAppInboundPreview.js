'use strict';

const { normalizeButtonsForPreview } = require('./whatsappTemplatePreview');

function langCompatible(clientLang, serverLang) {
  if (!clientLang || !serverLang) return true;
  if (clientLang === serverLang) return true;
  const a = String(clientLang).split(/[-_/]/)[0]?.toLowerCase() || '';
  const b = String(serverLang).split(/[-_/]/)[0]?.toLowerCase() || '';
  return a.length > 0 && b.length > 0 && a === b;
}

function clampStr(s, max) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max) : t;
}

function safeHttpUrl(u, maxLen) {
  if (u == null || typeof u !== 'string') return '';
  const t = u.trim().slice(0, maxLen);
  if (!/^https?:\/\//i.test(t)) return '';
  return t;
}

/**
 * Optional rich preview built in the Angular UI (canonical template definition from Meta list).
 * Merged server-side after building from Mongo/Meta-shaped send payload — fixes missing BODY.text in DB sync.
 */
function sanitizeWhatsAppInboundPreview(raw, { expectedName, expectedLanguageCode }) {
  if (!raw || typeof raw !== 'object') return null;
  const nameNeedle = String(expectedName || '')
    .trim()
    .toLowerCase();
  if (!nameNeedle) return null;
  const tn = String(raw.templateName ?? '')
    .trim()
    .toLowerCase();
  if (tn && tn !== nameNeedle) return null;

  const lc = raw.languageCode != null ? String(raw.languageCode).trim().slice(0, 35) : '';
  const exp =
    expectedLanguageCode != null ? String(expectedLanguageCode).trim().slice(0, 35) : '';
  if (lc && exp && !langCompatible(lc, exp)) return null;

  const bodyText = clampStr(raw.bodyText, 4096);
  const headerText = raw.headerText != null ? clampStr(raw.headerText, 4096) : '';
  const footerText = raw.footerText != null ? clampStr(raw.footerText, 1024) : '';
  const headerImageUrl = raw.headerImageUrl != null ? safeHttpUrl(String(raw.headerImageUrl), 2048) : '';

  const buttonsArr = Array.isArray(raw.buttons) ? normalizeButtonsForPreview(raw.buttons).slice(0, 25) : [];

  return {
    templateName: nameNeedle.slice(0, 512),
    languageCode: (lc || exp || 'en_US').slice(0, 35),
    category:
      raw.category != null ? clampStr(raw.category, 32) || null : null,
    headerImageUrl: headerImageUrl || null,
    headerText: headerText || null,
    bodyText,
    footerText: footerText || null,
    buttons: buttonsArr
  };
}

module.exports = { sanitizeWhatsAppInboundPreview };
