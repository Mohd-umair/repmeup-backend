'use strict';

/**
 * Build inbox UI preview for an outbound WhatsApp template (matches customer-facing layout).
 */

function normType(t) {
  return String(t || '').toLowerCase();
}

function textParamsFromSent(comp) {
  const ps = comp?.parameters;
  if (!Array.isArray(ps)) return [];
  return ps.filter((p) => normType(p.type) === 'text');
}

function interpolatePositional(templateText, values) {
  if (!templateText) return '';
  let i = 0;
  return templateText.replace(/\{\{\s*(\d+)\s*\}\}/g, () => {
    const v = values[i++];
    return v != null ? String(v) : '';
  });
}

function interpolateNamed(templateText, paramMap) {
  if (!templateText) return '';
  return templateText.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, raw) => {
    const k = String(raw).toLowerCase();
    return Object.prototype.hasOwnProperty.call(paramMap, k) ? String(paramMap[k]) : '';
  });
}

function interpolateComponent(templateText, sentComp, parameterFormat) {
  if (!templateText) return '';
  const texts = textParamsFromSent(sentComp).map((p) => String(p.text ?? ''));
  if (parameterFormat === 'NAMED' && /\{\{\s*\d+\s*\}\}/.test(templateText)) {
    return interpolatePositional(templateText, texts);
  }
  if (parameterFormat === 'NAMED') {
    const map = {};
    for (const p of textParamsFromSent(sentComp)) {
      const k = String(p.parameter_name || '').toLowerCase();
      if (k) map[k] = String(p.text ?? '');
    }
    return interpolateNamed(templateText, map);
  }
  return interpolatePositional(templateText, texts);
}

function fallbackBodyFromSent(bodySent) {
  return textParamsFromSent(bodySent)
    .map((p) => p.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}

function firstImageLinkFromSent(headerSent) {
  const img = headerSent?.parameters?.find((p) => normType(p.type) === 'image');
  return img?.image?.link ? String(img.image.link).trim() : null;
}

function normalizeButtonsForPreview(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((b) => {
    const type = String(b.type || '').toUpperCase();
    const text = String(b.text || '').trim() || type;
    let url = b.url ? String(b.url) : null;
    const example = Array.isArray(b.example) ? b.example : [];
    if (url && example.length) {
      let idx = 0;
      url = url.replace(/\{\{\s*\d+\s*\}\}/g, () => String(example[idx++] ?? ''));
    }
    return {
      type,
      text,
      url,
      phone_number: b.phone_number ? String(b.phone_number) : null
    };
  });
}

/**
 * @param {object|null} sent - sanitized { name, languageCode, components }
 * @param {object|null} dbTemplate - WhatsAppTemplate lean doc or null
 */
function buildWhatsAppTemplatePreview(sent, dbTemplate) {
  const templateName = String(sent?.name || '').trim();
  const languageCode = String(sent?.languageCode || 'en_US').trim() || 'en_US';
  const sentComponents = Array.isArray(sent?.components) ? sent.components : [];

  const dbComponents = Array.isArray(dbTemplate?.components) ? dbTemplate.components : [];
  const parameterFormat = dbTemplate?.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL';

  const headerSent = sentComponents.find((c) => normType(c.type) === 'header');
  const bodySent = sentComponents.find((c) => normType(c.type) === 'body');

  const dbHeader = dbComponents.find((c) => c.type === 'HEADER');
  const dbBody = dbComponents.find((c) => c.type === 'BODY');
  const dbFooter = dbComponents.find((c) => c.type === 'FOOTER');
  const dbButtons = dbComponents.find((c) => c.type === 'BUTTONS');

  let headerImageUrl = null;
  let headerText = null;

  if (dbHeader?.format === 'IMAGE') {
    headerImageUrl = firstImageLinkFromSent(headerSent);
  } else if (dbHeader?.format === 'VIDEO' || dbHeader?.format === 'DOCUMENT') {
    headerImageUrl = firstImageLinkFromSent(headerSent);
  } else if (dbHeader?.format === 'TEXT' && dbHeader.text) {
    headerText = interpolateComponent(dbHeader.text, headerSent, parameterFormat).trim() || null;
  } else {
    headerImageUrl = firstImageLinkFromSent(headerSent);
  }

  let bodyText = '';
  if (dbBody?.text) {
    bodyText = interpolateComponent(dbBody.text, bodySent, parameterFormat).trim();
  } else {
    bodyText = fallbackBodyFromSent(bodySent);
  }

  if (!bodyText && templateName) {
    bodyText = `«${templateName}»`;
  }

  const footerText = dbFooter?.text ? String(dbFooter.text).trim() : null;
  const buttons = normalizeButtonsForPreview(dbButtons?.buttons);

  return {
    templateName,
    languageCode,
    category: dbTemplate?.category ? String(dbTemplate.category) : null,
    headerImageUrl,
    headerText,
    bodyText,
    footerText,
    buttons
  };
}

/** Prefer server preview; overwrite text/header/media/footer from sanitized client when present (fixes missing BODY.text in Mongo). */
function mergeWhatsAppTemplatePreviews(serverPrev, clientPrev) {
  if (!serverPrev && !clientPrev) return null;
  if (!clientPrev || typeof clientPrev !== 'object') return serverPrev || null;
  if (!serverPrev) return clientPrev;

  const nonempty = (x) => x != null && String(x).trim().length > 0;
  const btnServer =
    Array.isArray(serverPrev.buttons) && serverPrev.buttons.length ? serverPrev.buttons : null;

  return {
    templateName: serverPrev.templateName || clientPrev.templateName,
    languageCode: serverPrev.languageCode || clientPrev.languageCode,
    category: serverPrev.category ?? clientPrev.category ?? null,
    headerImageUrl:
      nonempty(clientPrev.headerImageUrl) ? clientPrev.headerImageUrl : serverPrev.headerImageUrl,
    headerText:
      nonempty(clientPrev.headerText) ? clientPrev.headerText : serverPrev.headerText,
    bodyText:
      nonempty(clientPrev.bodyText) ? clientPrev.bodyText : serverPrev.bodyText,
    footerText:
      nonempty(clientPrev.footerText) ? clientPrev.footerText : serverPrev.footerText,
    buttons:
      btnServer ||
      (Array.isArray(clientPrev.buttons) && clientPrev.buttons.length ? clientPrev.buttons : [])
  };
}

module.exports = {
  buildWhatsAppTemplatePreview,
  mergeWhatsAppTemplatePreviews,
  normalizeButtonsForPreview
};
